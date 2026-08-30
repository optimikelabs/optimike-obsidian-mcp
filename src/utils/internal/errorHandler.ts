/**
 * @fileoverview This module provides utilities for robust error handling.
 * It defines structures for error context, options for handling errors,
 * and mappings for classifying errors. The main `ErrorHandler` class
 * offers static methods for consistent error processing, logging, and transformation.
 * @module src/utils/internal/errorHandler
 */
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { generateUUID, sanitizeInputForLogging } from "../index.js"; // Import from main barrel file
import { logger } from "./logger.js";
import {
  activeRequestCorrelationId,
  RequestContext,
} from "./requestContext.js"; // Import RequestContext

/**
 * Defines a generic structure for providing context with errors.
 * This context can include identifiers like `requestId` or any other relevant
 * key-value pairs that aid in debugging or understanding the error's circumstances.
 */
export interface ErrorContext {
  /**
   * A unique identifier for the request or operation during which the error occurred.
   * Useful for tracing errors through logs and distributed systems.
   */
  requestId?: string;

  /**
   * Allows for arbitrary additional context information.
   * Keys are strings, and values can be of any type.
   */
  [key: string]: unknown;
}

/**
 * Configuration options for the `ErrorHandler.handleError` method.
 * These options control how an error is processed, logged, and whether it's rethrown.
 */
export interface ErrorHandlerOptions {
  /**
   * The context of the operation that caused the error.
   * This can include `requestId` and other relevant debugging information.
   */
  context?: ErrorContext;

  /**
   * A descriptive name of the operation being performed when the error occurred.
   * This helps in identifying the source or nature of the error in logs.
   * Example: "UserLogin", "ProcessPayment", "FetchUserProfile".
   */
  operation: string;

  /**
   * The input data or parameters that were being processed when the error occurred.
   * This input will be sanitized before logging to prevent sensitive data exposure.
   */
  input?: unknown;

  /**
   * If true, the (potentially transformed) error will be rethrown after handling.
   * Defaults to `false`.
   */
  rethrow?: boolean;

  /**
   * A specific `BaseErrorCode` to assign to the error, overriding any
   * automatically determined error code.
   */
  errorCode?: BaseErrorCode;

  /**
   * A custom function to map or transform the original error into a new `Error` instance.
   * If provided, this function is used instead of the default `McpError` creation.
   * @param error - The original error that occurred.
   * @returns The transformed error.
   */
  errorMapper?: (error: unknown) => Error;

  /**
   * If true, stack traces will be included in the logs.
   * Defaults to `false`.
   */
  includeStack?: boolean;

  /**
   * If true, indicates that the error is critical and might require immediate attention
   * or could lead to system instability. This is primarily for logging and alerting.
   * Defaults to `false`.
   */
  critical?: boolean;
}

/**
 * Defines a basic rule for mapping errors based on patterns.
 * Used internally by `COMMON_ERROR_PATTERNS` and as a base for `ErrorMapping`.
 */
export interface BaseErrorMapping {
  /**
   * A string or regular expression to match against the error message.
   * If a string is provided, it's typically used for substring matching (case-insensitive).
   */
  pattern: string | RegExp;

  /**
   * The `BaseErrorCode` to assign if the pattern matches.
   */
  errorCode: BaseErrorCode;

  /**
   * An optional custom message template for the mapped error.
   * (Note: This property is defined but not directly used by `ErrorHandler.determineErrorCode`
   * which focuses on `errorCode`. It's more relevant for custom mapping logic.)
   */
  messageTemplate?: string;
}

/**
 * Extends `BaseErrorMapping` to include a factory function for creating
 * specific error instances and additional context for the mapping.
 * Used by `ErrorHandler.mapError`.
 * @template T The type of `Error` this mapping will produce, defaults to `Error`.
 */
