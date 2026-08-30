import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.OBSIDIAN_RUNTIME_MODE = "hybrid";
process.env.OBSIDIAN_VAULT = process.cwd();
process.env.SEMANTIC_SEARCH_PREWARM = "false";

// Bootstrap/HTTP startup output is emitted before the normal error boundary is
// available. Keep this small source contract next to the runtime privacy
// checks so paths, URLs, and raw exceptions cannot regress silently.
const configSource = readFileSync("src/config/index.ts", "utf8");
const entrypointSource = readFileSync("src/index.ts", "utf8");
const httpTransportSource = readFileSync(
  "src/mcp-server/transports/httpTransport.ts",
  "utf8",
);
const directConsoleCalls = [
  ...configSource.matchAll(/console\.(?:log|warn|error)\s*\(([\s\S]*?)\);/gu),
  ...entrypointSource.matchAll(
    /console\.(?:log|warn|error)\s*\(([\s\S]*?)\);/gu,
  ),
  ...httpTransportSource.matchAll(
    /console\.(?:log|warn|error)\s*\(([\s\S]*?)\);/gu,
  ),
].map((match) => match[1]);
for (const call of directConsoleCalls) {
  assert.doesNotMatch(
    call,
    /\b(?:errorDetails|resolvedDirPath|dirPath|rootDir|projectRoot|serverAddress|initialLogLevelConfig)\b/iu,
    "direct bootstrap output must not expose paths or derived addresses",
  );
  assert.doesNotMatch(
    call,
    /\b(?:error|err|statError)\.(?:message|stack)\b|\bString\(\s*(?:error|err|statError)\s*\)/u,
    "direct bootstrap output must not serialize raw exceptions",
  );
}
assert.doesNotMatch(
  httpTransportSource,
  /\bserverAddress\b|console\.log\s*\([\s\S]*https?:\/\//iu,
  "HTTP startup output must not expose a listener URL",
);

const {
  ErrorHandler,
  logger,
  publicMcpToolErrorPayload,
  sanitizeInputForLogging,
} = await import("../dist/utils/index.js");
const { BaseErrorCode, McpError } = await import(
  "../dist/types-global/errors.js"
);
const { requestLogMetadata } = await import(
  "../dist/services/obsidianRestAPI/requestLogMetadata.js"
);

const marker = "P0-PRIVATE-PAYLOAD-MARKER-6f1f98e4";
const backendOnlyMarker = "P0-BACKEND-ONLY-MARKER-a39c";
const backendTokenMarker = "BACKENDSECRET";
const numericSecretMarker = 918273645;
const mutationPayload = {
  content: marker,
  value: marker,
  replacements: [{ search: marker, replace: marker }],
  frontmatter: { privateProperty: marker },
  canvas: { nodes: [{ text: marker }] },
  base: { formulas: [{ formula: marker }] },
  atomic: { nextContent: marker },
};

const serializedSummary = JSON.stringify(
  sanitizeInputForLogging(mutationPayload),
);
assert.doesNotMatch(serializedSummary, new RegExp(marker, "u"));
assert.deepEqual(JSON.parse(serializedSummary), {
  kind: "object",
  fieldCount: 7,
  valueRedacted: true,
});

const originalLoggerError = logger.error;
let capturedLog;
logger.error = (...args) => {
  capturedLog = args;
};

try {
  const originalMappedError = new McpError(
    BaseErrorCode.CONFLICT,
    `backend echoed ${marker}`,
    {
      payload: mutationPayload,
      value: marker,
    },
  );
  let mapperInput;
  const handled = ErrorHandler.handleError(originalMappedError, {
    operation: "privacyMutationFailure",
    input: mutationPayload,
    context: {
      requestId: "p0-log-privacy-test",
      toolName: "obsidian_update_note",
      params: mutationPayload,
    },
    errorMapper: (error) => {
      mapperInput = error;
      return new Error(`service unavailable: generic mapper echoed ${marker}`);
    },
  });

  assert.ok(handled instanceof McpError);
  assert.equal(mapperInput, originalMappedError);
  assert.equal(handled.code, BaseErrorCode.SERVICE_UNAVAILABLE);
  assert.equal(
    handled.message,
    "The service is temporarily unavailable. Retry later.",
  );
  assert.doesNotMatch(handled.message, new RegExp(marker, "u"));
  assert.doesNotMatch(JSON.stringify(handled.details), new RegExp(marker, "u"));
  assert.ok(capturedLog, "ErrorHandler should emit an error log");
  assert.doesNotMatch(JSON.stringify(capturedLog), new RegExp(marker, "u"));
  assert.match(
    handled.details?.requestId ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.equal(capturedLog[1]?.requestId, handled.details?.requestId);

  const mapperFailure = ErrorHandler.handleError(
    new McpError(BaseErrorCode.CONFLICT, backendOnlyMarker),
    {
      operation: "mapperFailure",
      errorMapper: () => {
        throw new Error(marker);
      },
    },
  );
  assert.equal(mapperFailure.code, BaseErrorCode.CONFLICT);
  assert.equal(
    mapperFailure.message,
    "The request conflicts with the current resource state.",
  );
  assert.doesNotMatch(JSON.stringify(mapperFailure), new RegExp(marker, "u"));

  const hostileInput = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error(marker);
      },
    },
  );
  const hostileDetails = new Proxy(
    { reasonCode: "REVISION_CONFLICT" },
    {
      getOwnPropertyDescriptor() {
        throw new Error(marker);
      },
    },
  );
  const hostileHandled = ErrorHandler.handleError(
    new McpError(BaseErrorCode.CONFLICT, backendOnlyMarker, hostileDetails),
    {
      operation: "hostileDiagnostics",
      input: hostileInput,
      context: new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error(marker);
          },
        },
      ),
    },
  );
  assert.ok(hostileHandled instanceof McpError);
  assert.match(
    hostileHandled.details?.requestId ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.doesNotMatch(JSON.stringify(hostileHandled), new RegExp(marker, "u"));
  assert.doesNotMatch(JSON.stringify(capturedLog), new RegExp(marker, "u"));

  // `instanceof`, name/message/stack reads, JSON coercion and own-property
  // reflection can all be intercepted by a Proxy. A hostile thrown value is
  // opaque: the public boundary must return a canonical error rather than
  // attempting to classify or serialize it.
  const hostileThrown = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(marker);
      },
      getOwnPropertyDescriptor() {
        throw new Error(marker);
      },
      get() {
        throw new Error(marker);
      },
      ownKeys() {
        throw new Error(marker);
      },
    },
  );
  let hostileThrownHandled;
  assert.doesNotThrow(() => {
    hostileThrownHandled = ErrorHandler.handleError(hostileThrown, {
      operation: "hostileThrownValue",
      input: { marker },
      errorMapper: () => hostileThrown,
    });
  });
  assert.equal(hostileThrownHandled.code, BaseErrorCode.INTERNAL_ERROR);
  assert.doesNotMatch(
    JSON.stringify(hostileThrownHandled),
    new RegExp(marker, "u"),
  );

  const accessorError = new Error("private fallback");
  for (const field of ["message", "name", "stack"]) {
    Object.defineProperty(accessorError, field, {
      get() {
        throw new Error(marker);
      },
      configurable: true,
    });
  }
  let accessorHandled;
  assert.doesNotThrow(() => {
    accessorHandled = ErrorHandler.handleError(accessorError, {
      operation: "hostileErrorAccessors",
    });
  });
  assert.equal(accessorHandled.code, BaseErrorCode.INTERNAL_ERROR);
  assert.doesNotMatch(JSON.stringify(accessorHandled), new RegExp(marker, "u"));

  const circularDetails = { reasonCode: "REVISION_CONFLICT" };
  circularDetails.self = circularDetails;
  Object.defineProperty(circularDetails, "toJSON", {
    value() {
      throw new Error(marker);
    },
    enumerable: true,
  });
  let circularHandled;
  assert.doesNotThrow(() => {
    circularHandled = ErrorHandler.handleError(
      new McpError(BaseErrorCode.CONFLICT, backendOnlyMarker, circularDetails),
      { operation: "circularDetails" },
    );
  });
  assert.equal(circularHandled.details?.reasonCode, "REVISION_CONFLICT");
  assert.doesNotMatch(JSON.stringify(circularHandled), new RegExp(marker, "u"));

  const numericDiagnostics = ErrorHandler.handleError(
    new McpError(BaseErrorCode.CONFLICT, backendOnlyMarker, {
      operationId: numericSecretMarker,
      planRef: numericSecretMarker,
      recoveryRef: numericSecretMarker,
      reasonCode: numericSecretMarker,
      planDigest: numericSecretMarker,
      httpStatus: numericSecretMarker,
      retryable: numericSecretMarker,
      recoveryAllowed: numericSecretMarker,
      applyAllowed: numericSecretMarker,
      mutationMayHaveApplied: numericSecretMarker,
    }),
    { operation: "numericDiagnostics" },
  );
  assert.doesNotMatch(
    JSON.stringify(numericDiagnostics),
    new RegExp(String(numericSecretMarker), "u"),
  );
  assert.doesNotMatch(
    JSON.stringify(capturedLog),
    new RegExp(String(numericSecretMarker), "u"),
  );

  const namedError = new Error(`backend message ${marker}`);
  namedError.name = marker;
  const namedHandled = ErrorHandler.handleError(namedError, {
    operation: "privacyCustomErrorName",
    input: mutationPayload,
    includeStack: false,
  });
  assert.doesNotMatch(JSON.stringify(namedHandled), new RegExp(marker, "u"));
  assert.doesNotMatch(JSON.stringify(capturedLog), new RegExp(marker, "u"));
  assert.equal(namedHandled.details?.originalErrorName, undefined);

  const businessError = ErrorHandler.handleError(
    new McpError(
      BaseErrorCode.CONFLICT,
      "The sealed revision no longer matches the current note.",
      { reasonCode: "REVISION_CONFLICT" },
    ),
    { operation: "governedMutation" },
  );
  assert.equal(
    businessError.message,
    "The request conflicts with the current resource state.",
    "public errors must use the stable message catalog",
  );
  assert.equal(businessError.details?.reasonCode, "REVISION_CONFLICT");

  const backendOnlyError = ErrorHandler.handleError(
    new McpError(BaseErrorCode.INTERNAL_ERROR, backendOnlyMarker, {
      reasonCode: backendOnlyMarker,
    }),
    { operation: "backendOnlyFailure", input: { a: "q7" } },
  );
  assert.equal(
    backendOnlyError.message,
    "The request could not be completed. Use the request id to inspect server diagnostics.",
  );
  assert.doesNotMatch(
    JSON.stringify(backendOnlyError),
    new RegExp(backendOnlyMarker, "u"),
  );

  const shortCallerError = ErrorHandler.handleError(
    new McpError(BaseErrorCode.CONFLICT, "backend echoed q7"),
    { operation: "shortCallerFailure", input: { a: "q7" } },
  );
  assert.equal(
    shortCallerError.message,
    "The request conflicts with the current resource state.",
  );

  const formatted = ErrorHandler.formatError(
    new McpError(BaseErrorCode.CONFLICT, backendOnlyMarker, {
      reasonCode: backendTokenMarker,
      operationId: "callerSecret",
      recoveryAllowed: true,
    }),
  );
  assert.doesNotMatch(JSON.stringify(formatted), /BACKENDSECRET|callerSecret/u);
  assert.deepEqual(formatted.details, { recoveryAllowed: true });
} finally {
  logger.error = originalLoggerError;
}

