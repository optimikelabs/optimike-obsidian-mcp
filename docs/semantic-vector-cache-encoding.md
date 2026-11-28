# Semantic vector cache encoding

The derived SQLite `semantic_vectors.vec_json` TEXT column stores a JSON envelope with `encoding: float64le-base64-v1`, vector `length` and canonical base64 `data`. Data contains little-endian IEEE 754 Float64 values. There is no Float32 quantization, no change to Smart Connections files, the public number-array vector contract, or search ranking. Native typed-array conversion avoids formatting millions of decimal numbers. A big-endian host uses explicit little-endian Buffer access instead.

Reads accept historical JSON number arrays. Encoded rows require the known marker, an integer length equal to the database dimension, the exact byte length, and canonical base64. Unknown or corrupt envelopes throw; they do not manufacture a successful readiness observation. Existing readiness remains read-only, source-validated, generation-fenced and limited to a successful observation for at most 60 seconds.

The Smart Env V3 reader accepts a vector only when its `read_hash` equals the source's `last_read.hash`, falling back to `last_import.hash` for import-only records. Re-embedding can refresh `last_read` without re-importing the source; missing or stale hashes are rejected. `node scripts/test-smart-env-v3.mjs` covers these cases.

The source-signature domain is `smart-env-v3:last-read-v1:float64le-base64-v1`. This is a compatibility fence, not a cache freshness extension. Old releases compute the old domain, see a mismatch and rebuild their numeric-array rows from authoritative sources on the next actual query. Reapplying the new release similarly rebuilds its derived encoding once. Reverting the release pointer does not restore or delete journals, source files or cache databases. Do not remove this domain change while deploying the new encoding.

Qualification: `node scripts/test-semantic-vector-encoding.mjs`; existing semantic readiness, Smart Env V3 and capability-manifest suites. The local campaign also exercises old -> new -> old -> new on one isolated database. Exact values including negative zero and subnormals survive, malformed envelopes fail, and observational readiness does not modify the manifest. Live deployment still requires an actual semantic query; catalog presence alone is not certification.

Controlled local benchmark, 8 October 2026: one frozen source corpus, 7,578 vectors, three interleaved pairs of identical snapshots. Median persistence falls from 5,452.54 ms to 2,502.40 ms; vector payload falls from 102,016,265 to 52,174,530 bytes. All vector and metadata hashes match. These are local measurements, not an SLA. Event-loop stalls remain possible during synchronous SQLite persistence, so this does not certify that all simultaneous diagnostic timeouts disappear. No RAM reduction is claimed.

An independent probe and an actual query also share a source read when both are already in flight in the same refresh generation. This keeps only the active read promise; there is no new TTL, prewarm, background write or publication from a probe. Each role retains its generation and publication checks. `node scripts/test-semantic-source-coalescing.mjs` exercises both start orders, one source read, generation isolation, independent probe behavior and shared failure cleanup. An isolated cold overlap pair with the same 7,578 exact vectors took 11.00 / 8.19 seconds before and 4.87 / 4.78 seconds after for query-first / probe-first completion. One pair per order is evidence for eliminating duplicate work, not a latency guarantee; diagnostics may still time out before a cold source read finishes.

Bounded runtime diagnostics distinguish deadline expiration from an unreachable or missing service. Normalized timed-out probes project `local_rest_probe_timed_out` for REST, `semantic_probe_timed_out` for the semantic index and `bridge_probe_timed_out` for Atomic/Base/Operon, with `retry_capability_probe`. Their capability remains unavailable and unauthorized; no rights, deadlines, late-result promotion or stale-ready substitution change. Actual connection failures and explicit absence keep their existing reasons. `test-capability-manifest.mjs`, `test-semantic-probe-timeout.mjs` and `test-capability-probe-deadlines.mjs` exercise projections and real simultaneous deadlines.

## External Smart Env v3 generations

