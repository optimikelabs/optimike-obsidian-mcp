# External document roots — setup and operations

French version: [external-roots-setup.fr.md](external-roots-setup.fr.md)

External document roots let an MCP client discover and read explicitly allowed
files that remain outside the Obsidian vault. Typical examples are PDFs, Office
documents, datasets, project folders, and application-managed libraries.

This feature is primarily a read broker, not a second vault or a general file
manager:

- the MCP authorizes logical root IDs and confines every request to one root;
- it can list, stat, hash, and read bounded UTF-8 text;
- `external_handoff` can prepare one verified snapshot for a client that owns the
  appropriate PDF, Office, OCR, or binary tooling;
- one separately gated local-stdio workflow can move a regular file inside the
  same root and repair exact ÉLYSIA references;
- it does not index, synchronize, upload, create, replace, delete, or back up
  external documents.

Handoff delivery depends on the transport:

- local stdio returns a short-lived `local_path`;
- an authenticated direct HTTP profile may return an opt-in `http_ticket`;
- neither mode returns the physical source path;
- neither mode changes the source or grants durable-copy rights.

See [ADR — External document roots](adr/ADR-External-Document-Roots.md) and
[ADR — Governed HTTP delivery for external artifacts](adr/ADR-HTTP-External-Artifact-Delivery.md).
The move/repair boundary is owned by
[ADR — External reference integrity](adr/ADR-External-Reference-Integrity.md).

## 1. Create a machine-local configuration

Copy [`external-roots.example.json`](external-roots.example.json) outside the
repository. Never commit the configured file because it contains machine paths.

Unix example:

```json
{
  "version": 1,
  "roots": [
    {
      "id": "project.documents",
      "path": "/srv/documents/project",
      "capabilities": ["visible", "readable", "handoff"],
      "include": ["**/*.md", "**/*.pdf", "**/*.docx"],
      "exclude": ["**/.git/**", "**/node_modules/**", "**/~$*"],
      "limits": {
        "maxDepth": 6,
        "maxFileBytes": 52428800,
        "maxListEntries": 500,
        "maxTextChars": 200000
      }
    }
  ]
}
```

Windows JSON example:

```json
{
  "version": 1,
  "roots": [
    {
      "id": "project.documents",
      "path": "B:\\Documents\\Project",
      "capabilities": ["visible", "readable", "handoff"],
      "include": ["**/*.md", "**/*.pdf", "**/*.docx"],
      "exclude": ["**/.git/**", "**/node_modules/**", "**/~$*"],
      "limits": {
        "maxDepth": 6,
        "maxFileBytes": 52428800,
        "maxListEntries": 500,
        "maxTextChars": 200000
      }
    }
  ]
}
```

JSON backslashes must be escaped. Paths with a UNC prefix are rejected. A
mapped drive or a network filesystem mounted behind an ordinary local-looking
path cannot be detected reliably and remains outside the supported guarantees.

## 2. Configuration contract

The top-level object is strict:

| Field     | Contract                                          |
| --------- | ------------------------------------------------- |
| `version` | Must be `1`.                                      |
| `roots`   | Zero to 32 root objects. Root IDs must be unique. |

Each root is also strict:

| Field          | Contract                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | Stable lowercase logical ID: letters, digits, `.`, `_`, and `-`.                                                                 |
| `path`         | Absolute directory. UNC-prefixed paths are rejected; mapped or mounted network storage is not detected and remains unsupported.  |
| `capabilities` | One or more of `visible`, `readable`, `handoff`, `move`. `handoff` requires `readable`; `move` is an independent positive grant. |
| `include`      | Git-style glob allowlist. Default: `["**"]`. A file that matches no include pattern is denied, including extensionless files.    |
| `exclude`      | Git-style glob denylist. Default: `.git` and `node_modules`. Exclude wins over include.                                          |
| `limits`       | Optional bounded limits described below. Unknown fields are rejected.                                                            |

Capabilities are independent:

- root IDs, capabilities, availability, and limits are always disclosed by
  `external_runtime_status` and `external_roots_list`;
- `visible` permits bounded directory listing and file metadata;
- `readable` permits hashing and direct UTF-8 reads;
- `handoff` permits one verified snapshot through a delivery mode supported by
  the active transport.