const loggerState = {
  initialized: logger.initialized,
  winstonLogger: logger.winstonLogger,
  currentMcpLevel: logger.currentMcpLevel,
  mcpNotificationSender: logger.mcpNotificationSender,
};
const winstonEntries = [];
const mcpNotifications = [];
try {
  logger.initialized = true;
  logger.currentMcpLevel = "debug";
  logger.winstonLogger = {
    log: (...args) => winstonEntries.push(["log", ...args]),
    error: (...args) => winstonEntries.push(["error", ...args]),
  };
  logger.mcpNotificationSender = (...args) => mcpNotifications.push(args);

  const rawContext = {
    requestId: "dd5d4fea-2e7c-4c5f-b3d6-eb9c53c0c176",
    timestamp: "2026-08-30T00:00:00.000Z",
    operation: marker,
    toolName: backendOnlyMarker,
    path: marker,
    input: {
      kind: "object",
      fieldCount: 1,
      valueRedacted: true,
      value: marker,
    },
    errorDetails: {
      reasonCode: backendTokenMarker,
      phase: "applying",
      payload: marker,
    },
    httpStatus: numericSecretMarker,
    durationMs: numericSecretMarker,
    count: numericSecretMarker,
  };
  logger.debug(`debug ${marker}`, rawContext);
  logger.info(`info ${marker}`, rawContext);
  logger.notice(`notice ${marker}`, rawContext);
  logger.warning(`warning ${marker}`, rawContext);
  logger.error(
    `error ${marker}`,
    new Error(`stack ${backendOnlyMarker}`),
    rawContext,
  );
  logger.crit(`crit ${marker}`, new Error(backendOnlyMarker), rawContext);
  logger.alert(`alert ${marker}`, new Error(backendOnlyMarker), rawContext);
  logger.emerg(`emerg ${marker}`, new Error(backendOnlyMarker), rawContext);

  const serializedLogs = JSON.stringify({ winstonEntries, mcpNotifications });
  assert.doesNotMatch(serializedLogs, new RegExp(marker, "u"));
  assert.doesNotMatch(serializedLogs, new RegExp(backendOnlyMarker, "u"));
  assert.doesNotMatch(serializedLogs, new RegExp(backendTokenMarker, "u"));
  assert.doesNotMatch(
    serializedLogs,
    new RegExp(String(numericSecretMarker), "u"),
  );
  assert.match(serializedLogs, /operationFingerprint/u);
  assert.match(serializedLogs, /toolNameFingerprint/u);
  assert.match(serializedLogs, /"phase":"applying"/u);
  assert.doesNotMatch(serializedLogs, /stack P0-/u);

  logger.mcpNotificationSender = () => {
    throw new Error(backendOnlyMarker);
  };
  logger.info(`sender failure ${marker}`, rawContext);
  const serializedFailure = JSON.stringify(winstonEntries);
  assert.doesNotMatch(serializedFailure, new RegExp(marker, "u"));
  assert.doesNotMatch(serializedFailure, new RegExp(backendOnlyMarker, "u"));

  // Hostile callers must not be able to execute getters or Proxy traps from
  // the logging path. The logger fails closed and emits no private marker.
  const hostileNested = {};
  Object.defineProperty(hostileNested, "reasonCode", {
    get() {
      throw new Error(marker);
    },
    enumerable: true,
  });
  const hostileContext = new Proxy(
    { requestId: "logger-hostile", input: hostileNested },
    {
      getOwnPropertyDescriptor() {
        throw new Error(marker);
      },
    },
  );
  assert.doesNotThrow(() => logger.info(`hostile ${marker}`, hostileContext));
  assert.doesNotThrow(() =>
    logger.info(`nested getter ${marker}`, { input: hostileNested }),
  );
  assert.doesNotThrow(() =>
    logger.info(`nested proxy ${marker}`, {
      input: new Proxy(
        { reasonCode: marker },
        {
          getOwnPropertyDescriptor: () => {
            throw new Error(marker);
          },
        },
      ),
    }),
  );

  const throwingStackError = new Error("private error message");
  Object.defineProperty(throwingStackError, "stack", {
    get() {
      throw new Error(marker);
    },
    configurable: true,
  });
  assert.doesNotThrow(() =>
    logger.error(
      `throwing stack ${marker}`,
      throwingStackError,
      hostileContext,
    ),
  );

  const exoticMessage = new Proxy(
    {},
    {
      get() {
        throw new Error(marker);
      },
    },
  );
  assert.doesNotThrow(() => logger.info(exoticMessage, hostileContext));
  const hostileLoggerError = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(marker);
      },
      getOwnPropertyDescriptor() {
        throw new Error(marker);
      },
      get() {
        throw new Error(marker);
      },
    },
  );
  assert.doesNotThrow(() =>
    logger.error(`hostile error ${marker}`, hostileLoggerError, hostileContext),
  );
  const serializedHostile = JSON.stringify({
    winstonEntries,
    mcpNotifications,
  });
  assert.doesNotMatch(serializedHostile, new RegExp(marker, "u"));
  assert.doesNotMatch(serializedHostile, /stackAvailable":true/u);
} finally {
  logger.initialized = loggerState.initialized;
  logger.winstonLogger = loggerState.winstonLogger;
  logger.currentMcpLevel = loggerState.currentMcpLevel;
  logger.mcpNotificationSender = loggerState.mcpNotificationSender;
}

