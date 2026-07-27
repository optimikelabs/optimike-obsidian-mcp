# ADR — External document roots

- Status: proposed, design only
- Date: 2026-07-27
- MCP baseline: `optimikelabs/optimike-obsidian-mcp@13969990e5c6b0da455a70a2ed7a40ae0e1ea399`
- Related product contract: ÉLYSIA OS external spaces and artifacts boundary

## Problem

The MCP currently treats one Obsidian vault as its primary content boundary.
Important native documents may legitimately remain outside that vault: Office
files, PDFs, datasets, media, project folders, application-managed libraries,
repositories, and synchronized collaborative documents.

A link in a note does not grant the MCP permission to leave the vault. It also
does not prove that the resource can be read, extracted, indexed, written, or
backed up.

Extending the existing vault path implicitly would collapse the security
boundary, mix vault and external indexes, and make private machine paths part of
portable agent output.

## Decision

If external document access is implemented, it will use an explicit
`external_roots` subsystem with these invariants:

- default deny;
- machine-local root configuration;
- stable logical root IDs separated from physical paths;
- read-only first release;
- capability declaration per root;
- canonical-path confinement for every request;
- bounded listing, reading, extraction, and indexing;
- separate cache and search namespace from the Obsidian vault;
- hashes and provenance for every extracted representation;
- no automatic copying, moving, renaming, overwriting, or synchronization.

This ADR authorizes design and backlog preparation only. It does not authorize
new tools, new environment variables, wider filesystem permissions, or changes
to a running MCP configuration.

## Root contract

A root configuration must be local and must not be committed:

```json
{
  "id": "stable-logical-id",
  "path": "<machine-local-path>",
  "capabilities": ["visible", "readable"],
  "include": ["**/*.pdf", "**/*.docx"],
  "exclude": ["**/.git/**", "**/node_modules/**"],
  "limits": {
    "maxDepth": 6,
    "maxFileBytes": 52428800,
    "maxListEntries": 500
  }
}
```

Initial capability vocabulary:

- `visible`: disclose root metadata and bounded directory entries;
- `readable`: read an explicitly requested file;
- `extractable`: create a text representation with provenance;
- `indexable`: add extracted representations to the external index.

`writable` is excluded from the first implementation. If it is ever proposed,
it requires a separate ADR, threat model, mutation journal, optimistic
preconditions, dry-run contract, explicit apply gate, and rollback evidence.

The absence of a capability is a denial.

## Confinement

Every path request must:

1. accept a configured root ID and a relative path;
2. reject absolute paths and traversal segments;
3. resolve the physical root and candidate to canonical paths;
4. prove that the candidate remains inside the canonical root;
5. apply platform-aware case and separator rules;
6. reject or explicitly govern symlinks, junctions, reparse points and mounted
   paths;
7. apply include, exclude, depth, size and entry-count limits;
8. log the decision without exposing secrets or unnecessary physical paths.

The server must not infer a new root from a path found in a note.

UNC paths, network mounts and cloud placeholders remain unsupported until
separate availability, identity and timeout behavior is specified.

## Read and extraction boundary

The first extractor set should be deliberately narrow:

- UTF-8 text and Markdown;
- PDF text extraction;
- DOCX, XLSX and PPTX through format-aware parsers;
- metadata-only inspection for ZIP archives.

Rules:

- no macro execution;
- no embedded object execution;
- no recursive archive extraction;
- no OCR unless separately enabled and bounded;
- no active content rendering;
- no write-back to the native document;
- fail closed on encrypted or malformed content;
- return `unsupported`, `encrypted`, `too_large`, `inaccessible` or
  `non_verifiable` rather than fabricated text.

Extractor dependencies require their own license, vulnerability and resource
review.

## Cache, hashes and provenance

External content must not enter the existing vault `file_cache` or masquerade as
an Obsidian note.

A separate store or clearly isolated tables must record:

- root ID;
- normalized relative path;
- size and modification time;
- content SHA-256 when read;
- extractor name and version;
- extraction timestamp;
- source MIME/type decision;
- text hash;
- failure state;
- index namespace and embedding provenance when indexed.

The physical root path stays machine-local. Portable results expose the root ID
and relative path, not the user profile or drive layout.

Cache reuse requires matching source identity and hash policy. A changed file
invalidates the extracted representation before search can return it as current.

## Search boundary

External search is a separate namespace from vault semantic search.

- A caller must opt into the external namespace.
- Results identify their source as `external`.
- Vault and external scores are not silently merged.
- Indexing requires an `indexable` root and an explicit bounded refresh.
- No startup scan of all external roots.
- Deleting an index entry never deletes the source file.

## Provisional tool surface

Names are illustrative and not yet a public contract:

- `external_roots_list`
- `external_list`
- `external_stat`
- `external_read`
- `external_extract`
- `external_search`
- `external_runtime_status`

All tools are read-only in the first release. Tool annotations must declare
their read-only behavior and boundedness.

## Runtime and deployment policy

- No root is enabled by default.
- Stdio and localhost deployments may opt in through local configuration.
- Remote HTTP deployments require the existing authentication boundary plus a
  separate decision on whether external-root tools are exposed at all.
- Root configuration never comes from the vault, a note, a package, or a
  plugin data file distributed to other users.
- Runtime status reports root IDs, capabilities and health states without
  returning full physical paths by default.

## Required evidence before implementation

1. Threat model covering traversal, symlinks/reparse points, network mounts,
   malicious documents, archive bombs, race conditions and path disclosure.
2. Configuration schema with validation and redacted diagnostics.
3. Cross-platform confinement tests for Windows, macOS and Linux.
4. Resource budgets and cancellation tests for every extractor.
5. Separate SQLite migration and cache invalidation tests.
6. Tool contract tests proving read-only annotations and capability denial.
7. A disposable-root smoke suite with missing, inaccessible, malformed,
   encrypted and oversized files.
8. Packaging tests proving that no local root or private path is published.
9. A limited local pilot before any semantic indexing.
10. Explicit approval before enabling the feature in a production runtime.

## Phased backlog

### Phase 0 — Contract

- configuration schema;
- threat model;
- capability and error vocabulary;
- portable output contract;
- test fixtures with synthetic documents only.

### Phase 1 — Visibility

- list configured roots;
- bounded list and stat;
- no file content;
- redacted health diagnostics.

### Phase 2 — Read and extract

- explicit single-file read;
- bounded format extractors;
- hash and provenance records;
- no index.

### Phase 3 — External index

- explicit bounded refresh;
- separate namespace and storage;
- stale/hash semantics;
- no automatic startup crawl.

### Deferred

- write tools;
- sync or migration;
- watcher-driven recursive indexing;
- network and collaborative-provider connectors;
- deep links into pages, sheets, slides or embedded objects.

## Stop rules

Stop or simplify if:

- confinement cannot be proven after canonical resolution;
- a root must be inferred from note content;
- external content must share the vault index without provenance;
- extraction requires executing active content;
- the feature exposes private physical paths in portable output;
- a read operation can mutate timestamps, content or sync state unexpectedly;
- resource limits cannot interrupt a malicious or oversized document;
- the design requires write access to demonstrate value.
