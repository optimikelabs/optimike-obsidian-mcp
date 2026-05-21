# MCP Routing Guide

This guide helps agents choose the right layer for Obsidian work.

## Default Decision

| Need                                                                         | Use                                                           | Why                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Read, list, search, tasks, semantic search                                   | Optimike MCP                                                  | Stable tool surface across live, hybrid, and headless modes.            |
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

## What Headless Can Validate But Not Guarantee

Headless validation catches local format errors. It does not render Obsidian, load community plugins, evaluate exact Bases UI behavior, execute formulas, resolve backlinks through Obsidian's internal index, or confirm visual Canvas layout.

## Practical Rule For Agents

1. Validate generated content with `obsidian_validate_format`.
2. If Desktop/plugin behavior matters, use `live` or `hybrid` with Obsidian open.
3. If running on a backend, start with `headless-readonly`.
4. Enable `headless-filesystem` only on a copied or dedicated vault with rollback.
