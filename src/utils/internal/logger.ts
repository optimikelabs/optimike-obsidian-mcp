/**
 * @fileoverview Provides a singleton Logger class that wraps Winston for file logging
 * and supports sending MCP (Model Context Protocol) `notifications/message`.
 * It handles different log levels compliant with RFC 5424 and MCP specifications.
 * @module src/utils/internal/logger
 */
import { createHmac, randomBytes } from "node:crypto";
import path from "path";
import winston from "winston";
import TransportStream from "winston-transport";
import { config } from "../../config/index.js";
import { RequestContext } from "./requestContext.js";

/**
 * Defines the supported logging levels based on RFC 5424 Syslog severity levels,
 * as used by the Model Context Protocol (MCP).
 * Levels are: 'debug'(7), 'info'(6), 'notice'(5), 'warning'(4), 'error'(3), 'crit'(2), 'alert'(1), 'emerg'(0).
 * Lower numeric values indicate higher severity.
 */
export type McpLogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "crit"
  | "alert"
  | "emerg";

/**
 * Numeric severity mapping for MCP log levels (lower is more severe).
 * @private
 */
const mcpLevelSeverity: Record<McpLogLevel, number> = {
  emerg: 0,
  alert: 1,
  crit: 2,
  error: 3,
  warning: 4,
  notice: 5,
  info: 6,
  debug: 7,
};

/**
 * Maps MCP log levels to Winston's core levels for file logging.
 * @private
 */
const mcpToWinstonLevel: Record<
  McpLogLevel,
  "debug" | "info" | "warn" | "error"
> = {
  debug: "debug",
  info: "info",
  notice: "info",
  warning: "warn",
  error: "error",
  crit: "error",
  alert: "error",
  emerg: "error",
};

/**
 * Interface for the payload of an MCP log notification.
 * This structure is used when sending log data via MCP `notifications/message`.
 */
export interface McpLogPayload {
  message: string;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Type for the `data` parameter of the `McpNotificationSender` function.
 */
export type McpNotificationData = McpLogPayload | Record<string, unknown>;

/**
 * Defines the signature for a function that can send MCP log notifications.
 * This function is typically provided by the MCP server instance.
 * @param level - The severity level of the log message.
 * @param data - The payload of the log notification.
 * @param loggerName - An optional name or identifier for the logger/server.
 */
export type McpNotificationSender = (
  level: McpLogLevel,
  data: McpNotificationData,
  loggerName?: string,
) => void;

// The logsPath from config is already resolved and validated by src/config/index.ts
const resolvedLogsDir = config.logsPath;
const isLogsDirSafe = !!resolvedLogsDir; // If logsPath is set, it's considered safe by config logic.

/**
 * Per-process secret used to correlate repeated log templates without retaining
 * the template itself. A plain hash would make short paths, task titles and
 * other low-entropy caller data reversible through dictionary attacks.
 */
const logEventHmacKey = randomBytes(32);

const SAFE_LOG_CONTEXT_FIELDS = new Set([
  "requestId",
  "correlationId",
  "incidentId",
  "timestamp",
  "operation",
  "toolName",
  "module",
  "transport",
  "writeMode",
  "profile",
  "errorCode",
  "originalErrorType",
  "finalErrorType",
  "critical",
  "status",
  "httpStatus",
  "durationMs",
  "elapsedMs",
  "attempt",
  "retryCount",
  "count",
  "resultCount",
  "total",
  "limit",
  "offset",
  "phase",
  "outcome",
  "reasonCode",
  "retryable",
  "recoveryAllowed",
  "applyAllowed",
  "mutationMayHaveApplied",
  "method",
  "routeClass",
  "hasBody",
  "inputLength",
  "inputType",
  "failureCategory",
  "event",
  "signal",
  "pluginVersion",
  "appVersion",
  "serverName",
  "runtimeMode",
  "configured",
  "available",
  "enabled",
  "ready",
  "cacheEnabled",
  "source",
  "concurrency",
  "batchCount",
  "contentLength",
  "fieldCount",
  "length",
  "valueRedacted",
  "kind",
  "loggerSetup",
  "originalLevel",
  "stackAvailable",
]);

const SAFE_NESTED_LOG_FIELDS = new Set([
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
  "kind",
  "fieldCount",
  "length",
  "valueRedacted",
]);

const SAFE_LOG_ENUM_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  errorCode: new Set([
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "VALIDATION_ERROR",
    "PARSING_ERROR",
    "RATE_LIMITED",
    "TIMEOUT",
    "SERVICE_UNAVAILABLE",
    "INTERNAL_ERROR",
    "UNKNOWN_ERROR",
    "CONFIGURATION_ERROR",
  ]),
  transport: new Set(["stdio", "http", "sse", "streamable-http"]),
  writeMode: new Set(["readonly", "guarded", "full"]),
  profile: new Set(["minimal", "standard", "authoring", "tasks", "full"]),
  originalErrorType: new Set([
    "mcp",
    "syntax",
    "type",
    "reference",
    "range",
    "uri",
    "eval",
    "error",
    "non_error",
  ]),
  finalErrorType: new Set(["mcp"]),
  method: new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
  runtimeMode: new Set(["live", "headless", "hybrid"]),
  kind: new Set([
    "null",
    "array",
    "object",
    "string",
    "number",
    "boolean",
    "bigint",
    "symbol",
    "function",
    "undefined",
  ]),
  originalLevel: new Set(Object.keys(mcpLevelSeverity)),
  signal: new Set(["SIGINT", "SIGTERM", "SIGHUP"]),
  phase: new Set([
    "planned",
    "applying",
    "recovering",
    "committed",
    "conflict",
    "rejected",
    "failed",
    "outcome_unknown",
    "rolled_back",
  ]),
  outcome: new Set([
    "planned",
    "committed",
    "conflict",
    "rejected",
    "failed",
    "outcome_unknown",
    "rolled_back",
  ]),
};

