# ADR — External document roots

- Status: accepted and implemented on `main`; handoff transport amended by
  [ADR — Governed HTTP delivery](ADR-HTTP-External-Artifact-Delivery.md)
- Date: 2026-07-28
- External-roots baseline:
  `optimikelabs/optimike-obsidian-mcp@7c2eaad5bf958fa0315d69a067f9972910f6c39d`
- Transport amendment baseline:
  `optimikelabs/optimike-obsidian-mcp@5c74643a7840b9a1b68714c362a0fe7e1a9bea4f`
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

External document access uses an explicit
`external_roots` subsystem with these invariants:

- default deny;
- machine-local root configuration;
- stable logical root IDs separated from physical paths;
- read-only first release;
- capability declaration per root;
- canonical-path confinement for every request;
- bounded listing, text reading, hashing, and explicit verified handoff;
- no embedded Office/PDF extraction engine in the first release;
- no external cache or search namespace in the first release;
- no automatic copying, moving, renaming, overwriting, or synchronization.

The first implementation is intentionally a secure broker between logical roots
and agent clients that already have document tools, including Codex, Claude
Code, Gemini CLI, OpenClaw, and Hermes Agent. It does not make document parsing
a mandatory MCP dependency.

## Root contract

A root configuration must be local and must not be committed:

```json
{
  "id": "stable-logical-id",
  "path": "<machine-local-path>",
  "capabilities": ["visible", "readable", "handoff"],
  "include": ["**/*.pdf", "**/*.docx"],
  "exclude": ["**/.git/**", "**/node_modules/**"],
  "limits": {
    "maxDepth": 6,
    "maxFileBytes": 52428800,
    "maxListEntries": 500,
    "maxTextChars": 200000
  }
}
```

Initial capability vocabulary:

- root IDs, capabilities, availability, and limits are disclosed by runtime
  status and root listing independently of `visible`;
- `visible`: disclose bounded directory entries and file metadata;
- `readable`: hash or read an explicitly requested UTF-8 text file;
- `handoff`: create one verified temporary local copy for an explicitly
  requesting local stdio client so that it can use its own document tools.

`extractable` and `indexable` are reserved for optional future adapters. They
are not implemented by the core service.

`writable` is excluded from the first implementation. If it is ever proposed,
it requires a separate ADR, threat model, mutation journal, optimistic
preconditions, dry-run contract, explicit apply gate, and rollback evidence.

The absence of a capability denies the corresponding file operation; root
discovery remains available as described above.

## Confinement

Every path request must:

1. accept a configured root ID and a relative path;
2. reject absolute paths and traversal segments;
3. resolve the physical root and candidate to canonical paths;
4. prove that the candidate remains inside the canonical root;
5. apply platform-aware case and separator rules;
6. reject detectable symlink, junction, and reparse-point escapes supported by
   the current platform;
7. apply include, exclude, depth, size and entry-count limits;
8. log the decision without exposing secrets or unnecessary physical paths.

The server must not infer a new root from a path found in a note.

UNC-prefixed paths are rejected. Mapped drives, network filesystems mounted
behind ordinary local-looking paths, and cloud placeholders cannot be detected
reliably and remain outside supported identity and consistency guarantees until
provider-specific connectors exist.

## Read and client-handoff boundary

The first release reads only bounded UTF-8 text directly. PDF, DOCX, XLSX,
PPTX, ODF, RTF, OCR, and active rendering remain the responsibility of the
calling agent harness or an optional future adapter.

`external_handoff` is the only operation that returns a physical local path.
It requires both `readable` and `handoff`, reads through a handle whose
filesystem identity is revalidated after open, writes a process-owned temporary
copy, and is available only over stdio. Returning a verified copy avoids
re-opening a source path whose ancestors could be swapped after validation. The
temporary directory is removed when the MCP process exits. Lists, status, stat,
and text reads remain portable and never expose the machine path. The handoff
cache expires copies after one hour, sweeps every five minutes, evicts the
oldest entries above 16 files or 512 MiB, and scavenges directories owned by
dead processes or stale ownership heartbeats on the next configured service
startup. The heartbeat prevents PID reuse from preserving abandoned copies
indefinitely.