const quartetPayloads = [
  ["obsidian_note_replace_plan", { path: marker, nextContent: marker }],
  [
    "obsidian_frontmatter_patch_plan",
    { path: marker, operations: [{ op: "set", key: marker, value: marker }] },
  ],
  [
    "bases_formula_patch_plan",
    {
      path: marker,
      operations: [{ op: "set_formula", name: marker, expression: marker }],
    },
  ],
  [
    "obsidian_canvas_patch_plan",
    {
      path: marker,
      operations: [{ op: "set_text", id: marker, text: marker }],
    },
  ],
];
for (const [toolName, params] of quartetPayloads) {
  const envelope = publicMcpToolErrorPayload(
    new McpError(BaseErrorCode.CONFLICT, `backend echoed ${marker}`, {
      payload: params,
      planRef: "obsidian-note-replace:v1:6c3fc3b1-c43f-4c4d-a7fe-48e841612635",
      stack: marker,
    }),
    { operation: toolName, toolName, params },
  );
  const serialized = JSON.stringify(envelope);
  assert.doesNotMatch(serialized, new RegExp(marker, "u"));
  assert.equal(
    envelope.error.details.planRef,
    "obsidian-note-replace:v1:6c3fc3b1-c43f-4c4d-a7fe-48e841612635",
  );
  assert.match(
    envelope.error.details.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.equal("stack" in envelope.error, false);
}

const arbitraryDetailsEnvelope = publicMcpToolErrorPayload(
  new McpError(BaseErrorCode.INTERNAL_ERROR, backendOnlyMarker, {
    reasonCode: backendTokenMarker,
    operationId: "callerSecret",
  }),
  {
    operation: "arbitraryBackendDetails",
    toolName: "obsidian_update_note",
    params: { content: marker },
  },
);
assert.doesNotMatch(
  JSON.stringify(arbitraryDetailsEnvelope),
  /BACKENDSECRET|callerSecret|P0-BACKEND-ONLY-MARKER/u,
);

const numericDetailsEnvelope = publicMcpToolErrorPayload(
  new McpError(BaseErrorCode.CONFLICT, backendOnlyMarker, {
    operationId: numericSecretMarker,
    reasonCode: numericSecretMarker,
    retryable: numericSecretMarker,
  }),
  {
    operation: "numericBackendDetails",
    toolName: "obsidian_update_note",
    params: { content: marker },
  },
);
assert.doesNotMatch(
  JSON.stringify(numericDetailsEnvelope),
  new RegExp(String(numericSecretMarker), "u"),
);

const requestMetadata = requestLogMetadata(
  {
    method: "POST",
    url: `/vault/${marker}.md`,
    data: { content: marker },
    headers: { Authorization: `Bearer ${marker}` },
  },
  409,
);
assert.deepEqual(requestMetadata, {
  method: "POST",
  routeClass: "vault",
  hasBody: true,
  status: 409,
});
assert.doesNotMatch(JSON.stringify(requestMetadata), new RegExp(marker, "u"));

for (const registration of [
  "governedNoteReplaceTools/registration.ts",
  "governedFrontmatterTools/registration.ts",
  "governedBaseFormulaTools/registration.ts",
  "governedCanvasTools/registration.ts",
]) {
  const source = readFileSync(
    path.join(process.cwd(), "src/mcp-server/tools", registration),
    "utf8",
  );
  assert.match(source, /publicMcpToolErrorPayload/u);
  assert.match(source, /params,/u);
}

const loggerSource = readFileSync(
  path.join(process.cwd(), "src/utils/internal/logger.ts"),
  "utf8",
);
assert.doesNotMatch(loggerSource, /mcpDataPayload\.error/u);
assert.doesNotMatch(loggerSource, /originalMessage|mcpPayload/u);

console.log("Log privacy contract passed.");
