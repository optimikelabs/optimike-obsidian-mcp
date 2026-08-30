# ADR — Governed external-file move and ÉLYSIA reference integrity

- Status: accepted; diagnostic local-stdio surfaces implemented, mutation deferred
- Scope: one regular file inside one configured local external root
- French version: [ADR-External-Reference-Integrity.fr.md](ADR-External-Reference-Integrity.fr.md)
- Amends: [External document roots](ADR-External-Document-Roots.md)
- Does not amend: [Governed HTTP delivery](ADR-HTTP-External-Artifact-Delivery.md)

## Context

External roots originally exposed discovery, bounded reads, hashing and verified
handoff only. A local harness can already move a file, but that operation alone
can silently break the Obsidian notes that explain the file's role.

The useful product capability is therefore not a generic file manager. It is a
bounded future transaction that inventories ÉLYSIA references, plans one
same-root file move, repairs only exact references, proves the result and can
roll it back.

## Decision

Add a local-stdio-only workflow:

1. `external_references_scan` inventories references to one external file.
2. `external_move_plan` verifies the source and target, inventories the vault
   and persists a plan.
3. `external_move_status` returns a path-redacted receipt. It durably marks a
   stale partial receipt only when the current binding is proven; otherwise it
   returns a no-write manual-review projection. Structurally canonical legacy
   receipts remain inspectable status-only; malformed stored paths, tokens,
   hashes or review reasons are wholly redacted and can never drive a backend
   read or write.
4. `external_move_apply` is registered for diagnostics but is disabled.
5. `external_move_rollback` is registered for diagnostics but is disabled.

Reference-repair planning is deliberately part of `external_move_plan`; the
disabled `external_move_apply` remains the future same-plan continuation
boundary. There are no separate `external_links_repair_plan` or
`external_links_repair_apply` tools, so an audited implementation cannot apply
one surface while silently leaving the other behind.

Scanning, planning and status are diagnostic/read-only. Apply, rollback and
automatic mutating recovery are disabled on every platform until an audited
native handle-relative mutation primitive exists. Runtime reports the stable
reason `native_handle_relative_mutation_unavailable`; the historical write
gates below are not sufficient to enable mutation:

- `MCP_WRITE_MODE=full`;
- `MCP_EXTERNAL_MOVE_ENABLED=true`;
- the selected root declares the `move` capability.

The disabled surface still preserves path-redacted receipts, private SQLite
snapshots, legacy-binding and stale session/binding checks, and exact-CAS
preconditions as evidence for a future audited primitive.

The root capability never implies upload, create, replace, delete or sync.

## Canonical reference identity

An automatically repairable reference is one Markdown paragraph containing:

```md
[Open the brief](file:///B:/Documents/Project/brief%20final.docx) — `external-ref:project.documents::brief%20final.docx`
```

The `file:///` link remains the human-clickable locator. The adjacent inline
code token is the stable machine identity:

```text
external-ref:<rootId>::<percent-encoded-root-relative-path>
```

Each path segment uses canonical `encodeURIComponent` encoding while `/`
separates segments. Root IDs use the configured lowercase logical-ID grammar.
Absolute paths, traversal, empty segments, encoded separators, UNC hosts,
fragments and query strings are rejected.

The token does not authorize filesystem access and is not a custom URI scheme.
The configured root remains the sole authorization boundary.

The serialized token contains only the stable logical identity. At scan and plan
time, the complete reference record also carries the source SHA-256, occurrence
classification and source note path. Hashes and note paths are mutable evidence,
not durable identity, so they are not embedded in the token.

Only an exact token/link pair in an active Markdown paragraph is eligible for a
future automatic repair. Bare paths, unmatched tokens, mismatched pairs,
multiple candidate links, unsupported syntax, and references under history,
archive, example, release-note or changelog headings require manual review. Any
manual-review occurrence blocks any future mutation.

The scanner uses a Markdown AST. Fenced code is not traversed and YAML
frontmatter is excluded. A free-form path, a YAML property, or a path merely
placed under an artifacts heading is not promoted to a canonical reference.
Relevant physical-path occurrences and other unsupported forms are reported for
manual review and are never rewritten by guessing.

## Future filesystem transaction requirements

Any future audited move contract must remain intentionally narrow:

- one regular file only;
- source and target inside the same logical root and filesystem volume;
- target parent already exists and is a real directory;
- target does not exist;
- include/exclude policy accepts both paths;
- links and junctions are not followed;
- source size, modification time and SHA-256 still match the plan at execution.

The former hard-link/unlink sequence is retired and is not executable. A future
native handle-relative primitive must prove no-clobber behavior and fail closed
when that proof cannot be established.

## Vault repair and concurrency

Each planned note repair stores its exact before/after content and expected
SHA-256 as future evidence. An audited implementation must re-read every note
before moving the file and keep any exact-hash writer restricted to
`headless-filesystem` on a copied or dedicated vault. Local REST API 4.1.7
exposes an ETag but does not enforce `If-Match` on whole-note writes; it cannot
be used for a live external mutation.

The former coordinator compensation is historic evidence, not a current
capability. A future primitive must define and independently audit compensation
and post-interruption recovery before mutation can be enabled.

## Journal and recovery

Plans and state transitions are stored in a machine-local SQLite journal using
WAL and `synchronous=FULL`. Windows defaults beneath `LOCALAPPDATA`; operators
should set an explicit private absolute `MCP_EXTERNAL_MOVE_JOURNAL_PATH`,
especially on other platforms.

The journal contains note preimages required for compensation. It therefore
belongs inside the same trusted local boundary as the vault and must never be
committed, shared, or attached to public diagnostics. Public tool results expose
logical root IDs, relative paths, hashes, note paths and state, never physical
root paths.

The idempotency key is bound to one source/target request. Replaying plan/status
returns the recorded receipt; reusing the key for another move is rejected. The
disabled apply and rollback routes never continue a stored plan.

## Transport boundary

The stdio proxy owns external-root configuration and the journal. It does not
perform a physical move. The backend only supplies vault search/read for the
diagnostic surfaces.

Direct HTTP registers the tool names for discoverability but rejects scan,
plan, status, apply and rollback. HTTP tickets remain read-only downloads and
never authorize mutation. Remote and multi-tenant external mutation would need
a separate identity, tenant-isolation and network-storage contract.

## Explicitly out of scope

- create or replace of external files;
- upload, including upload by HTTP ticket;
- directory move or cross-root/cross-volume move;
- overwrite;
- delete, including trash semantics;
- synchronization;
- generic cloud, mapped-drive or network-storage mutation;
- automatic repair of ambiguous or legacy references.

These capabilities require demonstrated ÉLYSIA value and a separate decision.

## Verification

The regression suite covers canonical parsing, excluded/ambiguous references,
target collision, changed sources, changed notes, stale/legacy receipt
projection, HTTP denial, all-platform disabled apply/rollback/recovery, and
path redaction on Windows and Linux where applicable. A future mutation proposal
must add deterministic no-clobber, compensation and interruption tests for its
own primitive.
