# Governed Markdown body text patches (P4)

Before automatic date preparation, an empty frontmatter mapping (`{}`) is
refused with `frontmatter_empty_mapping_date_management`: adding dates removes
the mapping marker and cannot be justified by date-line-only verification.

Optimike MCP exposes one bounded body-only text patch family for existing
Markdown notes:

```text
obsidian_text_patch_plan → apply → status → recover
```

The family is a projection over the existing durable `obsidian.note.replace`
runtime. It does not create another journal or CAS implementation. Planning
reads the live Atomic Write binding, compiles the complete next note, seals its
before hash and private content, and returns only an opaque receipt.

## Supported intentions

- `append_body`: append non-empty literal text to the Markdown body;
- `prepend_body`: prepend non-empty literal text to the Markdown body;
- `replace_literal`: replace one exact literal occurrence by default;
- `replace_literal` with `occurrence: all` requires the explicit sealed
  `intent: replace_all`.

Operations are ordered and bounded. Regex, active-file targets, file creation,
non-Markdown resources, malformed frontmatter and ambiguous default literal
matches fail before a child plan is created. Existing noncanonical frontmatter
is normalized as an announced part of the plan; canonical frontmatter is preserved.
Real Markdown task lines are protected, while task examples inside fenced code
blocks remain ordinary body text.

## Text representation and task protection

LF, CRLF, and mixed line endings are supported. A bare CR or a UTF-8 BOM is
rejected fail-closed before planning. Public offsets and guarded character
counts use JavaScript UTF-16 code units; byte admission limits use UTF-8
bytes.

Task-shaped examples inside a fenced block are editable only when both the
CommonMark-like scanner and Operon parsing classify that content as fenced.
Any disagreement remains protected, including a blockquote fence ambiguity.

## Concurrency and recovery

Two plans may seal the same before state, but only the first matching Atomic
Write CAS can commit. The other receipt becomes a conflict without overwriting
the winner. After a timeout or lost response, call `status` first and `recover`
only for the same `planRef` and idempotency key. Never create a blind second
patch.

Configured created, modified and viewed property names come from the Atomic
Write Bridge status. P4 inherits the existing modified-time settlement policy:
only one valid configured modified timestamp inside the sealed observation
window can be reconciled; every other body or frontmatter drift remains
fail-closed. Cache data is refreshed after an independently established commit
and is never CAS evidence.

## Direct compatibility tools

When the complete P4 quartet is available, curated live profiles prefer it and
hide `obsidian_update_note` and `obsidian_search_replace`. The explicit `full`
profile and headless fallback modes retain those direct tools. They do not gain
a durable receipt or CAS guarantee.

## Pilot 2 live canary

Run the live canary only against one existing disposable Markdown note in the
open Pilot 2 vault. The command requires the vault name, Local REST API key,
explicit confirmation and the exact 40-character candidate commit:

```powershell
$env:OBSIDIAN_TEXT_PATCH_CANARY_PATH="Canary/modified-time-settlement.md"
$env:OBSIDIAN_TEXT_PATCH_CANARY_VAULT="operon-bridge-pilot-vault-2.5.0"
$env:OBSIDIAN_TEXT_PATCH_CANARY_CONFIRM="I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_PATCHED"
$env:OBSIDIAN_TEXT_PATCH_CANARY_EXPECTED_COMMIT="<exact candidate SHA>"
$env:OBSIDIAN_API_KEY="<Local REST API key>"
$env:MCP_WRITE_MODE="full"
npm run smoke:governed-text-patch-live
```

The canary verifies all four tools, body append/prepend/literal replacement,
one stale-plan conflict, the configured modified-time settlement and a
byte-exact restoration. The property name is discovered from the live Atomic
Write contract; it is never hard-coded. The supported date plugin is disabled
only during a direct CAS restoration fenced by the already attested Atomic
Write backend binding, then re-enabled and checked. Restoration does not create
a new governed plan after removing the dynamic settlement role.

The script prints the exact recovery directory before connecting. Private
backup and journal files live under the operating-system temporary directory.
Runtime logs live under the repository-ignored
`logs/governed-text-patch-live/` boundary required by server configuration.
On success, or on a handled failure before any mutation, those private
directories are removed. If exact restoration or plugin-state restoration
cannot be proved, they are retained and their exact paths are printed. The
redacted JSON evidence is written to the operating-system temporary directory
and its exact path is printed. A lost-response path is covered by deterministic
runtime tests because the live stdio canary exposes no response-loss injector.

## Fast return and final certification

