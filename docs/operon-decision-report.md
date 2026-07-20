# Operon integration decision report

## Decision

**PILOT Operon** through a read-only Bridge and MCP snapshot. Keep Tasks and TaskNotes during the evidence phase.

## Audited baselines

| Component | Branch / version | SHA | Evidence status |
|---|---|---|---|
| Optimike Obsidian MCP | `main` | `8cea94610a526e50a017d334be6008b8dab79500` | current repository code |
| Operon | `2.4.0` | `76d251973b149afc69192ef565d626740aa7b7cf` | current repository code/release |
| Historical ÉLYSIA lab | Operon `1.6.2` | local bundle | historical experiment only |

## M0 findings

| Area | Finding | Classification |
|---|---|---|
| MCP server | Main Optimike MCP already owns Tasks, Bases, semantic search, runtime modes, HTTP backend, stdio proxy, and SQLite | KEEP |
| Legacy Tasks MCP | No longer needed by the canonical server | KEEP legacy only; do not revive |
| Operon read model | Public runtime index exposes stable IDs and structured tasks | ADD Bridge projection |
| Operon mutation model | Full orchestration remains private and spans more than direct writes | BLOCK mutations |
| Headless exactness | Community plugins are not loaded headlessly | cache only, explicitly stale |
| Licenses | MCP Apache-2.0; Operon GPL-3.0-or-later | keep code/process boundary |
| Existing lab | Inline scan/dry-run only; incomplete for current upstream | evidence, not code source |
| Fork | Not required for read pilot | DEFER |

## Implemented in this branch

- read-only Obsidian companion Bridge;
- version/capability probe;
- REST status/list/get/query/validate;
- normalized contract v1;
- optional unmanaged file-task properties;
- stable per-task read revision;
- five MCP tools;
- transactional SQLite snapshots;
- generation/settings-signature validation;
- stale cache fallback;
- duplicate/P0 refusal;
- incomplete-pagination refusal;
- built contract and snapshot-service tests;
- CI workflow;
- ADR, contracts, validation recipe, migration and rollback plan.

## Deliberately not implemented

- create/update/transition/convert tools;
- reflective calls to private Operon methods;
- direct `TaskWriter` integration;
- raw Markdown/YAML mutation fallback;
- Operon fork;
- upstream PR;
- production-vault migration;
- Tasks/TaskNotes removal.

## Test status

| Test | Status |
|---|---|
| Plugin pure contract TypeScript check with local stubs | PASS |
| MCP new-source TypeScript check with local stubs | PASS |
| Bridge dependency install, typecheck, Node contract tests and build | PASS — GitHub Actions |
| MCP root `npm ci`, build and all runtime-mode smokes | PASS — GitHub Actions |
| MCP Operon contract smoke | PASS — GitHub Actions |
| MCP SQLite refresh/generation/stale/property/duplicate/P0/incomplete-page smoke | PASS — GitHub Actions |
| Package dry run | PASS — GitHub Actions |
| Runtime workflow on Ubuntu Node 22 | PASS — GitHub Actions |
| Runtime workflow on Windows Node 22 | PASS — GitHub Actions |
| Obsidian Desktop recipe | NOT RUN |
| Real Sync topology | UNVERIFIED |
| Production migration | NOT RUN by design |

## Risk register

### P0

- Duplicate `operonId`: blocks snapshot replacement.
- Incomplete pagination: blocks snapshot replacement.
- Contract/version mismatch: blocks live refresh.

### P1

- Runtime index shape is public in JavaScript but not a documented versioned API.
- A future Operon 2.x release may change internals without a major version change.
- File-task property parity still needs Desktop proof.
- Four ÉLYSIA cockpit equivalents still need pilot proof.

### P2

- Snapshot refresh loads the complete task set when generation changes.
- Query semantics are intentionally smaller than Operon's full Filter UI.

## Next evidence decision

Run `docs/operon-local-validation.md` on a copied vault. Do not progress to mutation architecture until the read gate passes.

## Project-state check

- Recommended status for the existing ÉLYSIA Operon project: `maturation` until Desktop parity is proven.
- Credible next action: execute the read-only validation recipe against the current Operon release and record the matrix.
- Existing Tasks/TaskNotes tasks: unchanged.
