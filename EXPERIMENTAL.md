# Experimental headless integration

`exp/headless-autonomy` integrates headless changes for evaluation on a local
copy of a vault. Its base is `2636214bf976e492a9e545a4705d9f2a09b4ae1d`.
This branch leaves `main` and the individual pull requests unaffected.

| Pull request | Integrated head | Behavior |
| --- | --- | --- |
| [#202](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/202) | `3dd977a7d5d1c3b12a1efc7a52228dc290848c7e` | Filesystem write serialization and conflict checks |
| [#204](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/204) | `6568cb6ad6b82f207c34225c5dcf80caf235db9a` | Headless Bases returns rows only for an explicit `property_only: true` scan, including for a filterless Base |
| [#205](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/205) | `12890e70897675a2becad16210d98e8559fd1132` | Read provenance, successful scan start time, and index freshness reporting |
| [#209](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/209) | `f628b91a56c46a8ad5d5b98ff98fe73f4cc5dac0` | Bases Bridge tests replay a capture from Obsidian 1.15.1 |
| [#210](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/210) | `de81ed30427fd7a33158ef4d8de2bbd6504ee269` | Semantic search reads external generations selected by a strict `CURRENT` pointer |
| [#212](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/212) | `12a1489b590aa63107b294c5800e3f688a61f896` | BitNet producer with Smart Connections block selection, configurable minimum sizes, and deletion guards before encoding and publication |
| [#217](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/217) | `9710f22b365ebc773ddbfb5e7fc899bb2edb3fb7` | Formula diagnostics recognize registered function names regardless of case |
| [#218](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/218) | `488cb4fcef6f9e8f8a34d0ee4c68b8a96220ee25` | Exact Markdown reads can succeed during the cold cache build |
| [#219](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/219) | `da7ef45f3c74f2b10cc053406ea609ceace398dd` | Shared HTTP startup test helper waits for the listener before probing it |
| [#220](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/220) | `2fd17ad831bd97b0bc2c413321ac0b1d167f80e2` | Import a text patch proposal into a sealed plan and recover its receipt after a lost response |
| [#223](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/223) | `1ac99ddd625a734c36855ff6e879917cb61354ff` | Notes expose the read SHA-256 for optional strict-base replacement planning |
| [#228](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/228) | `a7f7c7c01c73b3156351fbb95027904e095bb3d4` | Shared Markdown frontmatter parser handles CRLF, BOM, and literal YAML dates |
| [#229](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/229) | `215f1de9a3f019ed9d04632c1e12485d901f56cd` | Headless inventory excludes dot-prefixed files and directories by default |
| [#232](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/232) | `353b97e0011eb9aa6278f99dbf43416776124600` | Live reads reconcile stale metadata from the same response and report `metadataCacheStale` |
| [#233](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/233) | `d9befb4dc7e062e11a2f9a7af2bbb77641ed63e7` | Vault path aliases support NBSP and narrow NBSP, expose the physical spelling when needed, and refuse ambiguous REST aliases |
| [#234](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/234) | `e1f340c4fd00c2ddf7a3555c37100aa9cb4652db` | Bases Bridge 1.3.1 and headless share the request filter grammar and report the invalid node before selecting rows |
| [#224](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/224) | `99b2afbc6ba6f9c2b54eb80fa12576fde13af82e` | The producer can bootstrap an external generation from compatible Smart Connections vectors and reproduce the 4.7.2 selection rules |
| [#238](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/238) | `7a1065bba590fdd2d633bb7ec805c9de9b7d09ab` | Regex search anchors match each line in live and headless modes |
| [#239](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/239) | `2f42c5da8dacd4e0527e0a699aa9c54d264bafb9` | Bases Bridge 1.3.2 uses native row selection in both live query modes and omits formula columns with `evaluate: false` |
| [#240](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/240) | `6f69fb15a1476c84509e781c997dda02e2750670` | Headless frontmatter and SQLite note links. The background parser runs in a worker, splits large notes at block boundaries, and tracks completeness per source |
| [#241](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/241) | `0ab243287b173d10da8411be546a64bb5ac97895` | Live compact listings and global search report `diskPath` when a unique physical spelling uses NBSP or narrow NBSP. Search accepts up to 500 result files per page |
| [#242](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/242) | `c6ac776c0f0fe8527bfede421312c8f7de7317c6` | Vault-bound Sync evidence and optional write guard, plus the incremental semantic indexing service with leases, bounded retention, and status |
| [#243](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/243) | `45bb0fec8b600941072f835953ac114fdaaf70e1` | Governed move, backlink rewrites, trash and recovery in `headless-filesystem` with full write mode. Link index revision `v11:` |
| [#244](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/244) | `dc6e7a12519942e5719827c9c3ec4784eb9086c2` | Reads and validates Operon tasks from Markdown and synchronized settings in all three headless modes, with filesystem provenance and local saved filters |
| [#245](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/245) | `8bef7f1ed9f05cd0af3ddcf9c9ec75470721a42b` | Governed filesystem Markdown patches, creation, replacement and revert with a per-vault journal and native exchange on supported Linux/macOS filesystems |
| [#246](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/246) | `5b3edb76c2003e1370a448190f61aa4ac866cef9` | Ranked BM25 search over cached Markdown and hybrid search with lexical, note, and section signals |
| [#247](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/247) | `9cdf0af6e82f56373c88e66f7d7c8c682f90c43e` | Retries Operon `GET /status` once after a socket reset, with fixture connection cleanup |

Run the read-only profile first. Test filesystem writes on a separate,
disposable copy using synthetic notes. Write serialization is process-local.
Upstream Sync stays unknown unless a valid vault-bound heartbeat is configured.
Headless property scans do not run
the Bases engine. Semantic search requires a complete generation and a
compatible encoder. The producer's v3 input profile requires an explicit
rebuild of generations made with the older block selection. See the [producer](docs/semantic-index-producer.md) and
[reader](docs/semantic-vector-cache-encoding.md#external-smart-env-v3-generations)
contracts. Proposal planning needs the live Atomic Write authority. Apply
retains the sealed plan and its compare-and-swap check.

The optional Sync guard still runs before effects on the legacy paths that
use the shared vault file service. The new governed Markdown authority does
not consume the Sync heartbeat. Keep the experimental write vault isolated
from bidirectional Sync. Each write family retains its own concurrency
checks. The governed Markdown authority and the move/trash lifecycle use
separate journals and do not share a cross-family lock.
Exact disk reads retain their independent observation time. Semantic service
status comes from the current generation and its expiring observation.

The #240 update merges cleanly. The #246 merge keeps the SQLite checkpoint
and inventory in one read transaction, increments the BM25 generation when
the visible inventory changes, and preserves hot-content and link-index
invalidation. Global search retains live `diskPath`, multiline regex and the
500-file page limit alongside ranked scoring and ranked snippets. Live
`diskPath` enrichment runs only when the exact REST search succeeds.

The BM25 index warms after the text cache. A first ranked request waits for
the index. Hybrid search can fall back to lexical results and uses compatible
note and section vectors when available. The worker's link extraction limits
can leave individual sources incomplete.

The #243 merge preserves the existing changelog entries. The runtime
suite runs both headless Operon and note-operation tests. Static profiles
keep read-only Operon in all headless modes and use the extended governed
move and trash lifecycles only in `headless-filesystem`. The old index
revision remains only in a test fixture that verifies migration.

The #245 merge preserves #243's cache-backed move and trash lifecycle and
#244's Operon reads. It adds the guarded Markdown families to both writable
headless modes, with replace and revert in `headless-filesystem`. The merged
tool catalogue and cycle checks verify those combined profiles. The tests
retain the Sync guard check on the compatible filesystem move route after
the old headless note-edit routes were retired.

Known integration regression. In the runtime `tasks` profile,
`obsidian_note_replace_plan` acts as the marker for live Operon tools.
#245 also registers that plan in `headless-filesystem`. The marker then
exposes live-only Operon tools in that headless catalogue.
`test:operon-headless` catches the extra tools.

The merged replacement runtime retains #223's exact base-hash precondition
and #220's proposal sealing and retention. It also retains #245's disk
witnesses, divergence cleanup, date policy and per-vault filesystem journal.
The bilingual operations and capability guides describe both write
lifecycles. `OPTIMIKE_VAULT_TIMEZONE` qualifies Frontmatter Date Manager
against the process timezone. `OPERON_TIMEZONE` separately interprets
Operon's local dates. Set each to match the vault when using both features.
Windows refuses existing-note replacement by default. The explicit
`MCP_HEADLESS_ALLOW_TRANSIENT_ABSENCE=true` fallback can temporarily hide
the note path and is for a copy without bidirectional Sync.

The #244 merge keeps the exact tool sets from the shared catalogue in the
HTTP, stdio proxy, and static profile tests. The `tasks` catalogue includes
both the new Operon reads and #240's frontmatter and note links. The
changelog and bilingual guides retain Sync evidence and external semantic
generations alongside the new Operon entries.

Headless Operon can decode canonical Markdown fields without the plugin
settings. Configuration and saved filters require a synchronized
`.obsidian/plugins/operon/data.json`. Active timers and writes require
Desktop. See the [headless profile](docs/headless-server-profile.md#operon-without-desktop).

On this branch the proposal HTTP test from #220 uses #219's shared startup
helper. Its lost-response, redaction, and shutdown assertions still run.

With #205 and #218 combined, direct exact reads include
`readPath: "direct-filesystem"`, their own `observedAt`, and `partial: false`
in the provenance. The full inventory may still be refreshing. Cached reads
keep the successful scan's start and refresh timestamps. The regression test
exercises both responses on the same note.
Carry commit `1d52fc50fb1b5a1d96e08a7ac4851ba25fb83b86` into `main` when integrating #218 and #242. It updates the exact cache freshness test to require the three null Sync evidence fields when upstream Sync is unknown.
Also carry commit `a249eabee7dbcb2a3954e2e702f6406d01879e32`, which applies the same exact Sync provenance expectation to the cached read.

The headless Bases scan validates request filters with #234's shared compiler
before enforcing #204's explicit opt-in. It reads note properties with #228's
CORE-schema parser, which preserves literal dates. The scan supports local
property sorts. Formula evaluation and view queries still need Obsidian.
Live property tables require Bases Bridge 1.3.1 or later. This branch ships
1.3.2. Live queries explicitly refuse when native selection is unavailable.
Governed Base row operations still request the supported-filter snapshot on
the qualified Bridge route. Both paths use the shared request filter compiler.

The strict external generation reader and the bootstrap tool share the Smart
Environment readers. The external reader still checks the manifest model,
row counts, and vault-relative Markdown paths. Bootstrap checks the source
model, vector references, selection metadata, and a bounded sample against
the configured encoder. Builds that use the existing `bitnet-markdown-v3`
selection can keep their published generations. The 4.7.2 selection applies
when explicitly selected. See the [bootstrap contract](docs/semantic-index-producer.md#bootstrap-from-smart-connections-v3).

When a cold read bypasses the cache, it reports the exact physical spelling.
Alias resolution uses the completed inventory.

Headless frontmatter uses the shared CORE-schema parser. Live reads retain
stale metadata detection. The text cache becomes ready before the link index.
While that index builds in the background, note links return
`headless_link_index_building` with `retryable: true`. Frontmatter remains
available. SQLite changes invalidate hot note text across processes in both
headless and hybrid modes. Hidden notes remain excluded by default, with
explicit reinclusions supported. Heading and block validation requires
Desktop. The reviewed parser keeps bare URL handling, skips the GFM bare-email
tokenizer and includes a differentially tested shortcut for plain wikilinks.

## Add another change

1. Check out `exp/headless-autonomy` in its integration worktree with a clean
   working tree. If the remote branch advanced, fast-forward to it first.
2. Fetch the intended head with `git fetch --no-tags origin refs/pull/<number>/head`.
   Record `git rev-parse FETCH_HEAD` and merge that SHA using `git merge --no-ff`.
   Skip heads already in the branch. Merge advanced heads separately and keep
   the behavior and tests from both sides of conflicts.
3. Build and run each affected PR's focused checks, `npm run smoke:headless-server-profile`
   against a synthetic fixture, `npm run test:http-headless-multiclient`,
   `npm run test:docs`, and `git diff --check`.
4. Record the newly integrated heads here and push `exp/headless-autonomy`.
   Keep private pilot files, vault copies, credentials, and transcripts outside Git.
