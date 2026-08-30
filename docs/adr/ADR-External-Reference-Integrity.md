# ADR — Governed external-file move and ÉLYSIA reference integrity

- Status: accepted and implemented for a local stdio pilot
- Scope: one regular file inside one configured local external root
- French version: [ADR-External-Reference-Integrity.fr.md](ADR-External-Reference-Integrity.fr.md)
- Amends: [External document roots](ADR-External-Document-Roots.md)
- Does not amend: [Governed HTTP delivery](ADR-HTTP-External-Artifact-Delivery.md)

## Context

External roots originally exposed discovery, bounded reads, hashing and verified
handoff only. A local harness can already move a file, but that operation alone
can silently break the Obsidian notes that explain the file's role.

The useful product capability is therefore not a generic file manager. It is a
bounded transaction that inventories ÉLYSIA references, plans one same-root file
move, repairs only exact references, proves the result and can roll it back.

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
4. `external_move_apply` moves the file and conditionally repairs exact notes.
5. `external_move_rollback` restores both surfaces when every precondition still
   holds.

Reference repair is deliberately part of `external_move_plan` and
`external_move_apply`; there are no separate `external_links_repair_plan` or
`external_links_repair_apply` tools. The file move and its exact note repairs
form one compensating transaction, so a client cannot apply one surface while
silently leaving the other behind.

Planning and scanning are read-only. Apply and rollback require all three
positive gates:

- `MCP_WRITE_MODE=full`;
- `MCP_EXTERNAL_MOVE_ENABLED=true`;
- the selected root declares the `move` capability.

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

Only an exact token/link pair in an active Markdown paragraph is automatically
repairable. Bare paths, unmatched tokens, mismatched pairs, multiple candidate
links, unsupported syntax, and references under history, archive, example,
release-note or changelog headings require manual review. Any manual-review
occurrence blocks apply.

The scanner uses a Markdown AST. Fenced code is not traversed and YAML
frontmatter is excluded. A free-form path, a YAML property, or a path merely
placed under an artifacts heading is not promoted to a canonical reference.
Relevant physical-path occurrences and other unsupported forms are reported for
manual review and are never rewritten by guessing.

## Filesystem transaction

The V1 move contract is intentionally narrow:

- one regular file only;
- source and target inside the same logical root and filesystem volume;
- target parent already exists and is a real directory;
- target does not exist;
- include/exclude policy accepts both paths;
- links and junctions are not followed;
- source size, modification time and SHA-256 still match the plan.

Apply uses a no-clobber hard-link/unlink sequence. It creates the target link,
proves that source and target identify the same filesystem object, then removes
the source. Filesystems that cannot provide these guarantees fail closed.

## Vault repair and concurrency

Each planned note repair stores its exact before/after content and expected
SHA-256. Apply re-reads every note before moving the file. Apply and rollback
are restricted to `headless-filesystem` on a copied or dedicated vault, where
the existing exact-hash precondition is enforced. Local REST API 4.1.7 exposes
an ETag but does not enforce `If-Match` on whole-note writes; live apply
therefore fails closed before the external file is moved.

If a repair fails after the file move, the coordinator compensates completed
note repairs and rolls the file back when the verified state still permits it.

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

The idempotency key is bound to one source/target request. Replaying a completed
apply or rollback returns the recorded state; reusing the key for another move
is rejected.

## Transport boundary

The stdio proxy owns external-root configuration, the physical move and the
journal. The backend only supplies vault search/read and conditional note
replacement.

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

The regression suite must cover canonical parsing, excluded/ambiguous
references, target collision, changed sources, changed notes, no-clobber move,
failure after a subset of note repairs, compensation, rollback, both durable
restart states around the hard-link/unlink boundary, HTTP denial and path
redaction on Windows and Linux where applicable.
