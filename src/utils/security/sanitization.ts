/**
 * @fileoverview Provides a comprehensive sanitization utility class for various input types,
 * including HTML, strings, URLs, file paths, JSON, and numbers. It also includes
 * functionality for redacting sensitive information from objects for safe logging.
 * @module src/utils/security/sanitization
 */

import path from "path";
import sanitizeHtml from "sanitize-html";
import validator from "validator";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../internal/index.js"; // Use internal index

/**
 * Options for path sanitization, controlling how file paths are cleaned and validated.
 */
export interface PathSanitizeOptions {
  /**
   * If provided, restricts sanitized paths to be relative to this root directory.
   * Attempts to traverse above this root (e.g., using `../`) will result in an error.
   * The final sanitized path will be relative to this `rootDir`.
   */
  rootDir?: string;
  /**
   * If `true`, normalizes Windows-style backslashes (`\\`) to POSIX-style forward slashes (`/`).
   * Defaults to `false`.
   */
  toPosix?: boolean;
  /**
   * If `true`, allows absolute paths, subject to `rootDir` constraints if `rootDir` is also provided.
   * If `false` (default), absolute paths are converted to relative paths by removing leading slashes or drive letters.
   */
  allowAbsolute?: boolean;
}

/**
 * Information returned by the `sanitizePath` method, providing details about
 * the sanitization process and its outcome.
 */
export interface SanitizedPathInfo {
  /** The final sanitized and normalized path string. */
  sanitizedPath: string;
  /** The original path string passed to the function before any normalization or sanitization. */
  originalInput: string;
  /** Indicates if the input path was determined to be absolute after initial `path.normalize()`. */
  wasAbsolute: boolean;
  /**
   * Indicates if an initially absolute path was converted to a relative path
   * (typically because `options.allowAbsolute` was `false`).
   */
  convertedToRelative: boolean;
  /** The effective options (including defaults) that were used for sanitization. */
  optionsUsed: PathSanitizeOptions;
}

/**
 * Options for context-specific string sanitization using `sanitizeString`.
 */
export interface SanitizeStringOptions {
  /**
   * Specifies the context in which the string will be used, guiding the sanitization strategy.
   * - `'text'`: (Default) Strips all HTML tags, suitable for plain text content.
   * - `'html'`: Sanitizes for safe HTML embedding, using `allowedTags` and `allowedAttributes`.
   * - `'attribute'`: Sanitizes for use within an HTML attribute value (strips all tags).
   * - `'url'`: Validates and trims the string as a URL.
   * - `'javascript'`: **Disallowed.** Throws an error to prevent unsafe JavaScript sanitization.
   */
  context?: "text" | "html" | "attribute" | "url" | "javascript";
  /** Custom allowed HTML tags when `context` is `'html'`. Overrides default HTML sanitization tags. */
  allowedTags?: string[];
  /** Custom allowed HTML attributes per tag when `context` is `'html'`. Overrides default HTML sanitization attributes. */
  allowedAttributes?: Record<string, string[]>;
}

/**
 * Configuration options for HTML sanitization using `sanitizeHtml`.
 */
export interface HtmlSanitizeConfig {
  /** An array of allowed HTML tag names (e.g., `['p', 'a', 'strong']`). */
  allowedTags?: string[];
  /**
   * A map specifying allowed attributes for HTML tags.
   * Keys can be tag names (e.g., `'a'`) or `'*'` for global attributes.
   * Values are arrays of allowed attribute names (e.g., `{'a': ['href', 'title']}`).
   */
  allowedAttributes?: sanitizeHtml.IOptions["allowedAttributes"];
  /** If `true`, HTML comments (`<!-- ... -->`) are preserved. Defaults to `false`. */
  preserveComments?: boolean;
  /**
   * Custom rules for transforming tags during sanitization.
   * See `sanitize-html` documentation for `transformTags` options.
   */
  transformTags?: sanitizeHtml.IOptions["transformTags"];
}

/**
 * A singleton utility class for performing various input sanitization tasks.
 * It provides methods to clean and validate strings, HTML, URLs, file paths, JSON,
 * and numbers, and to produce value-free metadata for logging.
 */
export class Sanitization {
  private static instance: Sanitization;