function safeLogString(field: string, value: string): string | undefined {
  if (field === "timestamp") {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
      ? value
      : undefined;
  }
  if (field === "requestId") {
    return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|logger-[a-z0-9-]{1,64})$/iu.test(
      value,
    )
      ? value
      : undefined;
  }
  if (field === "planDigest") {
    return /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
  }
  if (field === "pluginVersion" || field === "appVersion") {
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)
      ? value
      : undefined;
  }
  return SAFE_LOG_ENUM_VALUES[field]?.has(value) ? value : undefined;
}

function fingerprintLogValue(value: string): string {
  return createHmac("sha256", logEventHmacKey)
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Reads only an own data property.  In particular, do not invoke getters from
 * caller/backend objects: both accessors and Proxy traps are untrusted input.
 */
function readOwnDataProperty(value: unknown, field: string): unknown {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  )
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

const SAFE_BOOLEAN_LOG_FIELDS = new Set([
  "critical",
  "retryable",
  "recoveryAllowed",
  "applyAllowed",
  "mutationMayHaveApplied",
  "hasBody",
  "configured",
  "available",
  "enabled",
  "ready",
  "cacheEnabled",
  "valueRedacted",
  "loggerSetup",
  "stackAvailable",
]);

const SAFE_COUNT_LOG_FIELDS = new Set([
  "attempt",
  "retryCount",
  "count",
  "resultCount",
  "total",
  "limit",
  "offset",
  "batchCount",
  "fieldCount",
  "length",
]);

const SAFE_LENGTH_LOG_FIELDS = new Set(["inputLength", "contentLength"]);
const MAX_SAFE_LOG_COUNT = 1_000_000;
const MAX_SAFE_LOG_LENGTH = 10 * 1024 * 1024;
const MAX_SAFE_LOG_DURATION_MS = 24 * 60 * 60 * 1000;

function isSafeLogNumber(field: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (field === "httpStatus" || field === "status") {
    return Number.isInteger(value) && value >= 100 && value <= 599;
  }
  if (field === "durationMs" || field === "elapsedMs") {
    return value >= 0 && value <= MAX_SAFE_LOG_DURATION_MS;
  }
  if (SAFE_COUNT_LOG_FIELDS.has(field)) {
    return Number.isInteger(value) && value >= 0 && value <= MAX_SAFE_LOG_COUNT;
  }
  if (SAFE_LENGTH_LOG_FIELDS.has(field)) {
    return (
      Number.isInteger(value) && value >= 0 && value <= MAX_SAFE_LOG_LENGTH
    );
  }
  return false;
}

/**
 * `instanceof` may invoke a Proxy's getPrototypeOf trap. Error values cross
 * the public boundary, so classification must never let that trap escape.
 */
function safelyInstanceOf(value: unknown, constructor: Function): boolean {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}

function isErrorValue(value: unknown): value is Error {
  return safelyInstanceOf(value, Error);
}

function isObjectRecord(value: unknown): value is object {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function appendSafeLogPrimitive(
  target: Record<string, unknown>,
  field: string,
  value: unknown,
): void {
  if (typeof value === "string") {
    const safe = safeLogString(field, value);
    if (safe !== undefined) target[field] = safe;
    else if (value.length > 0)
      target[`${field}Fingerprint`] = fingerprintLogValue(value);
    return;
  }
  if (typeof value === "number") {
    if (isSafeLogNumber(field, value)) target[field] = value;
    return;
  }
  if (typeof value === "boolean" && SAFE_BOOLEAN_LOG_FIELDS.has(field)) {
    target[field] = value;
  }
}

function sanitizeNestedLogMetadata(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  if (!isObjectRecord(value)) return undefined;
  const safe: Record<string, unknown> = {};
  for (const field of SAFE_NESTED_LOG_FIELDS) {
    appendSafeLogPrimitive(safe, field, readOwnDataProperty(value, field));
  }
  return Object.keys(safe).length > 0
    ? (safe as Record<string, string | number | boolean>)
    : undefined;
}

function sanitizeLogContext(context?: RequestContext): Record<string, unknown> {
  if (!context) return {};
  const safe: Record<string, unknown> = {};
  for (const field of SAFE_LOG_CONTEXT_FIELDS) {
    appendSafeLogPrimitive(safe, field, readOwnDataProperty(context, field));
  }
  for (const field of ["input", "errorDetails"] as const) {
    const nested = sanitizeNestedLogMetadata(
      readOwnDataProperty(context, field),
    );
    if (nested) safe[field] = nested;
  }
  return safe;
}

function logErrorCategory(error: unknown): string {
  if (safelyInstanceOf(error, SyntaxError)) return "syntax";
  if (safelyInstanceOf(error, TypeError)) return "type";
  if (safelyInstanceOf(error, ReferenceError)) return "reference";
  if (safelyInstanceOf(error, RangeError)) return "range";
  if (safelyInstanceOf(error, URIError)) return "uri";
  if (safelyInstanceOf(error, EvalError)) return "eval";
  if (isErrorValue(error)) return "error";
  return "non_error";
}

function hasReadableErrorStack(error: unknown): boolean {
  try {
    return Boolean(readOwnDataProperty(error, "stack"));
  } catch {
    return false;
  }
}

function fingerprintLogEvent(message: string): string {
  return fingerprintLogValue(message);
}

/**
 * Creates the Winston console log format.
 * @returns The Winston log format for console output.
 * @private
 */
function createWinstonConsoleFormat(): winston.Logform.Format {
  return winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let metaString = "";
      const metaCopy = { ...meta };
      if (Object.keys(metaCopy).length > 0) {
        try {
          const replacer = (_key: string, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value;
          const remainingMetaJson = JSON.stringify(metaCopy, replacer, 2);
          if (remainingMetaJson !== "{}")
            metaString += `\n  Meta: ${remainingMetaJson}`;
        } catch (stringifyError: unknown) {
          metaString += "\n  Meta: [Metadata serialization failed]";
        }
      }
      return `${timestamp} ${level}: ${message}${metaString}`;
    }),
  );
}

