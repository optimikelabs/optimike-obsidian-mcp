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

## Import one offline proposal

Before going offline, capture the vault-relative path and the `sha256` returned
by the authenticated Bridge read `POST /extensions/obsidian-atomic-write-bridge/notes/read`
with `contractVersion: 1` and the target `path`. This hashes the text read by
Obsidian, whose handling of a UTF-8 BOM can differ from hashing raw file bytes.
Capture the live Atomic Write `bindingFingerprint` from that read or from
`backend.bindingFingerprint` in `GET /extensions/obsidian-atomic-write-bridge/status`.
A detailed receipt for an existing governed
plan also reports its binding and the hash of its sealed before state.

Pass the version 1 JSON directly as the arguments to `obsidian_text_patch_plan`
when the authority is back. Replace both sample digests with the captured values.

```json
{
  "path": "Projects/Example.md",
  "idempotencyKey": "optimike:proposal:v1:example-01",
  "operations": [{ "op": "append_body", "text": "Follow up on the draft.\n" }],
  "proposal": {
    "version": 1,
    "bindingFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "baseSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}
```

The suffix of the reserved key is the proposal ID (1–64 lowercase ASCII
letters, digits or hyphens, starting with a letter or digit). Use a fresh ID
for a different intent, even on another note. Version 1 takes only body
operations, with the usual task protection and separately announced native
frontmatter normalization. Import reads the live note and writes only to the
operation journal. It refuses notes that require creation-date preparation or
whose active creation-date requirements cannot be verified. A wrong binding
is refused and can be retried on the original authority.

| Result | What to do |
| --- | --- |
| `phase: "planned"` | Review the receipt. Use `obsidian_text_patch_apply` with its `planRef` and the same key when authorized. |
| `outcome: "conflict"` | The first read differs from the proposed base, or the sealed plan conflicted on apply. Re-read the target and make a new proposal with a fresh ID if the patch is still wanted. |
| `proposal_changed_during_seal` or `target_not_found` | Retry the same proposal when its original base or target is available. These refusals do not reserve the ID. |
| `proposal_date_preparation_locked` | Resolve the earlier date-preparation lock before retrying. |
| `outcome: "committed"` | The same plan already applied. |
| `phase: "applying"` or `outcome: "outcome_unknown"` | Call `obsidian_text_patch_status`, then use `obsidian_text_patch_recover` on that same reference and key if required. |
| `reason: "expired_with_trace"` or `"receipt_purged"` | The result includes the terminal outcome alongside the original reference and digest in `trace`. The retained ID prevents a second admission until the trace is purged. |

Submitting the same proposal after a lost response returns the same plan and
its current state. A changed patch, base, target or binding under the same ID
is refused. The same SQLite transaction records the plan and the association.
Journal maintenance purges conflicts without a plan after
`MCP_OBSIDIAN_PROPOSAL_CONFLICT_RETENTION_DAYS` (default 90 days from the
conflict). Terminal plan traces are eligible for purge after
`MCP_OBSIDIAN_PROPOSAL_TRACE_RETENTION_DAYS` (default 365 days from the
terminal outcome), once the plan receipt is purged. Both settings accept
1–3650 days. Unresolved operations keep their trace while their plan exists.
The trace stores the ID, path, binding, hashes, key and outcome. Keep the full
receipt separately if needed after retention. Once the trace is purged, a
fresh import must pass the live checks again, and the original ID no longer
guarantees deduplication. Use the same journal for import and the existing
apply, status and recover tools.

## Optional apply confirmation (elicitation)

Off by default. When it is on, `obsidian_text_patch_apply` asks the MCP client
for a native yes/no confirmation before writing, provided the client declares
form elicitation. Every other client, and every other tool, keeps the usual
flow: agreement in the chat, then apply.

Enable it in each process that serves the client, with both values:

```text
MCP_PROTOCOL_MODE=dual
MCP_APPLY_CONFIRMATION=elicit
```

`MCP_APPLY_CONFIRMATION` accepts `off` (default) or `elicit`; another value
fails startup without echoing it. Legacy serving (`MCP_PROTOCOL_MODE=legacy`)
never reads it. Behind the stdio proxy, both the proxy and the shared HTTP
backend need it: the proxy declares form elicitation to the backend only when
its own upstream client declares it, and the backend asks only when it is
enabled itself. A backend started by the proxy inherits the proxy's
environment; an already running shared backend keeps its own.
In dual mode, `obsidian_runtime_status` reports the serving process's mode in
`capabilityManifest.applyConfirmation`; legacy responses do not have the field.

The question comes after the plan reference, idempotency key, sealed
projection proof and write policy are checked, and after a read-only check that
the note still has its sealed before bytes. It comes before any journal
transition or Atomic Write call. It names the target, the operation kinds,
changed frontmatter keys, the `planRef` and a digest prefix; it never contains
the sealed text. The form has no field: the answer is the client's accept,
decline or cancel. Because the message names one plan, a host that remembers an
"always allow" per message only re-accepts that same plan.

| Answer | Result |
| --- | --- |
| accept | The exact sealed plan is applied under the usual CAS; the receipt adds `confirmation: "elicited"` |
| decline | `apply_confirmation_declined`, nothing written |
| cancel | `apply_confirmation_cancelled`, nothing written |
| missing, expired, tampered or other-plan answer, or an accept without the declared capability | `apply_confirmation_invalid`, nothing written |
| client error, relay error or timeout | `apply_confirmation_unavailable`, nothing written |
| note changed since planning | `apply_confirmation_target_changed`, not asked, nothing written |

