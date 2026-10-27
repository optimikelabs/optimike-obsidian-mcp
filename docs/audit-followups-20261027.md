# Audit follow-ups (27 October 2026)

Non-priority findings of the 27 October 2026 audit, handled after the main fixes. Each section says what changed, what was measured, and what remains an inference.

## 1. Inline tags follow Obsidian's rules

Obsidian's tag rules ([help: Tags](https://obsidian.md/help/tags)): letters, digits, underscore, hyphen and forward slash for nesting, plus Unicode letters and emoji; no spaces; **at least one non-numerical character**, so `#1984` is not a tag and `#y1984` is.

The three copies of the inline-tag regex (`obsidian_read_note` JSON from the cache, `obsidian_validate_format`, `obsidian_manage_tags`) are replaced by one extractor, `src/services/markdownTags.ts`:

- a purely numerical candidate is not a tag: `#107/ #113/ #114/` (pull-request numbers) used to come back as the tags `107/`, `113/`, `114/`;
- a trailing `/` is punctuation; empty nesting segments (`#a//b`, `#/x`) are refused;
- fenced code blocks (backticks or tildes) and inline code spans are ignored, with the same masking `obsidian_validate_format` uses for wikilinks;
- the character set is Unicode, not ASCII: `#RÔLE` and `#stratégie-de-contenu` were truncated to `R` and `stratégie-`; they are now whole;
- a tag starts at a line start, whitespace or an opening bracket, never inside a word or a URL fragment.

Checked against the ÉLYSIA vault (read-only inventory of inline `#…` candidates): `#1`, `#2`, `#3`, `#113`, `#107` and similar numbers are no longer tags; `#seo`, `#digital-prod`, `#Super-Invite` and accented tags are unchanged or now complete. Hex colours written in prose (`#F5B800`) are tags in Obsidian too (they contain a letter) and stay tags; inside code they no longer are.

Not established: whether Obsidian treats `#2025-12-31` (digits and hyphens only) as a tag. The extractor follows the published rule literally (a hyphen is a non-numerical character), so it does. When the live Obsidian API returns the note JSON, Obsidian's own tag list is used as before; only the cache path was affected.

`obsidian_manage_tags` still edits tag text with a literal pattern that does not skip code blocks; that is unchanged.

## 2. Orphan durable journals

Cause (measured on the audit machine): each runtime profile — `sha256({runtimeMode, baseUrl, vault})` — has its own `obsidian-note-replace-*`, `obsidian-base-formula-*` and `obsidian-canvas-*` SQLite file in `%LOCALAPPDATA%\optimike-obsidian-mcp\`. Tests and qualification runs against temporary vaults or ports created one set each.

Prevention: `scripts/test-support/isolated-state.mjs` points `LOCALAPPDATA` and `XDG_STATE_HOME` at a private temporary directory removed on exit. The nine test scripts that were observed to write there (`governed-base-formula-http/mcp`, `governed-frontmatter-http/mcp`, `governed-note-replace-http/mcp`, `http-observability-endpoints`, `mcp-2026-governed-loss`, `tool-surface-runtime-conformance`) import it first. Found by running every `scripts/test-*.mjs` against an empty state directory and listing the ones that wrote into it. A test that starts the real runtime and sets no `MCP_*_JOURNAL_PATH` must import this helper.

Inventory (read-only): `npm run maintenance:foreign-journals` lists the journals of other profiles in the state directory.

```text
node scripts/list-foreign-journals.mjs [--directory <dir>] [--current <journal.sqlite>]...
                                       [--min-age-days 7] [--json]
                                       [--move-candidates-to <dir> --apply]
