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
ranges is identical before and after compilation. Files with no final line
ending remain supported; an added formula receives exactly one detected line
separator before its new mapping entry.

Anchors, aliases, tags, and merge keys are identified from parsed YAML nodes,
not raw character matches. The same indicator text remains ordinary content in
quoted scalars, block scalars, and comments. Multiline non-block formula
scalars fail closed because their source boundaries are outside V1.
Parsed node ranges also define existing-entry and append boundaries, preserving
block-scalar content even when a content line resembles blank/comment trivia.

Bases Bridge Atomic V1 supports existing `.base` files only. Its compare-and-
replace is bound to a stable device/install/vault fingerprint and executes
through Obsidian `Vault.process` with an exact SHA-256 precondition. The receipt
proves the raw before/after hashes and source-preservation contract. It does not
claim that every formula is semantically valid in every future Obsidian build,
or that UI/index/plugin side effects have completed.

## Obsidian engine check

Before sealing, `plan` asks the Bases Bridge engine route to evaluate every
formula of the Base twice: as stored and as planned. The engine runs on
Obsidian's main thread, so each evaluation reads at most the first 100 rows the
Base's global filters select (`rowLimit`): a syntax error or an unknown
function fails on any row, while an error limited to rows past the sample can
pass. A formula that the planned
Base turns into a `syntax_error` or `runtime_error`, and that did not already
have that status, refuses the plan with reason code `base_formula_engine_error`:
nothing is sealed or written. The refusal's `formulaCheck` lists, per formula,
up to three engine messages, the unknown functions it calls (`name(` and
`.name(` calls missing from the function registry of the installed Obsidian,
with the type when it can be inferred), the valid functions for that type and
up to three close names. Errors already present in the stored Base do not block.
A formula whose values are all empty (`all_null`) is a warning, never a
refusal.

The plan receipt carries `engineCheck`, sealed with the plan and returned
unchanged by replay and `status`:

- `{ "status": "verified", "obsidianVersion": "…" }`, with `warnings` for
  `all_null` or `not_evaluated` formulas, when both evaluations succeeded;
- `{ "status": "unverified", "reason": "…" }` otherwise: Obsidian closed, a
  Bridge without the engine route (`bridge_route_missing`), a failed engine
  canary, an unsupported Obsidian version or an unusable answer. The plan then
  proceeds as before; it is never reported as verified.

The check runs at plan time only. `apply`, `status` and `recover` are
unchanged. Outside a plan, the read-only `bases_check` reports the same
statuses for one Base or every Base, and `bases_functions` lists the functions
the installed Obsidian accepts, grouped by type or detailed for one type. Formula syntax: <https://help.obsidian.md/bases/syntax>; functions:
<https://help.obsidian.md/bases/functions>.

## Write gates and legacy migration

Both Bases Bridge write switches are disabled by default:

- **Allow atomic Base CAS** enables only the typed Atomic V1 replacement.
- **Legacy config writes** temporarily re-enables whole-file writes through
  `PUT /bases/:id/config` and `POST /bases`.

Validation-only legacy requests remain available. With the compatibility
switch off, the old `bases_upsert_config` and `bases_create` effects fail
closed at the Bridge, so they cannot silently bypass the governed formula
surface. Note-property upserts are a separate frontmatter domain.

In `guarded` mode, the configured write-size limit applies to the complete
sealed next YAML at initial plan, idempotent plan replay, apply, and recover.
No phase may rely only on the smaller formula expression or operation count.

## Deterministic gate

```bash
npm run test:governed-base
```

The suite proves byte preservation, fail-closed compilation, typed Base CAS,
durable plan/apply/status and idempotent replay, plus a complete stdio MCP
round trip. Initial feature admission and changed or unqualified Base paths additionally require the live canary in the dedicated
Operon Bridge pilot vault on an exact disposable copy of `PROJETS.base`, with
backup, stale-plan conflict, restoration, and final SHA equality.

Recipe selection follows [proportionate qualification](bridge-packaging.md#proportionate-release-qualification). An unchanged path may reuse applicable successful evidence; documentation or version metadata alone does not rerun this canary. Initial admission without proof, a relevant change or an unresolved failure requires qualification. Runtime guards and restoration guarantees remain unchanged.
