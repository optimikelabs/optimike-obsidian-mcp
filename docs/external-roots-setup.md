# External document roots — setup and operations

French version: [external-roots-setup.fr.md](external-roots-setup.fr.md)

External document roots let an MCP client discover and read explicitly allowed
files that remain outside the Obsidian vault. Typical examples are PDFs, Office
documents, datasets, project folders, and application-managed libraries.

This feature is a read-only broker, not a second vault:

- the MCP authorizes logical root IDs and confines every request to one root;
- it can list, stat, hash, and read bounded UTF-8 text;
- `external_handoff` can prepare one verified snapshot for a client that owns the
  appropriate PDF, Office, OCR, or binary tooling;
- it does not index, synchronize, move, rename, write, or back up external
  documents.

Handoff delivery depends on the transport:

- local stdio returns a short-lived `local_path`;
- an authenticated direct HTTP profile may return an opt-in `http_ticket`;
- neither mode returns the physical source path;
- neither mode changes the source or grants durable-copy rights.

See [ADR — External document roots](adr/ADR-External-Document-Roots.md) and
[ADR — Governed HTTP delivery for external artifacts](adr/ADR-HTTP-External-Artifact-Delivery.md).

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

| Field | Contract |
| --- | --- |
| `version` | Must be `1`. |
| `roots` | Zero to 32 root objects. Root IDs must be unique. |

Each root is also strict:

| Field | Contract |
| --- | --- |
| `id` | Stable lowercase logical ID: letters, digits, `.`, `_`, and `-`. |
| `path` | Absolute directory. UNC-prefixed paths are rejected; mapped or mounted network storage is not detected and remains unsupported. |
| `capabilities` | One or more of `visible`, `readable`, `handoff`. `handoff` requires `readable`. |
| `include` | Git-style glob allowlist. Default: `["**"]`. A file that matches no include pattern is denied, including extensionless files. |
| `exclude` | Git-style glob denylist. Default: `.git` and `node_modules`. Exclude wins over include. |
| `limits` | Optional bounded limits described below. Unknown fields are rejected. |

Capabilities are independent:

- root IDs, capabilities, availability, and limits are always disclosed by
  `external_runtime_status` and `external_roots_list`;
- `visible` permits bounded directory listing and file metadata;
- `readable` permits hashing and direct UTF-8 reads;
- `handoff` permits one verified snapshot through a delivery mode supported by
  the active transport.

Limit defaults and schema ceilings:

| Limit | Default | Maximum |
| --- | ---: | ---: |
| `maxDepth` | 6 | 20 |
| `maxFileBytes` | 50 MiB | 200 MiB |
| `maxListEntries` | 500 | 5,000 |
| `maxTextChars` | 200,000 | 2,000,000 |

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

| Variable | Default | Maximum |
| --- | ---: | ---: |
| `MCP_HTTP_HANDOFF_TTL_MS` | 60,000 | 300,000 |
| `MCP_HTTP_HANDOFF_MAX_TICKETS` | 16 | 128 |
| `MCP_HTTP_HANDOFF_MAX_FILE_BYTES` | 25 MiB | 200 MiB |
| `MCP_HTTP_HANDOFF_MAX_TOTAL_BYTES` | 128 MiB | 1 GiB |

The broker rejects the development authentication placeholder. Setting
`MCP_HTTP_HANDOFF_ENABLED=true` without a real authenticated identity does not
open binary handoff.

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
headers. The server ignores `X-Forwarded-For` by default.

Do not expose the Node server directly to the public internet merely by binding
`MCP_HTTP_HOST=0.0.0.0`.

## 5. Client capability matrix

| Client | Intended integration | What this repository verifies |
| --- | --- | --- |
| Codex | Local stdio proxy with process environment | Configured production use and local-path handoff workflow. |
| Claude Code | Local stdio server configured by the client | Protocol-compatible design; client-specific setup is not tested here. |
| Gemini CLI | Local stdio server configured by the client | Protocol-compatible design; client-specific setup is not tested here. |
| OpenClaw | Local MCP process when supported by its deployment | Protocol-compatible design; path access depends on the deployment. |
| Hermes Agent | Local MCP process when supported by its deployment | Protocol-compatible design; path access depends on the deployment. |
| Direct loopback HTTP client | Status/list/stat/read and optional ticket handoff | Automated Streamable HTTP, JWT, ticket, replay, identity and binary tests. |
| Remote HTTP client | Same protocol behind reviewed deployment controls | Architecture and automated server tests; real remote-client interoperability remains pilot evidence. |

The MCP core does not install or configure the client's document extraction
tools. A client without a suitable PDF or Office tool can still list, stat,
hash, and read allowed UTF-8 documents, but cannot extract binary content.

## 6. Restart and verify

The JSON root configuration and HTTP ticket settings are loaded when the process
starts. Restart the MCP client or service after changing them.

Recommended verification sequence:

1. Call `external_runtime_status` and confirm `enabled: true` plus the expected
   logical root ID.
2. Inspect `handoffModes`:
   - stdio should expose `local_path`;
   - an enabled authenticated direct HTTP service should expose `http_ticket`.
3. Call `external_roots_list`; confirm that the root is `available`.
4. Call `external_list` with the root ID and a bounded depth.
5. Call `external_stat`, then `external_read` on a small UTF-8 pilot file.
6. If needed, call `external_handoff` and consume the returned delivery mode.
7. Confirm that no public result contains the physical root path.

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

The HTTP broker does not own or delete that local cache. It verifies the copy,
keeps a separate bounded memory snapshot for the short ticket lifetime, then
removes the snapshot after use or expiry.

Portable provenance is the logical root ID, root-relative path, size,
modification time, and SHA-256, not a local path or ticket.

## 8. Mutations remain out of scope

The current `external_roots` surface has no upload, create, replace, move, delete,
or sync operation.

A future mutation proposal requires a separate ADR, granular positive
capabilities, expected-hash preconditions, plan and explicit apply calls,
idempotency, atomic replacement, journal, backup, post-write proof, crash tests,
and rollback evidence.

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

| Error/state | Check |
| --- | --- |
| `configuration_invalid` | Absolute config path, valid JSON, version `1`, known fields, root ID rules. |
| `root_unavailable` | The configured directory exists and the MCP process can access it. |
| `capability_denied` | The root declares the required capability; HTTP ticket mode is enabled and uses real auth. |
| `path_not_allowed` | The relative file path matches `include` and does not match `exclude`. |
| `path_link_unsupported` | Remove symlinks or junctions from the requested path. |
| `too_large` | Root limits plus the local or HTTP aggregate handoff budget. |
| `unsupported` | Use UTF-8 text for `external_read`, or a supported handoff mode for binary content. |
| HTTP ticket unavailable | Check feature flag, auth mode, bearer identity, TTL, one-use semantics, and service restart. |
| Unexpected port | Keep `MCP_HTTP_PORT_RETRIES=0` or inspect the bounded configured fallback. |
| Remote client failure | Verify TLS proxy, Origin allowlist, auth metadata, forwarding trust, firewall and client compatibility. |

The server never infers a new root from a path found in an Obsidian note.
