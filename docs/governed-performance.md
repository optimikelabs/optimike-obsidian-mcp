# Governed performance follow-up

Body and YAML intentions can share obsidian_text_patch_plan via frontmatterOperations.
Compact receipts and opt-in per-call diagnostics are additive; existing callers keep
detailed responses. No date-settlement deadline is reduced.

FDM 1.6.0 exposes private modify/new-file timers and processing sets, including editor
and cache deferrals. Those implementation details are not a stable completion contract.
The 37,250 ms fallback is retained. The locally qualified completion contract
is documented in fdm-completion.md; only a complete bound acknowledgement can
certify before that fallback. V2 shortens initial MCP modify debounce to 100 ms,
while every native retry gate remains intact. A metadata-event wake-up was tested
and retired because its small local difference did not justify the added code.

Two planning reads are retained: projection compilation and child admission recheck.
Their measurable contribution should justify any private snapshot optimization before
removing the second check. Apply-time read/protection validation and Bridge CAS remain
mandatory, independent of future planning optimizations.

FDM representation drift is reconciled only inside authorized frontmatter keys whose
presence and parsed values remain identical. Protected keys are sealed privately at
admission and are excluded, including dynamic date-role bindings. The original exact
date-only validator still proves every byte outside those ranges. The observed hash
is the original file hash, not the normalized comparison input. Earlier plans without
the private protected-key list keep strict behavior; they are never silently upgraded.
Two live failures that exposed quoted-string normalization are retained as unknown
outcomes on deleted synthetic notes, not relabeled successful. Subsequent corrected
campaigns have separate measured proofs and cleanup receipts.

Operon cold snapshot refresh overlaps independent configuration and task-page
reads. Task generation, page totals, validation, final status and configuration
signature checks all remain mandatory before the one snapshot commit. No live
observation is replaced with a TTL or labelled fresh from an unchecked cache.

Plain Markdown obsidian_read_note with includeStat=false does not construct
formatted statistics or initialize/tokenize with tiktoken. JSON and explicit
statistics retain the existing token count and timestamps, for live and cached
reads. The content itself is still read from the original authoritative source.

Blocking verified note/projection applies also persist the completion token before
polling the same fenced status reconciler at 250 ms. This includes one-existing-row
Base projections, which already call the note runtime in verified mode. The wait
budget is the original sealed observation deadline (37,250 ms on this installation),
not the private token lifetime. A known pending signal or failed probe at that
deadline returns applying; later status certifies or expires under the existing
five-minute contract. No-token plans retain the original single-delay path.
This does not convert bases_upsert_rows into a governed multi-row transaction.

### Measured local improvements

These successive small-fixture campaigns used the shared stdio/HTTP backend, Obsidian and Local REST API 5.4.0. They are conditional measurements, not an SLA or randomized study. The faster certification requires the qualified optional FDM completion integration; unchanged FDM installations retain conservative settlement.

| Path | Before | After (median) | Sample / condition |
| --- | ---: | ---: | --- |
| Combined governed edit, complete certification | 37.71 s | 1.52 s | After n=5, range 1.23–1.80 s; compatible FDM add-on |
| Blocking verified body/frontmatter apply | 37.53 s | 1.54 s | Before n=1, after n=3; compatible FDM add-on |
| One existing Markdown Base row apply | 38.00 s | 1.73 s | Before n=1, after n=3; compatible FDM add-on |
| Forced Operon snapshot refresh | 6.74 s | 5.03 s | n=3 per campaign |
| Compact terminal receipt | 4,217 bytes | 1,065 bytes | Three combined terminal statuses; ~75% fewer JSON bytes |

Early certification retains hash comparison, date protection, idempotent replay and concurrent-drift refusal. Pending or invalidated FDM signals are not relabeled successful. A single combined body/YAML intention also avoids a second CAS and settlement cycle.