export interface ErrorMapping<T extends Error = Error>
  extends BaseErrorMapping {
  /**
   * A factory function that creates and returns an instance of the mapped error type `T`.
   * @param error - The original error that occurred.
   * @param context - Optional additional context provided in the mapping rule.
   * @returns The newly created error instance.
   */
  factory: (error: unknown, context?: Record<string, unknown>) => T;

  /**
   * Additional static context to be merged or passed to the `factory` function
   * when this mapping rule is applied.
   */
  additionalContext?: Record<string, unknown>;
}

/**
 * Maps standard JavaScript error constructor names to `BaseErrorCode` values.
 * @private
 */
const ERROR_TYPE_MAPPINGS: Readonly<Record<string, BaseErrorCode>> = {
  SyntaxError: BaseErrorCode.VALIDATION_ERROR,
  TypeError: BaseErrorCode.VALIDATION_ERROR,
  ReferenceError: BaseErrorCode.INTERNAL_ERROR,
  RangeError: BaseErrorCode.VALIDATION_ERROR,
  URIError: BaseErrorCode.VALIDATION_ERROR,
  EvalError: BaseErrorCode.INTERNAL_ERROR,
};

/**
 * Array of `BaseErrorMapping` rules to classify errors by message/name patterns.
 * Order matters: more specific patterns should precede generic ones.
 * @private
 */
const COMMON_ERROR_PATTERNS: ReadonlyArray<Readonly<BaseErrorMapping>> = [
  {
    pattern:
      /auth|unauthorized|unauthenticated|not.*logged.*in|invalid.*token|expired.*token/i,
    errorCode: BaseErrorCode.UNAUTHORIZED,
  },
  {
    pattern: /permission|forbidden|access.*denied|not.*allowed/i,
    errorCode: BaseErrorCode.FORBIDDEN,
  },
  {
    pattern: /not found|missing|no such|doesn't exist|couldn't find/i,
    errorCode: BaseErrorCode.NOT_FOUND,
  },
  {
    pattern:
      /invalid|validation|malformed|bad request|wrong format|missing required/i,
    errorCode: BaseErrorCode.VALIDATION_ERROR,
  },
  {
    pattern: /conflict|already exists|duplicate|unique constraint/i,
    errorCode: BaseErrorCode.CONFLICT,
  },
  {
    pattern: /rate limit|too many requests|throttled/i,
    errorCode: BaseErrorCode.RATE_LIMITED,
  },
  {
    pattern: /timeout|timed out|deadline exceeded/i,
    errorCode: BaseErrorCode.TIMEOUT,
  },
  {
    pattern: /service unavailable|bad gateway|gateway timeout|upstream error/i,
    errorCode: BaseErrorCode.SERVICE_UNAVAILABLE,
  },
];

const SAFE_CONTEXT_FIELDS = new Set([
  "requestId",
  "timestamp",
  "operation",
  "toolName",
  "module",
  "transport",
  "writeMode",
  "profile",
]);

const SAFE_ERROR_DETAIL_FIELDS = new Set([
  "requestId",
  "operationId",
  "planRef",
  "recoveryRef",
  "reasonCode",
  "retryable",
  "recoveryAllowed",
  "applyAllowed",
  "mutationMayHaveApplied",
  "httpStatus",
  "planDigest",
  "phase",
  "outcome",
]);

