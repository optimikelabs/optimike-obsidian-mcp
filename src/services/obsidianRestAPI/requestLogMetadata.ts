import type { AxiosRequestConfig } from "axios";

export interface ObsidianRequestLogMetadata {
  method?: string;
  url?: string;
  hasBody: boolean;
}

/**
 * Keep request logging deliberately body-free. Note replacement bodies can
 * contain private vault content and must never reach the shared error logger.
 */
export function requestLogMetadata(
  requestConfig: AxiosRequestConfig,
): ObsidianRequestLogMetadata {
  return {
    method: requestConfig.method,
    url: requestConfig.url,
    hasBody: requestConfig.data !== undefined,
  };
}
