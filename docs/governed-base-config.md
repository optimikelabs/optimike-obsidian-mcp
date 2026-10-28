# Governed Base configuration

French version: [governed-base-config.fr.md](governed-base-config.fr.md)

Version 3.17.0 adds `bases_config_patch_plan`, `bases_config_patch_apply`,
`bases_config_patch_status` and `bases_config_patch_recover`: a governed edit of
a whole existing Obsidian Base. Before it, only named formulas
(`bases_formula_patch_*`) and note properties (`bases_rows_patch_*`) could be
changed without the whole-file compatibility path `bases_upsert_config`, which
the Bases Bridge refuses while legacy writes are off.

## Operations

One plan takes 1 to 64 ordered operations, following the
[Bases syntax](https://obsidian.md/help/bases/syntax):

| Operation | Effect |
| --- | --- |
| `set_filters` / `delete_filters` | global filters: a statement such as `file.hasTag("book")` or `{and\|or\|not: [...]}`, nested |
| `set_formula` / `delete_formula` | one named formula |
| `set_property` / `delete_property` | one setting of a property (for example `displayName`), or the whole property entry |
| `set_summary` / `delete_summary` | one custom summary formula using `values` |
| `add_view` / `delete_view` / `move_view` | a view object with `type` and a unique `name`, at an optional position; a Base keeps at least one view |
| `set_view_key` / `delete_view_key` | any key of the named view: `name` (rename), `type`, `filters`, `order`, `sort`, `groupBy`, `groupOrder`, `summaries`, `limit`, or a view or plugin key |

Views are selected by their exact unique name. A view keeps its `name` and
`type`. An emptied `formulas`, `properties` or `summaries` section is removed.
Documented view keys are checked: `order` and `groupOrder` are lists, `limit`
a non-negative integer, `groupBy` and `sort` use `property` and `ASC`/`DESC`,
`summaries` maps a property to a summary name. Other keys stay free JSON.
Built-in view types are `table`, `cards`, `list` and `map`. A plugin view type
(such as `kanban`) needs `pluginViewType: true` on the operation, or a Base that
already uses one; it is reported as a `base-view-type-plugin` warning. A typo
such as `tabel` is refused (`base_config_view_type_unknown`).

## Guarantees

The plan reads the Base through Bases Bridge Atomic V1, applies the edits to
the YAML document model (comments, key order and untouched values survive),
and checks the result against an independent model of the same intent: any
other difference refuses the plan. A comment written above a removed top-level
section moves to the next key; comments attached to a deleted entry go with it,
and the proof counts them in `commentsDropped`. The result must pass
`obsidian_validate_format` `kind: base` without errors. The receipt proof
states `semantic-identical-outside-authorized-paths`, lists the changed paths,
and reports `formattingPreserved: false` when the file did not round-trip
byte-for-byte before the edit. CRLF files stay CRLF. YAML anchors, aliases,
custom tags, merge keys and mixed line endings are refused.

Apply, status and recover are the formula lifecycle: the same journal, the same
atomic compare-and-replace on the exact SHA-256 and backend binding, the same
`allowAtomicBaseWrites` grant. No Bridge change is needed. Recovery replays only
the sealed plan; it is not undo.

Refusals return closed `base_config_*` reason codes and never echo the
submitted values.

## Tests

```bash
npm run build && node scripts/test-base-config-patch.mjs
```
