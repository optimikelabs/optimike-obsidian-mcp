# Standalone semantic index producer

Use Node 22.12 or later and a BitNet bridge that exposes its encoding identity at
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

Note inputs use the vault-relative breadcrumb followed by `:\n` and the
Markdown. Block inputs use the parent breadcrumb followed by a newline and the
original inclusive line range. The producer uses the pinned jsbrains parser and
`SmartBlock.should_embed` rule. Set `--min-block-chars` to match the Smart
Connections block setting for the corpus (250 by default). A parent is
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
If a note is omitted, its blocks are omitted too. The manifest and CLI output
list skipped paths or blocks with their reasons, including invalid UTF-8
and paths the strict reader cannot load. Filesystem read errors abort the run.

Each run rechecks the full source inventory and source hashes before publication.
Incremental runs only request embeddings for inputs absent from the active
generation, keyed by the exact UTF-8 input and encoding profile. Vault identity,
I/O errors, source changes detected during the build and changes in bridge
identity can stop publication. A live filesystem can still change between the
last check and pointer replacement. Use a stable filesystem snapshot if a
point-in-time source view is required, with a dedicated index root for that
snapshot.

Before encoding, compare the active generation's paths with the new inventory.
Refuse publication if more than 10% or more than 50 active paths are missing.
Use `--max-deletion-percent` and `--max-deletions` to configure the limits.
Renames and newly excluded paths count as missing. Use `--allow-deletions` for
one run after verifying that the removals are intentional. Content refusals
are reported separately from missing paths.

## Publication and recovery

- `<index>/CURRENT` contains the active generation ID and a newline.
- `<index>/generations/<id>/` is an immutable Smart Environment v3 directory.
  Its `generation.json` records the vault binding, model and encoding profile,
  source hashes, input hashes, row references, counts and artifact checksums.
  The external reader requires at least one note. An empty corpus blocks
  publication and leaves any previous pointer in place.
- The producer validates the staged generation and publishes it by renaming a
  sibling temporary pointer over `CURRENT`. A failed run can leave an unpublished
  directory. The previous pointer remains readable until replacement.
  Windows can reject replacement while another process holds the pointer open.
  Close that handle and rerun the producer. Readers should close the pointer as
  soon as they have copied the generation ID.
- A changed encoding profile requires an explicit `--rebuild`. The rebuild
  encodes every row and still checks the new model identity, source binding and
  source consistency. To index a different vault, use a different index root.
- A killed producer can leave `.producer.lock` with its PID and start time.
  Confirm the owning invocation is gone and prevent another producer from
  starting before removing that lock. A complete published generation remains
  readable through `CURRENT`.
- Keep the current and previous generations. Older generations and
  `.staging-*` or `.CURRENT-*` leftovers can be removed with producers stopped
  and readers drained, including readers pinned to a concrete generation path.
  The producer performs no automatic pruning because readers may still hold a
  previously published path.

On a server configured with `SMART_ENV_DIR`, set it to the concrete published
generation directory at startup, `OBSIDIAN_VAULT` to the corresponding vault,
and `OLLAMA_BASE_URL` to the compatible query endpoint. Refresh the reader
configuration when adopting another generation. On a server that supports
`SMART_ENV_GENERATION_POINTER`, set it to the absolute path to `CURRENT` and
pin the matching query profile with `SMART_ENV_QUERY_FINGERPRINT`. Keep
`OBSIDIAN_VAULT` and `OLLAMA_BASE_URL` set as above.