This preserves a clean responsibility boundary:

- MCP: authorization, confinement, limits, metadata, hashes, and handoff;
- client harness: document extraction and OCR;
- ÉLYSIA: meaning, authority, relations, and lifecycle.

## Cache, hashes and provenance

External content must not enter the existing vault `file_cache` or masquerade as
an Obsidian note.

The first release does not persist an external cache. Stat, text-read, and
handoff responses return root ID, normalized relative path, size, modification
time where relevant, and SHA-256 when requested or required.

The physical root path stays machine-local. Portable results expose the root ID
and relative path, not the user profile or drive layout. The sole exception is
the explicit local stdio handoff response.

## Search boundary

External search is deferred. If implemented, it must use a separate namespace
from vault semantic search.

- A caller must opt into the external namespace.
- Results identify their source as `external`.
- Vault and external scores are not silently merged.
- Indexing requires an `indexable` root and an explicit bounded refresh.
- No startup scan of all external roots.
- Deleting an index entry never deletes the source file.

## Provisional tool surface

Current first-release tool surface:

- `external_roots_list`
- `external_list`
- `external_stat`
- `external_read`
- `external_handoff`
- `external_runtime_status`

These tools are implemented on `main`. All are read-only and carry read-only
MCP annotations.

## Runtime and deployment policy

- No root is enabled by default.
- Stdio and localhost deployments may opt in through local configuration.
- Physical-path handoff is denied on HTTP even when a root has the capability.
- Remote HTTP deployments require a separate decision on whether the remaining
  external-root tools are exposed at all.
- Root configuration never comes from the vault, a note, a package, or a
  plugin data file distributed to other users.
- Runtime status reports root IDs, capabilities and health states without
  returning full physical paths by default.

## Product-promotion evidence

The promoted implementation provides:

1. configuration schema validation with duplicate-ID and UNC-prefix rejection;
2. traversal, absolute-path, strict include/exclude, capability, and size-limit
   tests;
3. Windows junction escape rejection;
4. public status/list/stat/read outputs without physical paths;
5. a verified temporary copy as the only physical-path disclosure;
6. local stdio `local_path` handoff plus the separately governed, opt-in
   authenticated loopback HTTP `http_ticket` amendment;
7. read-only annotations on every MCP tool;
8. disposable-root tests plus a limited AMEX pilot;
9. packaging checks proving that no machine-local root configuration is
   published;
10. Linux and Windows CI coverage for the external-roots regression suite.

## Phased backlog

### Phase 0 — Contract — complete

- configuration schema;
- threat model;
- capability and error vocabulary;
- portable output contract;
- test fixtures with synthetic documents only.

### Phase 1 — Visibility — complete

- list configured roots;
- bounded list and stat;
- no file content;
- redacted health diagnostics.

### Phase 2 — Read and handoff — complete

- explicit single-file read;
- SHA-256 and bounded metadata;
- explicit local stdio handoff and optional authenticated loopback HTTP ticket
  delivery under the transport amendment;
- extraction delegated to the client harness;
- no index.

### Phase 3 — Optional extraction adapters — deferred

- adapter capability negotiation;
- MarkItDown or another reviewed provider;
- extractor version and provenance;
- no parser dependency in the core package.

### Phase 4 — External index — deferred

- explicit bounded refresh;
- separate namespace and storage;
- stale/hash semantics;
- no automatic startup crawl.

### Deferred

- write tools;
- sync or migration;
- watcher-driven recursive indexing;
- network and collaborative-provider connectors;
- embedded extraction engine in the core MCP;
- deep links into pages, sheets, slides or embedded objects.

## Stop rules

Stop or simplify if:

- confinement cannot be proven after canonical resolution;
- a root must be inferred from note content;
- external content must share the vault index without provenance;
- core operation requires executing or parsing active content;
- the feature exposes private physical paths in portable output;
- a read operation can mutate timestamps, content or sync state unexpectedly;
- the design requires write access to demonstrate value.
