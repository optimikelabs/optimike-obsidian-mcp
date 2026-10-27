import type { AxiosRequestConfig } from "axios";
import { classifyErrorClass } from "../../utils/internal/errorClass.js";
import type { ErrorClass } from "../../utils/internal/errorClass.js";

export interface ObsidianRequestLogMetadata {
  method?: string;
  routeClass: string;
  hasBody: boolean;
  status?: number;
  errorClass?: ErrorClass;
}

function routeClass(url: string | undefined): string {
  if (!url || url === "/") return "status";
  let pathname = url;
  try {
    pathname = new URL(url, "http://local.invalid").pathname;
  } catch {
    return "unknown";
  }
  const [first, second, third] = pathname.split("/").filter(Boolean);
  if (first === "extensions" && second && third) {
    // Retain only a finite capability family, never plugin names or any
    // caller-controlled route tail.
    return "extension";
  }
  if (["search", "commands", "active", "vault", "open"].includes(first)) {
    return first;
  }
  return "other";
}

/**
 * Keep request logging deliberately body-free. Note replacement bodies can
 * contain private vault content and must never reach the shared error logger.
 */
export function requestLogMetadata(
  requestConfig: AxiosRequestConfig,
  status?: number,
  failure?: unknown,
): ObsidianRequestLogMetadata {
  // The class is read from the failure's own system code and the HTTP status
  // only, so it says why the upstream call failed (unreachable, timeout, 5xx)
  // without carrying a message, URL or header.
  const errorClass =
    failure === undefined ? undefined : classifyErrorClass(failure, status);
  return {
    method: requestConfig.method,
    routeClass: routeClass(requestConfig.url),
    hasBody: requestConfig.data !== undefined,
    ...(typeof status === "number" ? { status } : {}),
    ...(errorClass ? { errorClass } : {}),
  };
}
