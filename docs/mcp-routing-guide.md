# MCP Routing Guide

French version: [mcp-routing-guide.fr.md](mcp-routing-guide.fr.md)

Related docs: [README](../README.md), [Operations](../OPERATIONS.md),
[Runtime Capability Matrix](runtime-capability-matrix.md),
[Headless Server Profile](headless-server-profile.md), and
[External document roots](external-roots-setup.md)

This guide helps agents choose the right layer for Obsidian work.

## Default Decision

| Need                                                                         | Use                                                           | Why                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Read, list, search, tasks, semantic search                                   | Optimike MCP                                                  | Stable tool surface across live, hybrid, and headless modes.            |
| Read an explicitly configured document outside the vault                     | Optimike MCP external-root tools                              | Default-deny confinement with portable logical paths.                   |
| Full Obsidian behavior, commands, active file, plugin-backed Bases           | Optimike MCP in `live` or `hybrid` with Obsidian Desktop open | This is the only mode with Desktop/plugin-backed semantics.             |
| Safe backend server over a synced vault                                      | Optimike MCP in `headless-readonly` first                     | No Desktop required and no write risk.                                  |
| Bounded Markdown/frontmatter/tag/admin writes on a copied or dedicated vault | Optimike MCP in `headless-filesystem`                         | Path safety, dry-run defaults, and preconditions.                       |
| Direct one-off file edits outside the MCP contract                           | Filesystem tools                                              | Useful for local repo-style work, but the agent owns all safety checks. |
| App-native Obsidian actions or diagnostics                                   | Obsidian CLI                                                  | Useful as a Desktop/app control plane, not strict headless.             |
| Knowing how to write Obsidian Markdown, Bases, or Canvas syntax              | Obsidian-format skills or docs                                | Skills teach format conventions; they do not execute MCP operations.    |

## New In V2.2

Use `obsidian_validate_format` before risky writes or generated content:

- `kind: markdown` checks frontmatter YAML, tags, wikilinks, embeds, callouts, and code fences.
- `kind: base` checks `.base` YAML, views, formula references, and common shape issues.
- `kind: canvas` checks JSON Canvas nodes, edges, IDs, node geometry, and edge references.
- `kind: auto` infers from `filePath` extension.

Use `obsidian_manage_canvas` only in `headless-filesystem`:

- `validate` reads and validates an existing `.canvas`.
- `create` writes a structurally valid `.canvas`.
- `add_text_node` appends a text node.
- `connect_nodes` adds an edge between existing node IDs.

Dry-run is the default for write operations.

## External document routing

An Obsidian link to a local file does not authorize access to that file. Use
external-root tools only when the operator has explicitly configured a logical
root ID.

Agent workflow:

1. Call `external_runtime_status` or `external_roots_list`; never infer a root
   from a physical path found in a note.
2. Use `external_list` and `external_stat` with a root ID and root-relative
   path.
3. Use `external_read` only for bounded UTF-8 text.
4. For PDF or Office content, request `external_handoff` explicitly:
   - local stdio returns a verified temporary `local_path`;
   - authenticated direct HTTP may return an opt-in `http_ticket`, which the
     client claims once from `GET /external-handoff` with the same bearer
     identity and `X-External-Handoff-Ticket` header.
5. Preserve the logical root ID, relative path, size and SHA-256 as provenance.
   Never persist a temporary path or ticket.

Every direct HTTP external-root operation requires `external:read`. Remote HTTP
remains pilot-only behind reviewed TLS proxy and network controls.

Do not promise extraction merely because handoff succeeds: extraction depends
on the calling client. Do not silently copy external content into the vault,
merge it into vault search, or treat the configured root as a backup.

## What Headless Can Validate But Not Guarantee

Headless validation catches local format errors. It does not render Obsidian, load community plugins, evaluate exact Bases UI behavior, execute formulas, resolve backlinks through Obsidian's internal index, or confirm visual Canvas layout.

## Practical Rule For Agents

1. Validate generated content with `obsidian_validate_format`.
2. If Desktop/plugin behavior matters, use `live` or `hybrid` with Obsidian open.
3. If running on a backend, start with `headless-readonly`.
4. Enable `headless-filesystem` only on a copied or dedicated vault with rollback.