- `move` permits planning one same-root regular-file move. It does not enable
  apply, rollback, or automatic mutating recovery: those paths are disabled on
  every platform until an audited native handle-relative primitive exists.

Limit defaults and schema ceilings:

| Limit            | Default |   Maximum |
| ---------------- | ------: | --------: |
| `maxDepth`       |       6 |        20 |
| `maxFileBytes`   |  50 MiB |   200 MiB |
| `maxListEntries` |     500 |     5,000 |
| `maxTextChars`   | 200,000 | 2,000,000 |

`external_read` accepts valid UTF-8 files with these extensions: `.txt`, `.md`,
`.markdown`, `.csv`, `.json`, `.yaml`, `.yml`, `.xml`, `.html`, `.htm`, and
`.log`. Use `external_handoff` for an allowed binary document.

## 3. Recommended local stdio profile

The recommended local entrypoint is `dist/stdio-proxy.js`. Set
`MCP_EXTERNAL_ROOTS_FILE` on that MCP process, never in the vault.

Codex on Windows:

```toml
[mcp_servers.optimike-obsidian-mcp-stdio]
command = "node"
args = ['E:\path\to\optimike-obsidian-mcp\dist\stdio-proxy.js']

[mcp_servers.optimike-obsidian-mcp-stdio.env]
MCP_EXTERNAL_ROOTS_FILE = 'C:\Users\you\.config\optimike\external-roots.json'
```

Codex on Unix:

```toml
[mcp_servers.optimike-obsidian-mcp-stdio]
command = "node"
args = ["/path/to/optimike-obsidian-mcp/dist/stdio-proxy.js"]

[mcp_servers.optimike-obsidian-mcp-stdio.env]
MCP_EXTERNAL_ROOTS_FILE = "/home/you/.config/optimike/external-roots.json"
```

The proxy reuses or starts the persistent localhost backend and intercepts the
external-root tools locally. `external_handoff` therefore returns a verified
`local_path` that the same client process can consume.

Do not register the proxy and the direct HTTP endpoint as two copies of the same
MCP in one client by default. That duplicates the tool surface and makes routing
ambiguous.

## 4. Optional direct HTTP profile

Direct Streamable HTTP is an explicit service profile. It requires an already
running supervised backend; it is not auto-started by a remote client.

Safe local defaults:

```text
MCP_TRANSPORT_TYPE=http
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3010
MCP_HTTP_PORT_RETRIES=0
MCP_EXTERNAL_ROOTS_FILE=/absolute/path/external-roots.json
```

Start and verify:

```bash
npm run build
npm run start:daemon
curl http://127.0.0.1:3010/healthz
```

`/healthz` is an unauthenticated liveness probe and intentionally returns only
minimal, path-free service state. Use the authenticated
`obsidian_runtime_status` and `obsidian_runtime_maintenance` tools for runtime,
cache, configuration, or integrity details.

The configured port is deterministic by default. Set
`MCP_HTTP_PORT_RETRIES` to a bounded value only when controlled fallback ports
are acceptable.

### Enable HTTP ticket handoff

HTTP binary delivery is disabled by default. Enable it only on an authenticated
HTTP profile:

```text
MCP_HTTP_HANDOFF_ENABLED=true
MCP_AUTH_MODE=jwt
MCP_AUTH_SECRET_KEY=<at-least-32-character-secret>
```

OAuth can also provide the authenticated identity, but remote OAuth deployment
remains a pilot until protected-resource metadata and client interoperability
are validated.

Optional bounded HTTP ticket settings:

| Variable                               | Default | Maximum |
| -------------------------------------- | ------: | ------: |
| `MCP_HTTP_HANDOFF_TTL_MS`              |  60,000 | 300,000 |
| `MCP_HTTP_HANDOFF_MAX_TICKETS`         |      16 |     128 |
| `MCP_HTTP_HANDOFF_MAX_FILE_BYTES`      |  25 MiB | 200 MiB |
| `MCP_HTTP_HANDOFF_MAX_TOTAL_BYTES`     | 128 MiB |   1 GiB |
| `MCP_HTTP_HANDOFF_TRANSFER_TIMEOUT_MS` | 120,000 | 600,000 |

