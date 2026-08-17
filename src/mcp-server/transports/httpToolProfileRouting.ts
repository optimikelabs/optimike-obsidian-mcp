import {
  TOOL_PROFILE_IDS,
  parseToolProfileId,
  type ToolProfileId,
} from "../toolProfiles.js";

export const INTERNAL_TOOL_PROFILE_HEADER =
  "x-optimike-internal-tool-profile" as const;

export function toolProfileForMcpPath(
  pathname: string,
): ToolProfileId | undefined {
  if (pathname === "/mcp") return "full";
  if (!pathname.startsWith("/mcp/")) return undefined;

  const suffix = pathname.slice("/mcp/".length);
  if (!suffix || suffix.includes("/")) {
    throw new Error("Invalid MCP tool profile path.");
  }
  return parseToolProfileId(decodeURIComponent(suffix));
}

/**
 * Public profile endpoints are rewritten internally to the existing /mcp Hono
 * route. The internal profile header is always overwritten from the path, so a
 * caller cannot inject or switch profile through a custom header.
 */
export function rewriteProfiledMcpRequest(request: Request): Request | Response {
  const url = new URL(request.url);
  let profile: ToolProfileId | undefined;
  try {
    profile = toolProfileForMcpPath(url.pathname);
  } catch {
    return new Response(
      JSON.stringify({
        error: "unknown_tool_profile",
        message: `MCP profile must be one of: ${TOOL_PROFILE_IDS.join(", ")}.`,
      }),
      {
        status: 404,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }

  if (!profile) return request;

  const headers = new Headers(request.headers);
  headers.set(INTERNAL_TOOL_PROFILE_HEADER, profile);
  url.pathname = "/mcp";
  return new Request(url, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    duplex: request.body ? "half" : undefined,
    signal: request.signal,
  } as RequestInit & { duplex?: "half" });
}

export function toolProfileFromInternalRequest(request: Request): ToolProfileId {
  return parseToolProfileId(
    request.headers.get(INTERNAL_TOOL_PROFILE_HEADER) ?? "full",
  );
}
