# FDM completion contract — local qualification

This local extension qualifies the audited FDM 1.6.0 build whose original main.js
SHA-256 is ab07d62224b415cba7d978e2e8a87a27dac568842dc7f137a381925fc9f315fb.
It preserves the existing metadata-freshness guard and all settings. It is not an
upstream FDM release or a portable/mobile qualification.

The FDM-owned `optimikeSettlement` API (contractVersion 1,
implementation elysia-fdm-1.6.0-v2) observes the existing modify pipeline. Only
the initial modify debounce of a live admitted checkpoint is 100 ms instead of
2 seconds. Certification ends that acceleration; cancellation, settings drift,
unload and checkpoint expiry also end it. It never changes a timestamp.
Native metadata, dirty-buffer, rate-limit, lock and new-file retry delays remain
unchanged. A successful pass without an active checkpoint adds no vault read/hash. A checkpoint is opened before CAS, activated
only after successful CAS, and acknowledged only by a successful locked modify
pass started after activation. A later modification invalidates its generation.
The acknowledgement includes the SHA-256 of the bytes observed after that pass.

Readiness refuses outstanding modify/new-file timers, remembered/manual work,
locks, asynchronous pre-lock file-open work, bulk work, rename suppression, paused
automatic dates, changed settings and an unsafe editor. The lifecycle closes its
event listeners and restores wrappers on unload. Checkpoints/Bridge receipts are
bounded to 512 and five minutes; a maximum five-minute pending observation is
reported unknown instead of certified.

The Atomic Bridge keeps an opaque per-CAS token, fences plugin identity, epoch,
configuration, generation and observed hash across a content read, and returns
optional completion metadata. Invalidated/absent receipts fall back to the original
sealed observation delay. Pending receipts remain pending even after that delay.

The MCP stores this token privately in deferred postflight metadata, never in the
sealed intent or public receipt. Status can certify early only after the matching
complete acknowledgement, followed by the original exact-byte or narrowly admitted
date/frontmatter-format comparison. Public detailed proof adds completionKind,
completionDigest, completionEpoch and completionGeneration. Replays do not dispatch
another CAS; a backend restart preserves the private token, while a Bridge/FDM
reload invalidates the process-local acknowledgement and keeps the old wait.

Scope: deferred and blocking verified note_replace/text_patch/frontmatter_patch,
plus one-existing-Markdown-row Base projections, via successful note CAS with
exactly one supported FDM integration. Blocking calls poll the same durable
reconciler at 250 ms within the original sealed window; if the signal is still
pending or unreadable at that deadline, they return applying for later status.
Existing plans without a token, CAS conflicts, lost CAS replies, create, Canvas,
Base document operations and legacy bases_upsert_rows retain their original
settlement behavior. No global guard is shortened.
The next suggested status time is 250 ms; certification latency includes client
polling and is not an SLA. An FDM update replacing the local asset removes this
extension; the Bridge then withholds its fast completion capability.

Qualification: real FDM, Bridge and Local REST API 5.4.0; combined edits, editor
deferrals, concurrent drift, reload fallback, exact replay and fixture cleanup.
Hermetic tests additionally cover activation races, all tracked pending states,
content-read generation drift, invalid token/path/binding, configuration changes,
durable MCP proof and observation expiry. Plugin assets are backed up independently
from the common MCP release pointer. No credentials are persisted in evidence.

## Optional installation and rollback

The add-on is opt-in. No MCP start or upgrade modifies FDM automatically.
The installer requires the exact audited FDM 1.6.0 asset hash above and refuses
other builds. It adds the signal to FDM's load and modify paths; it preserves
`manifest.json`, `data.json`, timestamp settings and native retry guards.

From the installed MCP package directory, first inspect the read-only plan:

```powershell
node scripts/install-fdm-completion.mjs plan --vault "C:\Obsidian\Vault"
```

Close Obsidian for the target vault before applying. The closed-vault flag is
an explicit operator attestation, not automatic detection. Keep backups outside
the vault. Installation prints the backup receipt path; retain it for recovery.

```powershell
node scripts/install-fdm-completion.mjs install --vault "C:\Obsidian\Vault" --backup-root "C:\ObsidianBackups" --apply --confirm-obsidian-closed
```

Reopen Obsidian and inspect completion readiness before measuring fast
certification. To undo, close the target vault again and use its receipt:

```powershell
node scripts/install-fdm-completion.mjs rollback --receipt "C:\ObsidianBackups\fdm-completion-ID\receipt.json" --apply --confirm-obsidian-closed
```

Rollback restores the original `main.js` exactly. It refuses changed settings,
manifest or concurrently replaced assets. An interrupted installation retains
an `applying` receipt and the original asset for guarded recovery. If metadata
has subsequently changed, inspect the receipt and backup before manual recovery;
do not overwrite a newer plugin build. An upstream FDM update may replace the
add-on, in which case the conservative certification window remains in force.
