import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

// Contract for operator-readable, still value-free runtime events:
//   - closed tool / operation / route / error-class fields instead of bare
//     fingerprints, never a path, message, header or payload;
//   - a request context reused by a loop does not rewrite one event forever;
//   - `info` and `debug` are different files, nothing is created empty;
//   - rotation is configurable and the defaults keep >= 7 days at the volume
//     measured on the production runtime (peak day: 8.33 MB of combined.log).
//
// The orchestrator runs each case in a child process because the logger is a
// process singleton configured from the environment at import time.

const caseArgument = process.argv.find((value) => value.startsWith("--case="));
const MARKER = "OBS-PRIVATE-MARKER-3b7e";
const PATH_MARKER = "Notes/Private Client/plan-5c1d.md";
const REQUEST_ID = "6622fa69-ea81-4cf4-b320-986a3e2e762e";

if (!caseArgument) {
  const logsRoot = path.join(process.cwd(), "logs");
  mkdirSync(logsRoot, { recursive: true });
  const cases = [
    ["readable-fields", {}],
    ["attribution-and-class", {}],
    ["repeat-collapse", { MCP_LOG_DEDUPE_WINDOW_MS: "60000" }],
    ["repeat-disabled", { MCP_LOG_DEDUPE_WINDOW_MS: "0" }],
    ["level-files", {}],
    ["rotation", { MCP_LOG_MAX_FILE_SIZE_MB: "1", MCP_LOG_MAX_FILES: "3" }],
    ["defaults", {}],
    ["probe", { MCP_LOG_DEDUPE_WINDOW_MS: "60000" }],
    ["operation-sources", {}],
  ];
  const only = process.argv.find((value) => value.startsWith("--only="));
  for (const [name, env] of cases) {
    if (only && only !== `--only=${name}`) continue;
    const logs = path.join(logsRoot, `observability-${name}-${process.pid}`);
    rmSync(logs, { recursive: true, force: true });
    mkdirSync(logs, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [process.argv[1], `--case=${name}`],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          OBSIDIAN_RUNTIME_MODE: "hybrid",
          OBSIDIAN_VAULT: process.cwd(),
          SEMANTIC_SEARCH_PREWARM: "false",
          LOGS_DIR: logs,
          ...env,
        },
      },
    );
    rmSync(logs, { recursive: true, force: true });
    assert.equal(result.status, 0, `case ${name} failed`);
  }
  console.log("Log observability contract passed.");
  process.exit(0);
}

const caseName = caseArgument.slice("--case=".length);
const logsDir = process.env.LOGS_DIR;

