# VNext Reliability P0

This bounded change preserves the governed operation engine and its permission, CAS, idempotency and no-replay guarantees. It does not deploy a runtime or claim Desktop qualification.

## Retrieval

`obsidian_list_notes` traverses directories independently of the name filter. A non-matching ancestor is retained as path context only when a matching descendant is present. Recursion depth and extension filters still apply. Live and cache paths follow the same rule, including scoped paths and a depth of zero.

Global search applies one JavaScript content matcher for regex, literal text and case on both backends. Regex is validated before retrieval; invalid patterns are errors, not empty successful searches. Live regex and case-sensitive requests enumerate Markdown candidates in the selected directory and read their content. This can require more backend reads than simple search, especially without `searchInPath`. Ordinary case-insensitive literal requests retain the simple-search candidate path and verify content matches. Filename-only matches are excluded from this content-search contract. Cache fallback remains an observation of cached content, not proof of live freshness.

## Semantic diagnostics

Creating an embedder function verifies configuration, not execution. The doctor reports `semantic_query_unverified` with state `degraded` and next action `run_semantic_search` until a successful functional search has been observed in this process with the same embedder and dimension within 60 seconds. The capability remains callable. A failed embedding or invalid vector marks it unavailable; a later successful search restores readiness. This is recent observed health, not a continuous availability guarantee. The doctor sends no synthetic query to a paid or remote provider.

The tool and doctor use the same Smart Environment host inference. Public errors and private logs retain only closed, safe stage codes:

- `semantic_index_unavailable`
- `semantic_embedder_configuration_invalid`
- `semantic_query_embedding_failed`
- `semantic_query_vector_invalid`

Provider messages, query content, credentials and physical paths remain redacted. A query vector must match the index dimension, contain finite values and have nonzero norm.

The two historical September 22 errors were correlated to runtime logs, which retained only generic `INTERNAL_ERROR` events. Their original cause cannot be recovered from those records. Contemporary production read-only searches succeeded; no index reset or speculative provider fix is included.

## Governed diagnostics

A settled, unexplained create-content mismatch becomes `outcome_unknown`; apply remains disabled and status can later reconcile a qualified observation without replay. See [the creation contract](durable-note-create-m4.md).

A missing active creation-date property still refuses a replacement/frontmatter plan before dispatch, now with `atomic_write_creation_property_missing`. No property name is exposed. Operon probe failure or a missing presence observation becomes `bridge_unavailable`; `operon_not_present` requires explicit `present === false`.

## Response counts and pagination

Global-search `matchCount` is the total content occurrence count for that file, independent of `maxMatchesPerFile`. Detailed responses also expose `returnedMatchCount` for snippets actually returned. Compact responses omit snippets and off-page identities. `hasMore` and `nextPage` provide continuation. Detailed `alsoFoundInFiles` contains at most 20 full vault-relative paths, with `alsoFoundInFilesTotal` indicating the full off-page count. Consumers relying on unbounded basename lists must use pagination instead. Equal modification timestamps use path ordering for deterministic pages.

## Reproducible qualification

Run `npm run test:vnext-reliability`, then `npm run benchmark:vnext`. The benchmark uses a real MCP SDK client/server in-memory transport, simulated vault backends and a real SQLite journal. It verifies search/read/create/status/reopen postconditions rather than just selecting a first tool. Its 302-note corpus covers homonyms, a frontmatter alias, scoped regex/case search, counts, pagination, bounded response size, exact creation, unexplained drift and a lost response. Five repetitions per scenario report p50/p95, response bytes, response tokens using the `cl100k_base` tokenizer as a fixed proxy, MCP calls and backend reads. They are not production latency or model-billing measurements.

To compare unchanged baseline code with the same harness, set `VNEXT_DIST_ROOT` to another built checkout's `dist`. Pass an output JSON path to `node scripts/benchmark-vnext-e2e.mjs`. Baseline failures are retained as failures, never compared as faster successful tasks. Graph, native move, Base-row and Operon regressions remain separately covered by their domain suites. These ten Reliability benchmark scenarios are not the ten full Desktop qualification journeys proposed in the VNext pivot.