`apply` and `recover` accept `completionMode: deferred | verified` (default:
`deferred`). A CAS with automatic dates may return `applying`,
`postflight.status: pending` and `postflight.checkAfter` without an `afterProof`.
Call `status` at or after that time; only `committed` with `verified` certifies
success. `verified` waits for the same full observation window. Pending work
survives restart and cannot trigger a second CAS.
See the [shared completion contract](governed-note-replacement.md#completion-modes-for-note-body-and-frontmatter-writes).


## Combined body and frontmatter plan

`obsidian_text_patch_plan` optionally accepts `frontmatterOperations` using
the structured frontmatter `set` / `delete` compiler. Body compilation runs
first, followed by announced native frontmatter normalization and YAML compilation. ONE sealed child plan,
ONE CAS and ONE date-settlement observation cover both intentions. Both
write policies and dynamic date protections apply. YAML failure or a conflict
rejects the whole change; there is no partial body/frontmatter commit.

The body proof keeps its operation-input coordinates. Frontmatter proof
coordinates refer to the normalized body-patch output. `composition` binds intermediate and
final content hashes; normalization hashes bind the extra step. Bytes outside
authorized body and announced frontmatter changes remain identical. Even without
`frontmatterOperations`, an old noncanonical frontmatter is normalized and announced.

## Receipt size and diagnostics

All four tools accept `responseMode: compact | detailed` (default detailed for
compatibility). Compact preserves references/digests, state, permissions,
postflight and checkAfter, omitting verbose range proofs. `detailedReceipt`
provides the matching status call to retrieve complete evidence. Pending is
never certified success, in either representation.

`diagnostics: true` adds isolated per-server-call milliseconds for Bridge
status, note reads, pre-dispatch reads, atomic CAS and cache refresh. It excludes
client transport and does not enter the sealed intent or journal.

## Exact YAML representation after FDM

Only a qualified modified-date line may differ from the sealed candidate.
Representation drift of a targeted property, unknown-key drift and body drift
remain unverified. The completion signal does not replace this exact check.

## Creation-date preparation

Before sealing a new plan, the runtime can ask the candidate Atomic Write Bridge to date an undated note. The Bridge requires writes enabled, a loaded and active Frontmatter Date Manager and its `frontmatter-date-manager:update-timestamps-current-file` command. It opens only the target in a temporary tab, checks the source hash and vault binding, then invokes the command. FDM owns all creation/modified values; the MCP never invents or calculates them.

The compiler and CAS use a fresh dated read. The durable and compact receipts include `datePreparation`. Source-preservation claims start at that dated source: the requested patch still waits for `apply`, but vault-owned dating can happen during planning. A whole-note replacement carries forward only observed manager-owned date values, while caller edits to protected keys remain forbidden.

No active manager or absent command fails closed with `atomic_write_creation_property_missing`. Once preparation has been dispatched, a timeout, lost response or unverifiable effect returns `date_preparation_unverified` and `mutationMayHaveApplied: true`. A durable target fence prevents another preparation or patch plan even after restart: no automatic replay is allowed. No public administrative closure for this fence is currently available; an operator must investigate it as an explicit integration follow-up. No patch is sealed on uncertain evidence. If preparation normalized an existing noncanonical frontmatter, `datePreparation.frontmatterNormalization` announces the effect and binds its source and prepared hashes. The fresh read must match the native canonical source outside qualified date lines, with the separately reported editor line-ending exception.

The fence remains held until the requested plan is sealed. If verified preparation
completed but later compilation or admission fails, the tool returns
`date_preparation_completed_plan_unverified` with `datePreparation`, including
any normalization, and directs the caller to inspect the note and pending
operations. It never returns parser diagnostics or note content.

Install the candidate MCP and Bridge together. Active vault settings define date names. Without an active integration, only protected canonical creation keys (`création`, `creation`, `created`) are recognized, not arbitrary names. Other date managers, multiple integrations and disabled FDM are not admitted for automatic preparation. Already-dated notes retain protected-key and CAS behavior.

### Templates and paths outside date management

Do not require or prepare dates under `X/Modèles/**`, Templater's configured `templates_folder`, or paths excluded by FDM `filterRules`. Loaded settings take precedence; otherwise the Bridge reads the plugin configuration inside the vault's `configDir`. Rules use FDM 1.6.0 ordered Picomatch POSIX matching, comments, `!` exceptions and folder boundaries. Ordinary undated notes still require FDM preparation.

The durable receipt carries `datePreparation.kind: outside-date-management` and “Note hors gestion des dates.”. Sealed planning, CAS conflict rejection and reread verification remain mandatory. These paths receive no post-write date-settlement tolerance. Explicitly configured protected keys remain immutable; the exception never authorizes client-supplied dates.

FDM also reacts asynchronously to vault modifications. The Bridge wraps FDM's `shouldFileBeIgnored` in memory to exclude template paths even when missing from FDM's filters, delegating ordinary paths unchanged and restoring the hook on Bridge unload. No plugin configuration or date field is written by this hook. This integration is tested against FDM 1.6.0; other managers are not qualified. Verification proves the reread state, not immunity to later independent changes.

The preparation's 55-second budget starts at request arrival and includes queueing and native I/O. An expired queued request never dispatches FDM, and dispatch requires enough remaining time for the minimum settlement window. During dating and native editor close, body comparison tolerates only CRLF/LF conversion, including mixed CRLF/LF files. Lone CR characters, whitespace, other characters and newline counts remain significant; other body or non-date property changes still conflict. If the final body differs only in line endings, the durable and compact receipt includes `lineEndingsNormalized: true` and “fins de ligne normalisées par Obsidian pendant la datation”. The MCP does not rewrite line endings: planning seals the exact fresh reread after dating and editor close, and CAS retains the exact hash. The temporary leaf is always detached even when the user changed focus; only restoration of the previous focus is conditional.
