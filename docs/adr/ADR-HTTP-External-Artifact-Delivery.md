# ADR — Governed HTTP delivery for external artifacts

- Status: proposed and implemented as an opt-in pilot on
  `feat/http-external-artifacts-broker`
- Date: 2026-07-28
- Depends on: [ADR — External document roots](ADR-External-Document-Roots.md)
- Product contract: ÉLYSIA OS external spaces and artifacts boundary

## Context

The external-roots subsystem already provides default-deny root discovery,
bounded listing, metadata, hashing, UTF-8 reads, and a verified local handoff.
The local handoff returns a process-owned temporary path and is intentionally
available only to a stdio client sharing the server filesystem.

The MCP server also already has a stateful Streamable HTTP transport. A direct
HTTP client can use the portable external-root operations, but cannot consume a
binary handoff because a local path is meaningless or unsafe across a transport
boundary.

This ADR decides whether HTTP should be an official profile, how a verified
artifact is delivered without disclosing a physical source path, and whether
external-root mutation belongs in the same change.

## Decision summary

| Axis | Verdict | Decision |
| --- | --- | --- |
| Direct HTTP, loopback | `ADOPT_WITH_LIMITS` | Official single-process profile on a deterministic loopback endpoint. |
| HTTP behind a trusted reverse proxy | `PILOT_ONLY` | TLS termination, explicit origins, trusted proxy configuration, and standards-compliant OAuth deployment evidence are required. |
| Direct public exposure by the Node server | `REJECT` | The server does not provide TLS termination or a complete internet-facing deployment boundary. |
| Transport-independent handoff | `ADOPT_WITH_LIMITS` | One semantic operation with `local_path` and `http_ticket` delivery modes. |
| HTTP transfer mechanism | `ADOPT_WITH_LIMITS` | Authenticated auxiliary GET endpoint with an opaque one-use ticket in a header. |
| External mutations | `DEFER` | Separate ADR, module, threat model, journal, rollback proof, and local-root pilot are required. |
| Generic cloud/network mutation | `REJECT` | Provider-specific connectors must own identity, revisions, and conflict semantics. |

## HTTP profiles

### Profile 1 — stdio proxy plus localhost backend

Status: stable and preferred for local agent harnesses.

The proxy owns local external-root configuration and can return a verified
`local_path`. The persistent HTTP backend remains an internal implementation
detail and must not be registered as a duplicate MCP in the same client.

### Profile 2 — direct loopback HTTP

Status: supported with limits.

Requirements:

- bind to `127.0.0.1` by default;
- use a deterministic configured port;
- fail closed when the port is occupied unless bounded retries are explicitly
  configured;
- expose `/healthz` for supervision;
- validate every supplied `Origin` against an exact allowlist;
- ignore `X-Forwarded-For` unless `MCP_TRUST_PROXY=true`;
- use JWT with a real secret or OAuth for HTTP artifact tickets;
- run as one supervised process with in-memory sessions.

This profile is not a clustered or serverless contract. HTTP sessions and
artifact tickets are process-local.

### Profile 3 — remote HTTP behind a trusted reverse proxy

Status: pilot only.

The reverse proxy or service boundary must provide:

- TLS;
- trusted Host and forwarding-header policy;
- request-size and connection limits;
- authentication routing;
- process supervision and restart;
- an exact origin policy;
- private network or firewall controls where applicable.

OAuth deployment must be reviewed against the current MCP authorization
specification, including protected-resource metadata. Existing JWT and OAuth
middleware are useful building blocks, not proof of a complete public-service
profile.

### Profile 4 — directly internet-exposed Node server

Status: rejected.

No documentation or example may imply that setting `MCP_HTTP_HOST=0.0.0.0`
alone creates a secure remote service.

## Handoff abstraction

`external_handoff` remains one semantic tool. The active transport selects one
of two delivery modes.

### `local_path`

- stdio only;
- verified process-owned temporary copy;
- physical path returned only to the local client;
- existing expiry and aggregate budgets remain active;
- never becomes the canonical ÉLYSIA locator.

