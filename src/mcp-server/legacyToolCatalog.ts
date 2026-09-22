import type { Server } from "@modelcontextprotocol/server";

const installed = new WeakSet<Server>();
/**
 * SDK v1 tool() explicitly published taskSupport: forbidden. SDK v2 removed
 * that convenience API and omits execution by default. Retain the old wire
 * catalogue for legacy clients, without advertising legacy Tasks in 2026.
 * This wraps a public request handler; no private SDK registration state.
 */
export function installLegacyToolCatalog(server: Server): void {
  if (installed.has(server)) return;
  server.assertCanSetRequestHandler("tools/list");
  const register = server.setRequestHandler.bind(server) as (
    ...args: any[]
  ) => any;
  server.setRequestHandler = ((method: string, ...args: any[]) => {
    if (method !== "tools/list") return register(method, ...args);
    const handler = args.at(-1);
    return register(
      method,
      ...args.slice(0, -1),
      async (...parameters: any[]) => {
        const result = await handler(...parameters);
        if (server.getNegotiatedProtocolVersion() === "2026-07-28")
          return result;
        return {
          ...result,
          tools: result.tools.map((tool: Record<string, unknown>) => ({
            ...tool,
            execution: tool.execution ?? { taskSupport: "forbidden" },
          })),
        };
      },
    );
  }) as typeof server.setRequestHandler;
  installed.add(server);
}