const SAFE_PUBLIC_REASON_CODES = new Set([
  "REVISION_CONFLICT",
  "OPERON_BRIDGE_REQUEST_INVALID",
  "OPERON_BRIDGE_UNAUTHORIZED",
  "OPERON_BRIDGE_FORBIDDEN",
  "OPERON_BRIDGE_RESOURCE_NOT_FOUND",
  "OPERON_BRIDGE_CONFLICT",
  "OPERON_BRIDGE_RATE_LIMITED",
  "OPERON_BRIDGE_UNAVAILABLE",
  "OPERON_BRIDGE_REQUEST_FAILED",
  "EXTERNAL_ROOT_CONFIGURATION_INVALID",
  "EXTERNAL_ROOT_ROOT_UNKNOWN",
  "EXTERNAL_ROOT_ROOT_UNAVAILABLE",
  "EXTERNAL_ROOT_CAPABILITY_DENIED",
  "EXTERNAL_ROOT_PATH_INVALID",
  "EXTERNAL_ROOT_PATH_OUTSIDE_ROOT",
  "EXTERNAL_ROOT_PATH_NOT_ALLOWED",
  "EXTERNAL_ROOT_PATH_LINK_UNSUPPORTED",
  "EXTERNAL_ROOT_NOT_FOUND",
  "EXTERNAL_ROOT_NOT_A_FILE",
  "EXTERNAL_ROOT_NOT_A_DIRECTORY",
  "EXTERNAL_ROOT_TARGET_EXISTS",
  "EXTERNAL_ROOT_PRECONDITION_FAILED",
  "EXTERNAL_ROOT_TOO_LARGE",
  "EXTERNAL_ROOT_UNSUPPORTED",
  "EXTERNAL_ROOT_ENCRYPTED",
  "EXTERNAL_ROOT_INACCESSIBLE",
  "EXTERNAL_ROOT_NON_VERIFIABLE",
  "EXTERNAL_ROOT_TIMEOUT",
]);

const SAFE_OPERATION_PHASES = new Set([
  "planned",
  "applying",
  "recovering",
  "terminal",
]);

const SAFE_OPERATION_OUTCOMES = new Set([
  "committed",
  "compensated",
  "conflict",
  "rejected",
  "failed",
  "outcome_unknown",
]);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPERON_FALLBACK_OPERATION_ID = /^operon-\d{13}-[0-9a-f]+$/u;
const GOVERNED_PLAN_REFERENCE =
  /^(?:obsidian-note-replace|obsidian-frontmatter-patch|obsidian-base-formula-patch|obsidian-canvas-patch|external-move):v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPERON_RECOVERY_REFERENCE = /^dvr1_[0-9a-f]{48}$/u;

const SAFE_TRANSPORTS = new Set(["stdio", "http", "sse", "streamable-http"]);
const SAFE_WRITE_MODES = new Set(["readonly", "guarded", "full"]);
const SAFE_PROFILES = new Set([
  "minimal",
  "standard",
  "authoring",
  "tasks",
  "full",
]);

/**
 * Error values may be arbitrary Proxies. Both `instanceof` and property reads
 * can execute traps, so this public boundary treats a failed probe as an
 * opaque internal failure rather than letting a second exception escape.
 */
function safelyInstanceOf(value: unknown, constructor: Function): boolean {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}

function isMcpError(value: unknown): value is McpError {
  return safelyInstanceOf(value, McpError);
}

function isNativeError(value: unknown): value is Error {
  return safelyInstanceOf(value, Error);
}

function readOwnDataProperty(value: unknown, field: string): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isBaseErrorCode(value: unknown): value is BaseErrorCode {
  return (
    typeof value === "string" &&
    (Object.values(BaseErrorCode) as string[]).includes(value)
  );
}

function safeMcpErrorCode(error: unknown): BaseErrorCode | undefined {
  if (!isMcpError(error)) return undefined;
  const code = readOwnDataProperty(error, "code");
  return isBaseErrorCode(code) ? code : undefined;
}

function safeMcpErrorDetails(
  error: unknown,
): Record<string, unknown> | undefined {
  if (!isMcpError(error)) return undefined;
  const details = readOwnDataProperty(error, "details");
  return details && typeof details === "object"
    ? (details as Record<string, unknown>)
    : undefined;
}