  // Kept for the public configuration API. Logging itself is now value-free, so
  // this list is no longer the primary security boundary.
  private sensitiveFields: string[] = [
    "password",
    "token",
    "secret",
    "key",
    "apikey",
    "auth",
    "credential",
    "jwt",
    "ssn",
    "credit",
    "card",
    "cvv",
    "authorization",
    "passphrase",
    "privatekey",
    "obsidianapikey",
  ];

  private defaultHtmlSanitizeConfig: HtmlSanitizeConfig = {
    allowedTags: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "a",
      "ul",
      "ol",
      "li",
      "b",
      "i",
      "strong",
      "em",
      "strike",
      "code",
      "hr",
      "br",
      "div",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "pre",
      "blockquote", // Added blockquote
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "title"], // Added title for links
      img: ["src", "alt", "title", "width", "height"],
      "*": ["class", "id", "style", "data-*"], // Allow data-* attributes
    },
    preserveComments: false,
  };

  private constructor() {
    // Singleton constructor
  }

  /**
   * Gets the singleton instance of the `Sanitization` class.
   * @returns {Sanitization} The singleton instance.
   */
  public static getInstance(): Sanitization {
    if (!Sanitization.instance) {
      Sanitization.instance = new Sanitization();
    }
    return Sanitization.instance;
  }

  /**
   * Sets or extends the list of field names considered sensitive for log redaction.
   * Field names are matched case-insensitively.
   * @param {string[]} fields - An array of field names to add to the sensitive list.
   * @param {RequestContext} [context] - Optional context for logging this configuration change.
   */
  public setSensitiveFields(fields: string[], context?: RequestContext): void {
    const opContext =
      context ||
      requestContextService.createRequestContext({
        operation: "Sanitization.setSensitiveFields",
      });
    this.sensitiveFields = [
      ...new Set([
        ...this.sensitiveFields,
        ...fields.map((f) => f.toLowerCase()),
      ]),
    ];
    logger.debug("Updated sensitive fields list for log redaction.", {
      ...opContext,
      newCount: this.sensitiveFields.length,
    });
  }

  /**
   * Retrieves a copy of the current list of sensitive field names used for log redaction.
   * @returns {string[]} An array of sensitive field names (all lowercase).
   */
  public getSensitiveFields(): string[] {
    return [...this.sensitiveFields];
  }

  /**
   * Sanitizes an HTML string by removing potentially malicious tags and attributes,
   * based on a configurable allow-list.
   * @param {string} input - The HTML string to sanitize.
   * @param {HtmlSanitizeConfig} [config] - Optional custom configuration for HTML sanitization.
   *   Overrides defaults for `allowedTags`, `allowedAttributes`, etc.
   * @returns {string} The sanitized HTML string. Returns an empty string if input is falsy.
   */
  public sanitizeHtml(input: string, config?: HtmlSanitizeConfig): string {
    if (!input) return "";

    const effectiveConfig = { ...this.defaultHtmlSanitizeConfig, ...config };
    const options: sanitizeHtml.IOptions = {
      allowedTags: effectiveConfig.allowedTags,
      allowedAttributes: effectiveConfig.allowedAttributes,
      transformTags: effectiveConfig.transformTags,
    };

    if (effectiveConfig.preserveComments) {
      // Ensure '!--' is not duplicated if already present
      options.allowedTags = [
        ...new Set([...(options.allowedTags || []), "!--"]),
      ];
    }
    return sanitizeHtml(input, options);
  }

  /**
   * Sanitizes a tag name by removing the leading '#' and replacing invalid characters.
   * @param {string} input - The tag string to sanitize.
   * @returns {string} The sanitized tag name.
   */
  public sanitizeTagName(input: string): string {
    if (!input) return "";
    // Remove leading '#' and replace spaces/invalid characters with nothing
    return input.replace(/^#/, "").replace(/[\s#,\\?%*:|"<>]/g, "");
  }

  /**
   * Sanitizes a string based on its intended usage context (e.g., HTML, URL, plain text).
   *
   * **Security Note:** Using `context: 'javascript'` is explicitly disallowed and will throw an `McpError`.
   * This is to prevent accidental introduction of XSS vulnerabilities through ineffective sanitization
   * of JavaScript code. Proper contextual encoding or safer methods should be used for JavaScript.
   *
   * @param {string} input - The string to sanitize.
   * @param {SanitizeStringOptions} [options={}] - Options specifying the sanitization context
   *   and any context-specific parameters (like `allowedTags` for HTML).
   * @param {RequestContext} [contextForLogging] - Optional context for logging warnings or errors.
   * @returns {string} The sanitized string. Returns an empty string if input is falsy.
   * @throws {McpError} If `options.context` is `'javascript'`.
   */
  public sanitizeString(
    input: string,
    options: SanitizeStringOptions = {},
    contextForLogging?: RequestContext,
  ): string {
    const opContext =
      contextForLogging ||
      requestContextService.createRequestContext({
        operation: "sanitizeString",
        inputContext: options.context,
      });
    if (!input) return "";

    switch (options.context) {
      case "html":
        return this.sanitizeHtml(input, {
          allowedTags: options.allowedTags,
          allowedAttributes: options.allowedAttributes
            ? this.convertAttributesFormat(options.allowedAttributes)
            : undefined,
        });
      case "attribute":
        // For HTML attributes, strip all tags. Values should be further encoded by the templating engine.
        return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} });
      case "url":
        // Validate and trim. Throws McpError on failure.
        try {
          return this.sanitizeUrl(input, ["http", "https"], opContext); // Use sanitizeUrl for consistent validation
        } catch (urlError) {
          logger.warning(
            "Invalid URL detected during string sanitization (context: url).",
            {
              ...opContext,
              inputType: typeof input,
              inputLength: input.length,
              failureCategory: "invalid_url",
            },
          );
          return ""; // Return empty or rethrow, depending on desired strictness. Empty for now.
        }
      case "javascript":
        logger.error(
          "Attempted JavaScript sanitization via sanitizeString, which is disallowed.",
          { ...opContext, inputLength: input.length },
        );
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "JavaScript sanitization is not supported via sanitizeString due to security risks. Use appropriate contextual encoding or safer alternatives.",
          opContext,
        );
      case "text":
      default:
        // Default to stripping all HTML for plain text contexts.
        return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} });
    }
  }

  /**
   * Sanitizes a URL string by validating its format and protocol.
   * @param {string} input - The URL string to sanitize.
   * @param {string[]} [allowedProtocols=['http', 'https']] - An array of allowed URL protocols (e.g., 'http', 'https', 'ftp').
   * @param {RequestContext} [contextForLogging] - Optional context for logging errors.
   * @returns {string} The sanitized and trimmed URL string.
   * @throws {McpError} If the URL is invalid, uses a disallowed protocol, or contains 'javascript:'.
   */
  public sanitizeUrl(
    input: string,
    allowedProtocols: string[] = ["http", "https"],
    contextForLogging?: RequestContext,
  ): string {
    const opContext =
      contextForLogging ||
      requestContextService.createRequestContext({ operation: "sanitizeUrl" });
    try {
      if (!input || typeof input !== "string") {
        throw new Error("Invalid URL input: must be a non-empty string.");
      }
      const trimmedInput = input.trim();
      // Stricter check for 'javascript:' regardless of validator's protocol check
      if (trimmedInput.toLowerCase().startsWith("javascript:")) {
        throw new Error("JavaScript pseudo-protocol is explicitly disallowed.");
      }
      if (
        !validator.isURL(trimmedInput, {
          protocols: allowedProtocols,
          require_protocol: true,
        })
      ) {
        throw new Error(
          `Invalid URL format or protocol not in allowed list: [${allowedProtocols.join(", ")}].`,
        );
      }
      return trimmedInput;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid or disallowed URL.";
      logger.warning(`URL sanitization failed: ${message}`, {
        ...opContext,
        input,
      });
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, message, {
        ...opContext,
        input,
      });
    }
  }

  /**
   * Sanitizes a file path to prevent path traversal attacks and normalize its format.
   *
   * @param {string} input - The file path string to sanitize.
   * @param {PathSanitizeOptions} [options={}] - Options to control sanitization behavior (e.g., `rootDir`, `toPosix`).
   * @param {RequestContext} [contextForLogging] - Optional context for logging warnings or errors.
   * @returns {SanitizedPathInfo} An object containing the sanitized path and metadata about the sanitization.
   * @throws {McpError} If the path is invalid (e.g., empty, contains null bytes) or determined to be unsafe
   *   (e.g., attempts to traverse outside `rootDir` or current working directory if no `rootDir`).
   */
  public sanitizePath(
    input: string,
    options: PathSanitizeOptions = {},
    contextForLogging?: RequestContext,
  ): SanitizedPathInfo {
    const opContext =
      contextForLogging ||
      requestContextService.createRequestContext({ operation: "sanitizePath" });
    const originalInput = input;
    const effectiveOptions: PathSanitizeOptions = {
      toPosix: options.toPosix ?? false,
      allowAbsolute: options.allowAbsolute ?? false,
      rootDir: options.rootDir ? path.resolve(options.rootDir) : undefined, // Resolve rootDir upfront
    };

    let wasAbsoluteInitially = false;
    let convertedToRelative = false;

    try {
      if (!input || typeof input !== "string") {
        throw new Error("Invalid path input: must be a non-empty string.");
      }
      if (input.includes("\0")) {
        throw new Error("Path contains null byte, which is disallowed.");
      }

      let normalized = path.normalize(input); // Normalize first (e.g., 'a/b/../c' -> 'a/c')
      wasAbsoluteInitially = path.isAbsolute(normalized);

      if (effectiveOptions.toPosix) {
        normalized = normalized.replace(/\\/g, "/");
      }

      let finalSanitizedPath: string;

      if (effectiveOptions.rootDir) {
        // Resolve the input path against the root directory.
        // If 'normalized' is absolute, path.resolve treats it as the new root.
        // To correctly join, ensure 'normalized' is treated as relative to 'rootDir' if it's not already escaping.
        let tempPathForResolve = normalized;
        if (path.isAbsolute(normalized) && !effectiveOptions.allowAbsolute) {
          // If absolute paths are not allowed, make it relative before resolving with rootDir
          tempPathForResolve = normalized.replace(/^(?:[A-Za-z]:)?[/\\]+/, "");
          convertedToRelative = true;
        } else if (
          path.isAbsolute(normalized) &&
          effectiveOptions.allowAbsolute
        ) {
          // Absolute path is allowed, check if it's within rootDir
          if (
            !normalized.startsWith(effectiveOptions.rootDir + path.sep) &&
            normalized !== effectiveOptions.rootDir
          ) {
            throw new Error(
              "Absolute path is outside the specified root directory.",
            );
          }
          finalSanitizedPath = path.relative(
            effectiveOptions.rootDir,
            normalized,
          );
          finalSanitizedPath =
            finalSanitizedPath === "" ? "." : finalSanitizedPath; // Handle case where path is rootDir itself
          // Early return if absolute path is allowed and within root.
          return {
            sanitizedPath: finalSanitizedPath,
            originalInput,
            wasAbsolute: wasAbsoluteInitially,
            convertedToRelative,
            optionsUsed: effectiveOptions,
          };
        }
        // If path was relative or made relative, join with rootDir
        const fullPath = path.resolve(
          effectiveOptions.rootDir,
          tempPathForResolve,
        );

        if (
          !fullPath.startsWith(effectiveOptions.rootDir + path.sep) &&
          fullPath !== effectiveOptions.rootDir
        ) {
          throw new Error(
            "Path traversal detected: sanitized path escapes root directory.",
          );
        }
        finalSanitizedPath = path.relative(effectiveOptions.rootDir, fullPath);
        finalSanitizedPath =
          finalSanitizedPath === "" ? "." : finalSanitizedPath;
      } else {
        // No rootDir specified
        if (path.isAbsolute(normalized)) {
          if (effectiveOptions.allowAbsolute) {
            finalSanitizedPath = normalized; // Absolute path allowed
          } else {
            // Convert to relative (strip leading slash/drive)
            finalSanitizedPath = normalized.replace(
              /^(?:[A-Za-z]:)?[/\\]+/,
              "",
            );
            convertedToRelative = true;
          }
        } else {
          // Path is relative, and no rootDir
          // For relative paths without a rootDir, ensure they don't traverse "above" the conceptual CWD.
          // path.resolve('.') gives current working directory.
          const resolvedAgainstCwd = path.resolve(normalized);
          if (!resolvedAgainstCwd.startsWith(path.resolve("."))) {
            // This check is a bit tricky because '..' is valid if it stays within CWD's subtree.
            // A more robust check might involve comparing segments or ensuring it doesn't go "too high".
            // For simplicity, if it resolves outside CWD's prefix, consider it traversal.
            // This might be too strict for some use cases but safer for general utility.
            // A common pattern is to check if path.relative(cwd, resolvedPath) starts with '..'.
            if (
              path
                .relative(path.resolve("."), resolvedAgainstCwd)
                .startsWith("..")
            ) {
              throw new Error(
                "Relative path traversal detected (escapes current working directory context).",
              );
            }
          }
          finalSanitizedPath = normalized;
        }
      }
      return {
        sanitizedPath: finalSanitizedPath,
        originalInput,
        wasAbsolute: wasAbsoluteInitially,
        convertedToRelative,
        optionsUsed: effectiveOptions,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid or unsafe path.";
      logger.warning(`Path sanitization error: ${message}`, {
        ...opContext,
        input: originalInput,
        options: effectiveOptions,
        errorDetails: String(error),
      });
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, message, {
        ...opContext,
        input: originalInput,
      });
    }
  }

  /**
   * Sanitizes a JSON string by parsing it to validate its format.
   * Optionally checks if the JSON string's byte size exceeds a maximum limit.
   *
   * @template T The expected type of the parsed JSON object. Defaults to `unknown`.
   * @param {string} input - The JSON string to sanitize/validate.
   * @param {number} [maxSizeBytes] - Optional maximum allowed size of the JSON string in bytes.
   * @param {RequestContext} [contextForLogging] - Optional context for logging errors.
   * @returns {T} The parsed JavaScript object.
   * @throws {McpError} If the input is not a string, is not valid JSON, or exceeds `maxSizeBytes`.
   */
  public sanitizeJson<T = unknown>(
    input: string,
    maxSizeBytes?: number,
    contextForLogging?: RequestContext,
  ): T {
    const opContext =
      contextForLogging ||
      requestContextService.createRequestContext({ operation: "sanitizeJson" });
    try {
      if (typeof input !== "string") {
        throw new Error("Invalid input: expected a JSON string.");
      }
      if (
        maxSizeBytes !== undefined &&
        Buffer.byteLength(input, "utf8") > maxSizeBytes
      ) {
        throw new McpError( // Throw McpError directly
          BaseErrorCode.VALIDATION_ERROR,
          `JSON content exceeds maximum allowed size of ${maxSizeBytes} bytes. Actual size: ${Buffer.byteLength(input, "utf8")} bytes.`,
          {
            ...opContext,
            size: Buffer.byteLength(input, "utf8"),
            maxSize: maxSizeBytes,
          },
        );
      }
      const parsed = JSON.parse(input);
      // Note: This function only validates JSON structure. It does not sanitize content within the JSON.
      // For deep sanitization of object values, additional logic would be needed.
      return parsed as T;
    } catch (error) {
      if (error instanceof McpError) throw error; // Re-throw if already McpError (e.g., size limit)
      const message = "Invalid JSON format.";
      logger.warning("JSON sanitization failed.", {
        ...opContext,
        inputType: typeof input,
        inputLength: typeof input === "string" ? input.length : undefined,
        failureCategory: error instanceof SyntaxError ? "syntax" : "invalid",
      });
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, message, opContext);
    }
  }

  /**
   * Sanitizes a numeric input (number or string) by converting it to a number
   * and optionally clamping it within a specified min/max range.
   *
   * @param {number | string} input - The numeric value or string representation of a number.
   * @param {number} [min] - Optional minimum allowed value (inclusive).
   * @param {number} [max] - Optional maximum allowed value (inclusive).
   * @param {RequestContext} [contextForLogging] - Optional context for logging clamping or errors.
   * @returns {number} The sanitized (and potentially clamped) number.
   * @throws {McpError} If the input cannot be parsed into a valid, finite number.
   */
  public sanitizeNumber(
    input: number | string,
    min?: number,
    max?: number,
    contextForLogging?: RequestContext,
  ): number {
    const opContext =
      contextForLogging ||
      requestContextService.createRequestContext({
        operation: "sanitizeNumber",
      });
    let value: number;

    if (typeof input === "string") {
      const trimmedInput = input.trim();
      // Validator's isNumeric allows empty strings, so check explicitly.
      if (trimmedInput === "" || !validator.isNumeric(trimmedInput)) {
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "Invalid number format: string is not numeric or is empty.",
          { ...opContext, input },
        );
      }
      value = parseFloat(trimmedInput);
    } else if (typeof input === "number") {
      value = input;
    } else {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "Invalid input type: expected number or string.",
        { ...opContext, input: String(input) },
      );
    }

    if (isNaN(value) || !isFinite(value)) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "Invalid number value (NaN or Infinity).",
        { ...opContext, input },
      );
    }

    let clamped = false;
    let originalValueForLog = value; // Store original before clamping for logging
    if (min !== undefined && value < min) {
      value = min;
      clamped = true;
    }
    if (max !== undefined && value > max) {
      value = max;
      clamped = true;
    }
    if (clamped) {
      logger.debug("Number clamped to range.", {
        ...opContext,
        originalValue: originalValueForLog,
        min,
        max,
        finalValue: value,
      });
    }
    return value;
  }

  /**
   * Produces structural metadata for an input that is safe to put in a log.
   *
   * This is deliberately not a key-name blacklist. MCP mutation payloads can carry
   * note bodies, frontmatter values, Canvas JSON, Base formulas, or a new payload
   * shape that has not been added to a blacklist yet. Logging only the input shape
   * keeps diagnostics useful without retaining any caller supplied value.
   *
   * @param {unknown} input - The object, array, or other value to summarize.
   * @param {RequestContext} [contextForLogging] - Optional context for logging errors during sanitization.
   * @returns {unknown} Value-free input metadata, safe for logging.
   *   Returns `'[Log Sanitization Failed]'` if an unexpected error occurs during sanitization.
   */
  public sanitizeForLogging(
    input: unknown,
    contextForLogging?: RequestContext,
  ): unknown {
    const opContext =
      contextForLogging ||
      requestContextService.createRequestContext({
        operation: "sanitizeForLogging",
      });
    try {
      if (input === null) {
        return { kind: "null", valueRedacted: true };
      }

      if (Array.isArray(input)) {
        return {
          kind: "array",
          length: input.length,
          valueRedacted: true,
        };
      }

      if (typeof input === "object") {
        return {
          kind: "object",
          fieldCount: Object.keys(input).length,
          valueRedacted: true,
        };
      }

      return { kind: typeof input, valueRedacted: true };
    } catch (error) {
      logger.error(
        "Error during log sanitization process.",
        error instanceof Error ? error : undefined,
        {
          ...opContext,
          errorDetails: error instanceof Error ? error.message : String(error),
        },
      );
      return "[Log Sanitization Failed]"; // Fallback string indicating sanitization failure
    }
  }

  /**
   * Helper to convert attribute format for sanitize-html.
   * `sanitize-html` expects `allowedAttributes` in a specific format.
   * This method assumes the input `attrs` (from `SanitizeStringOptions`)
   * is already in the correct format or a compatible one.
   * @param {Record<string, string[]>} attrs - Attributes configuration.
   * @returns {sanitizeHtml.IOptions['allowedAttributes']} Attributes in `sanitize-html` format.
   * @private
   */
  private convertAttributesFormat(
    attrs: Record<string, string[]>,
  ): sanitizeHtml.IOptions["allowedAttributes"] {
    // The type Record<string, string[]> is compatible with sanitizeHtml.IOptions['allowedAttributes']
    // which can be Record<string, Array<string | RegExp>> or boolean.
    // No complex conversion needed if options.allowedAttributes is already Record<string, string[]>.
    return attrs;
  }
}

/**
 * A default, shared instance of the `Sanitization` class.
 * Use this instance for all sanitization tasks.
 *
 * Example:
 * ```typescript
 * import { sanitization, sanitizeInputForLogging } from './sanitization';
 *
 * const unsafeHtml = "<script>alert('xss')</script><p>Safe</p>";
 * const safeHtml = sanitization.sanitizeHtml(unsafeHtml);
 *
 * const request = { content: '# private note', mode: 'overwrite' };
 * const safeLogData = sanitizeInputForLogging(request);
 * // safeLogData will be { kind: 'object', fieldCount: 2, valueRedacted: true }
 * ```
 */
export const sanitization = Sanitization.getInstance();

/**
 * A convenience function that wraps `sanitization.sanitizeForLogging`.
 * Converts arbitrary caller input into value-free metadata for logging.
 *
 * @param {unknown} input - The data to sanitize for logging.
 * @param {RequestContext} [contextForLogging] - Optional context for logging errors during sanitization.
 * @returns {unknown} Value-free input metadata, safe for logging.
 */
export const sanitizeInputForLogging = (
  input: unknown,
  contextForLogging?: RequestContext,
): unknown => sanitization.sanitizeForLogging(input, contextForLogging);
