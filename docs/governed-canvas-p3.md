# Governed Canvas P3

French version: [governed-canvas-p3.fr.md](governed-canvas-p3.fr.md)

P3 adds a public, domain-specific lifecycle for bounded mutations of one
existing Obsidian JSON Canvas file:

1. `obsidian_canvas_patch_plan`
2. `obsidian_canvas_patch_apply`
3. `obsidian_canvas_patch_status`
4. `obsidian_canvas_patch_recover`

It does not expose a generic `operation_*` API and does not upgrade
`obsidian_manage_canvas`. That direct helper remains a headless-filesystem
compatibility path without a durable receipt.

## Supported intentions

- add one text node with explicit ID and geometry;
- change the text of an existing text node;
- move or resize an existing node;
- delete one node and its sealed set of incident edges;
- connect two existing or newly added nodes with an explicit edge ID;
- delete one edge.

Each node or edge ID may be targeted at most once in one plan. The compiler
preserves unknown root fields and unknown values on targeted and untargeted
entities. It rejects an invalid current graph and validates the final graph,
including unique IDs, node shape, geometry, edge sides, and edge references.
It does not render the Canvas or judge visual layout quality.

## Durable and atomic boundary

Planning reads the current `.canvas`, compiles the next strict JSON, records a
projection proof, and seals it in the machine-local SQLite journal before any
effect. Apply sends only that sealed content to Atomic Write Bridge 0.4.0. The
Bridge verifies the vault binding and exact SHA-256 inside `Vault.process`.

Canvas writes have a separate **Allow atomic Canvas writes** gate, disabled by
default. Note writes may stay disabled while governed Canvas is enabled, and
vice versa. The journal defaults outside the vault and repository; operators
may set `MCP_OBSIDIAN_CANVAS_JOURNAL_PATH` to an absolute machine-local path.

After a timeout or lost response, call status first. Recover may resume only
the exact same sealed plan when the durable receipt authorizes it. It accepts
no new graph operation and is not undo.

## Failure contract

| Condition                                  | Result                                      |
| ------------------------------------------ | ------------------------------------------- |
| malformed JSON or invalid current graph    | plan rejected, no write                     |
| unsupported or duplicate entity intent     | plan rejected, no write                     |
| Canvas or vault binding changes after plan | conflict/rejected, no P3 write              |
| Canvas gate disabled                       | plan/apply rejected before CAS              |
| response lost after CAS                    | status/recover reconcile before any retry   |
| observed hash matches neither sealed proof | `outcome_unknown`, exact-plan recovery only |

Terminal rows follow the common 30-day retention and content-expurgation
contract. Logs and public receipts never expose the sealed complete Canvas.

## Pilot boundary

Release admission requires stdio and HTTP tests plus a live canary in the
dedicated Operon Bridge pilot vault. The canary must use a disposable Canvas,
prove plan-without-write, commit, replay, stale-plan conflict, lost-response
reconciliation, graph validation, and exact restoration of the original
SHA-256.
