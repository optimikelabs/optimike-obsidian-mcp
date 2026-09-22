export type McpProtocolMode = "legacy" | "dual";

/** Rollback switch. Never infer the protocol mode from a client identity. */
export function mcpProtocolMode(): McpProtocolMode {
  const value = process.env.MCP_PROTOCOL_MODE ?? "legacy";
  if (value !== "legacy" && value !== "dual") {
    throw new Error("Invalid MCP protocol mode. Expected legacy or dual.");
  }
  return value;
}
