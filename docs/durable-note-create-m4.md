# M4 — durable exclusive Markdown creation

## Public contract

`obsidian_note_create_plan`, `obsidian_note_create_apply`, `obsidian_note_create_status` are a live-only three-tool family. The existing process-owned SQLite journal is reused; there is no second durable runtime and no synthetic recover endpoint. Planning stores an exact private content snapshot and an observed-absence proof. Apply requires the sealed target/backend/date-policy identity and independent `allowNoteCreates` Bridge grant (false by default). Guarded/full MCP write policy permits explicit bounded content; readonly rejects new plans/effects.

The Bridge uses a local filesystem exclusive create (`O_CREAT | O_EXCL`) followed by file data fsync. Existing files are never overwritten. The parent directory must exist. Hidden/configuration paths, traversal, device paths, symlinks/junctions and hardlink leaves are refused by pre/post checks. A source file is not published under an automatic suffix. This is not a rename, general file writer, or transaction across notes.

A process/OS failure can leave a partial newly created file. Status never repairs, overwrites or deletes it, and apply never redispatches an already admitted uncertain attempt. Directory fsync/power-loss durability and races with hostile processes replacing ancestor directories are not certified. The local vault and host filesystem remain a trusted boundary; do not expose creation against an adversarial shared mount. Windows/Linux filesystem tests do not establish correctness for network or cloud-mounted vaults.

## Receipts and ambiguity

`committed` means the intended resource state was observed, not that this attempt is proven to have authored the file. Every receipt reports `authorAttribution: not_proven` and `indexing: not_certified`. A known exclusive-create conflict remains terminal conflict. After a lost response or process restart, only exact intended bytes or explicitly qualified date-field effects may reconcile an uncertain operation. Absence, partial content, changed binding or unexplained changes remain unverified. There is no automatic retry/new-key policy and no recover/undo tool.

A content-free effect proof is persisted before terminal payload zeroization. Later status compares current bytes with that proof; drift does not revoke the historical committed receipt but makes the current postflight unverified. The existing journal's retention window applies; indefinite idempotency after journal purging is not promised.

If the file exists but its observed content matches neither the sealed bytes nor qualified automatic date effects after the settlement delay, status transitions an `applying` attempt to `terminal / outcome_unknown` with `postflight: unverified`. Apply and recovery remain disallowed; status may later reconcile a qualified observation without redispatching creation.

## Automatic fields

The existing Bridge date-integration discovery and strict timestamp-settlement verifier are reused. Only qualified created/modified fields with a supported format/delay are eligible. Viewed fields, ambiguous keys and unsupported configurations refuse admission. Active automatic fields require an explicit frontmatter envelope in the sealed content. An explicit creation timestamp is never silently replaced. Body changes or unqualified YAML normalization are not accepted. Status may be pending until the advertised delay passes. No arbitrary plugin rewrite is excused.

Qualified automatic timestamp fields are Bridge-managed postflight effects, not caller-authored keys. A protected timestamp may settle after exclusive creation when it was absent from the sealed content. Supplying that protected key in the requested frontmatter remains forbidden at both plan and apply.

## Local qualification still required

Real Pilot2 must check Obsidian file-watcher indexing and plugin-created/modified fields, concurrent exclusive creation, no duplicates/suffixes, lost-response/restart status and absence of collateral. The Bridge does not certify Obsidian indexing from filesystem existence. Do not merge/promote until the exact candidate passes the ordered local gate.