```

- The running profile is derived from the backend's own environment (`OBSIDIAN_VAULT`, `OBSIDIAN_BASE_URL`, `OBSIDIAN_RUNTIME_MODE`) or given with `--current`; without either the script refuses rather than guess.
- It never opens an original: the database and its WAL are copied to a private temporary directory and read there, so listing cannot checkpoint, create or change anything beside the journal.
- States: `empty`, `terminal_only`, `has_non_terminal` (a `planned`, `applying`, `outcome_unknown` or unrecognised row: always kept), `unreadable` (kept).
- A *move candidate* is empty or terminal-only **and** untouched for `--min-age-days` (default 7), because another profile (another vault, another port) may be live.
- The report holds counts, file names and sizes only: no plan content, note path or idempotency key.
- Default: **lists, deletes and moves nothing**. `--move-candidates-to <dir> --apply` moves candidates (database, `-wal`, `-shm`) aside after re-inspecting each one; moving them back undoes it. There is no delete option.

## 3. Shared-cache WAL growth

Measured on the audit machine: a 167 MB WAL beside a 264 MB cache and 35 % free pages, after 3.5 days without restart.

- `PRAGMA journal_size_limit` is applied on every connection that opens the shared cache (vault cache, semantic cache, tasks cache, Operon snapshot). After a complete checkpoint, SQLite truncates the WAL back to the limit; it never drops committed data or forces a checkpoint. Setting: `MCP_SQLITE_JOURNAL_SIZE_LIMIT_MB`, default `64`, `0` keeps SQLite's default (no truncation).
- `obsidian_runtime_maintenance` gains the action `checkpoint_wal`: `PRAGMA wal_checkpoint(TRUNCATE)` (waits up to the busy timeout for other connections) and, if blocked, `PASSIVE`. It never deletes rows and never runs `VACUUM`. The result is numbers and one fixed label: `mode`, `busy`, `walBytesBefore`, `walBytesAfter`, `logFrames`, `checkpointedFrames`, `freelistPages`, `pageCount`.
- Nothing runs implicitly. `run_maintenance` (checkpoint, `VACUUM`, `ANALYZE`) is unchanged: `VACUUM` rewrites the database and needs free disk about the size of the database. Use `checkpoint_wal` first and `freelistPages / pageCount` to decide whether a `VACUUM` is worth it.

## 4. `operon_list_pending_recoveries` and `operon_recover_mutation`

Both refuse when `OPERON_MUTATION_ALLOWED_PATH_PREFIXES` is set, because recovery records carry no route evidence. That policy is kept. What changed is how it is communicated:

- the refusal now carries `reasonCode: operon_recovery_blocked_by_path_scope` and `retryable: false`, and a fixed message that says it is a policy refusal and not an empty list, that retrying cannot succeed, not to replay the mutation or relax the allowlist, and to ask the vault owner;
- while the allowlist is set, the tool descriptions begin with `UNAVAILABLE in this runtime: …`, so an agent learns it from `tools/list` instead of from a refusal (four of four calls were refused in 21 days).

The tools stay listed, like every other policy refusal (the capability doctor separates discoverability from authorization). Hiding them was not chosen: it would change tool counts per configuration and hide the reason.

## 5. `completionMode: verified` as the default

Not changed. Measurements from 21 days of agent sessions (Claude, approximate client-side durations, `apply` calls that passed `completionMode`; the extract records that the argument was present, not its value; n = 167):

| Result | n | median | p90 | max |
| --- | --- | --- | --- | --- |
| terminal (`committed`) | 150 | 3.7 s | 11.9 s | 39.4 s |
| `applying` | 17 | 0.5 s | 37.4 s | 73.8 s |

The 150 terminal answers can only come from `verified` (a deferred apply returns `applying`); none exceeded 60 s. Most of the 17 `applying` answers came back within a second, so they are explicit `deferred` calls; two took 37.4 s and 73.8 s, which are `verified` waits that ended unsettled, one of them beyond 60 s. Without the qualified FDM add-on the settlement window is about 37.7 s (about 1.5 s with it). Two facts keep the default at `deferred`:

1. A `verified` apply can outlast the MCP client's default request timeout of 60 s (`DEFAULT_REQUEST_TIMEOUT_MSEC` in the MCP SDK; the proxy sets none): one observed wait lasted 73.8 s. A live `apply` with `verified` on 27 October came back as `MCP backend rejected the request (status=unknown)` although `status` later said `committed/verified`; the timeout is the likely cause, not proven.
2. The honest receipt for such a loss (`OUTCOME_UNKNOWN`, `mutationMayHaveApplied`, `nextAction: …_status`) existed only for the text-patch and frontmatter-patch applies. It now covers every governed apply (note replace, create, move, delete, canvas, Base formula, Base rows).

Conditions to switch the default: a live qualification with FDM and the add-on showing no `apply` beyond the request timeout over a representative number of calls, and the ChatGPT connector's own limit measured. Until then, agents that want a terminal answer pass `completionMode: "verified"` themselves.

## 6. Operon latency (diagnosis, read-only)

Measured over 21 days (client-side, includes permission waits): `operon_transition_task` median 30.3 s, p90 102 s, max 197 s; `operon_update_task` 11.1 s; `operon_create_task` 4.4 s; `operon_get_task` **7.5 s** (a read); `operon_query_tasks` 5.5 s; `obsidian_runtime_status` 2.7 s; governed note writes 0.1–1 s.

What the code shows (facts):

- The MCP client for the Operon Bridge has a 180 s timeout, commented *"Operon 3.1.1 can settle a semantic transition/project-serial graph after roughly 80 seconds"*; the Bridge's own apply budget is 120 s (`DEVELOPER_API_APPLY_TIMEOUT_MS`). A transition is designed to be able to take that long in Operon itself.
- Each mutation does, inside the call: a live status fetch, the native apply, a live configuration fetch, then a forced full snapshot refresh (`ensureSnapshot(true)`: status, all task pages, settled status, persisted) before the receipt is returned. Every read does at least a live status fetch, and a full refresh when the index generation changed.
- Every hop goes through Obsidian's single renderer process, measured at about 33 % of a core on average and 2.6 GB. Even a one-task read costs 7.5 s at the median.
- The MCP server did not record how long the native apply and the refresh took separately.

Most probable cause (inference): the native Operon transition itself (graph and project-serial settlement inside Obsidian) dominates the 30 s median; the in-line snapshot refresh adds a second, smaller share to every mutation; a saturated Obsidian inflates both. The audit's single admission slot (`inFlight 1`) means a slow call also delays the ones queued behind it, which client-side timings include.

Added: two log events per applied mutation, `Operon native apply returned.` and `Operon post-apply snapshot refresh finished.`, each with `durationMs`, so the next ten transitions attribute the time without guessing. Refutation test: if the refresh event is a small fraction of the call, the cause is Operon's native settle and only Operon (or the vault's plugin load) can fix it.

Proposed correction, not implemented (it changes the receipt timing contract): return the mutation receipt right after the identity and outcome checks and refresh the snapshot in the background, coalesced, leaving the next read to see a stale-by-generation snapshot and refresh itself. Expected gain: the refresh share of each mutation. A short-lived cache of the live status result across one tool call would remove repeated round trips on reads.

**Implemented in 3.15.1 (server only, Bridge unchanged).** Measured on the pilot test vault (159 tasks, Operon 4.2.0, Bridge 0.9.3, medians of 8 runs; the production renderer is also loaded by Smart Connections, so absolute values there are higher):

| Call | 3.15.0 | 3.15.1 |
| --- | --- | --- |
| Mutation receipt (`operon_update_task`, description) | 15.2 s | 9.0 s |
| `operon_get_task` after a generation change | 4.9 s | 2.0 s |
| `operon_query_tasks` after a generation change | 5.0 s | 3.0 s |
| Three concurrent `operon_get_task` after a change | 5.1 s | 2.3 s |
| `operon_get_task` / `operon_query_tasks`, unchanged generation | 0.7 s | 0.7 s |
| Second `operon_get_task` right after the first (background refresh still running) | 0.7 s | 2.1 s |

- Receipts no longer wait for the snapshot. The refresh runs in the background, coalesced per Bridge and snapshot database. Read-after-write holds in the process: a read reuses the snapshot only once a refresh that started after the last receipt has completed, so it never relies on the generation alone. Tested races: refresh started before a mutation, several mutations during one refresh (one follow-up refresh covers them), a failed refresh followed by a successful read, a failed retry labelled `operon-cache` / `stale`, and two snapshot databases that never share a refresh.
- `operon_get_task` reads one task through the existing Bridge route when the snapshot is behind, fenced on the generation and settings of the status read just before. Parity checked on the pilot vault: 158 of 158 tasks identical to the snapshot copy.
- Qualification finding, fixed: a second write right after the mutation (the date manager stamping the note, Sync, an editor) moves the index while the background refresh runs; the refresh fails and the next read fell back to the snapshot without the mutation (`operon-cache`, `stale: true`, previous value; reproduced 2 of 8 on the pilot vault). Reads now retry transient failures for up to 15 seconds while a confirmed mutation is uncovered: 10 of 10 reads saw the mutation, at about 8 s in that case. Without a second writer the timings above are unchanged.
- A refresh now issues 2 status calls instead of 3 and runs validation alongside the pages.
- Cause of the remaining time (fact, measured): the Local REST API answers in 2 ms, but every Bridge call that reads the index state renegotiates the Operon Developer API session, about 0.7 s each (status 0.75 s, single task 1.3 s, page 1.3 s, validation 1.3 s). Caching that session in the Bridge between index generations would remove most of what remains; it needs a Bridge release and was not done here.
