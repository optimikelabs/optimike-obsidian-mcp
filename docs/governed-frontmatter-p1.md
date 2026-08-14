# Governed frontmatter projection (P1)

French version: [governed-frontmatter-p1.fr.md](governed-frontmatter-p1.fr.md)

P1 adds a source-preserving frontmatter mutation domain above the released P0
atomic-note runtime. It does not add another transaction engine.

## Public surface

The four tools are available only in `live`, or in `hybrid` with a reachable
Obsidian REST service and Atomic Write Bridge:

- `obsidian_frontmatter_patch_plan`
- `obsidian_frontmatter_patch_apply`
- `obsidian_frontmatter_patch_status`
- `obsidian_frontmatter_patch_recover`

One public P1 plan maps to one P0 `obsidian.note.replace` operation. The P1 plan
reference is opaque. Apply and recovery accept no new path, patch, value, hash,
or compiled Markdown.

P1 canonicalizes intent keys with a total code-unit order before hashing. Its
public idempotency identity therefore does not depend on the host locale or ICU
configuration; legacy P0 digest semantics remain unchanged.

## Supported V1 intent

One request targets one existing Markdown note with a standard frontmatter
block. It may contain up to 64 unique top-level operations:

- `set`: add or replace one top-level bare key with a JSON-compatible value;
- `delete`: remove one existing top-level bare key when the source range and
  neighboring-comment ownership are unambiguous.

The compiler fails closed on unsupported source, including duplicate or
case-colliding keys, anchors, aliases, merge keys, explicit YAML tags, complex
or quoted keys, multi-document syntax, targeted block scalars, ambiguous comment
ownership, excessive nesting, non-finite numbers, and oversized values.

## Source-preservation guarantee

P1 never performs `parse YAML -> mutate object -> dump whole YAML`.

It locates the source ranges owned by the targeted top-level entries and edits
only those ranges. For every admitted plan:

```text
actualDiff(before, after) is a subset of authorizedChangeSet(intent)
```

When not targeted, the following remain byte-identical:

- the Markdown body;
- line endings;
- comments;
- key order, spelling, quoting, indentation, and YAML representation;
- every source segment outside the authorized edit ranges.

The durable projection proof contains only digests, operation names, keys, line
ending, and authorized ranges. It never contains the next Markdown or values.
When several keys are inserted at one offset, their single authorized range
uses a fixed bounded marker; the individual names remain in `changedKeys`.

## Authority and concurrency

P1 reuses the P0 SQLite journal, leases, attempt fencing, Atomic Write Bridge
CAS, terminal receipts, status reconciliation, and exact-plan recovery.

Planning has two phases:

1. P1 reads the live note and compiles the source-preserving candidate;
2. P0 re-reads the same target and admits the candidate only if both SHA-256 and
   backend binding still equal the compiler snapshot.

A source or backend change between those two reads creates no durable plan.

The public idempotency key is hashed into a domain-specific internal P0 key. A
separate intent digest binds path plus canonical operations:

- same public key + same intent returns the first durable winner, including
  when a concurrent loser compiled from another source snapshot;
- same public key + different intent is rejected;
- a rejected pre-admission source drift does not reserve the key;
- direct P0 note-replacement idempotency remains unchanged.

P1 status is an observer. It may trigger P0 reconciliation but cannot borrow or
clear an active executor's authority. A stale executor cannot terminalize a
newer recovery attempt. A lost response is followed by status, not a blind new
mutation. Recovery resumes or reconciles the exact sealed child plan; it is not
undo.

## Write policy

Planning is not read-only because it creates durable mutation intent. P1 plan,
apply, and recovery honor the current MCP write mode. Protected frontmatter
keys are checked from the explicit P1 intent and again by P0 against the complete
before/after Markdown immediately before any possible effect.

The cache is never an authority for admission, CAS, commit, or recovery.

## Effect boundary

The atomic guarantee covers one target-note transition performed by Obsidian
`Vault.process` under exact SHA-256 CAS. Sync, filesystem watchers, third-party
plugins, indexers, and external automations remain outside the recovery
boundary.

## Deterministic evidence

The permanent gates cover:

- a pure executable authority/admission model;
- source-preserving compiler fixtures on LF and CRLF;
- source and backend drift between compilation and admission;
- same-key winner and different-intent conflict semantics;
- protected keys and write-policy drift;
- concurrent plan/apply/recover and exactly one backend effect;
- lost response, process restart, status, and exact-plan recovery;
- one plan and one projection proof across three independent HTTP MCP sessions;
- redaction of values, next content, and private journal paths;
- Linux and Windows.

## Live Obsidian canary

Use only an explicitly disposable existing Markdown note. The two reserved
canary keys must not already exist:

- `_optimike_p1_canary`
- `_optimike_p1_canary_delete`

PowerShell:

```powershell
$env:OBSIDIAN_FRONTMATTER_CANARY_PATH = "Canary/Frontmatter P1.md"
$env:OBSIDIAN_FRONTMATTER_CANARY_CONFIRM = "I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_PATCHED"
$env:OBSIDIAN_API_KEY = "<local-rest-api-key>"
$env:MCP_WRITE_MODE = "guarded"
npm run smoke:governed-frontmatter-live
```

The script saves an initial private backup before its first mutation, proves
add/set/delete, exact readback, replay, status, stale-plan conflict, and exact
restoration of the original SHA-256. It fails closed and retains the recovery
directory if restoration cannot be verified.

A live PASS must never be claimed without a real Obsidian Desktop and Atomic
Write Bridge run.
