import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import {
  isToolSurfaceProfile,
  type ToolSurfaceProfile,
} from "./catalog.js";
import { withToolSurfaceProfile } from "./runtime.js";

const INSTALL_MARKER = Symbol.for("optimike.tool-surface-v3.http-boundary");
const LEGACY_ENDPOINT_PROFILE: ToolSurfaceProfile = "full";
const PROFILE_SESSION_LIMIT = 4096;
const PROFILE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

type ProfileSession = {
  readonly profile: ToolSurfaceProfile;
  readonly createdAt: number;
  lastSeenAt: number;
};

const sessions = new Map<string, ProfileSession>();

function sweepSessions(now = Date.now()): void {
  for (const [sessionId, session] of sessions) {
    if (now - session.lastSeenAt > PROFILE_SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
  while (sessions.size > PROFILE_SESSION_LIMIT) {
    const first = sessions.keys().next().value as string | undefined;
    if (!first) break;
    sessions.delete(first);
  }
}

function headerValue(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" ? raw : undefined;
}

function profileForPath(pathname: string): ToolSurfaceProfile | undefined {
  if (pathname === "/mcp") return LEGACY_ENDPOINT_PROFILE;
  const match = /^\/mcp\/([^/]+)$/u.exec(pathname);
  if (!match) return undefined;
  return isToolSurfaceProfile(match[1]) ? match[1] : undefined;
}

function isMcpProfileCandidate(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

function rewriteMcpUrl(rawUrl: string): string {
  const url = new URL(rawUrl, "http://127.0.0.1");
  url.pathname = "/mcp";
  return `${url.pathname}${url.search}`;
}

function jsonRpcSessionError(
  response: http.ServerResponse,
  statusCode = 404,
): void {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message: "Invalid or expired session ID.",
    },
    id: null,
  });
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function notFound(response: http.ServerResponse): void {
  const body = "Not Found";
  response.statusCode = 404;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function observeSessionHeader(
  response: http.ServerResponse,
  profile: ToolSurfaceProfile,
): void {
  const remember = (name: string | number | symbol, value: unknown) => {
    if (String(name).toLowerCase() !== "mcp-session-id") return;
    const sessionId = Array.isArray(value) ? value[0] : value;
    if (typeof sessionId !== "string" || !sessionId) return;
    const now = Date.now();
    sessions.set(sessionId, { profile, createdAt: now, lastSeenAt: now });
    sweepSessions(now);
  };

  const originalSetHeader = response.setHeader.bind(response);
  response.setHeader = ((name: string, value: http.OutgoingHttpHeader) => {
    remember(name, value);
    return originalSetHeader(name, value);
  }) as typeof response.setHeader;

  const originalWriteHead = response.writeHead.bind(response);
  response.writeHead = ((...args: Parameters<typeof response.writeHead>) => {
    const headers = args.find(
      (argument) =>
        argument !== null &&
        typeof argument === "object" &&
        !Array.isArray(argument),
    ) as http.OutgoingHttpHeaders | undefined;
    if (headers) {
      for (const [name, value] of Object.entries(headers)) remember(name, value);
    }
    return originalWriteHead(...args);
  }) as typeof response.writeHead;
}

function wrapRequestListener(
  listener: http.RequestListener,
): http.RequestListener {
  return (request, response) => {
    const rawUrl = request.url ?? "/";
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    if (!isMcpProfileCandidate(parsed.pathname)) {
      return listener(request, response);
    }

    const profile = profileForPath(parsed.pathname);
    if (!profile) {
      notFound(response);
      return;
    }

    sweepSessions();
    const sessionId = headerValue(request.headers, "mcp-session-id");
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session && session.profile !== profile) {
        jsonRpcSessionError(response);
        return;
      }
      if (session) session.lastSeenAt = Date.now();
    }

    observeSessionHeader(response, profile);
    const originalUrl = request.url;
    request.url = rewriteMcpUrl(rawUrl);
    request.headers["x-optimike-tool-profile"] = profile;

    response.once("finish", () => {
      request.url = originalUrl;
      if (request.method === "DELETE" && sessionId && response.statusCode < 400) {
        sessions.delete(sessionId);
      }
      if (sessionId && response.statusCode === 404) sessions.delete(sessionId);
    });

    return withToolSurfaceProfile(profile, () => listener(request, response));
  };
}

export function installHttpToolProfileBoundary(): void {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  if (globalRecord[INSTALL_MARKER]) return;
  globalRecord[INSTALL_MARKER] = true;

  const originalCreateServer = http.createServer.bind(http);
  const patchedCreateServer = ((...args: unknown[]) => {
    const nextArgs = [...args];
    let listenerIndex = -1;
    for (let index = nextArgs.length - 1; index >= 0; index -= 1) {
      if (typeof nextArgs[index] === "function") {
        listenerIndex = index;
        break;
      }
    }
    if (listenerIndex >= 0) {
      nextArgs[listenerIndex] = wrapRequestListener(
        nextArgs[listenerIndex] as http.RequestListener,
      );
    }
    return (originalCreateServer as (...serverArgs: unknown[]) => http.Server)(
      ...nextArgs,
    );
  }) as typeof http.createServer;

  (http as unknown as { createServer: typeof http.createServer }).createServer =
    patchedCreateServer;
  syncBuiltinESMExports();
}

export function clearHttpToolProfileSessionsForTest(): void {
  sessions.clear();
}