/**
 * Singleton Logger class that wraps Winston for robust logging.
 * Supports file logging, conditional console logging, and MCP notifications.
 */
export class Logger {
  private static instance: Logger;
  private winstonLogger?: winston.Logger;
  private initialized = false;
  private mcpNotificationSender?: McpNotificationSender;
  private currentMcpLevel: McpLogLevel = "info";
  private currentWinstonLevel: "debug" | "info" | "warn" | "error" = "info";

  private readonly LOG_FILE_MAX_SIZE = 5 * 1024 * 1024; // 5MB
  private readonly LOG_MAX_FILES = 5;

  /** @private */
  private constructor() {}

  /**
   * Initializes the Winston logger instance.
   * Should be called once at application startup.
   * @param level - The initial minimum MCP log level.
   */
  public async initialize(level: McpLogLevel = "info"): Promise<void> {
    if (this.initialized) {
      this.warning("Logger already initialized.", {
        loggerSetup: true,
        requestId: "logger-init",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Set initialized to true at the beginning of the initialization process.
    this.initialized = true;

    this.currentMcpLevel = level;
    this.currentWinstonLevel = mcpToWinstonLevel[level];

    // The logs directory (config.logsPath / resolvedLogsDir) is expected to be created and validated
    // by the configuration module (src/config/index.ts) before logger initialization.
    // If isLogsDirSafe is true, we assume resolvedLogsDir exists and is usable.
    // No redundant directory creation logic here.

    const fileFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    );

    const transports: TransportStream[] = [];
    const fileTransportOptions = {
      format: fileFormat,
      maxsize: this.LOG_FILE_MAX_SIZE,
      maxFiles: this.LOG_MAX_FILES,
      tailable: true,
    };

    if (isLogsDirSafe) {
      transports.push(
        new winston.transports.File({
          filename: path.join(resolvedLogsDir, "error.log"),
          level: "error",
          ...fileTransportOptions,
        }),
        new winston.transports.File({
          filename: path.join(resolvedLogsDir, "warn.log"),
          level: "warn",
          ...fileTransportOptions,
        }),
        new winston.transports.File({
          filename: path.join(resolvedLogsDir, "info.log"),
          level: "info",
          ...fileTransportOptions,
        }),
        new winston.transports.File({
          filename: path.join(resolvedLogsDir, "debug.log"),
          level: "debug",
          ...fileTransportOptions,
        }),
        new winston.transports.File({
          filename: path.join(resolvedLogsDir, "combined.log"),
          ...fileTransportOptions,
        }),
      );
    } else {
      if (process.stdout.isTTY) {
        console.warn(
          "File logging disabled as logsPath is not configured or invalid.",
        );
      }
    }

    this.winstonLogger = winston.createLogger({
      level: this.currentWinstonLevel,
      transports,
      exitOnError: false,
    });

    // Configure console transport after Winston logger is created
    const consoleStatus = this._configureConsoleTransport();

    const initialContext: RequestContext = {
      loggerSetup: true,
      requestId: "logger-init-deferred",
      timestamp: new Date().toISOString(),
    };
    // Removed logging of logsDirCreatedMessage as it's no longer set
    if (consoleStatus.message) {
      this.info(consoleStatus.message, initialContext);
    }

    this.initialized = true; // Ensure this is set after successful setup
    this.info(
      `Logger initialized. File logging level: ${this.currentWinstonLevel}. MCP logging level: ${this.currentMcpLevel}. Console logging: ${consoleStatus.enabled ? "enabled" : "disabled"}`,
      {
        loggerSetup: true,
        requestId: "logger-post-init",
        timestamp: new Date().toISOString(),
        logsPathUsed: resolvedLogsDir,
      },
    );
  }

  /**
   * Sets the function used to send MCP 'notifications/message'.
   * @param sender - The function to call for sending notifications, or undefined to disable.
   */
  public setMcpNotificationSender(
    sender: McpNotificationSender | undefined,
  ): void {
    this.mcpNotificationSender = sender;
    const status = sender ? "enabled" : "disabled";
    this.info(`MCP notification sending ${status}.`, {
      loggerSetup: true,
      requestId: "logger-set-sender",
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Dynamically sets the minimum logging level.
   * @param newLevel - The new minimum MCP log level to set.
   */
  public setLevel(newLevel: McpLogLevel): void {
    const setLevelContext: RequestContext = {
      loggerSetup: true,
      requestId: "logger-set-level",
      timestamp: new Date().toISOString(),
    };
    if (!this.ensureInitialized()) {
      if (process.stdout.isTTY) {
        console.error("Cannot set level: Logger not initialized.");
      }
      return;
    }
    if (!(newLevel in mcpLevelSeverity)) {
      this.warning(
        `Invalid MCP log level provided: ${newLevel}. Level not changed.`,
        setLevelContext,
      );
      return;
    }

    const oldLevel = this.currentMcpLevel;
    this.currentMcpLevel = newLevel;
    this.currentWinstonLevel = mcpToWinstonLevel[newLevel];
    if (this.winstonLogger) {
      // Ensure winstonLogger is defined
      this.winstonLogger.level = this.currentWinstonLevel;
    }

    const consoleStatus = this._configureConsoleTransport();

    if (oldLevel !== newLevel) {
      this.info(
        `Log level changed. File logging level: ${this.currentWinstonLevel}. MCP logging level: ${this.currentMcpLevel}. Console logging: ${consoleStatus.enabled ? "enabled" : "disabled"}`,
        setLevelContext,
      );
      if (
        consoleStatus.message &&
        consoleStatus.message !== "Console logging status unchanged."
      ) {
        this.info(consoleStatus.message, setLevelContext);
      }
    }
  }

  /**
   * Configures the console transport based on the current log level and TTY status.
   * Adds or removes the console transport as needed.
   * @returns {{ enabled: boolean, message: string | null }} Status of console logging.
   * @private
   */
  private _configureConsoleTransport(): {
    enabled: boolean;
    message: string | null;
  } {
    if (!this.winstonLogger) {
      return {
        enabled: false,
        message: "Cannot configure console: Winston logger not initialized.",
      };
    }

    const consoleTransport = this.winstonLogger.transports.find(
      (t) => t instanceof winston.transports.Console,
    );
    const shouldHaveConsole =
      this.currentMcpLevel === "debug" && process.stdout.isTTY;
    let message: string | null = null;

    if (shouldHaveConsole && !consoleTransport) {
      const consoleFormat = createWinstonConsoleFormat();
      this.winstonLogger.add(
        new winston.transports.Console({
          level: "debug", // Console always logs debug if enabled
          format: consoleFormat,
        }),
      );
      message = "Console logging enabled (level: debug, stdout is TTY).";
    } else if (!shouldHaveConsole && consoleTransport) {
      this.winstonLogger.remove(consoleTransport);
      message = "Console logging disabled (level not debug or stdout not TTY).";
    } else {
      message = "Console logging status unchanged.";
    }
    return { enabled: shouldHaveConsole, message };
  }

  /**
   * Gets the singleton instance of the Logger.
   * @returns The singleton Logger instance.
   */
  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Ensures the logger has been initialized.
   * @returns True if initialized, false otherwise.
   * @private
   */
  private ensureInitialized(): boolean {
    if (!this.initialized || !this.winstonLogger) {
      if (process.stdout.isTTY) {
        console.warn("Logger not initialized; message dropped.");
      }
      return false;
    }
    return true;
  }

  /**
   * Centralized log processing method.
   * @param level - The MCP severity level of the message.
   * @param msg - The main log message.
   * @param context - Optional request context for the log.
   * @param error - Optional error object associated with the log.
   * @private
   */
  private log(
    level: McpLogLevel,
    msg: string,
    context?: RequestContext,
    error?: Error,
  ): void {
    if (!this.ensureInitialized()) return;
    if (mcpLevelSeverity[level] > mcpLevelSeverity[this.currentMcpLevel]) {
      return; // Do not log if message level is less severe than currentMcpLevel
    }

    // Runtime callers can bypass TypeScript. Never coerce an exotic message;
    // only a primitive string is eligible for fingerprinting/length metadata.
    const safeMessage = typeof msg === "string" ? msg : undefined;
    const logData: Record<string, unknown> = {
      ...sanitizeLogContext(context),
    };
    if (safeMessage !== undefined) {
      logData.eventFingerprint = fingerprintLogEvent(safeMessage);
      logData.messageLength = safeMessage.length;
    }
    if (error) {
      logData.errorCategory = logErrorCategory(error);
      logData.stackAvailable = hasReadableErrorStack(error);
    }
    const winstonLevel = mcpToWinstonLevel[level];
    const publicMessage = `Runtime ${level} event.`;

    try {
      this.winstonLogger!.log(winstonLevel, publicMessage, logData);
    } catch {
      // Logging is observability only. A transport failure must never turn a
      // handled backend error into an uncaught exception.
      return;
    }

    if (this.mcpNotificationSender) {
      const mcpDataPayload: McpLogPayload = {
        message: publicMessage,
        context: logData,
      };
      try {
        const serverName =
          config?.mcpServerName ?? "MCP_SERVER_NAME_NOT_CONFIGURED";
        this.mcpNotificationSender(level, mcpDataPayload, serverName);
      } catch (sendError: unknown) {
        const requestIdCandidate = readOwnDataProperty(context, "requestId");
        const internalErrorContext: RequestContext = {
          requestId:
            typeof requestIdCandidate === "string"
              ? requestIdCandidate
              : "logger-internal-error",
          timestamp: new Date().toISOString(),
          originalLevel: level,
          failureCategory: logErrorCategory(sendError),
        };
        try {
          this.winstonLogger!.error(
            "Runtime logging notification failed.",
            sanitizeLogContext(internalErrorContext),
          );
        } catch {
          // The fallback transport is best effort too.
        }
      }
    }
  }

  /** Logs a message at the 'debug' level. */
  public debug(msg: string, context?: RequestContext): void {
    this.log("debug", msg, context);
  }

  /** Logs a message at the 'info' level. */
  public info(msg: string, context?: RequestContext): void {
    this.log("info", msg, context);
  }

  /** Logs a message at the 'notice' level. */
  public notice(msg: string, context?: RequestContext): void {
    this.log("notice", msg, context);
  }

  /** Logs a message at the 'warning' level. */
  public warning(msg: string, context?: RequestContext): void {
    this.log("warning", msg, context);
  }

  /**
   * Logs a message at the 'error' level.
   * @param msg - The main log message.
   * @param err - Optional. Error object or RequestContext.
   * @param context - Optional. RequestContext if `err` is an Error.
   */
  public error(
    msg: string,
    err?: Error | RequestContext,
    context?: RequestContext,
  ): void {
    const errorObj = isErrorValue(err) ? err : undefined;
    const actualContext = isErrorValue(err) ? context : err;
    this.log("error", msg, actualContext, errorObj);
  }

  /**
   * Logs a message at the 'crit' (critical) level.
   * @param msg - The main log message.
   * @param err - Optional. Error object or RequestContext.
   * @param context - Optional. RequestContext if `err` is an Error.
   */
  public crit(
    msg: string,
    err?: Error | RequestContext,
    context?: RequestContext,
  ): void {
    const errorObj = isErrorValue(err) ? err : undefined;
    const actualContext = isErrorValue(err) ? context : err;
    this.log("crit", msg, actualContext, errorObj);
  }

  /**
   * Logs a message at the 'alert' level.
   * @param msg - The main log message.
   * @param err - Optional. Error object or RequestContext.
   * @param context - Optional. RequestContext if `err` is an Error.
   */
  public alert(
    msg: string,
    err?: Error | RequestContext,
    context?: RequestContext,
  ): void {
    const errorObj = isErrorValue(err) ? err : undefined;
    const actualContext = isErrorValue(err) ? context : err;
    this.log("alert", msg, actualContext, errorObj);
  }

  /**
   * Logs a message at the 'emerg' (emergency) level.
   * @param msg - The main log message.
   * @param err - Optional. Error object or RequestContext.
   * @param context - Optional. RequestContext if `err` is an Error.
   */
  public emerg(
    msg: string,
    err?: Error | RequestContext,
    context?: RequestContext,
  ): void {
    const errorObj = isErrorValue(err) ? err : undefined;
    const actualContext = isErrorValue(err) ? context : err;
    this.log("emerg", msg, actualContext, errorObj);
  }

  /**
   * Logs a message at the 'emerg' (emergency) level, typically for fatal errors.
   * @param msg - The main log message.
   * @param err - Optional. Error object or RequestContext.
   * @param context - Optional. RequestContext if `err` is an Error.
   */
  public fatal(
    msg: string,
    err?: Error | RequestContext,
    context?: RequestContext,
  ): void {
    const errorObj = isErrorValue(err) ? err : undefined;
    const actualContext = isErrorValue(err) ? context : err;
    this.log("emerg", msg, actualContext, errorObj);
  }
}

/**
 * The singleton instance of the Logger.
 * Use this instance for all logging operations.
 */
export const logger = Logger.getInstance();