function isSafeDiagnosticString(field: string, value: string): boolean {
  if (field === "requestId") return UUID.test(value);
  if (field === "timestamp") {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value);
  }
  if (field === "transport") {
    return SAFE_TRANSPORTS.has(value);
  }
  if (field === "writeMode") {
    return SAFE_WRITE_MODES.has(value);
  }
  if (field === "profile") {
    return SAFE_PROFILES.has(value);
  }
  if (field === "planDigest") return /^[a-f0-9]{64}$/u.test(value);
  if (field === "reasonCode") return SAFE_PUBLIC_REASON_CODES.has(value);
  if (field === "operationId") {
    return UUID.test(value) || OPERON_FALLBACK_OPERATION_ID.test(value);
  }
  if (field === "planRef") return GOVERNED_PLAN_REFERENCE.test(value);
  if (field === "recoveryRef") {
    return (
      GOVERNED_PLAN_REFERENCE.test(value) ||
      OPERON_RECOVERY_REFERENCE.test(value)
    );
  }
  if (field === "phase") return SAFE_OPERATION_PHASES.has(value);
  if (field === "outcome") return SAFE_OPERATION_OUTCOMES.has(value);
  return false;
}

function isSafeDiagnosticValue(
  field: string,
  value: unknown,
): value is string | number | boolean {
  if (typeof value === "string") return isSafeDiagnosticString(field, value);
  if (typeof value === "boolean") {
    return new Set([
      "retryable",
      "recoveryAllowed",
      "applyAllowed",
      "mutationMayHaveApplied",
    ]).has(field);
  }
  if (typeof value === "number") {
    return (
      field === "httpStatus" &&
      Number.isInteger(value) &&
      value >= 100 &&
      value <= 599
    );
  }
  return false;
}

function safeDiagnosticFields(
  source: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  callerStrings?: CallerStringCollection,
): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const field of allowedFields) {
    // Read only own data descriptors. Accessors and Proxy traps are caller
    // controlled at this boundary, so evaluating them would turn diagnostics
    // into a new source of failure or data disclosure.
    let value: unknown;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(source, field);
      if (!descriptor || !("value" in descriptor)) continue;
      value = descriptor.value;
    } catch {
      continue;
    }
    if (!isSafeDiagnosticValue(field, value)) continue;
    if (
      typeof value === "string" &&
      callerStrings &&
      isCallerDerivedString(value, callerStrings)
    ) {
      continue;
    }
    safe[field] = value;
  }
  return safe;
}

function publicErrorMessage(code: BaseErrorCode): string {
  switch (code) {
    case BaseErrorCode.UNAUTHORIZED:
      return "Authentication is required for this request.";
    case BaseErrorCode.FORBIDDEN:
      return "This request is not authorized.";
    case BaseErrorCode.NOT_FOUND:
      return "The requested resource was not found.";
    case BaseErrorCode.CONFLICT:
      return "The request conflicts with the current resource state.";
    case BaseErrorCode.VALIDATION_ERROR:
    case BaseErrorCode.PARSING_ERROR:
      return "The request could not be validated.";
    case BaseErrorCode.RATE_LIMITED:
      return "The request is rate limited. Retry later.";
    case BaseErrorCode.TIMEOUT:
      return "The request timed out. Its final state may require verification.";
    case BaseErrorCode.SERVICE_UNAVAILABLE:
      return "The service is temporarily unavailable. Retry later.";
    case BaseErrorCode.CONFIGURATION_ERROR:
      return "The service configuration is invalid.";
    case BaseErrorCode.UNKNOWN_ERROR:
    case BaseErrorCode.INTERNAL_ERROR:
    default:
      return "The request could not be completed. Use the request id to inspect server diagnostics.";
  }
}

interface CallerStringCollection {
  strings: Set<string>;
  incomplete: boolean;
}

const MAX_CALLER_STRING_DEPTH = 8;
const MAX_CALLER_STRING_NODES = 512;
const MAX_CALLER_STRINGS = 256;
const MAX_CALLER_STRING_LENGTH = 4096;

function addCallerString(
  value: string,
  collection: CallerStringCollection,
): void {
  if (
    value.length > MAX_CALLER_STRING_LENGTH ||
    collection.strings.size >= MAX_CALLER_STRINGS
  ) {
    collection.incomplete = true;
    return;
  }
  if (value.length > 0) collection.strings.add(value);
}