Refusals are errors with `mutationMayHaveApplied: false`, never successes. The
plan stays `planned`: applying it again asks again. After
`apply_confirmation_target_changed`, call `status` and plan again. A plan that
is already committed or applying is not asked again; a late decline for it is
still refused. A request that carries an answer is never treated as a fresh
apply, even without the capability or when the hop cannot carry it. If the
client never answers, the question expires after ten minutes and nothing is
written.

`confirmation: "elicited"` means the client answered accept. A host hook or an
automatic approval policy can answer without showing anything, so it does not
prove that a person clicked. The confirmation never replaces the seal, the CAS
or the write policy; it only confirms the plan named by its digest.

On protocol `2026-07-28` the question is an `input_required` result with an
integrity-protected `requestState`; on `2025-11-25` the server sends a classic
`elicitation/create` within the same call. The stdio proxy relays both: its
backend hop is always `2026-07-28`; it passes the round unchanged to a
`2026-07-28` upstream and asks a `2025-11-25` upstream itself. Errors in either
case are closed refusals, never the host's own text.

Manual check in a host (synthetic test vault only, never a real vault):

1. Start the proxy with the two values above and a fresh backend.
2. Plan an `append_body` on a disposable canary note.
3. Apply it: the host shows the question. Choose Decline. Expect
   `apply_confirmation_declined` and an unchanged note.
4. Apply the same plan again and choose Accept. Expect `committed`,
   `confirmation: "elicited"` and exactly the sealed text appended.

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

All four tools accept `responseMode: compact | detailed` (default compact). Compact preserves references/digests, state, permissions,
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

Before sealing a new plan, the runtime can ask the candidate Atomic Write Bridge to date an undated note. The Bridge requires writes enabled, a loaded and active Frontmatter Date Manager and its `frontmatter-date-manager:update-timestamps-current-file` command. It opens only the target in a temporary tab, checks the source hash and vault binding, then invokes the command. FDM produces every creation and modified value; the MCP never writes a date into the note. It compares the values FDM wrote with the file stat observed by the Bridge just before the command.

The compiler and CAS use a fresh dated read. The durable and compact receipts include `datePreparation`. Source-preservation claims start at that dated source: the requested patch still waits for `apply`, but vault-owned dating can happen during planning. A whole-note replacement carries forward only observed manager-owned date values, while caller edits to protected keys remain forbidden.

### Proof of the dates written by FDM

FDM 1.6.0 writes a missing creation as the file creation time (`file.stat.ctime`) and a missing modification as the file modification time (`file.stat.mtime`), formatted in the local time of the Obsidian process. A creation is therefore usually earlier than the plan, sometimes by years. Atomic Write Bridge 0.9.2 returns, with the dated content, `datePreparation.fileStat`: `ctimeMs`, `mtimeMs`, the UTC offset of each timestamp, and `observedAtMs`, the Bridge clock at the capture. It is the stat observed just before the command, not a copy of the value FDM read a few milliseconds later. The Bridge refuses the preparation if `ctime` moves between the source read, the command and the end of the observation.

The MCP checks each date by role, for the four plan tools (text patch, frontmatter patch, note replace, Base rows):

- an added creation must equal exactly the local rendering of `ctimeMs` with its own offset (`yyyy-MM-dd'T'HH:mm` or `…:ss`), and `ctimeMs` must not be later than `observedAtMs`; no time window is accepted for a creation;
- an existing creation must stay byte-identical;
- an added or changed modification must equal the local rendering of `mtimeMs` (when `mtimeMs` is not later than `observedAtMs`) or fall in the request window between dispatch and the MCP's fresh read; that window, which uses the MCP clock and the current offset, qualifies the timing of the write, not its provenance;
- every other byte, outside the qualified date lines and the reported line-ending conversion, must be unchanged.

When the Bridge advertises `datePreparation.fileStatProvenance` but the proof is missing, of an unknown version, outside the representable range (milliseconds from 1973, four-digit years) or has a non-integer offset or one beyond ±840 minutes, the preparation is refused after dispatch, the lock stays and nothing is replayed; the MCP never falls back to the previous check.

A Bridge that does not advertise `fileStatProvenance` (0.9.1 or earlier) cannot prove an added creation. A note that needs a preparation is then refused before any lock or dispatch with `date_preparation_bridge_upgrade_required` and `mutationMayHaveApplied: false`: nothing changed and the note is not locked. The calling agent asks the vault owner to update the Atomic Write Bridge to 0.9.2 or later, then plans again; it does not retry before. Notes that already have their creation date and notes outside date management keep working with an older Bridge.

No active manager or absent command fails closed with `atomic_write_creation_property_missing`. Once preparation has been dispatched, a timeout, lost response or unverifiable effect returns `date_preparation_unverified` and `mutationMayHaveApplied: true`. When the Bridge answered and a verification failed, the public error also carries `preparationCheck`, a closed sub-cause without path or value: `fresh_read_mismatch`, `non_date_drift`, `created_drift`, `created_missing_or_duplicate`, `created_provenance_mismatch`, `modified_provenance_mismatch`, `provenance_missing_or_invalid`, `format_unqualified` or `unclassified`. The agent reports it to the user and follows the [procedure for notes locked by a date preparation](administrative-closure.md#notes-locked-by-a-date-preparation); it never replans in a loop. The server logs the same sub-cause as a warning, without path or value. A durable target fence prevents another preparation or patch plan even after restart: no automatic replay is allowed. After review, `obsidian_operation_close` with `datePreparationPaths` can release the lock when the Bridge proves that no effect can still occur. No patch is sealed on uncertain evidence. If preparation normalized an existing noncanonical frontmatter, `datePreparation.frontmatterNormalization` announces the effect and binds its source and prepared hashes. The fresh read must match the native canonical source outside qualified date lines, with the separately reported editor line-ending exception.

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
