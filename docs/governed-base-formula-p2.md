# Governed Base formula P2

French version: [governed-base-formula-p2.fr.md](governed-base-formula-p2.fr.md)

P2 adds the first governed mutation of an existing Obsidian `.base` file. It
is deliberately narrower than arbitrary YAML editing: callers can set or
delete named entries in the top-level `formulas` mapping only.

## Public MCP surface

- `bases_formula_patch_plan`
- `bases_formula_patch_apply`
- `bases_formula_patch_status`
- `bases_formula_patch_recover`

`plan` performs no write. It reads the exact Base bytes through Bases Bridge
Atomic V1, compiles the bounded intent, and seals the before hash, complete
next YAML, backend binding, idempotency identity, and source-preservation proof
in the private durable journal. `apply` accepts only that opaque plan. After a
lost response, call `status`; `recover` may resume only the same sealed plan
from a durable uncertain state. Recovery is not undo.

## Guaranteed boundary

The compiler accepts conservative bare formula names, one block-style
top-level `formulas` mapping, LF or CRLF, and at most 32 operations. It rejects
anchors, aliases, tags, merge keys, duplicate/case-colliding formula names,
mixed line endings, ambiguous YAML layout, and deletion of the final formula.
Existing key spelling is preserved. Every byte outside the authorized formula
ranges is identical before and after compilation.

Bases Bridge Atomic V1 supports existing `.base` files only. Its compare-and-
replace is bound to a stable device/install/vault fingerprint and executes
through Obsidian `Vault.process` with an exact SHA-256 precondition. The receipt
proves the raw before/after hashes and source-preservation contract. It does not
claim that every formula is semantically valid in every future Obsidian build,
or that UI/index/plugin side effects have completed.

## Write gates and legacy migration

Both Bases Bridge write switches are disabled by default:

- **Allow atomic Base CAS** enables only the typed Atomic V1 replacement.
- **Legacy config writes** temporarily re-enables whole-file writes through
  `PUT /bases/:id/config` and `POST /bases`.

Validation-only legacy requests remain available. With the compatibility
switch off, the old `bases_upsert_config` and `bases_create` effects fail
closed at the Bridge, so they cannot silently bypass the governed formula
surface. Note-property upserts are a separate frontmatter domain.

## Deterministic gate

```bash
npm run test:governed-base
```

The suite proves byte preservation, fail-closed compilation, typed Base CAS,
durable plan/apply/status and idempotent replay, plus a complete stdio MCP
round trip. Publication additionally requires the live canary in the dedicated
Operon Bridge pilot vault on an exact disposable copy of `PROJETS.base`, with
backup, stale-plan conflict, restoration, and final SHA equality.