Set `SMART_ENV_GENERATION_POINTER` on the MCP server to the absolute path of
a UTF-8 file such as `/srv/semantic-index/CURRENT`. It contains one generation
ID followed by exactly one LF or CRLF, for example `g42\n`. A UTF-8 BOM is
accepted. The line terminator is required so a partial write cannot select an
existing generation whose ID is a prefix. IDs start with an ASCII
letter or digit and contain at most 64 letters, digits, underscores or hyphens.
Use a fresh ID for each publication and avoid reserved Windows device names.
The reader looks for `generations/<id>` next to the pointer. Put the pointer
and generation files on the same volume, outside the vault, as regular files
without redirects. With the variable unset, the existing `SMART_ENV_DIR`
behavior applies. A configured but unreadable or invalid pointer makes semantic
search unavailable even if `SMART_ENV_DIR` is also set.

Use one semantic mode per shared SQLite cache. When running external-pointer
and `SMART_ENV_DIR` backends side by side, give them separate
`OBSIDIAN_SHARED_CACHE_DB_PATH` values. Their semantic snapshots replace each
other in a shared database, causing repeated cold reads.

Each generation uses the usual `smart_env.json`, model registry
`embedding_models/embedding_models.ajson` and source records
`smart_sources/smart_sources.ajson` (numbered shards are accepted).
Source paths must be vault-relative Markdown paths with slash separators.
Include both binary files, `smart_sources/<fingerprint>` and
`smart_blocks/<fingerprint>`, with at least one note and zero or more sections. Each vector
row must have one current source or section reference. Write `generation.json`
with these fields. Additional producer metadata is allowed.

```json
{
  "generation": "g42",
  "model": {
    "provider_key": "ollama",
    "model_key": "example-embed",
    "dimensions": 640,
    "max_tokens": 32768
  },
  "fingerprint": "mf_example",
  "vectors": {
    "encoding": "float32le",
    "notes": { "count": 10, "sha256": "<64 lowercase hex digits>" },
    "sections": { "count": 24, "sha256": "<64 lowercase hex digits>" }
  }
}
```

Set `SMART_ENV_QUERY_FINGERPRINT` to the expected Smart Env v3 fingerprint of
the query encoder's profile. The fingerprint covers provider key, model key,
dimensions and token limit (zero when unspecified). It must match both the
generation manifest and the active registry record. Explicit
`QUERY_EMBEDDER` and `QUERY_EMBEDDER_MODEL` values must agree as well. Configure
the query endpoint on the server, for example with `OLLAMA_BASE_URL`. The
external registry cannot select the endpoint. The operator must ensure the
endpoint actually serves the compatible weights and query preprocessing.
The v3 fingerprint does not identify weights or tokenization, and the reader
checks the returned vector's dimension and validity during search.

1. Build a complete generation in staging on the pointer volume. Write and
   validate the registry, source references, both vector files and manifest.
2. Rename the completed directory to `generations/<id>`. Write a temporary
   pointer beside `CURRENT` and atomically replace `CURRENT` by renaming that
   file. Keep the old pointer in place until replacement succeeds.
3. Keep earlier generations immutable and readable until all requests that
   could have seen them finish. To roll back, atomically point back to a
   retained complete generation. Protect the pointer, index and cache like
   vault data and restrict publication to a trusted producer.

Search pins the pointer once for the entire request. SQLite and in-memory
snapshots are fenced by the generation and its observed files. An incomplete
or incompatible generation returns a semantic error. Successful external
searches return `generation_id`, `indexGeneration`, `indexBuiltAt` and
`staleNotes`. The [producer service](semantic-index-producer.md#service-mode)
defines the validity and scope of the freshness count. `obsidian_runtime_status` reports
`semanticCache.source: "external"`, the resolved `generationId` when available,
and semantic availability under `capabilityManifest`. Snippets and section
line verification read current Markdown under the explicit `OBSIDIAN_VAULT`
root. They can reflect edits made after indexing.