function readLines(file) {
  const target = path.join(logsDir, file);
  if (!existsSync(target)) return [];
  return readFileSync(target, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, description, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${description}`);
}

const { logger, withActiveToolName } = await import("../dist/utils/index.js");
const { config } = await import("../dist/config/index.js");

if (caseName === "defaults") {
  // 24/10 produced 8.33 MB of combined.log (the busiest observed day). Keep
  // seven such days with 25% headroom for the added fields.
  const peakDayBytes = 8.33e6;
  const capacity = config.logMaxFileSizeBytes * config.logMaxFiles;
  assert.ok(
    capacity >= 7 * peakDayBytes * 1.25,
    `default rotation keeps ${capacity} bytes; at least ${
      7 * peakDayBytes * 1.25
    } needed for 7 days`,
  );
  assert.equal(config.logDedupeWindowMs, 300_000);
  console.log("PASS defaults: rotation capacity covers 7 peak days.");
  process.exit(0);
}

if (caseName === "operation-sources") {
  // `operation` and `module` are readable when identifier-shaped. That is only
  // sound while every template literal feeding them interpolates a closed,
  // code-defined value. Fail when a new interpolation appears.
  const allowed = new Set([
    "transportType",
    "toolName",
    "name",
    "operationName",
    // z.enum(["append", "prepend", "overwrite"]) in obsidianUpdateNoteTool.
    "mode",
  ]);
  const unexpected = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) scan(full);
    }
  };
  const scan = (file) => {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /\boperation:\s*`([^`]*)`|\bmodule:\s*`([^`]*)`/gu,
    )) {
      const body = match[1] ?? match[2];
      for (const expression of body.matchAll(/\$\{([^}]*)\}/gu)) {
        if (!allowed.has(expression[1].trim()))
          unexpected.push(
            `${path.relative(process.cwd(), file)}: ${expression[1]}`,
          );
      }
    }
  };
  walk(path.join(process.cwd(), "src"));
  assert.deepEqual(
    unexpected,
    [],
    "new interpolated operation/module value: prove it is closed before allowing it",
  );
  console.log("PASS operation-sources: interpolations are closed values.");
  process.exit(0);
}

await logger.initialize("info");

if (caseName === "readable-fields") {
  const context = {
    requestId: REQUEST_ID,
    timestamp: "2026-10-23T12:05:26.190Z",
    operation: "ObsidianAPI_checkStatus",
    module: "HttpLiveApiProbe",
    toolName: "obsidian_read_note",
    routeClass: "vault",
    method: "GET",
    status: 503,
    errorCode: "SERVICE_UNAVAILABLE",
    errorClass: "upstream_unreachable",
  };
  logger.error(`Obsidian API did not respond for ${PATH_MARKER}`, context);
  // Values outside the closed vocabularies stay fingerprinted, never readable.
  logger.warning(`hostile ${MARKER}`, {
    requestId: "11111111-2222-4333-8444-555555555555",
    operation: `${PATH_MARKER} with spaces`,
    module: PATH_MARKER,
    toolName: MARKER,
    routeClass: PATH_MARKER,
    errorClass: MARKER,
    event: MARKER,
  });
  await waitFor(
    () => readLines("combined.log").length >= 3,
    "combined.log entries",
  );
  const lines = readLines("combined.log");
  const readable = lines.find((line) => line.requestId === REQUEST_ID);
  assert.ok(readable, "event with the probe request ID was written");
  for (const [field, value] of Object.entries({
    operation: "ObsidianAPI_checkStatus",
    module: "HttpLiveApiProbe",
    toolName: "obsidian_read_note",
    routeClass: "vault",
    method: "GET",
    status: 503,
    errorCode: "SERVICE_UNAVAILABLE",
    errorClass: "upstream_unreachable",
  })) {
    assert.equal(readable[field], value, field);
  }
  for (const field of ["operation", "module", "toolName", "routeClass"]) {
    assert.equal(readable[`${field}Fingerprint`], undefined, field);
  }
  assert.equal(readable.message, "Runtime error event.");
  const hostile = lines.find(
    (line) => line.requestId === "11111111-2222-4333-8444-555555555555",
  );
  assert.ok(hostile);
  for (const field of [
    "operation",
    "module",
    "toolName",
    "routeClass",
    "errorClass",
    "event",
  ]) {
    assert.equal(hostile[field], undefined, `${field} must not be readable`);
    assert.match(hostile[`${field}Fingerprint`], /^[0-9a-f]{16}$/u, field);
  }
  const text = readFileSync(path.join(logsDir, "combined.log"), "utf8");
  assert.doesNotMatch(text, new RegExp(MARKER, "u"));
  assert.doesNotMatch(text, /Private Client|plan-5c1d|with spaces/u);
  console.log(
    "PASS readable-fields: closed fields readable, free text fingerprinted.",
  );
}

if (caseName === "attribution-and-class") {
  const refused = Object.assign(
    new Error(`connect ECONNREFUSED ${PATH_MARKER}`),
    {
      code: "ECONNREFUSED",
    },
  );
  const diskFull = Object.assign(new Error(MARKER), { code: "ENOSPC" });
  const wrapped = new Error("outer", {
    cause: Object.assign(new Error(MARKER), { code: "ETIMEDOUT" }),
  });
  const hostile = new Proxy(new Error("x"), {
    getOwnPropertyDescriptor() {
      throw new Error(MARKER);
    },
  });
  withActiveToolName("obsidian_read_note", () => {
    logger.error("a", refused, {
      requestId: REQUEST_ID,
      timestamp: new Date().toISOString(),
    });
    logger.error("b", diskFull, {
      requestId: "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb",
      timestamp: new Date().toISOString(),
    });
    logger.error("c", wrapped, {
      requestId: "bbbbbbbb-1111-4222-8333-cccccccccccc",
      timestamp: new Date().toISOString(),
    });
    logger.error("d", hostile, {
      requestId: "cccccccc-1111-4222-8333-dddddddddddd",
      timestamp: new Date().toISOString(),
    });
  });
  withActiveToolName(MARKER, () => {
    logger.error("e", {
      requestId: "dddddddd-1111-4222-8333-eeeeeeeeeeee",
      timestamp: new Date().toISOString(),
    });
  });
  logger.error("f", {
    requestId: "eeeeeeee-1111-4222-8333-ffffffffffff",
    timestamp: new Date().toISOString(),
  });
  await waitFor(() => readLines("combined.log").length >= 7, "entries");
  const byId = Object.fromEntries(
    readLines("combined.log").map((line) => [line.requestId, line]),
  );
  assert.equal(byId[REQUEST_ID].toolName, "obsidian_read_note");
  assert.equal(byId[REQUEST_ID].errorClass, "upstream_unreachable");
  assert.equal(
    byId["aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb"].errorClass,
    "disk_full",
  );
  assert.equal(
    byId["bbbbbbbb-1111-4222-8333-cccccccccccc"].errorClass,
    "upstream_timeout",
  );
  assert.equal(
    byId["cccccccc-1111-4222-8333-dddddddddddd"].errorClass,
    undefined,
  );
  // An unregistered active tool name is never attributed.
  assert.equal(
    byId["dddddddd-1111-4222-8333-eeeeeeeeeeee"].toolName,
    undefined,
  );
  assert.equal(
    byId["eeeeeeee-1111-4222-8333-ffffffffffff"].toolName,
    undefined,
  );
  const text = readFileSync(path.join(logsDir, "combined.log"), "utf8");
  assert.doesNotMatch(
    text,
    new RegExp(`${MARKER}|ECONNREFUSED|Private Client`, "u"),
  );
  console.log(
    "PASS attribution-and-class: tool and error class attributed without leaking.",
  );
}

if (caseName === "repeat-collapse") {
  const loopContext = {
    requestId: REQUEST_ID,
    timestamp: "2026-10-23T12:05:26.190Z",
    operation: "ObsidianAPI_checkStatus",
    routeClass: "status",
    method: "GET",
    errorCode: "SERVICE_UNAVAILABLE",
  };
  for (let index = 0; index < 500; index++) {
    logger.error("Obsidian API did not respond.", loopContext);
  }
  // A different request with the same event is a different failure: it keeps
  // its own line so a public requestId still resolves.
  logger.error("Obsidian API did not respond.", {
    ...loopContext,
    requestId: "11111111-2222-4333-8444-555555555555",
  });
  logger.flushSuppressed();
  await waitFor(
    () =>
      readLines("combined.log").filter((line) => line.level === "error")
        .length >= 3,
    "collapsed entries",
  );
  const errors = readLines("combined.log").filter(
    (line) => line.level === "error",
  );
  const loopLines = errors.filter((line) => line.requestId === REQUEST_ID);
  assert.equal(loopLines.length, 2, "one line plus one summary, not 500");
  assert.equal(loopLines[0].suppressedRepeats, undefined);
  assert.equal(loopLines[1].suppressedRepeats, 499);
  assert.equal(loopLines[1].event, "log_events_suppressed");
  assert.equal(loopLines[1].repeatWindowMs, 60000);
  assert.equal(
    errors.filter(
      (line) => line.requestId === "11111111-2222-4333-8444-555555555555",
    ).length,
    1,
  );
  // Emission time wins; the loop's old context time is kept as provenance.
  const now = Date.now();
  for (const line of loopLines) {
    assert.ok(
      Math.abs(Date.parse(line.timestamp) - now) < 60_000,
      "timestamp is emission time",
    );
    assert.equal(line.requestTimestamp, "2026-10-23T12:05:26.190Z");
  }
  console.log(
    "PASS repeat-collapse: 500 identical events become 1 line + counter.",
  );
}

if (caseName === "repeat-disabled") {
  for (let index = 0; index < 5; index++) {
    logger.error("same", {
      requestId: REQUEST_ID,
      timestamp: new Date().toISOString(),
    });
  }
  await waitFor(
    () =>
      readLines("combined.log").filter((line) => line.level === "error")
        .length >= 5,
    "uncollapsed entries",
  );
  console.log(
    "PASS repeat-disabled: MCP_LOG_DEDUPE_WINDOW_MS=0 keeps every event.",
  );
}

if (caseName === "level-files") {
  const ids = ["error", "warning", "info", "notice", "debug"].map(
    (name, index) => `00000000-0000-4000-8000-00000000000${index}`,
  );
  const context = (index) => ({
    requestId: ids[index],
    timestamp: new Date().toISOString(),
  });
  logger.error("e", context(0));
  logger.warning("w", context(1));
  logger.info("i", context(2));
  logger.notice("n", context(3));
  logger.debug("d-before-debug", context(4));
  await waitFor(
    () => readLines("combined.log").some((line) => line.requestId === ids[3]),
    "info-level entries",
  );
  const files = () => readdirSync(logsDir).sort();
  assert.ok(
    !files().includes("debug.log"),
    "debug.log is not created at info level",
  );
  const levels = (file) => new Set(readLines(file).map((line) => line.level));
  assert.deepEqual([...levels("error.log")], ["error"]);
  assert.deepEqual([...levels("warn.log")], ["warn"]);
  assert.deepEqual([...levels("info.log")], ["info"]);
  assert.deepEqual([...levels("combined.log")].sort(), [
    "error",
    "info",
    "warn",
  ]);
  assert.equal(
    readLines("combined.log").some((line) => line.requestId === ids[4]),
    false,
    "a debug event is not written at info level",
  );

  logger.setLevel("debug");
  logger.debug("d", {
    requestId: "99999999-0000-4000-8000-000000000009",
    timestamp: new Date().toISOString(),
  });
  await waitFor(() => readLines("debug.log").length >= 1, "debug.log entries");
  assert.deepEqual([...levels("debug.log")], ["debug"]);
  assert.notEqual(
    readFileSync(path.join(logsDir, "info.log"), "utf8"),
    readFileSync(path.join(logsDir, "debug.log"), "utf8"),
    "info.log and debug.log must differ",
  );
  for (const file of files()) {
    assert.ok(
      statSync(path.join(logsDir, file)).size > 0,
      `${file} must not be empty`,
    );
  }
  console.log(
    "PASS level-files: exact levels, no empty file, debug only when enabled.",
  );
}

if (caseName === "rotation") {
  assert.equal(config.logMaxFileSizeBytes, 1024 * 1024);
  assert.equal(config.logMaxFiles, 3);
  const pad = "x".repeat(200);
  for (let index = 0; index < 12_000; index++) {
    logger.info(`event ${pad}`, {
      requestId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      timestamp: new Date().toISOString(),
    });
  }
  await waitFor(
    () =>
      readdirSync(logsDir).filter((file) => file.startsWith("combined"))
        .length >= 3,
    "rotation to three files",
    15000,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const family of ["combined", "info"]) {
    const rotated = readdirSync(logsDir).filter(
      (file) => file.startsWith(family) && file.endsWith(".log"),
    );
    assert.ok(rotated.length >= 2, `${family} rotated`);
    assert.ok(
      rotated.length <= 3,
      `${family} keeps at most MCP_LOG_MAX_FILES files`,
    );
    for (const file of rotated) {
      assert.ok(
        statSync(path.join(logsDir, file)).size <= 1024 * 1024 + 256 * 1024,
        `${file} stays near MCP_LOG_MAX_FILE_SIZE_MB (a write burst may overshoot slightly)`,
      );
    }
  }
  console.log("PASS rotation: size and file count follow the environment.");
}

if (caseName === "probe") {
  const { createLiveApiProbe } = await import(
    "../dist/mcp-server/transports/httpTransport.js"
  );
  const seen = [];
  let calls = 0;
  const service = {
    async checkStatus(context) {
      seen.push(context);
      calls++;
      if (calls <= 4) throw new Error(`down ${PATH_MARKER}`);
      return { service: "Obsidian Local REST API", authenticated: true };
    },
  };
  const probe = createLiveApiProbe(service, 250);
  await waitFor(() => calls >= 7, "probe calls", 10000);
  probe.stop();
  const failed = seen.slice(0, 4);
  assert.equal(
    new Set(failed.map((context) => context.requestId)).size,
    1,
    "failed probes of one outage share one correlation ID",
  );
  assert.notEqual(
    seen[6].requestId,
    failed[0].requestId,
    "recovery starts a new episode",
  );
  for (const context of seen) {
    assert.equal(context.operation, "httpObservabilityLiveApiProbe");
  }
  assert.ok(
    Math.abs(Date.parse(failed[3].timestamp) - Date.now()) < 60_000,
    "a probe context is created for the probe, not borrowed from startup",
  );
  logger.flushSuppressed();
  await waitFor(
    () =>
      readLines("combined.log").some(
        (line) => line.event === "live_api_probe_recovered",
      ),
    "recovery event",
  );
  const lines = readLines("combined.log");
  assert.equal(
    lines.filter((line) => line.event === "live_api_probe_unavailable").length,
    1,
  );
  assert.equal(
    lines.filter((line) => line.event === "live_api_probe_recovered").length,
    1,
  );
  assert.doesNotMatch(
    readFileSync(path.join(logsDir, "combined.log"), "utf8"),
    /Private Client|plan-5c1d/u,
  );
  console.log(
    "PASS probe: one correlation ID per outage, transitions logged once.",
  );
}

process.exit(0);
