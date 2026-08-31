# Pending Operation Cockpit (P5)

French version: [operation-cockpit-p5.fr.md](operation-cockpit-p5.fr.md)

## Purpose

`obsidian_list_pending_operations` lets an MCP client recover its place after a
crash, transport loss, or context reset without already knowing a `planRef`.
It lists only governed Obsidian operations whose durable state is `planned`,
`applying`, or `outcome_unknown`.

The cockpit is an inventory, not an executor. It never calls a backend, runs
status, applies a plan, performs recovery, sweeps leases, purges retention, or
changes a journal.

## Public contract

Input:

```json
{ "limit": 50, "cursor": "opaque-optional-cursor" }
```

Each row contains only:

- `operationKind`;
- the domain `planRef` accepted by that family's status/apply/recover tools;
- `state`;
- `admittedAt` and `updatedAt`;
- bounded `ageSeconds`;
- `nextAction`: `apply`, `status`, or `recover`.

The response never exposes a vault path, target name, idempotency key, note or
Canvas content, formula/frontmatter value, hash, backend binding, execution
owner, error payload, or journal path. The opaque cursor is versioned and
contains only the last public ordering key.

## Families and routing

| `operationKind`               | Use the matching family        |
| ----------------------------- | ------------------------------ |
| `obsidian.note.replace`       | `obsidian_note_replace_*`      |
| `obsidian.frontmatter.patch`  | `obsidian_frontmatter_patch_*` |
| `obsidian.base.formula.patch` | `bases_formula_patch_*`        |
| `obsidian.canvas.patch`       | `obsidian_canvas_patch_*`      |
| `obsidian.text.patch`         | `obsidian_text_patch_*`        |

Call the returned action only through that domain family. In particular,
`applying` means call status; never issue a blind apply. `outcome_unknown`
means the exact sealed plan remains uncertain and may be passed to that
family's recovery tool. Recovery is not undo.

## Durable authority and isolation

The cockpit reads the three journals already opened by the current live or
hybrid-live runtime: Note (also Frontmatter and Text Patch projections), Base
Formula, and Canvas. It does not scan other SQLite files or profiles on the
machine. Each journal keeps its existing backend/profile namespace and
retention policy.

Stable terminal rows (`committed`, `conflict`, `rejected`, `failed`) are never
listed, even while retained for replay or audit. `outcome_unknown` remains
listed because its effect is not proven and exact-plan recovery may still be
required.

Operon remains independently authoritative through
`operon_list_pending_recoveries`. Diagnostic `external_move` receipts are not
included while external mutation is fail-closed. Direct compatibility writes
have no durable receipt and cannot appear in this cockpit.

## Availability

The tool is read-only and appears in all four profiles in `live` and
`hybrid-live`. It is absent from headless and hybrid-degraded runtimes because
those processes do not own the governed live journals. Write mode does not
change the inventory; apply/recover tools still recheck their own profile,
policy, Bridge, binding, and authorization gates.

## Verification

```bash
npm run test:operation-cockpit
npm run test:operation-runtime
npm run test:profiles
npm run test:tool-routing
```

The deterministic fixtures cover global keyset pagination, equal timestamps,
the five families, stable-terminal exclusion, journal isolation, closed
journals, privacy sentinels, no-write inspection, stdio and multiple HTTP MCP
sessions.

The release gate is an exact-commit live canary against one disposable note in
the open Pilot 2 vault. It uses private OS-temporary journals, lists the sealed
plan before apply, verifies that the terminal plan disappears, and restores the
original note byte-for-byte. The recovery directory is deleted only after the
original content, named-vault Obsidian CLI path and Atomic Write binding have
all been re-attested. If a supported modified-time plugin is active, the canary
temporarily disables it only for the exact restoration CAS, restores its real
enabled state, and verifies the original hash again before cleanup.

```powershell
$env:MCP_WRITE_MODE = "guarded"
$env:OBSIDIAN_API_KEY = "<Local REST API key>"
$env:OBSIDIAN_BASE_URL = "http://127.0.0.1:27233"
$env:OBSIDIAN_OPERATION_COCKPIT_CANARY_VAULT = "operon-bridge-pilot-vault-2.5.0"
$env:OBSIDIAN_OPERATION_COCKPIT_CANARY_PATH = "Canary/modified-time-settlement.md"
$env:OBSIDIAN_OPERATION_COCKPIT_CANARY_CONFIRM = "I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_PATCHED"
$env:OBSIDIAN_OPERATION_COCKPIT_CANARY_EXPECTED_COMMIT = "<40-character candidate SHA>"
npm run smoke:operation-cockpit-live
```

The command refuses a dirty worktree, a commit mismatch, an ambiguous date
integration, a named-vault/backend disagreement, or a changed binding. A signal
closes the gate for new mutations but leaves exact restoration enabled.
