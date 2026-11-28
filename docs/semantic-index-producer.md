# Standalone semantic index producer

Use Node 22.13.0 or later and a BitNet bridge that exposes its encoding identity at
`GET /health`. Run the installed `optimike-semantic-index` command. From a
checkout, run `npm run build` and use `node scripts/semantic-index-producer.mjs`.

```text
optimike-semantic-index --vault <vault-dir> --index <index-dir> --endpoint <bitnet-origin> --model <model-id> --revision <model-revision> --model-sha256 <expected-weights-sha256>
```

Use a dedicated index directory outside any Obsidian vault on a local filesystem. The
bridge receives the document inputs and their vault-relative provenance. Use a
trusted endpoint and restrict access to the index, including any backups. On
Windows, set access restrictions on the parent directory before the first build.
Supply the revision and SHA-256 from the model distribution or deployment lock.
The CLI checks the weights digest against the digest the bridge reports.

## Corpus and encoding

The CLI scans UTF-8 Markdown without modifying it. Hidden files and directories
(names beginning with a dot) are skipped. Repeat `--exclude-path` for exact,
case-sensitive vault-relative file or directory paths, using forward slashes.
Repeat `--exclude-heading` for exact, case-sensitive titles of parsed headings.
The producer removes their ranges from note inputs and
skips any block that overlaps them. Set these options on each invocation. Linked
entries require an explicit path exclusion. Directory traversal across devices
is refused.

The jsbrains `SmartSource.should_embed` rule selects notes whose file size in
bytes exceeds `--min-note-chars` (300 by default, including when set to 0).
Note inputs use the vault-relative breadcrumb followed by `:\n` and the
Markdown. Block inputs use the parent breadcrumb followed by a newline and the
original inclusive line range. The producer uses the pinned jsbrains parser and
`SmartBlock.should_embed` rule. Set `--min-block-chars` to match the Smart
Connections block setting for the corpus (300 by default). For a Smart
Connections configuration with note and block minimums of 200 and 250, pass
`--min-note-chars 200 --min-block-chars 250`. A parent is
omitted when selected descendants meet both edge lines defined by jsbrains.
Frontmatter and excluded heading ranges are omitted from block search.
CUDA uses `/bitnet/embed-batch` with up to four items across notes. CPU uses
`/bitnet/embed`. Both send `purpose: document` and validate vector identity and
normalization.

The generic jsbrains note adapter estimates a character budget at 3.7
characters per token. The producer sends the exact input and lets the BitNet
tokenizer enforce its context (`max_tokens` from health, 32,768 in the current
bridge). When the bridge truncates an input or reports a size or context
refusal, the producer omits that input instead of publishing a partial vector.
The strict external reader requires a note vector for each source record, so
an omitted note's blocks are also omitted even when they fit the context.
The manifest and CLI output
list skipped paths or blocks with their reasons, including invalid UTF-8
and paths the strict reader cannot load. Filesystem read errors abort the run.

A one-shot run rechecks the full source inventory and source hashes before publication.
Incremental runs only request embeddings for inputs absent from the active
generation, keyed by the exact UTF-8 input and encoding profile. Vault identity,
I/O errors, source changes detected during the build and changes in bridge
identity can stop publication. A live filesystem can still change between the
last check and pointer replacement. Use a stable filesystem snapshot if a
point-in-time source view is required, with a dedicated index root for that
snapshot.

Before encoding, compare the active generation's paths with the new inventory.
Before sealing, compare those paths with the notes that will actually publish.
Refuse publication if more than 10% or more than 50 active paths would be lost.
Use `--max-deletion-percent` and `--max-deletions` to configure the limits.
Renames, newly excluded paths, invalid paths and active notes refused for
invalid UTF-8 or by BitNet count toward the thresholds. The configured note
size rule reports `note_below_min_size` and its skips are exempt. Use
`--allow-deletions` for one run after verifying that the losses are intentional.

## Bootstrap from Smart Connections v3