### `http_ticket`

- direct HTTP only;
- disabled by default with `MCP_HTTP_HANDOFF_ENABLED=false`;
- requires a non-development authenticated identity;
- returns no source path and no temporary path;
- returns an opaque ticket, fixed endpoint, fixed ticket-header name, logical
  provenance, size, media type, modification time, SHA-256, and expiry;
- the client downloads from `GET /external-handoff` and sends the ticket in
  `X-External-Handoff-Ticket` together with the same bearer identity.

The ticket is:

- random and unguessable;
- bound to the bearer-token fingerprint, client ID, and subject;
- scoped to one staged file;
- short-lived;
- claimed atomically before reading;
- single-use;
- deleted with its staged copy after success, failure, or expiry.

A cross-client attempt receives the same generic unavailable response as an
unknown, expired, or replayed ticket. The ticket is not placed in a URL, query,
redirect, filename, or log field.

## Why an auxiliary endpoint

A standard MCP resource can carry binary content, but a large base64 blob inside
JSON-RPC adds encoding and memory overhead and depends on uneven client resource
handling. Streaming arbitrary binary bytes through the MCP JSON response would
also blur transport and business semantics.

The chosen endpoint remains inside the same authenticated process boundary but
outside the MCP JSON body. The MCP tool authorizes and stages the transfer; the
auxiliary endpoint consumes the resulting capability ticket.

This endpoint is not a generic file server. It has no root, path, directory, or
upload parameter.

## Provenance contract

The portable handoff descriptor contains:

- `delivery: http_ticket`;
- `rootId`;
- normalized root-relative `path`;
- `size`;
- `modifiedAt`;
- `sha256`;
- `mediaType`;
- `expiresAt`;
- fixed endpoint and ticket-header names.

The download response contains the bytes, content length, media type, a safe
filename, and `X-Artifact-SHA256`. It does not contain root ID, relative path,
source path, temporary path, user profile, or drive layout.

The delivered object is the verified snapshot prepared at handoff time. A later
change to the source does not silently change the prepared snapshot; the hash
identifies exactly what was delivered.

## Limits and lifecycle

Defaults for the opt-in HTTP pilot:

- 60-second ticket TTL;
- 16 active tickets;
- 25 MiB per file;
- 128 MiB total staged bytes;
- one process-local ticket store;
- no persistence across restart;
- no replay after claim.

All budgets are independently bounded below the existing local handoff ceiling.
Environment overrides are bounded and validated. Restart invalidates every
outstanding session and ticket, which is a safe failure mode.

## HTTP lifecycle and supervision

The direct HTTP profile requires an already running backend. The repository must
provide or document:

- `npm run start:daemon` or an equivalent service command;
- deterministic host and port configuration;
- `/healthz` checks;
- restart on process failure;
- graceful termination where the supervisor supports it;
- Windows service/task examples and systemd examples as documentation, not an
  implicit installer.

The stdio proxy keeps its existing auto-start and reconnect behavior.

## Mutation decision

External mutation is not implemented in this change.

A generic `writable` capability is rejected because it collapses materially
different risks. A future vocabulary should evaluate at least:

- `create`;
- `replace` for an existing file;
- `move`;
- `delete`;
- `sync` as a separate and substantially riskier capability.

`replace` is preferred to the vague word `update`: it states that the full
binary object is replaced and avoids pretending that every format has a safe
semantic diff.

### Smallest defensible future mutation

A first mutation pilot may support only replacement of one existing regular file
inside one explicitly mutable local root:

1. read source and record expected SHA-256 `H0`;
2. upload to a process-owned staging area;
3. enforce size, type and root policy;
4. hash the staged payload;
5. produce a mutation plan and dry-run result;
6. require a distinct explicit apply call;
7. re-open and revalidate the source identity and `H0`;
8. create a same-filesystem backup;
9. atomically rename the staged file over the target where the platform permits;
10. re-read and verify `H1`;
11. journal the result with redacted logical identity;
12. expose rollback evidence.

