# Governed atomic note replacement

French version: [governed-note-replacement.fr.md](governed-note-replacement.fr.md)

Optimike Obsidian MCP 2.6.0 exposes the first public non-Operon mutation backed by the
common operation-runtime vocabulary. It replaces the complete content of one
existing Markdown note without exposing a generic `operation_*` API.

## Availability and lifecycle

The four tools are registered only in `live`, or `hybrid` when a shared
Obsidian REST service is configured. They are absent from every headless mode
and from degraded hybrid operation without API credentials.

One `RestAtomicWriteBackend`, `ObsidianNoteReplaceJournal`, and
`ObsidianNoteReplaceOperationAdapter` are built in the application lifecycle.
The same runtime is passed to the stdio server or every per-session HTTP MCP
server and is closed during process shutdown. HTTP sessions never open a
competing SQLite journal.

The journal defaults to the machine-local Optimike MCP state directory. An
operator may set `MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH` to an absolute path.
It must remain outside the vault, repositories, synchronized directories,
published artifacts, and public diagnostics.

## Tool contract

### `obsidian_note_replace_plan`

Input: `path`, complete `nextContent`, and mandatory `idempotencyKey`.

Planning performs no note write. The Atomic Write Bridge reads the existing
`.md` note; that same read supplies the before SHA-256 and the current content
used for structured protected-frontmatter comparison. The server validates the
future Obsidian Markdown, seals target, backend binding, before/after hashes,
request digest, idempotency key, and the private recovery content, then returns
a receipt with an opaque `planRef`.

The same key and canonical request return the same plan. Reusing the key for a
different replacement is rejected. Planning is not classified as read-only:
it creates durable mutation intent and is blocked by `MCP_WRITE_MODE=readonly`.

### `obsidian_note_replace_apply`

Input: `planRef` and the matching `idempotencyKey` only. A caller cannot replace
the target, content, binding, or hashes after planning.

Before any possible effect, the server revalidates the current MCP write policy,
re-reads the target for protected-frontmatter and sealed-hash proof, verifies the
Bridge binding and write gate, then delegates the exact plan to Obsidian
`Vault.process` SHA-256 compare-and-replace. Replay of the same plan cannot
produce a second committed write.

Stable terminal receipts remain replayable after a restart even if the MCP is
now read-only, because that replay cannot produce an effect. A plan that is
still eligible to execute must pass the current write policy; the backend
revalidates it again immediately before every compare-and-replace attempt.

### `obsidian_note_replace_status`

Input: `planRef` only. Status reads and reconciles durable authority. It may
classify a previously uncertain operation from current proof, but it never
executes a new mutation.

After a timeout, process interruption, or lost response, call `status` first.
Do not create a new mutation or blindly retry with a new idempotency key.

### `obsidian_note_replace_recover`

Input: `planRef` and the matching `idempotencyKey` only. Recovery reconciles or,
when proof shows it is safe, resumes the exact same sealed plan. It accepts no
replacement payload and cannot reactivate a stable terminal plan.

`recover` is not undo. It never promises to restore the note’s previous state.
The same terminal-replay rule applies: read-only mode does not hide an existing
terminal receipt, but it still blocks every recovery that could write.

## Security and durable authority

The current MCP write policy is enforced in addition to the default-off Atomic
Write Bridge gate. In guarded mode the target remains explicit and
vault-relative and content stays within configured limits.
`MCP_PROTECTED_FRONTMATTER_KEYS` cannot be bypassed by replacing the whole file:
frontmatter is parsed as YAML and compared structurally, not by regular
expression. The Markdown body is passed to the Bridge exactly as supplied.

The note-replacement journal is the sole durable authority for this operation.
Non-terminal plans retain sealed `nextContent` only for exact-plan recovery.
Stable terminal transitions redact that content and checkpoint sensitive WAL
frames; terminal receipts are retained under the existing bounded policy.
Receipts and logs never expose `nextContent` or the physical journal path.

### Bounded modified-time settlement

Atomic Write Bridge 0.2.0 reports the exact modified-time property configured by
an enabled supported integration: Frontmatter Date Manager, Update Time, or
Update time on edit. Planning seals that policy only when the property is also
listed in `MCP_PROTECTED_FRONTMATTER_KEYS`.