```text
optimike-semantic-index bootstrap --from-smart-env <smart-env-dir> --vault <vault-dir> --index <index-dir> --endpoint <bitnet-origin> --model <model-id> --revision <model-revision> --model-sha256 <expected-weights-sha256>
```

Use an index directory without `CURRENT`, disjoint from both the vault and the
Smart Environment. The source directories are read-only. Use a stable Smart
Environment snapshot if Desktop is still indexing. The importer matches the
active provider, model ID, dimensions, token budget and v3 fingerprint. It
checks the current note hash, the vector reference and, for a section, its
block key, inclusive lines and block hash. For notes it requires an identical
unfiltered input. When Smart Connections has excluded headings configured,
note vectors are encoded again. A conservative UTF-8 size bound leaves room
for tokenizer overhead. Unmatched, oversized or invalid rows enter the
normal encoding path.

Bootstrap uses the section keys and range selection of Smart Connections
4.7.2 with Smart Environment v3 selection policy 2. It reads the configured
note and block minima, embedding toggle, heading exclusions, file and folder
patterns, and recorded Git ignore rules. Explicit CLI minima override the
settings. The generation freezes that settings snapshot for later incremental
builds on any machine. To adopt another Desktop selection snapshot, bootstrap
into a new index directory. The verification report counts notes at or
below the byte cutoff as exclusions. When the note vector is omitted, its
sections are omitted from the published generation.

Section imports require the source record's selection policy version, block
minimum, and character budget to match policy 2, the effective minimum, and
`floor(max_tokens * 3.7)`. The report counts selected sections with an SC
reference and a missing or incompatible rule in `sectionsWithRuleMismatch`.
Publication stops when this count is nonzero. Use `--allow-selection-mismatch`
to encode those sections through the normal path.

Before encoding any remaining rows, the producer re-encodes a deterministic
sample stratified by vector type and UTC encoding month from the SC reference,
with an unknown-month stratum. The default is up to 100 rows. Use an encoder
with a fresh document cache. If the bridge reports a
cache hit, the check stops. The minimum cosine must reach 0.995 and the median
0.999. The v3 fingerprint does not identify the original weights or preserve
every historical input. The current heading exclusions do not establish which
rules were active when historical vectors were encoded. SC's 32-bit text hash
uses the low byte of each UTF-16 code unit, so a matching hash can conceal text
changes. The manifest marks imported rows as `sc-hash32` and preserves the
marker when reusing them. It also records the sample result, population and
comparison counts per stratum, and imported and encoded counts by kind.

Add `--verify-only` to report import coverage, rows that require encoding and
sample agreement as JSON. The report also compares section keys with eligible
Smart Environment references, including references outside the scanned corpus.
Use `--max-samples` with a value from 20 to 500 to set the cap in either
bootstrap mode. Verification-only uses the producer lock and can create the index directory.
It does not encode the remaining rows or publish a generation.
The queued counts are measured before the encoder can refuse an item for length.

## Service mode

Run `optimike-semantic-index service` with the same vault, index, encoding and
selection options as a one-shot build. The service polls Markdown inventory
every 15 seconds by default (`--poll-ms`) and debounces new changes
(`--debounce-ms`, default 5 seconds). Continuous changes cannot keep deferring
the start of a build. Metadata-only changes to a known file are checked by
content hash before counting pending work. Unchanged polls do not contact
the embedder.

The producer verifies the vault identity and the content of newly included notes
before publication. If a note changes during the build, the service carries
forward its last published vectors and hashes, or leaves it out if it has no
published version. Its changes remain pending. If a build has no stable changes
to publish, `source_drift` waits for the debounce and retries. A 64 MiB in-memory
cache reuses encodings from recent attempts by exact input hash and encoding
profile until eviction or restart. Embedding errors use exponential backoff capped
at five minutes. An encoding profile change requires an offline `--rebuild`.

Content-identical renames are matched one-to-one against new paths when applying
the deletion limit. A changed breadcrumb can still require new embeddings.
If the limit is exceeded, the service reports `deletion_guard`. After checking
that the losses are intentional, place a file named `ALLOW_DELETIONS` beside
`CURRENT` with the current generation ID followed by a newline. The service
consumes a matching marker before allowing one build to exceed the limit. If that
build fails, a new authorization is required. `--allow-deletions` remains a
one-shot option.

