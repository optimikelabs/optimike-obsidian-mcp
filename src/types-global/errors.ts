import { z } from "zod/v3";

/**
 * Defines a set of standardized error codes for common issues within MCP servers or tools.
 * These codes help clients understand the nature of an error programmatically.
 */
export enum BaseErrorCode {
  /** Access denied due to invalid credentials or lack of authentication. */
  UNAUTHORIZED = "UNAUTHORIZED",
  /** Access denied despite valid authentication, due to insufficient permissions. */
  FORBIDDEN = "FORBIDDEN",
  /** The requested resource or entity could not be found. */
  NOT_FOUND = "NOT_FOUND",
  /** The request could not be completed due to a conflict with the current state of the resource. */
  CONFLICT = "CONFLICT",
  /** The request failed due to invalid input parameters or data. */
  VALIDATION_ERROR = "VALIDATION_ERROR",
  /** An error occurred while parsing input data (e.g., date string, JSON). */
  PARSING_ERROR = "PARSING_ERROR",
  /** The request was rejected because the client has exceeded rate limits. */
  RATE_LIMITED = "RATE_LIMITED",
  /** The request timed out before a response could be generated. */
  TIMEOUT = "TIMEOUT",
  /** The service is temporarily unavailable, possibly due to maintenance or overload. */
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
  /** An unexpected error occurred on the server side. */
  INTERNAL_ERROR = "INTERNAL_ERROR",
  /** An error occurred, but the specific cause is unknown or cannot be categorized. */
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
  /** An error occurred during the loading or validation of configuration data. */
  CONFIGURATION_ERROR = "CONFIGURATION_ERROR",
}

/**
 * Custom error class for MCP-specific errors.
 * Encapsulates a `BaseErrorCode`, a descriptive message, and optional details.
 * Provides a method to format the error into a standard MCP tool response.
 */
export class McpError extends Error {
  /**
   * Creates an instance of McpError.
   * @param {BaseErrorCode} code - The standardized error code.
   * @param {string} message - A human-readable description of the error.
   * @param {Record<string, unknown>} [details] - Optional additional details about the error.
   */
  constructor(
    public code: BaseErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    // Set the error name for identification
    this.name = "McpError";
    // Ensure the prototype chain is correct
    Object.setPrototypeOf(this, McpError.prototype);
  }

  // Removed toResponse() method. The SDK should handle formatting errors into JSON-RPC responses.
}

/**
 * Zod schema for validating error objects, potentially used for parsing
 * error responses or validating error structures internally.
 */
export const ErrorSchema = z
  .object({
    /** The error code, corresponding to BaseErrorCode enum values. */
    code: z.nativeEnum(BaseErrorCode).describe("Standardized error code"),
    /** A human-readable description of the error. */
    message: z.string().describe("Detailed error message"),
    /** Optional additional details or context about the error. */
    details: z
      .record(z.unknown())
      .optional()
      .describe("Optional structured error details"),
  })
  .describe("Schema for validating structured error objects.");

/**
 * TypeScript type inferred from `ErrorSchema`.
 * Represents a validated error object structure.
 * @typedef {z.infer<typeof ErrorSchema>} ErrorResponse
 */
export type ErrorResponse = z.infer<typeof ErrorSchema>;