The broker rejects the development authentication placeholder and requires the
authenticated identity to carry the `external:read` scope. Setting
`MCP_HTTP_HANDOFF_ENABLED=true` without that real scoped identity does not open
binary handoff.

### HTTP handoff sequence

1. Call `external_handoff` through the authenticated MCP HTTP session.
2. Receive `delivery: http_ticket`, logical provenance, SHA-256, expiry, the
   fixed endpoint, and the ticket-header name.
3. Send `GET /external-handoff` to the same service.
4. Send the same bearer identity plus
   `X-External-Handoff-Ticket: <opaque-ticket>`.
5. Verify `Content-Length`, `X-Artifact-SHA256`, and the downloaded bytes.

The ticket:

- is scoped to one verified in-memory snapshot;
- is bound to the bearer token fingerprint, client ID, and subject;
- requires the `external:read` scope when issued;
- is single-use;
- expires quickly;
- never appears in a URL;
- does not disclose a source or temporary path.

An interrupted download consumes the ticket. Request a new handoff rather than
replaying the old ticket.

### Remote HTTP boundary

A remote profile is pilot-only behind a trusted TLS reverse proxy or equivalent
service boundary. It needs explicit origin policy, connection and body limits,
trusted forwarding-header configuration, authentication, process supervision,
and firewall or private-network controls.

Set `MCP_TRUST_PROXY=true` only when a trusted reverse proxy overwrites forwarding
headers and network policy blocks direct access to the Node process. The server
ignores `X-Forwarded-For` by default; the boolean setting does not authenticate
a proxy by itself.

Do not expose the Node server directly to the public internet merely by binding
`MCP_HTTP_HOST=0.0.0.0`.

## 5. Client capability matrix

| Client                      | Intended integration                               | What this repository verifies                                                                        |
| --------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Codex                       | Local stdio proxy with process environment         | Configured production use and local-path handoff workflow.                                           |
| Claude Code                 | Local stdio server configured by the client        | Protocol-compatible design; client-specific setup is not tested here.                                |
| Gemini CLI                  | Local stdio server configured by the client        | Protocol-compatible design; client-specific setup is not tested here.                                |
| OpenClaw                    | Local MCP process when supported by its deployment | Protocol-compatible design; path access depends on the deployment.                                   |
| Hermes Agent                | Local MCP process when supported by its deployment | Protocol-compatible design; path access depends on the deployment.                                   |
| Direct loopback HTTP client | Status/list/stat/read and optional ticket handoff  | Automated Streamable HTTP, JWT, ticket, replay, identity and binary tests.                           |
| Remote HTTP client          | Same protocol behind reviewed deployment controls  | Architecture and automated server tests; real remote-client interoperability remains pilot evidence. |

The MCP core does not install or configure the client's document extraction
tools. A client without a suitable PDF or Office tool can still list, stat,
hash, and read allowed UTF-8 documents, but cannot extract binary content.

## 6. Restart and verify

The JSON root configuration and HTTP ticket settings are loaded when the process
starts. Restart the MCP client or service after changing them.

Recommended verification sequence:

1. Call `external_runtime_status` and confirm `enabled: true` plus the expected
   logical root ID.
2. Use an identity carrying `external:read` for every external-root status,
   list, stat, read, hash, or handoff call made through direct HTTP.
3. Inspect `handoffModes`:
   - stdio should expose `local_path`;
   - an enabled authenticated direct HTTP service should expose `http_ticket`.
4. Call `external_roots_list`; confirm that the root is `available`.
5. Call `external_list` with the root ID and a bounded depth.
6. Call `external_stat`, then `external_read` on a small UTF-8 pilot file.
7. If needed, call `external_handoff` and consume the returned delivery mode.
8. Confirm that no public result contains the physical root path.

Repository checks:

```bash
npm run test:external-roots
npm run test:http-external-handoff
MCP_EXTERNAL_ROOTS_FILE=/absolute/path/external-roots.json npm run smoke:external-roots
MCP_EXTERNAL_ROOTS_FILE=/absolute/path/external-roots.json npm run smoke:external-roots:mcp
```

PowerShell:

```powershell
npm run test:external-roots
npm run test:http-external-handoff
$env:MCP_EXTERNAL_ROOTS_FILE = 'C:\Users\you\.config\optimike\external-roots.json'
npm run smoke:external-roots
npm run smoke:external-roots:mcp
```

These checks cover different boundaries:

- `test:external-roots` uses disposable fixtures and tests confinement,
  allowlists, handle identity, redaction, limits, local handoff lifecycle, the
  stdio proxy, and authenticated HTTP ticket delivery on Linux and Windows CI;
- `test:http-external-handoff` isolates the HTTP broker and transport contract;
- `smoke:external-roots` validates the configured service and a real pilot root;
- `smoke:external-roots:mcp` validates the MCP tool contract through the direct
  stdio server entrypoint with the configured root;
- the production client still needs a client-specific verification.

## 7. Handoff lifecycle and security

`external_handoff` never returns the source path.

The local handoff service reads through a verified file handle and owns a bounded
copy with mode `0600` on platforms that enforce POSIX permissions:

- copies expire after one hour and are swept every five minutes;
- one service keeps at most 16 files and 512 MiB;
- the oldest copies are evicted to make room;
- the process removes its directory on normal exit;
- a later configured service scavenges directories owned by dead processes or
  stale ownership heartbeats.

The HTTP broker does not own or delete that local cache. It verifies the copy
and keeps a separate bounded memory snapshot while the ticket is pending and
while the chunked download is in flight. The snapshot's capacity lease is
released only after the stream completes or is cancelled; an expired unused
ticket is swept without delivery.

Portable provenance is the logical root ID, root-relative path, size,
modification time, and SHA-256, not a local path or ticket.

## 8. Governed local move and reference repair

The reference scan, move plan and move status are diagnostic/read-only on every
platform. Move apply, rollback and automatic mutating recovery are disabled
until an audited native handle-relative mutation primitive exists. The runtime
reason is `native_handle_relative_mutation_unavailable`; setting write mode,
the feature flag or the root `move` capability does not override this fail-closed
boundary. Redacted receipts, private SQLite snapshots, legacy bindings, stale
session/binding checks and exact-CAS evidence remain required contract data.

The designed external-root mutation is a local stdio transaction for one
regular file. It is currently disabled on every platform by the
`native_handle_relative_mutation_unavailable` boundary; it is designed to
preserve ÉLYSIA references, not to replace filesystem tools.

The durable reference model is assembled at scan/plan time from `rootId`,
root-relative path, source SHA-256, occurrence classification and source note
path. The Markdown token serializes only the stable `rootId` plus relative path.
Repair planning is embedded in `external_move_plan`. The disabled
`external_move_apply` surface remains only the future same-plan continuation
boundary; separate `external_links_repair_*` tools are intentionally absent so
an audited implementation cannot apply file and note changes independently.

### Add the stable identity next to the clickable link

```md
- [Open the brief](file:///B:/Documents/Project/brief%20final.docx) — `external-ref:project.documents::brief%20final.docx`
```

The link remains clickable. The adjacent inline-code token carries the logical
root ID and the canonically percent-encoded root-relative path. `/` separates
encoded path segments. The token neither exposes the configured root path nor
authorizes access by itself.

Only an exact token/link pair in the same active Markdown paragraph is eligible
for a future automatic repair. Bare physical paths, mismatched or orphan
tokens, multiple candidates, unsupported syntax and
historical/example/archive/release sections are classified for manual review.
One manual-review occurrence blocks any future mutation.

The Markdown parser does not traverse fenced code and excludes YAML frontmatter.
A free-form path, a YAML property or a path under an artifacts heading without
the canonical pair is never auto-repaired. If it physically refers to the
planned source, it remains manual review and blocks any future mutation.

### Configure diagnostic planning explicitly

Keep the ordinary examples above read-only. For one non-sensitive diagnostic
pilot root, add `move` deliberately:

```json
"capabilities": ["visible", "readable", "handoff", "move"]
```

Then configure the local stdio process. These historical write gates do not
enable mutation while the fail-closed boundary is active:

```text
MCP_WRITE_MODE=full
MCP_EXTERNAL_MOVE_ENABLED=true
MCP_EXTERNAL_MOVE_PROFILE_ID=<stable-lowercase-vault-profile-id>
MCP_EXTERNAL_MOVE_JOURNAL_PATH=<optional-absolute-local-sqlite-path>
```

