# Administrative closure and the Bridge effect fence

`obsidian_operation_close` closes a governed write whose outcome stays
`outcome_unknown` as `reviewed_unverified`, or releases a
`date_preparation_unverified` lock, after the owner reviewed it. It never writes
a note, never claims success and never replays an effect.

## Why the journal alone is not enough

A request already sent to the Atomic Write Bridge can still change the note
after the MCP lease expired and the journal recorded `outcome_unknown`. Marking
the journal closed would therefore not exclude a late effect (reproduced by
`scripts/test-effect-fence-closure.mjs`, case 1). Closure is only allowed when
the Bridge itself proves that no attempt of the operation can still reach its
effect point.

## The effect fence

- The Bridge issues an **epoch** at each plugin load (`status.effectFence`). An
  unload closes it; an Obsidian restart discards every pending handler.
- Before dispatch, the MCP journal durably records an **attempt token**
  `{ epoch, attemptId }` with a compare-and-set that fails once the attempt no
  longer owns the `applying` plan. A stale executor therefore never dispatches.
- The Bridge admits the token **synchronously at the effect point**: inside the
  `vault.process` callback (note and Canvas CAS), immediately before the
  `O_EXCL` create, immediately before `renameFile`, and before the temporary
  leaf used for FDM date preparation. A revoked, replayed or superseded token
  is refused there (`effect_fence_refused`, HTTP 403), with no effect.
- `POST /extensions/obsidian-atomic-write-bridge/effect-fence/resolve`
  (`mode: inspect | revoke`) returns one verdict per token. Revocation is
  irreversible and handled on the same JavaScript thread as admission.

| Verdict | Meaning | Closure |
| --- | --- | --- |
| `revoked_before_effect` | never passed its effect point and never will | allowed, `priorEffect: none` |
| `effect_in_progress` | passed its effect point, not settled | refused, retry later |
| `effect_settled` | passed and settled `settledAgoMs` ago | allowed after max(60 s, sealed date delay), `priorEffect: may_have_occurred` |
| `epoch_unknown` | the realm that held this epoch is gone | allowed, `priorEffect: unknown` |
| `not_reached` | inspection only: could still arrive | dry run reports `would_close` |

## Attempts sent without a token

Plans dispatched by MCP 3.14 or older, or to a Bridge without the fence, carry
no token (`effectTracking` absent, sticky `untracked`, or an attempt without
epoch). They can only be closed when the Bridge setting **Require a fence token
for every write** has been continuously enabled for at least 10 minutes and no
unfenced write admitted in this Obsidian realm is still running
(`legacy.quiescent`). From then on no unfenced request can pass any effect
point, and older Bridge builds in the same realm had time to finish. The
receipt records `priorEffect: unknown` and the legacy proof. Enabling the
setting refuses writes from MCP clients that do not send tokens. Keep it
enabled: the legacy guarantee holds while it stays on, or once no MCP process
of an older release is still running (only such a process could deliver an
unfenced request again).

## Refusals (nothing changes)

`closure_bridge_unavailable`, `closure_fence_capability_missing` (Bridge without
the fence: fail-closed), `closure_binding_mismatch`,
`closure_operation_still_applying`, `closure_effect_in_progress`,
`closure_effect_settling`, `closure_legacy_requires_fence_requirement`,
`closure_legacy_quiescence_pending`, `closure_state_changed`,
`closure_operation_kind_unsupported` (Canvas, Base Formula and asset import keep
their own journals), `closure_not_applicable` (planned or already terminal),
`closure_plan_not_found`, `closure_plan_ref_invalid`, `closure_path_invalid`.
Before evaluating the fence, the tool runs the family status reconciliation;
an exact effect is reported as `not_needed` with `outcome: committed`.

## Receipt and retention

The closed row keeps `administrativeClosure`: reason code, Bridge version,
binding and epoch, per-attempt verdicts, legacy proof, `priorEffect`,
`guarantee: no_further_effect` and an observation of the current note hash
(`before`, `after` or `neither`; never content). Sealed `nextContent` is erased.
`reviewed_unverified` rows are terminal, leave the cockpit and are not purged by
the stable-terminal retention. Repeated calls return `already_closed` with the
same evidence and send nothing to the Bridge.

## FDM date preparation lock

`date_preparation_unverified` blocks plans on a note after an uncertain FDM
preparation. The lock now stores the preparation's token. `datePreparationPaths`
releases it with the same verdict rules and keeps the review in
`obsidian_date_preparation_fence_reviews`.

The lock now stays only when the preparation may have acted:

- Any failure of the preparation request is checked against the fence. A
  Bridge fence refusal, or a revocation verdict `revoked_before_effect`, proves
  that this attempt never reached its effect point and never will: the lock is
  released at once and the plan fails with a retryable reason —
  `date_preparation_not_started` (note edited meanwhile, request not
  delivered), `date_preparation_fdm_pending` (see below) or the original
  `atomic_write_creation_property_missing`.
- A lock left because the Bridge could not answer is released at the next plan
  on that note once the Bridge proves the attempt never started (that attempt
  is revoked; a concurrent preparation of the same note then fails before any
  effect and must be planned again).
- A started or settled attempt, a lock without token, or a Bridge without the
  fence keeps `date_preparation_unverified`: owner review and
  `datePreparationPaths` are required.

FDM's own pending work is no longer raced. FDM 1.6.0 opens a window
(`delayForNewFiles`, 20 s in ÉLYSIA) for every new file and replays, after it,
a pass for any modification made inside it; debounce, retry and manual passes
are also queued per path. Before its effect point the Bridge now waits until
FDM has nothing pending for the note (`recentlyCreated`, `newFileTimers`,
`newFileModified`, `modifyTimers`, `manualPending`, `processingFiles`,
`bulkRunning`), then re-reads the note: if FDM changed it meanwhile the
preparation is refused before any effect. When the wait does not fit in the
request budget (55 s) it refuses with `date_preparation_fdm_pending`. FDM builds
that do not expose these queues keep the previous behaviour.

Manual procedure when the tool cannot be used (Bridge without fence, Bridge
unreachable for good):

1. Quit Obsidian completely (no window left) and stop the MCP backend and
   every MCP client. This ends every pending Bridge handler and executor.
2. Read the note on disk and decide whether its current frontmatter is
   acceptable; correct it in Obsidian later if needed.
3. With both still stopped, run
   `node scripts/release-date-preparation-lock.mjs --journal <journal.sqlite> --list`,
   then the same command with `--release <targetDigest> --confirm`. The script
   refuses while the Local REST or backend port answers and records the manual
   review before deleting the lock, in one transaction.
4. Restart Obsidian, then the backend; plan again.

## Batch closure of historical operations

`scripts/close-pending-operations.mjs` pages
`obsidian_list_pending_operations` (`status: outcome_unknown`,
`closeAllowed: true`) and calls `obsidian_operation_close` in batches of 20,
first as a dry run, then for real with `--apply`. It writes every receipt to a
JSON file and never retries a refusal automatically.
