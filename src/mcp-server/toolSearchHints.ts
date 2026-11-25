import type { McpServer } from "@modelcontextprotocol/server";

/**
 * Tool-search hints for clients that defer MCP tool definitions and find them
 * by keyword. Claude Code reads `_meta["anthropic/searchHint"]`; clients that
 * do not know the key ignore it. Its ranking weighs a query word found in the
 * tool name far above one found in the description (a hint word sits between
 * the two), so a hint carries the user's words for a tool that its name lacks.
 *
 * Rules (checked by scripts/test-tool-surface-runtime-conformance.mjs):
 * - one short factual phrase per tool, in the user's vocabulary, about that
 *   tool's own job; no keyword lists and no other tool's job;
 * - only words the tool name lacks: a word already inside a name part scores
 *   through the name, and repeating it would widen the name's lead;
 * - no function words (a, the, of, to, and...) and no vault-wide words (note,
 *   file, vault, content, Markdown): the client does not drop them, so each one
 *   would lift every hinted tool for any query that contains it;
 * - entry points only: read tools and governed `*_plan` tools, not the
 *   apply/status/recover steps that a client reaches from the plan.
 */
export const TOOL_SEARCH_HINT_META_KEY = "anthropic/searchHint";

export const TOOL_SEARCH_HINTS: Readonly<Record<string, string>> = {
  // Notes: read and find.
  obsidian_read_note: "open, show text, frontmatter",
  obsidian_list_notes: "browse folder, subfolders",
  obsidian_global_search: "find exact words, phrase, regex",
  smart_semantic_search: "find matching meaning, topic, concept",
  obsidian_note_links: "backlinks, incoming, outgoing references, embeds",
  obsidian_get_frontmatter: "read one property value",
  obsidian_runtime_status: "check connection, health, version",

  // Notes: governed writes.
  obsidian_note_create_plan: "add new, write first version",
  obsidian_text_patch_plan: "edit: replace, append, prepend paragraph, line",
  obsidian_note_replace_plan: "rewrite everything: new full version",
  obsidian_frontmatter_patch_plan: "change, set, remove property value",
  obsidian_note_move_plan: "rename, relocate, another folder",
  obsidian_note_delete_plan: "remove, trash",
  asset_import_plan: "attach image, attachment",

  // Bases.
  bases_list: "show database views",
  bases_query: "show, filter, sort view rows",
  bases_create_plan: "new database table view",
  bases_rows_patch_plan: "change property value, one entry, view",
  bases_formula_patch_plan: "add, change, delete computed column",
  bases_config_patch_plan: "edit: add, change views, filters, sorting, columns",

  // Canvas.
  obsidian_canvas_create_plan: "new board",
  obsidian_canvas_patch_plan: "edit: add, change, remove cards, nodes, edges",

  // Operon tasks.
  operon_list_tasks: "show todos",
  operon_query_tasks: "filter: due date, status, priority, tag, project, path",
  operon_find_tasks: "search projects, todos: text, ranked results",
  operon_create_task: "add new todo, due date, priority",
  operon_update_task: "edit: description, deadline (due), priority, tags",
  operon_transition_task: "mark done, complete, cancel, reopen, change status",
  operon_update_periodic_scheduling: "set, clear task planned day",
  operon_update_recurrence: "make task repeat, stop repeating",
  operon_relocate_task: "move, another destination",
  operon_set_relationships: "task parent, subtasks, blocking dependencies",
};

/**
 * Opening sentence of the server instructions, for clients that find tools by
 * keyword search. Other servers a user connects can own the same verbs
 * (`add_note`, `update_task`), and their name match outranks any hint here.
 * The word obsidian is in this server's documented name and in most tool
 * names, so a search that carries it can lift these tools above theirs; it
 * does not guarantee first place.
 */
export const TOOL_SEARCH_INSTRUCTION =
  "Tools for the user's Obsidian vault: notes, Operon tasks, Bases and canvases. " +
  "When you search for one of these tools, include the word obsidian in the search query " +
  '(for example "obsidian add note" or "obsidian mark task done"): ' +
  "other connected servers may have tools with the same verbs.";

/** Server instructions: the search sentence, then any other instructions. */
export function withToolSearchInstruction(instructions?: string): string {
  return instructions
    ? `${TOOL_SEARCH_INSTRUCTION}\n\n${instructions}`
    : TOOL_SEARCH_INSTRUCTION;
}

export function toolSearchHint(name: string): string | undefined {
  return Object.hasOwn(TOOL_SEARCH_HINTS, name)
    ? TOOL_SEARCH_HINTS[name]
    : undefined;
}

/**
 * Adds the search hint to each tool's `_meta` at registration, next to any
 * `_meta` the tool already declares. Install before tools are registered.
 */
export function installToolSearchHints(server: McpServer): void {
  type Registrar = (
    name: string,
    configuration: unknown,
    callback: unknown,
  ) => unknown;
  const register = server.registerTool.bind(server) as Registrar;
  server.registerTool = ((
    name: string,
    configuration: unknown,
    callback: unknown,
  ) => {
    const hint = toolSearchHint(name);
    if (!hint || typeof configuration !== "object" || configuration === null) {
      return register(name, configuration, callback);
    }
    const config = configuration as { _meta?: Record<string, unknown> };
    return register(
      name,
      {
        ...config,
        _meta: { [TOOL_SEARCH_HINT_META_KEY]: hint, ...config._meta },
      },
      callback,
    );
  }) as typeof server.registerTool;
}