The profile ID is mandatory when scan/plan initialize the external-move
coordinator, independently of `MCP_WRITE_MODE` and
`MCP_EXTERNAL_MOVE_ENABLED`. Read/list/stat/handoff work without it and do not
initialize a move journal. The profile is an operator label, not the
destructive identity on its own: both the proxy and its already-running backend
must be in `headless-filesystem` against the same configured, resolvable
`OBSIDIAN_VAULT`. Before plan, and before any future mutation, the
backend re-reads its vault directory and compares its strict SHA-256 filesystem
proof (device/inode) to an opaque 64-hex challenge supplied by the proxy. It
returns only `destructiveVaultIdentityVerified: true|false` plus a scheme
version: neither side's digest is returned by runtime status. The proxy fails
closed on absence or mismatch.

The proof and challenge never contain a path, URL, device or inode. The
challenge is not logged, reflected, stored in a plan or placed in a receipt.
`external_runtime_status.externalMove` exposes only the redacted binding facts:
`planningAvailable` is `false` with `planningUnavailableReason: "stdio_only"`
on direct HTTP; on local stdio it is true only after binding verification, or
false with one of `profile_required`, `target_unverified`, or
`backend_attestation_unavailable`. `mutationAvailable` is independently always
false with `native_handle_relative_mutation_unavailable`. For older clients,
stdio retains `unavailableReason` only as a compatibility alias of the planning
reason; new callers must use the explicit planning fields. No path, digest,
challenge, URL, device or inode is exposed. The journal persists its private
derived binding only and is automatically
namespaced by that binding. Attested startup, runtime status, scan and an
unknown file-backed status do not create or open a writable journal. Plan opens
the journal lazily. An existing receipt, including one still held in a WAL, is
read from a verified private temporary DB/WAL snapshot with a freshly rebuilt
private SHM. That private directory is deleted after the query; the original
journal is not opened by SQLite. Status opens the writable journal only when it
can prove the current binding yet finds a stale session on a partial receipt:
that guarded reconciliation persists `recovery_required` with the stable
`backend_session_changed` code. If no coordinator is available, the stored
binding differs, or the receipt is a non-partial actionable state, status makes
no journal write: it returns an ephemeral manual-review projection with
`readyToApply: false` and no apply or rollback continuation.

The journal payload is untrusted input, even when its SQLite file is private.
A receipt with an authenticated-binding shape that is legacy or incomplete but
whose paths and integrity fields are still canonical remains inspectable as
status-only: it keeps its safe logical root/path fields, reports
`legacyBinding: true`, and projects `external_root_non_verifiable` with manual
review. A malformed receipt (for example an absolute, traversal or backslash
path, an unrecognised manual-review reason, or inconsistent hashes/tokens) is
never normalized or rewritten by status: it becomes a wholly redacted no-write
manual-review incident. The disabled apply and rollback routes return their
stable unavailable result before opening a backend session or consulting a
stored path.

For a future audited mutation, the proxy must capture its current backend
connection generation immediately after that proof. The destructive sequence
must be fenced to that one live session: a reconnect or backend swap must
invalidate the operation. It must not continue, repair notes, compensate, or
roll back through the replacement backend; the durable journal must record a
manual-recovery state instead. Public runtime status deliberately exposes no
stable configuration fingerprint or other connection correlator.

The historical three write grants (full write mode, the feature flag and the
root `move` capability) are necessary evidence but cannot enable mutation while
the native handle-relative primitive is unavailable. Scan, plan and status do
not move the file, but remain stdio-only because the proxy owns the local root
and journal.

### Diagnostic workflow

1. Call `external_references_scan` with `rootId` and `relativePath`. The scan
   inventories the whole governed vault.
2. Call `external_move_plan` with `sourceRelativePath`,
   `targetRelativePath` and a unique `idempotencyKey`. Planning always
   inventories the whole governed vault; it cannot be narrowed to a subfolder.
3. Inspect `external_move_status`; it remains diagnostic and reports
   `readyToApply: false` with reason
   `native_handle_relative_mutation_unavailable` while the fail-closed boundary
   is active.