function collectCallerStrings(
  value: unknown,
  collection: CallerStringCollection,
  seen = new WeakSet<object>(),
  depth = 0,
  state = { nodes: 0 },
): void {
  if (typeof value === "string") {
    addCallerString(value, collection);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  if (
    depth >= MAX_CALLER_STRING_DEPTH ||
    state.nodes >= MAX_CALLER_STRING_NODES
  ) {
    collection.incomplete = true;
    return;
  }
  seen.add(value);
  state.nodes += 1;
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    // Enumeration can execute Proxy traps. If it is not observable safely, do
    // not permit any caller-derived strings through the allowlist later.
    collection.incomplete = true;
    return;
  }
  for (const key of keys) {
    addCallerString(key, collection);
    if (collection.incomplete) return;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      collection.incomplete = true;
      return;
    }
    if (!descriptor || !("value" in descriptor)) {
      collection.incomplete = true;
      return;
    }
    collectCallerStrings(descriptor.value, collection, seen, depth + 1, state);
    if (collection.incomplete) return;
  }
}

function isCallerDerivedString(
  value: string,
  callerStrings: CallerStringCollection,
): boolean {
  if (callerStrings.incomplete) return true;
  for (const callerValue of callerStrings.strings) {
    if (value === callerValue) return true;
    // Long caller values can be reflected inside a structured reference. Short
    // field names (for example `id`) are too collision-prone to use as
    // substring redactors once the destination value has passed a strict
    // generated-reference or finite-catalog validator.
    if (callerValue.length >= 12 && value.includes(callerValue)) return true;
  }
  return false;
}

type ErrorCategory =
  | "mcp"
  | "syntax"
  | "type"
  | "reference"
  | "range"
  | "uri"
  | "eval"
  | "error"
  | "non_error";

function errorCategory(error: unknown): ErrorCategory {
  if (isMcpError(error)) return "mcp";
  if (safelyInstanceOf(error, SyntaxError)) return "syntax";
  if (safelyInstanceOf(error, TypeError)) return "type";
  if (safelyInstanceOf(error, ReferenceError)) return "reference";
  if (safelyInstanceOf(error, RangeError)) return "range";
  if (safelyInstanceOf(error, URIError)) return "uri";
  if (safelyInstanceOf(error, EvalError)) return "eval";
  if (isNativeError(error)) return "error";
  return "non_error";
}

/**
 * Creates a "safe" RegExp for testing error messages.
 * Ensures case-insensitivity and removes the global flag.
 * @param pattern - The string or RegExp pattern.
 * @returns A new RegExp instance.
 * @private
 */
function createSafeRegex(pattern: string | RegExp): RegExp {
  if (safelyInstanceOf(pattern, RegExp)) {
    try {
      const flagsGetter = Object.getOwnPropertyDescriptor(
        RegExp.prototype,
        "flags",
      )?.get;
      const sourceGetter = Object.getOwnPropertyDescriptor(
        RegExp.prototype,
        "source",
      )?.get;
      const source = sourceGetter?.call(pattern);
      let flags = flagsGetter?.call(pattern)?.replace("g", "");
      if (typeof source !== "string" || typeof flags !== "string") {
        return /$a/u;
      }
      if (!flags.includes("i")) {
        flags += "i";
      }
      return new RegExp(source, flags);
    } catch {
      return /$a/u;
    }
  }
  return new RegExp(typeof pattern === "string" ? pattern : "", "i");
}

/**
 * Retrieves a descriptive name for an error object or value.
 * @param error - The error object or value.
 * @returns A string representing the error's name or type.
 * @private
 */
function getErrorName(error: unknown): string {
  if (isMcpError(error)) return "McpError";
  if (safelyInstanceOf(error, SyntaxError)) return "SyntaxError";
  if (safelyInstanceOf(error, TypeError)) return "TypeError";
  if (safelyInstanceOf(error, ReferenceError)) return "ReferenceError";
  if (safelyInstanceOf(error, RangeError)) return "RangeError";
  if (safelyInstanceOf(error, URIError)) return "URIError";
  if (safelyInstanceOf(error, EvalError)) return "EvalError";
  if (isNativeError(error)) return "Error";
  if (error === null) {
    return "NullValueEncountered";
  }
  if (error === undefined) {
    return "UndefinedValueEncountered";
  }
  return typeof error === "object" ? "ObjectEncountered" : "UnknownError";
}

