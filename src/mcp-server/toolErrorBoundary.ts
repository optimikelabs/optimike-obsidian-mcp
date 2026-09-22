import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ProtocolError, type McpServer } from "@modelcontextprotocol/server";
import { ErrorHandler, publicMcpToolErrorPayload } from "../utils/index.js";
import { activeHttpRequestId } from "./transports/httpRequestState.js";

// These are request-local provenance flags, never protocol sessions or grants.
const toolInvocation = new AsyncLocalStorage<{ applicationError: boolean }>();
const sdkBoundaries = new WeakSet<McpServer>();
const applicationBoundaries = new WeakSet<McpServer>();

type Callback = (...args: any[]) => any;
type Registrar = (...args: any[]) => any;

function opaqueSdkFailure() {
  const requestId = activeHttpRequestId() ?? randomUUID();
  const handled = ErrorHandler.handleError(
    new Error("MCP SDK tool execution failed."),
    {
      operation: "mcpSdkToolErrorBoundary",
      context: { requestId, toolName: "mcp_sdk" },
      includeStack: false,
    },
  );
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          requestId,
          error: ErrorHandler.formatError(handled),
        }),
      },
    ],
    isError: true,
  };
}

/**
 * Install before any tools. Uses only public SDK registration APIs; no access
 * to createToolError, _registeredTools or _toolHandlersInitialized. The SDK's
 * input/output validation and unknown/disabled-tool failures are untrusted.
 * An application callback's deliberately returned error is distinguished by
 * request-local provenance, retaining governed recovery metadata unchanged.
 */
export function installMcpSdkToolErrorPrivacyBoundary(server: McpServer): void {
  if (sdkBoundaries.has(server)) return;
  if (
    typeof server.server?.assertCanSetRequestHandler !== "function" ||
    typeof server.server?.setRequestHandler !== "function"
  ) {
    throw new Error("Unsupported MCP SDK public request-handler boundary.");
  }
  server.server.assertCanSetRequestHandler("tools/call");
  const register = server.server.setRequestHandler.bind(
    server.server,
  ) as Registrar;
  server.server.setRequestHandler = ((method: string, ...args: any[]) => {
    if (method !== "tools/call") return register(method, ...args);
    const callback = args.at(-1) as Callback;
    if (typeof callback !== "function")
      throw new Error("Invalid MCP tool request-handler boundary.");
    return register(
      method,
      ...args.slice(0, -1),
      async (...callbackArgs: any[]) =>
        toolInvocation.run({ applicationError: false }, async () => {
          try {
            const result = await callback(...callbackArgs);
            if (
              result?.isError === true &&
              !toolInvocation.getStore()?.applicationError
            ) {
              return opaqueSdkFailure();
            }
            return result;
          } catch (error) {
            if (server.server.getNegotiatedProtocolVersion() === "2026-07-28") {
              // Modern unknown/disabled tools are protocol errors, not tool
              // execution errors. Preserve that distinction without echoing the
              // SDK's caller-controlled message or arbitrary data.
              let code = -32603;
              try {
                if (error instanceof ProtocolError && error.code === -32602)
                  code = -32602;
              } catch {
                /* opaque */
              }
              throw new ProtocolError(
                code,
                code === -32602
                  ? "The requested tool is unknown or unavailable."
                  : "The request could not be completed.",
                { requestId: activeHttpRequestId() ?? randomUUID() },
              );
            }
            return opaqueSdkFailure();
          }
        }),
    );
  }) as typeof server.server.setRequestHandler;
  sdkBoundaries.add(server);
}

/** Preserve the established application error envelope before SDK handling. */
export function installMcpToolPublicErrorBoundary(server: McpServer): void {
  if (applicationBoundaries.has(server)) return;
  installMcpSdkToolErrorPrivacyBoundary(server);
  const register = server.registerTool.bind(server) as Registrar;
  server.registerTool = ((
    name: string,
    configuration: unknown,
    callback: Callback,
  ) => {
    if (typeof callback !== "function")
      throw new Error("Invalid MCP tool callback.");
    return register(name, configuration, async (...args: any[]) => {
      let result: any;
      try {
        result = await callback(...args);
      } catch (error) {
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                publicMcpToolErrorPayload(error, {
                  operation: `mcpTool:${name}`,
                  toolName: name,
                  params: args.length > 1 ? args[0] : undefined,
                  requestId: activeHttpRequestId(),
                }),
              ),
            },
          ],
          isError: true,
        };
      }
      const state = toolInvocation.getStore();
      if (state) state.applicationError = result?.isError === true;
      return result;
    });
  }) as typeof server.registerTool;
  applicationBoundaries.add(server);
}