The apply request must include an idempotency key bound to operation, root ID,
relative path, expected hash, and staged payload hash. Reusing the key with any
other payload or target is rejected.

### Milestone verdicts

| Milestone | Verdict | Reason |
| --- | --- | --- |
| M1 direct loopback HTTP profile | `APPLY_READY` | Transport and health endpoint already exist; deterministic and security hardening are bounded. |
| M2 transport-independent handoff | `APPLY_READY` | Preserves stdio and adds one explicit delivery mode. |
| M3 HTTP read-only handoff | `APPLY_READY` | One-file, one-use, authenticated, bounded, path-redacted transfer. |
| M4 upload staging | `EVAL_FIRST` | Useful only as part of a mutation contract; must not imply apply. |
| M5 governed replace | `HOLD` | Requires independent journal, backup, crash, Windows, and rollback evidence. |
| M6 create | `EVAL_FIRST` | Target non-existence and idempotence semantics need proof. |
| M6 move | `HOLD` | Reference breakage and cross-filesystem behavior need a separate plan. |
| M6 delete | `REJECT` for V1 | Irreversible risk is not justified by the current use case. |
| `sync` | `REJECT` | It is a reconciliation product, not a file-write operation. |

## Storage classes

| Storage | Read/handoff | Generic mutation |
| --- | --- | --- |
| Ordinary local filesystem | Supported within explicit roots | Future local-only pilot may be possible. |
| Windows mapped drive | Outside consistency guarantees | Rejected for generic mutation. |
| Unix network mount | Outside consistency guarantees | Rejected for generic mutation. |
| OneDrive synchronized folder | Best-effort local read only | Provider connector required for governed mutation. |
| SharePoint | Provider connector | Provider connector only. |
| Google Drive | Provider connector | Provider connector only. |
| Other collaborative storage | Provider connector | Provider connector only. |

A local-looking path is not proof that storage has local atomicity, revision, or
locking semantics.

## Threat model