/**
 * Extracts a message string from an error object or value.
 * @param error - The error object or value.
 * @returns The error message string.
 * @private
 */
function getErrorMessage(error: unknown): string {
  if (isNativeError(error)) {
    const message = readOwnDataProperty(error, "message");
    return typeof message === "string" ? message : "Error encountered";
  }
  if (error === null) {
    return "Null value encountered as error";
  }
  if (error === undefined) {
    return "Undefined value encountered as error";
  }
  // Never coerce arbitrary thrown values. Proxy `toString`, `toJSON`, name,
  // constructor and message hooks are all executable caller-controlled code.
  return typeof error === "string" ? error : "Non-Error value encountered";
}

/**
 * A utility class providing static methods for comprehensive error handling.
 */
export class ErrorHandler {
  /**
   * Determines an appropriate `BaseErrorCode` for a given error.
   * Checks `McpError` instances, `ERROR_TYPE_MAPPINGS`, and `COMMON_ERROR_PATTERNS`.
   * Defaults to `BaseErrorCode.INTERNAL_ERROR`.
   * @param error - The error instance or value to classify.
   * @returns The determined error code.
   */
  public static determineErrorCode(error: unknown): BaseErrorCode {
    const mcpCode = safeMcpErrorCode(error);
    if (mcpCode) return mcpCode;

    const errorName = getErrorName(error);
    const errorMessage = getErrorMessage(error);

    if (errorName in ERROR_TYPE_MAPPINGS) {
      return ERROR_TYPE_MAPPINGS[errorName as keyof typeof ERROR_TYPE_MAPPINGS];
    }

    for (const mapping of COMMON_ERROR_PATTERNS) {
      const regex = createSafeRegex(mapping.pattern);
      if (regex.test(errorMessage) || regex.test(errorName)) {
        return mapping.errorCode;
      }
    }
    return BaseErrorCode.INTERNAL_ERROR;
  }

