/**
 * @fileoverview Closed classification of a failure for operator-facing logs.
 * The class names where a failure happened (an upstream hop, the disk, the
 * journal database) without carrying any message, path, header or payload.
 * @module src/utils/internal/errorClass
 */

export const ERROR_CLASSES = [
  "upstream_unreachable",
  "upstream_timeout",
  "upstream_reset",
  "upstream_tls",
  "upstream_http_4xx",
  "upstream_http_5xx",
  "request_setup",
  "disk_full",
  "filesystem_permission",
  "filesystem_missing",
  "resource_exhausted",
  "database_busy",
  "database_error",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

const CLASS_BY_SYSTEM_CODE: Readonly<Record<string, ErrorClass>> = {
  ECONNREFUSED: "upstream_unreachable",
  EHOSTUNREACH: "upstream_unreachable",
  ENETUNREACH: "upstream_unreachable",
  ENOTFOUND: "upstream_unreachable",
  EAI_AGAIN: "upstream_unreachable",
  ETIMEDOUT: "upstream_timeout",
  ESOCKETTIMEDOUT: "upstream_timeout",
  ECONNABORTED: "upstream_timeout",
  ECONNRESET: "upstream_reset",
  EPIPE: "upstream_reset",
  ERR_STREAM_PREMATURE_CLOSE: "upstream_reset",
  ENOSPC: "disk_full",
  EACCES: "filesystem_permission",
  EPERM: "filesystem_permission",
  ENOENT: "filesystem_missing",
  EMFILE: "resource_exhausted",
  ENFILE: "resource_exhausted",
  EBUSY: "resource_exhausted",
  SQLITE_BUSY: "database_busy",
  SQLITE_LOCKED: "database_busy",
};

function readCode(error: unknown): string | undefined {
  if (
    (typeof error !== "object" && typeof error !== "function") ||
    error === null
  )
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function classFromCode(code: string | undefined): ErrorClass | undefined {
  if (!code) return undefined;
  if (Object.hasOwn(CLASS_BY_SYSTEM_CODE, code))
    return CLASS_BY_SYSTEM_CODE[code];
  if (
    code.startsWith("CERT_") ||
    code.startsWith("ERR_TLS_") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  )
    return "upstream_tls";
  if (code.startsWith("SQLITE_") || code === "ERR_SQLITE_ERROR")
    return "database_error";
  return undefined;
}

/**
 * Classifies a failure from its own `code` data property (never a message), the
 * `code` of its `cause`, and an optional upstream HTTP status. Accessors and
 * Proxy traps are never invoked. Returns `undefined` when nothing is known.
 */
export function classifyErrorClass(
  error: unknown,
  httpStatus?: number,
): ErrorClass | undefined {
  const fromCode =
    classFromCode(readCode(error)) ?? classFromCode(readCode(readCause(error)));
  if (fromCode) return fromCode;
  if (typeof httpStatus === "number" && Number.isInteger(httpStatus)) {
    if (httpStatus >= 500 && httpStatus <= 599) return "upstream_http_5xx";
    if (httpStatus >= 400 && httpStatus <= 499) return "upstream_http_4xx";
  }
  return undefined;
}

function readCause(error: unknown): unknown {
  if (
    (typeof error !== "object" && typeof error !== "function") ||
    error === null
  )
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "cause");
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