4. Do not call `external_move_apply`; it cannot mutate on any platform.
5. Do not call `external_move_rollback`; recovery is diagnostic/manual only.

The target parent must already exist. Source and target must be regular-file
paths in the same logical root and filesystem volume, and the target must be
absent. These are plan-time diagnostic conditions. A future audited mutation
must revalidate source size, modification time and SHA-256; its native
handle-relative primitive, not the retired hard-link/unlink design, must prove
no-clobber behavior.

Each note repair is planned with an expected SHA-256 for future audited
execution. Apply and rollback remain disabled; if enabled after the native
handle-relative primitive is audited, they must stay restricted to
`headless-filesystem` on a copied or dedicated vault, where that hash is
enforced by the filesystem writer. Local REST API 4.1.7 returns an ETag but does
not enforce `If-Match` on whole-note writes. The machine-local SQLite
journal persists plan state and note preimages for compensation. Treat that
journal as sensitive local data and never commit or share it.

The historic compensating design restored already-modified notes and moved a
verified file back to its source. It is not executable now. A future primitive
must specify and independently audit its compensation and post-interruption
recovery semantics before any mutation can be enabled.

Direct HTTP refuses scan, plan, status, apply and rollback. HTTP tickets remain
read-only handoffs.

### Legacy journals are status-only

An existing pre-attestation journal at the old configured
`MCP_EXTERNAL_MOVE_JOURNAL_PATH` is never adopted into a new binding. If it is
still present, `external_move_status` can read its redacted receipt and marks it
`legacyBinding: true`; the disabled apply and rollback routes refuse it. Keep the private journal
and its preimages for a manual incident recovery, then create a new plan with a
new idempotency key after the backend/proxy target has been verified. Never copy
or rename a legacy database to make it look authenticated.

There is still no external-root upload, create, replace, directory move,
cross-root/cross-volume move, overwrite, delete, trash or sync operation.

Cloud, synchronized, mapped, or mounted network storage does not inherit local
filesystem mutation guarantees. SharePoint, Google Drive, OneDrive and similar
services need provider-specific connectors for governed writes.

## 9. Rollback and troubleshooting

Disable HTTP ticket delivery without changing any root or source file:

1. remove `MCP_HTTP_HANDOFF_ENABLED` or set it to `false`;
2. restart the HTTP service;
3. call `external_runtime_status` and confirm that `http_ticket` is absent.

Disable all external roots:

1. remove `MCP_EXTERNAL_ROOTS_FILE` from the MCP client configuration;
2. restart the process;
3. confirm `external_runtime_status.enabled: false`.

Common failures:

| Error/state             | Check                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `configuration_invalid` | Absolute config path, valid JSON, version `1`, known fields, root ID rules.                                                        |
| `root_unavailable`      | The configured directory exists and the MCP process can access it.                                                                 |
| `capability_denied`     | The root declares the required capability; HTTP ticket mode is enabled and uses real auth.                                         |
| `path_not_allowed`      | The relative file path matches `include` and does not match `exclude`.                                                             |
| `path_link_unsupported` | Remove symlinks or junctions from the requested path.                                                                              |
| `target_exists`         | Choose an absent target; overwrite is never allowed.                                                                               |
| `precondition_failed`   | Re-scan and create a new plan after a source, note or plan-state change.                                                           |
| Move target unavailable | Confirm both proxy and backend use `headless-filesystem`, the same resolvable vault, the profile ID, then restart the local proxy. |
| `too_large`             | Root limits plus the local or HTTP aggregate handoff budget.                                                                       |
| `unsupported`           | Use UTF-8 text for `external_read`, or a supported handoff mode for binary content.                                                |
| HTTP ticket unavailable | Check feature flag, auth mode, bearer identity, TTL, one-use semantics, and service restart.                                       |
| Unexpected port         | Keep `MCP_HTTP_PORT_RETRIES=0` or inspect the bounded configured fallback.                                                         |
| Remote client failure   | Verify TLS proxy, Origin allowlist, auth metadata, forwarding trust, firewall and client compatibility.                            |

The server never infers a new root from a path found in an Obsidian note.
Disable move without affecting reads by setting `MCP_EXTERNAL_MOVE_ENABLED=false`
or removing `move` from the root, then restarting the stdio process.