  /**
   * Handles an error with consistent logging and optional transformation.
   * Sanitizes input, determines error code, logs details, and can rethrow.
   * @param error - The error instance or value that occurred.
   * @param options - Configuration for handling the error.
   * @returns The handled (and potentially transformed) error instance.
   */
  public static handleError(
    error: unknown,
    options: ErrorHandlerOptions,
  ): Error {
    const {
      context = {},
      operation,
      input,
      rethrow = false,
      errorCode: explicitErrorCode,
      includeStack = false,
      critical = false,
      errorMapper,
    } = options;

    const initialErrorCode =
      safeMcpErrorCode(error) ||
      explicitErrorCode ||
      ErrorHandler.determineErrorCode(error);
    const callerStrings: CallerStringCollection = {
      strings: new Set<string>(),
      incomplete: false,
    };
    collectCallerStrings(input, callerStrings);
    let sanitizedInput: unknown;
    try {
      sanitizedInput =
        input !== undefined ? sanitizeInputForLogging(input) : undefined;
    } catch {
      // A hostile caller payload must not prevent the public error boundary
      // from returning its correlation id.
      sanitizedInput = { kind: "uninspectable", valueRedacted: true };
    }
    const contextMetadata = safeDiagnosticFields(
      context,
      SAFE_CONTEXT_FIELDS,
      callerStrings,
    );
    const originalDetails = safeMcpErrorDetails(error);
    const errorDetailsMetadata = originalDetails
      ? safeDiagnosticFields(
          originalDetails,
          SAFE_ERROR_DETAIL_FIELDS,
          callerStrings,
        )
      : {};
    const originalErrorCategory = errorCategory(error);
    // Mappers receive the original error so their existing classification contract
    // stays intact. Their result is treated strictly as an untrusted hint and is
    // canonicalized below before it can cross the public boundary.
    let loggedErrorCode = initialErrorCode;
    let mappedDetailsMetadata: Record<string, string | number | boolean> = {};
    if (errorMapper) {
      try {
        const mapped = errorMapper(error);
        const mappedMcpCode = safeMcpErrorCode(mapped);
        if (mappedMcpCode) {
          loggedErrorCode = mappedMcpCode;
          const mappedDetails = safeMcpErrorDetails(mapped);
          mappedDetailsMetadata = mappedDetails
            ? safeDiagnosticFields(
                mappedDetails,
                SAFE_ERROR_DETAIL_FIELDS,
                callerStrings,
              )
            : {};
        } else if (isNativeError(mapped)) {
          loggedErrorCode = ErrorHandler.determineErrorCode(mapped);
        }
      } catch {
        // A diagnostics mapper is never allowed to replace the original failure.
      }
    }

    const logRequestId =
      typeof contextMetadata.requestId === "string"
        ? contextMetadata.requestId
        : generateUUID(); // Generate if not provided in context

    const logTimestamp =
      typeof contextMetadata.timestamp === "string"
        ? contextMetadata.timestamp
        : new Date().toISOString(); // Generate if not provided

    const finalError = new McpError(
      loggedErrorCode,
      publicErrorMessage(loggedErrorCode),
      {
        ...contextMetadata,
        ...errorDetailsMetadata,
        ...mappedDetailsMetadata,
        // Always expose the same safe UUID used by the log entry so clients
        // can correlate a failure without receiving backend diagnostics.
        requestId: logRequestId,
      },
    );

    // Prepare log payload, ensuring RequestContext properties are at the top level for logger
    const logPayload: Record<string, unknown> = {
      requestId: logRequestId,
      timestamp: logTimestamp,
      operation,
      input: sanitizedInput,
      critical,
      errorCode: loggedErrorCode,
      // Never log Error.name directly: userland errors can assign it arbitrary
      // caller-derived text. The category is a closed, stable taxonomy.
      originalErrorType: originalErrorCategory,
      finalErrorType: "mcp",
      // Context is allowlisted because some handlers place raw params in it.
      ...Object.fromEntries(
        Object.entries(contextMetadata).filter(
          ([key]) => key !== "requestId" && key !== "timestamp",
        ),
      ),
    };

    logPayload.errorDetails = finalError.details;

    if (includeStack) logPayload.stackAvailable = true;

    // Log using the logger, casting logPayload to RequestContext for compatibility
    // The logger's `error` method expects a RequestContext as its second or third argument.
    logger.error(
      `Error in ${operation}: ${finalError.message}`,
      logPayload as RequestContext,
    );

    if (rethrow) {
      throw finalError;
    }
    return finalError;
  }

  /**
   * Maps an error to a specific error type `T` based on `ErrorMapping` rules.
   * Returns original/default error if no mapping matches.
   * @template T The target error type, extending `Error`.
   * @param error - The error instance or value to map.
   * @param mappings - An array of mapping rules to apply.
   * @param defaultFactory - Optional factory for a default error if no mapping matches.
   * @returns The mapped error of type `T`, or the original/defaulted error.
   */
  public static mapError<T extends Error>(
    error: unknown,
    mappings: ReadonlyArray<ErrorMapping<T>>,
    defaultFactory?: (error: unknown, context?: Record<string, unknown>) => T,
  ): T | Error {
    const errorMessage = getErrorMessage(error);
    const errorName = getErrorName(error);

    for (const mapping of mappings) {
      const regex = createSafeRegex(mapping.pattern);
      if (regex.test(errorMessage) || regex.test(errorName)) {
        return mapping.factory(error, mapping.additionalContext);
      }
    }

    if (defaultFactory) {
      return defaultFactory(error);
    }
    // Ensure a proper Error object is returned
    return isNativeError(error)
      ? error
      : new Error("Unhandled non-Error value");
  }