The write precondition remains an exact whole-file SHA-256 CAS: settlement does
not weaken pre-effect CAS. No timestamp is ignored before the effect. During
postflight, lost-response reconciliation, or status after interruption, the
adapter may accept exactly one additional top-level frontmatter line only when
all of these facts are proven:

- it is the unique configured modified-time property reported by the Bridge;
- both values are canonical local datetimes and the observed value advances;
- the observed timestamp falls inside the real, at-most-five-minute apply and
  settlement window recorded by the durable attempt;
- replacing that one observed line with its sealed value makes the whole note
  byte-identical to the sealed after content.

The receipt records both the sealed target SHA-256 and the actual settled
SHA-256. Any body, YAML, second-line, non-monotonic, out-of-window, unprotected,
or unconfigured drift remains unverified. A Bridge that does not advertise this
additive contract retains the previous exact-hash behavior.

## Effect boundary

The atomic guarantee covers one controlled resource: the target note content
changed by Obsidian `Vault.process` under an exact SHA-256 CAS precondition. It
does not form a distributed transaction and does not reverse effects emitted to
Sync, watchers, third-party plugins, indexers, or external automations.

## Evidence and release gate

The permanent deterministic gate runs the compiled MCP server through the real
SDK stdio client and mocks only the Obsidian/Atomic Write HTTP boundary. It
proves schemas and annotations, nominal convergence, replay, lost response,
process restart, exact recovery, concurrent apply/recover, two-plan CAS
competition, backend binding, policy changes, protected frontmatter, and sealed
content non-disclosure. It also covers a lost response followed by one bounded
Frontmatter Date Manager timestamp, restart reconciliation, and rejection of a
timestamp accompanied by any real concurrent drift.

The concurrency fixture also forces two journal connections to observe the same
planned operation. The loser of the conditional `planned → applying`
transition reloads and returns the durable winner instead of exposing an
internal error or attempting another write.

Post-commit cache refresh treats an empty Markdown note as valid content. The
integration gate commits an empty replacement, verifies the shared SQLite row,
then disables REST reads and proves that the cache fallback returns the empty
note rather than stale pre-replacement content.

The recovery fixture also covers a delayed original executor committing before
a third-party edit makes the note match neither sealed hash. A subsequent CAS
conflict remains `outcome_unknown`; it is not collapsed into a terminal
conflict merely because the recovery attempt itself did not write.

A second gate starts the real Streamable HTTP server and carries one sealed plan
across three independent MCP sessions. It proves that per-session server
factories share one application runtime and one journal, commit one backend CAS,
and close that authority cleanly at process shutdown.

Every applying row also records its runtime instance owner. A durable heartbeat
lease proves that exact instance is still active without trusting a reusable OS
PID. Opening the same journal from another MCP process leaves a fresh lease
untouched; lease expiry or explicit owner shutdown makes exact-plan recovery
eligible. This prevents an independently launched client from manufacturing an
interruption while another process is still executing the CAS.
Every transition leaving `applying` must also present the distinct attempt ID
observed by that executor and match the current durable payload. The runtime
instance remains the lease owner, but each recovery gets a new attempt fence.
An executor resuming after its lease expired therefore cannot terminalize a
plan already recovered, even inside the same process.
The default journal filename is separately namespaced by a stable non-secret
digest of the configured runtime mode, REST base URL, and vault path; an
operator may provide an explicit stable profile ID. Plans and idempotency keys
therefore cannot cross backend profiles unless an operator deliberately forces
the same journal path.

The SQLite busy policy is installed before WAL negotiation, schema creation,
migration, lease, or journal writes. Startup retries only bounded transient
contention and closes its connection on a terminal initialization failure. A
heartbeat timeout in an already-running process is contained and retried; it
does not terminate the MCP server.

`npm run smoke:atomic-note-mcp-live` is a separate fail-closed operator canary.
It requires an explicit disposable existing note and confirmation string,
saves a durable private backup before mutation, proves a real Bridge CAS
rejection and the four public MCP tools, restores the fixture, and writes a
redacted evidence record directly under the OS temporary root. The exact
`evidenceFile` is printed. Successful or safely handled pre-mutation runs delete
the private journal/log/backup directory; abrupt interruption or unverified
restoration retains it at the recovery path printed before the MCP starts. This
live Desktop gate passed on 2026-08-14 with the final SHA-256 equal to the
pre-mutation SHA-256. These guarantees are released in Optimike Obsidian MCP
2.6.0; later capability paliers remain separate repository-authority decisions.
