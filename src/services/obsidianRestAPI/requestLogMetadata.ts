import type { AxiosRequestConfig } from "axios";

export interface ObsidianRequestLogMetadata {
  method?: string;
  routeClass: string;
  hasBody: boolean;
  status?: number;
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
): ObsidianRequestLogMetadata {
  return {
    method: requestConfig.method,
    routeClass: routeClass(requestConfig.url),
    hasBody: requestConfig.data !== undefined,
    ...(typeof status === "number" ? { status } : {}),
  };
}