| Threat | Protected asset | Plausible attacker/error | Mitigation | Required test | Residual decision |
| --- | --- | --- | --- | --- | --- |
| Path traversal | Root boundary | Malicious relative path | Existing normalization rejects `..`, empty segments and absolute paths | Traversal cases on Linux/Windows | `MITIGATE` |
| Client absolute path | Root boundary | Client submits source path | Tool accepts `rootId` plus relative path only | POSIX and drive-letter absolute paths | `MITIGATE` |
| Physical-path leak | User privacy | Response, error or log exposes path | HTTP descriptor and response are path-redacted; ticket stays in header | Scan outputs, headers and logs | `MITIGATE` |
| Symlink/junction/reparse escape | Root boundary | Link swapped into path | Component checks, canonical confinement and opened-handle identity checks | Symlink and Windows junction fixtures | `MITIGATE` |
| Swap after validation | File integrity | Ancestor or file replaced | Re-resolve and compare device/inode around open/read | Simulated identity swap | `MITIGATE` |
| TOCTOU during read | File integrity | Concurrent writer | Handle stats and final path identity revalidation | Mutate during read | `MITIGATE` |
| Source changes after staging | Provenance | Legitimate concurrent edit | Deliver immutable staged snapshot with SHA-256 and timestamp | Change source after ticket issue | `ACCEPT` |
| Unauthorized client | Confidentiality | Missing/invalid bearer | JWT/OAuth middleware plus authenticated tool metadata | Missing, invalid and valid auth | `MITIGATE` |
| Ticket replay | Confidentiality | Same client reuses ticket | Claim and delete before read | Second consume fails | `MITIGATE` |
| Ticket transferred to another client | Confidentiality | Ticket leakage | Bind to token fingerprint, client ID and subject | Different-token and different-client attempts | `MITIGATE` |
| Expiry failure | Confidentiality/disk | Stale ticket retained | Bounded TTL sweep and consume-time expiry | Controlled clock expiry | `MITIGATE` |
| Partial download | Client result | Network interruption | SHA-256 and content length allow client verification; ticket is consumed | Abort client and verify no replay | `ACCEPT` |
| Oversized file | Memory/disk | Large allowed source | Root limit plus lower HTTP file and aggregate limits | Boundary and over-limit tests | `MITIGATE` |
| Disk or memory exhaustion | Availability | Many concurrent tickets | Ticket count, byte budget, serialized claims, expiry | Capacity and concurrency tests | `MITIGATE` |
| Malicious archive | Client execution | Crafted ZIP/Office/PDF | Broker never executes, extracts or renders content | Binary pass-through fixture | `ACCEPT` |
| Active content | Client safety | Macros/scripts in document | Content-Type only; client harness owns sandbox/extraction policy | Document remains opaque bytes | `DEFER` |
| Concurrent writes | Source integrity | Multiple mutation clients | No mutation surface in this ADR | Assert no mutating external tool | `REJECT` for current scope |
| Crash during replacement | Source integrity | Process/host crash | Future journal, same-filesystem staging and backup | Crash-injection suite | `DEFER` |
| Incomplete rollback | Source integrity | Backup or restore failure | Future verified backup and post-rollback hash | Fault-injection suite | `DEFER` |
| Secret or path in journal | Privacy | Over-detailed logging | Current transfer logs only error code and client ID | Log scan | `MITIGATE` |
| Untrusted proxy headers | Rate-limit identity | Client spoofs forwarding header | Ignore unless explicit `MCP_TRUST_PROXY=true` | Spoof with flag off/on | `MITIGATE` |
| Unreliable network | Availability | Disconnect/retry | One-use snapshot; client requests a new ticket after failure | Interrupted download | `ACCEPT` |
| Cloud/synchronized storage | Consistency | Placeholder or remote conflict | Outside local consistency guarantees | Documentation and config fixture | `DEFER` |
| Wrong same-named file | Authority | Human selects wrong relative path | Root ID, normalized relative path, size and hash in plan | Two same-name fixtures | `MITIGATE` |
| Move/delete breaks references | ÉLYSIA graph | Mutation without inventory | No move/delete implementation; future reference inventory gate | Mutation tool absence | `REJECT` for V1 |
| Idempotency-key abuse | Mutation integrity | Replay with changed payload | Future key binding and immutable result record | Same/different payload replay | `DEFER` |
| Apply-gate bypass | Source integrity | Staging treated as authorization | No upload or mutation in current change; future distinct plan/apply tools | Assert staging cannot write source | `REJECT` for current scope |
| Browser DNS rebinding | Local service | Malicious web origin | Exact Origin validation; default loopback bind | Disallowed and allowed Origin tests | `MITIGATE` |
| Port drift | Availability/authority | Server silently selects another port | Zero retries by default; bounded opt-in retries only | Occupied configured port | `MITIGATE` |

## Compatibility

- Existing stdio handoff remains unchanged.
- The stdio proxy continues to intercept external-root operations locally.
- HTTP ticket delivery is disabled by default.
- No PDF or Office extractor enters the core.
- No external index is introduced.
- No new external-root mutation capability is introduced.
- No external content enters the vault cache.

## Rollback

1. Set `MCP_HTTP_HANDOFF_ENABLED=false` or remove the variable.
2. Restart the HTTP service; all process-local tickets become invalid.
3. Revert the HTTP broker commits if the profile is abandoned.
4. The original stdio local-path handoff and portable read-only tools remain
   available.

Rollback never modifies an external source file.

## Open decisions

Before promoting remote HTTP beyond pilot:

1. complete OAuth protected-resource metadata and client interoperability tests;
2. publish reviewed Windows service and systemd examples;
3. test at least two real remote MCP clients;
4. decide whether sessions and tickets ever need a distributed store;
5. add trusted reverse-proxy integration evidence;
6. run a separate mutation ADR only if read-only delivery produces a real unmet
   need.
