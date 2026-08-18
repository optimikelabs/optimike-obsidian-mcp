import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const TOOL_ROUTING_RESOURCE_URI =
  "optimike://guides/tool-routing" as const;

export const TOOL_ROUTING_RESOURCE_TEXT = `# Optimike MCP tool routing

Tool availability depends on the runtime mode and the immutable tool profile
selected before MCP initialization. Use the narrowest exposed tool that owns the
required guarantee. Never infer that an absent tool can be emulated safely.

## Canonical priorities

- Read, list and exact text search: use the dedicated read/search tools.
- Semantic similarity: use \`smart_semantic_search\`. Optimike MCP 3.0 no longer
  exposes the former \`smart_search\` or \`smart-search\` aliases.
- Operon-managed tasks: use \`operon_list_tasks\` or \`operon_query_tasks\`. Use
  \`list_all_tasks\` and \`query_tasks\` only for Obsidian Tasks-compatible
  Markdown inspection.
- Complete replacement of an existing Markdown note in live/hybrid mode: prefer
  \`obsidian_note_replace_plan\`, then apply the sealed plan. After a lost response,
  call status before recover; never issue a new blind mutation. Use
  \`obsidian_update_note\` only when its direct append/prepend/create contract is
  intentional.
- \`obsidian_search_replace\` is a direct edit without durable recovery. For a
  high-assurance replacement, compile the intended complete content through
  \`obsidian_note_replace_plan\`.
- Top-level Frontmatter set/delete in live/hybrid mode: prefer
  \`obsidian_frontmatter_patch_plan\`. The direct Frontmatter helper is a bounded
  fallback only when the governed family is structurally absent.
- Named Base formula set/delete: prefer \`bases_formula_patch_plan\`.
  \`bases_upsert_config\` is a full-profile compatibility path, not a formula
  fallback.
- Existing JSON Canvas graph mutation in live/hybrid mode: prefer
  \`obsidian_canvas_patch_plan\`, then its matching apply/status/recover tools.
  \`obsidian_manage_canvas\` is a direct headless-filesystem fallback without a
  durable receipt.
- Direct append/prepend/search-replace/tag tools do not provide a durable
  plan/status/recovery receipt. Use them only when that narrower direct contract
  is intentional and allowed by the runtime policy.
- Headless filesystem mutations are bounded fallback operations for copied or
  dedicated vaults. They do not claim Obsidian Desktop or plugin semantics.

## Governed sequence

1. Call the domain-specific \`*_plan\` tool once with a caller-owned idempotency key.
2. Inspect the returned receipt and retain its opaque \`planRef\`.
3. Call the matching \`*_apply\` tool with the same key.
4. After timeout or transport loss, call \`*_status\` first.
5. Call \`*_recover\` only when the receipt authorizes recovery of that exact plan.

A session belongs to one tool profile. A durable plan does not; it can be
inspected or recovered after reconnecting from any profile that exposes the same
complete family and satisfies the existing runtime/write authority.

There is intentionally no generic public \`operation_*\` surface.
`;

export function registerToolRoutingResource(server: McpServer): void {
  server.registerResource(
    "optimike-tool-routing",
    TOOL_ROUTING_RESOURCE_URI,
    {
      title: "Optimike MCP tool routing",
      description:
        "Canonical precedence between direct, compatibility and governed Optimike MCP tools in the active profile.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: TOOL_ROUTING_RESOURCE_URI,
          mimeType: "text/markdown",
          text: TOOL_ROUTING_RESOURCE_TEXT,
        },
      ],
    }),
  );
}
