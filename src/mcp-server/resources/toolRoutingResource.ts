import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const TOOL_ROUTING_RESOURCE_URI =
  "optimike://guides/tool-routing" as const;

export const TOOL_ROUTING_RESOURCE_TEXT = `# Optimike MCP tool routing

Use the narrowest tool that owns the required guarantee. Tool availability is
runtime-dependent; never infer that an absent tool can be emulated safely.

## Canonical priorities

- Read, list and exact text search: use the dedicated read/search tools.
- Semantic search: use \`smart_semantic_search\`. \`smart_search\` and
  \`smart-search\` are legacy compatibility aliases of the same implementation.
- Operon-managed tasks: use \`operon_list_tasks\` or \`operon_query_tasks\`. Use
  \`list_all_tasks\` and \`query_tasks\` only for legacy Obsidian Tasks-compatible
  Markdown inspection.
- Complete replacement of an existing Markdown note in live/hybrid mode: prefer
  \`obsidian_note_replace_plan\`, then apply the sealed plan. After a lost response,
  call status before recover; never issue a new blind mutation. Use
  \`obsidian_update_note\` for intentional direct append/prepend/create operations;
  its overwrite mode is a compatibility path without a durable receipt.
- \`obsidian_search_replace\` is a direct edit without durable recovery. For a
  high-assurance replacement, compute the intended complete content and route it
  through \`obsidian_note_replace_plan\`.
- Top-level frontmatter set/delete in live/hybrid mode: prefer
  \`obsidian_frontmatter_patch_plan\`. Use \`obsidian_manage_frontmatter\` for
  direct reads, compatibility, or a runtime where the governed tool is absent.
- Named Base formula set/delete: prefer \`bases_formula_patch_plan\`.
  \`bases_upsert_config\` is a legacy whole-config compatibility path and must not
  bypass the governed formula contract.
- Direct append/prepend/search-replace/tag tools do not provide a durable
  plan/status/recovery receipt. Use them only when that narrower direct contract
  is intentional and allowed by the active runtime policy.
- Headless filesystem mutations are bounded fallback operations for copied or
  dedicated vaults. They do not claim Obsidian Desktop or plugin semantics.

## Governed sequence

1. Call the domain-specific \`*_plan\` tool once with a caller-owned idempotency key.
2. Inspect the returned receipt and retain its opaque \`planRef\`.
3. Call the matching \`*_apply\` tool with the same key.
4. After timeout or transport loss, call \`*_status\` first.
5. Call \`*_recover\` only when the receipt authorizes recovery of that exact plan.

There is intentionally no generic public \`operation_*\` surface.
`;

export function registerToolRoutingResource(server: McpServer): void {
  server.registerResource(
    "optimike-tool-routing",
    TOOL_ROUTING_RESOURCE_URI,
    {
      title: "Optimike MCP tool routing",
      description:
        "Canonical precedence between direct, legacy and governed Optimike MCP tools.",
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