`SERVICE.json` records an expiring inventory observation against the exact
published generation and is refreshed during encoding. MCP runtime status and
authenticated `/statusz` expose `semanticIndex.generation`, `builtAt`,
`pendingChanges`, `lastError` and `coverage`. External searches report
`generation_id`, `indexGeneration`, `indexBuiltAt` and `staleNotes`. The count
reflects additions, content changes and removals in the latest valid poll.
It can lag recent disk writes. Missing or expired observations yield `null`
for the count and last error.
Status writes retry transient file sharing errors and leave the producer running
if publication remains blocked. The service quarantines and rebuilds corrupt
retirement metadata and keeps the three newest quarantine files. If a file
lock prevents recovery, it pauses new builds and reports
`semanticIndex.maintenanceWarning: "retirements_recovery_blocked"` until it can
retry successfully. A successful repair reports `retirements_rebuilt` for the
rest of that service run, unless another maintenance issue takes precedence.

The service keeps `CURRENT` plus two recent retired generations by default
(`--keep-generations`) and caps total generations at four (`--max-generations`).
At capacity the producer waits until it can remove a retired generation before
building again. If an open handle blocks removal after grace, the service
records that generation, reports `generation_prune_blocked` and retries on
later polls. It starts no extra generation while at or above the cap. An
existing index already above the cap may remain there while files are locked.
Grace defaults to 60 seconds (`--reader-grace-seconds`), since
each new query opens `CURRENT` and only requests already in flight can need the
retired generation. Set grace above the longest reader request for your
deployment. Each generation contains full vector files, even for unchanged
vectors. Allow disk space for that many complete indexes. Use the pointer for
service readers and a separately retained copy for readers fixed to a directory.

See [service deployment](../OPERATIONS.md#headless-sync-and-semantic-services).

## Publication and recovery

- `<index>/CURRENT` contains the active generation ID and a newline.
- `<index>/generations/<id>/` is an immutable Smart Environment v3 directory.
  Its `generation.json` records the vault binding, model and encoding profile,
  source hashes, input hashes, row references, counts and artifact checksums.
  The external reader requires at least one note. An empty corpus blocks
  publication and leaves any previous pointer in place.
- The producer validates the staged generation and publishes it by renaming a
  sibling temporary pointer over `CURRENT`. A failed run preserves the previous pointer.
  Windows can reject replacement while another process holds the pointer open.
  Close that handle and rerun the producer. Readers should close the pointer as
  soon as they have copied the generation ID.
- A changed encoding profile requires an explicit `--rebuild`. The rebuild
  encodes every row and still checks the new model identity, source binding and
  source consistency. To index a different vault, use a different index root.
- Use a machine-local filesystem that supports hard links and SQLite locking.
  A single producer holds the SQLite lock and renews its
  `.producer.lock` receipt every 10 seconds. After a forced exit, a new process
  takes over an expired receipt after 30 seconds once it proves that the owner
  PID is gone or belongs to a different process or boot. An unverifiable owner
  still blocks takeover. SIGINT and SIGTERM interrupt encoding and release
  the lease without changing an unpublished pointer.
- A refused build removes its sealed but unpublished generation. A forced
  exit may leave staging or pointer work files, which the next producer
  cleans up. With the service stopped, older retired generations can be pruned
  manually after readers drain. Stop the service before changing `CURRENT`
  to roll back.

On a server configured with `SMART_ENV_DIR`, set it to the concrete published
generation directory at startup, `OBSIDIAN_VAULT` to the corresponding vault,
and `OLLAMA_BASE_URL` to the compatible query endpoint. Refresh the reader
configuration when adopting another generation. On a server that supports
`SMART_ENV_GENERATION_POINTER`, set it to the absolute path to `CURRENT` and
pin the matching query profile with `SMART_ENV_QUERY_FINGERPRINT`. Keep
`OBSIDIAN_VAULT` and `OLLAMA_BASE_URL` set as above.