  /**
   * Formats an error into a consistent object structure for API responses or structured logging.
   * @param error - The error instance or value to format.
   * @returns A structured representation of the error.
   */
  public static formatError(error: unknown): Record<string, unknown> {
    const mcpCode = safeMcpErrorCode(error);
    if (mcpCode) {
      const details = safeMcpErrorDetails(error);
      return {
        code: mcpCode,
        message: publicErrorMessage(mcpCode),
        details: details
          ? safeDiagnosticFields(details, SAFE_ERROR_DETAIL_FIELDS)
          : {},
      };
    }

    if (isNativeError(error)) {
      const code = ErrorHandler.determineErrorCode(error);
      return {
        code,
        message: publicErrorMessage(code),
        details: { errorCategory: errorCategory(error) },
      };
    }

    // Handle non-Error types
    return {
      code: BaseErrorCode.UNKNOWN_ERROR,
      message: publicErrorMessage(BaseErrorCode.UNKNOWN_ERROR),
      details: { errorCategory: errorCategory(error) },
    };
  }

  /**
   * Safely executes a function (sync or async) and handles errors using `ErrorHandler.handleError`.
   * The error is always rethrown by default by `handleError` when `rethrow` is true.
   * @template T The expected return type of the function `fn`.
   * @param fn - The function to execute.
   * @param options - Error handling options (excluding `rethrow`, as it's forced to true).
   * @returns A promise resolving with the result of `fn` if successful.
   * @throws {McpError | Error} The error processed by `ErrorHandler.handleError`.
   * @example
   * ```typescript
   * async function fetchData(userId: string, context: RequestContext) {
   *   return ErrorHandler.tryCatch(
   *     async () => {
   *       const response = await fetch(`/api/users/${userId}`);
   *       if (!response.ok) throw new Error(`Failed to fetch user: ${response.status}`);
   *       return response.json();
   *     },
   *     { operation: 'fetchUserData', context, input: { userId } } // rethrow is implicitly true
   *   );
   * }
   * ```
   */
  public static async tryCatch<T>(
    fn: () => Promise<T> | T,
    options: Omit<ErrorHandlerOptions, "rethrow">, // Omit rethrow from options type
  ): Promise<T> {
    try {
      // Await the promise if fn returns one, otherwise resolve directly.
      const result = fn();
      return await Promise.resolve(result);
    } catch (error) {
      // ErrorHandler.handleError will return the error to be thrown.
      // rethrow is true by default when calling handleError this way.
      throw ErrorHandler.handleError(error, { ...options, rethrow: true });
    }
  }
}

/**
 * The shared MCP-tool failure boundary. Tools pass their validated parameters
 * here exactly once: diagnostics retain only safe structural metadata while the
 * client receives a stable code/message/details envelope with no stack or raw
 * request payload.
 */
export function publicMcpToolErrorPayload(
  error: unknown,
  options: {
    operation: string;
    toolName: string;
    params: unknown;
    /** Server-owned HTTP correlation UUID, when this tool callback originated
     * from Streamable HTTP. */
    requestId?: string;
  },
): Record<string, unknown> {
  const requestId = options.requestId ?? activeRequestCorrelationId();
  const handled = ErrorHandler.handleError(error, {
    operation: options.operation,
    input: options.params,
    context: {
      toolName: options.toolName,
      ...(requestId ? { requestId } : {}),
    },
    includeStack: false,
  });
  const mcpError = isMcpError(handled)
    ? handled
    : new McpError(
        BaseErrorCode.INTERNAL_ERROR,
        publicErrorMessage(BaseErrorCode.INTERNAL_ERROR),
        {},
      );
  const code = safeMcpErrorCode(mcpError) ?? BaseErrorCode.INTERNAL_ERROR;
  const details = safeMcpErrorDetails(mcpError) ?? {};
  const publicDetails = safeDiagnosticFields(details, SAFE_ERROR_DETAIL_FIELDS);
  return {
    ok: false,
    requestId:
      typeof publicDetails.requestId === "string"
        ? publicDetails.requestId
        : undefined,
    error: {
      code,
      message: publicErrorMessage(code),
      details: publicDetails,
    },
  };
}
