# Governed Base and Canvas creation

French version: [governed-file-create.fr.md](governed-file-create.fr.md)

Version 3.16.0 extends [durable note creation](durable-note-create-m4.md) to the
two other native Obsidian files an agent builds: a Base (`.base`) and a Canvas
(`.canvas`). Before it, a live vault had no governed way to create either:
`bases_create` writes through the Bases Bridge legacy switch, which is off by
default, and `obsidian_manage_canvas` is registered only in
`headless-filesystem`.

## Public MCP surface

Two live-only three-tool families, without a recover tool:

- `bases_create_plan`, `bases_create_apply`, `bases_create_status`;
- `obsidian_canvas_create_plan`, `obsidian_canvas_create_apply`,
  `obsidian_canvas_create_status`.

They belong to the `bases.governed` and `canvas.governed` groups, so the
`authoring`, `operational` and `full` profiles expose them; `standard` and
`tasks` do not. Pending operations appear in `obsidian_list_pending_operations`
as `obsidian.base.create` and `obsidian.canvas.create`, with `nextAction`
`apply` or `status`, and `obsidian_operation_close` can close an
`outcome_unknown` creation as `reviewed_unverified`.

`bases_create` and `obsidian_manage_canvas` are unchanged. They remain the
direct paths for headless or copied vaults.

## Plan

`plan` takes `path`, the exact complete `content` and an `idempotencyKey`. It
creates nothing. It:

1. checks the new name with the shared [note name rules](note-name-rules.md)
   and the kind's extension (`.base` or `.canvas`);
2. checks the bytes: nonempty UTF-8, at most 2 MiB, no BOM, no lone CR;
3. validates the format:
   - Base: the YAML must pass `obsidian_validate_format` `kind: base` without
     errors and be a nonempty mapping. Warnings (for example a missing `views`
     array) are kept in the receipt as `formatWarnings`;
   - Canvas: strict JSON, `nodes` and `edges` arrays, and a graph that the
     [governed Canvas patch](governed-canvas-p3.md) compiler accepts (unique
     IDs, integer geometry, positive size, known node types, edges between
     existing nodes), so the new Canvas can be edited by
     `obsidian_canvas_patch_plan` later. `{"nodes":[],"edges":[]}` is a valid
     empty Canvas;
4. asks the Bridge to observe the path absent, then seals the content, its
   SHA-256, the Bridge binding and the vault binding in the existing durable
   journal.

A refusal returns `VALIDATION_ERROR` with `reasonCode`
`create_format_invalid`. The submitted content and parser messages are never
echoed; `obsidian_validate_format` lists the issues of a draft.

The same key with the same path and content replays the sealed plan. The same
key with another intent is refused with `create_idempotency_conflict`.

## Apply and status

`apply` takes the `planRef` and the same `idempotencyKey`. It checks again the
write policy, the Bridge grant and both bindings, records the effect-fence
token in the journal, then asks the Atomic Write Bridge for one exclusive
creation (`O_CREAT | O_EXCL`, data fsync). An existing file is never
overwritten, no suffix is added and the parent directory is never created. The
Bridge parses the content again before the effect: YAML mapping for a Base
(Obsidian `parseYaml`), JSON object with `nodes` and `edges` arrays for a
Canvas.

`status` observes the file without writing. Only the exact sealed bytes verify
the creation: unlike Markdown notes, no automatic date field or plugin rewrite
is excused. After a lost response, status reconciles from the file. A file
that exists with other bytes moves the attempt to `outcome_unknown`; it is
never overwritten, deleted or created again. `committed` means the intended
bytes were observed, not that this attempt authored them, and Obsidian
indexing is not certified.

## Bridge grants

Atomic Write Bridge 0.9.0 adds two settings, both off by default and
independent of note creation:

- **Allow exclusive Base creation** (`allowBaseCreates`);
- **Allow exclusive Canvas creation** (`allowCanvasCreates`).

The Bridge status reports them as `baseCreate` and `canvasCreate`. Each kind
has its own binding fingerprint: a Base plan cannot be applied as a note or a
Canvas. The MCP also needs `MCP_WRITE_MODE` `guarded` or `full`; `readonly`
refuses new plans and effects. An older Bridge has no `baseCreate` /
`canvasCreate` capability: planning is refused with
`create_bridge_unsupported` and the capability doctor reports
`bridge_contract_incompatible` with `update_bridge_contract`.

| Condition | Result |
| --- | --- |
| invalid name, extension, bytes or format | plan rejected, nothing sealed |
| target exists, or folded sibling (case/Unicode) | plan rejected (`409` / `note_name_case_collision`) |
| parent directory missing | plan rejected (`file_create_parent_missing`) |
| Bridge grant off or vault binding changed after plan | apply rejected before any effect |
| target appeared after plan | terminal `conflict`, file untouched |
| response lost after dispatch | `status` reconciles from the exact bytes |
| other bytes observed | `outcome_unknown`, file kept, no replay |

## Limits

This is not a Base or Canvas editor. Editing an existing Base stays limited to
formulas (`bases_formula_patch_*`) and note properties (`bases_rows_patch_*`);
views and filters of an existing Base have no governed mutation. Editing an
existing Canvas uses `obsidian_canvas_patch_*`. The format validation does not
evaluate Obsidian formulas, filters or rendering. The trust boundary and
partial-file behaviour are those of [note creation](durable-note-create-m4.md).

## Tests

```bash
npm run build && node scripts/test-vault-file-create.mjs
npm --prefix plugins/obsidian-atomic-write-bridge run check
```

The MCP suite covers plan/apply/status, idempotent replay, format refusals
without content echo, wrong kind and wrong reference, Bridge grant and binding
changes, an older Bridge, a lost response, a rewritten file and an occupied
target. The Bridge suite covers exclusive creation, kind-bound fingerprints,
disabled grants, unsafe paths, a missing parent, invalid content and a
refusing effect fence. Initial admission also requires the live Pilot 2 cycle
described in [Bridge packaging](bridge-packaging.md#proportionate-release-qualification).
