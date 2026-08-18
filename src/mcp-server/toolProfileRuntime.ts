import type {
  McpServer,
  RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { currentToolProfileContext } from "./toolProfileContext.js";
import {
  parseToolProfileId,
  selectAvailableToolProfileNames,
  type ToolProfileId,
} from "./toolProfiles.js";

export function resolveToolProfile(raw?: string): ToolProfileId {
  const selected =
    raw?.trim() ||
    currentToolProfileContext() ||
    process.env.MCP_TOOL_PROFILE?.trim() ||
    "full";
  return parseToolProfileId(selected);
}

/**
 * Installs a registration-time exposure gate on one McpServer instance.
 *
 * The SDK's public RegisteredTool handles are authoritative: disabling a tool
 * removes it from tools/list and rejects direct callTool invocation. We keep
 * every registered handle, recompute the selected profile from the concrete
 * names currently present, and reconcile enabled state after each registration.
 * This makes canonical/direct fallback resolution independent of registration
 * order while preserving `full` as the unfiltered 2.x compatibility surface.
 *
 * HTTP session creation may provide a request-scoped profile through
 * AsyncLocalStorage; stdio falls back to CLI/env selection.
 */
export function installToolProfileRegistrationGate(
  server: McpServer,
  profile: ToolProfileId = resolveToolProfile(),
): void {
  if (profile === "full") return;

  const handles = new Map<string, RegisteredTool>();
  const originalTool = server.tool.bind(server) as (
    name: string,
    ...rest: unknown[]
  ) => RegisteredTool;
  const originalRegisterTool = server.registerTool.bind(server) as (
    name: string,
    ...rest: unknown[]
  ) => RegisteredTool;

  const reconcile = () => {
    const allowed = new Set(
      selectAvailableToolProfileNames({
        profile,
        availableNames: [...handles.keys()],
      }),
    );

    for (const [name, handle] of handles) {
      const shouldEnable = allowed.has(name);
      if (handle.enabled !== shouldEnable) {
        handle.update({ enabled: shouldEnable });
      }
    }
  };

  const remember = (name: string, handle: RegisteredTool): RegisteredTool => {
    handles.set(name, handle);
    reconcile();
    return handle;
  };

  // The project still uses the v1 convenience `tool()` API extensively, while
  // future registrations may migrate to `registerTool()`. Intercept both public
  // entrypoints so the profile contract cannot drift during that migration.
  (server as unknown as { tool: typeof server.tool }).tool = ((
    name: string,
    ...rest: unknown[]
  ) => remember(name, originalTool(name, ...rest))) as typeof server.tool;

  (server as unknown as { registerTool: typeof server.registerTool }).registerTool = ((
    name: string,
    ...rest: unknown[]
  ) => remember(name, originalRegisterTool(name, ...rest))) as typeof server.registerTool;
}
