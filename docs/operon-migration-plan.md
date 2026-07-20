# ÉLYSIA Tasks / TaskNotes → Operon migration plan

## Current decision

`PILOT Operon`, not `SWITCH Operon`.

This plan is intentionally unapplied. The integration branch performs no production-vault migration and registers no mutation tool.

## Existing canon to preserve

### Execution zones

- `Efforts/Projets/`
- `Efforts/Créations/`

### Capture zone

- daily notes under `Calendrier/NOTES PÉRIODIQUES/`

### Task-disabled zones

- Atlas and other non-execution areas remain text/checklist-only.

### Current Tasks states

- `[ ]` Todo
- `[/]` In Progress
- `[n]` Note / capture inbox
- `[*]` Étoile du Nord
- `[-]` Cancelled
- `[x]` Done

TaskNotes remains a bounded mission layer containing context, Definition of Done, evidence, dependencies, decisions, and next action. It is not a second general backlog.

## Proposed Operon model for the pilot

### Checkbox

Use only Operon's durable checkbox semantics:

- open
- done
- cancelled

### Execution pipeline

Recommended minimal pipeline:

```text
Execution.Inbox
Execution.Todo
Execution.Doing
Execution.Paused
Execution.Done
Execution.Cancelled
```

The exact labels must be configured and validated in the pilot; this document does not write them.

### Orthogonal fields

Do not overload workflow status with strategic or semantic roles.

Recommended fields:

```yaml
north_star: true|false
capture_kind: note|null
elysia_owner: operon|tasks|tasknotes
```

Only add fields that prove necessary in the pilot. `north_star` is the likely minimum.

### Rich missions

A rich Operon file task may replace a TaskNote only if it preserves:

- context;
- Definition of Done;
- evidence;
- dependencies;
- decisions;
- next action;
- link to the project pivot;
- durable Markdown readability with Operon disabled.

The project pivot remains a project note, not a task file.

## Mapping draft

| Tasks source | Operon target | Notes |
|---|---|---|
| `[ ]` Todo | open + `Execution.Todo` | Preserve links, due/scheduled dates, priority |
| `[/]` In Progress | open + `Execution.Doing` | Must not survive in sleeping/closed projects |
| `[n]` Note | open + `Execution.Inbox` and capture marker | Remains daily-note inbox, not production work |
| `[*]` Étoile du Nord | normal execution status + `north_star: true` | Strategic importance is not a workflow stage |
| `[-]` Cancelled | cancelled + `Execution.Cancelled` | Preserve cancellation evidence/date |
| `[x]` Done | done + `Execution.Done` | Preserve completion date |
| `[?]`, `[!]`, ritual checklists | no Operon task by default | Keep checklist/text unless an executable action is proven |

## Pilot inventory

Use one real but non-critical project and a copied vault.

Suggested fixture:

- 20–30 inline tasks;
- 5–10 TaskNotes/rich missions;
- parent/child examples;
- dependency examples;
- completed and cancelled history;
- one North Star action;
- daily-note captures;
- sleeping and closed project residues.

Each task has one owner:

```text
Tasks OR TaskNotes OR Operon
```

Never mirror writes.

## Cockpit equivalence

### Now

Open execution tasks only, scoped to Projects/Creations, excluding captures and North Star-only view noise.

### Inbox

Open capture tasks in daily notes, grouped by source note, with an age audit.

### Étoile du Nord

Open tasks with `north_star=true`, independent of current execution status.

### Audit

Open tasks outside authorized execution/capture zones, plus open/in-progress tasks in sleeping or closed projects.

The pilot must show equivalent counts and explain every difference from the Tasks cockpit.

## Migration sequence

1. Snapshot the copied vault and plugin configurations.
2. Export canonical Tasks and TaskNotes inventories.
3. Detect duplicate or ambiguous task identities.
4. Freeze new pilot-scope Tasks captures.
5. Produce a dry-run mapping table per task.
6. Review losses, gains, unknown statuses, and unsupported checklist markers.
7. Migrate no more than one project scope.
8. Reindex Operon.
9. Compare counts, fields, links, dates, parents, dependencies, and cockpits.
10. Run the local validation recipe after restart and Sync settlement.
11. Observe for 7–14 calendar days.
12. Decide KEEP / extend pilot / switch.

## Rollback package required before apply

- original file snapshot;
- Tasks inventory JSON/Markdown;
- TaskNotes inventory;
- mapping manifest from source line/note to `operonId`;
- reverse mapping for statuses and dates;
- list of created Operon file tasks;
- list of modified inline lines;
- hash/mtime preconditions;
- explicit restore procedure.

Rollback is file restoration plus plugin reindex. A plugin cache is never the rollback source.

## Switch gates

Recommend `SWITCH Operon` only if all pass:

1. zero lost task;
2. zero silent duplicate;
3. every simulated conflict is detected;
4. inline and file-task parity;
5. ÉLYSIA properties preserved;
6. all four cockpits reproduced;
7. restart/reindex stable;
8. Sync stable;
9. safe idempotent mutation path exists;
10. recurrence/dependencies are not bypassed;
11. TaskNotes rich mission capability is replaced;
12. Tasks and legacy MCP layers can actually be removed;
13. rollback has been executed successfully on the copy.

## Stop rules

Stop the migration if:

- a task needs two active owners;
- North Star must be encoded as a workflow status to function;
- file tasks become false project pivots;
- the agent needs raw Markdown writes to simulate Operon;
- sleeping/closed project tasks remain actionable without requalification;
- the maintenance burden exceeds the simplification gained.
