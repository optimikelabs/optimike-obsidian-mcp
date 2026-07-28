# External document roots — setup and operations

External document roots let an MCP client discover and read explicitly allowed
files that remain outside the Obsidian vault. Typical examples are PDFs, Office
documents, datasets, project folders, and application-managed libraries.

This feature is a read-only broker, not a second vault:

- the MCP authorizes logical root IDs and confines every request to one root;
- it can list, stat, hash, and read bounded UTF-8 text;
- a local stdio client can explicitly request a verified temporary copy with
  `external_handoff`, then use its own PDF, Office, or OCR tools;
- it does not index, synchronize, move, rename, write, or back up external
  documents.

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

JSON backslashes must be escaped. UNC and network roots are not supported.

## 2. Configuration contract

The top-level object is strict:

| Field     | Contract                                          |
| --------- | ------------------------------------------------- |
| `version` | Must be `1`.                                      |
| `roots`   | Zero to 32 root objects. Root IDs must be unique. |

Each root is also strict:

| Field          | Contract                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`           | Stable lowercase logical ID: letters, digits, `.`, `_`, and `-`.                                                              |
| `path`         | Absolute machine-local directory. UNC/network paths are rejected.                                                             |
| `capabilities` | One or more of `visible`, `readable`, `handoff`. `handoff` requires `readable`.                                               |
| `include`      | Git-style glob allowlist. Default: `["**"]`. A file that matches no include pattern is denied, including extensionless files. |
| `exclude`      | Git-style glob denylist. Default: `.git` and `node_modules`. Exclude wins over include.                                       |
| `limits`       | Optional bounded limits described below. Unknown fields are rejected.                                                         |

Capabilities are independent:

- `visible` permits root status, bounded listing, and metadata;
- `readable` permits hashing and direct UTF-8 reads;
- `handoff` permits a verified temporary copy over local stdio only.

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

## 3. Configure a local stdio client

The recommended entrypoint is `dist/stdio-proxy.js`. Set
`MCP_EXTERNAL_ROOTS_FILE` on that MCP process, not in the vault.

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

Claude Code, Gemini CLI, OpenClaw, Hermes Agent, and other local MCP clients can
use the same stdio command and environment variable if their MCP implementation
supports local process environment configuration. Configuration syntax,
approval behavior, and access to a returned local path are client-specific.
The repository does not claim identical behavior across those clients.

| Client             | Intended integration                                      | What this repository verifies                                         |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------------------------- |
| Codex              | Local stdio proxy with process environment                | Configured production use and pilot workflow.                         |
| Claude Code        | Local stdio server configured by the client               | Protocol-compatible design; client-specific setup is not tested here. |
| Gemini CLI         | Local stdio server configured by the client               | Protocol-compatible design; client-specific setup is not tested here. |
| OpenClaw           | Local MCP process when supported by its deployment        | Protocol-compatible design; path access depends on the deployment.    |
| Hermes Agent       | Local MCP process when supported by its deployment        | Protocol-compatible design; path access depends on the deployment.    |
| Remote HTTP client | Status/list/stat/read may be exposed by deployment policy | Physical-path handoff is always denied.                               |

The MCP core does not install or configure the client's document extraction
tools. A client without a suitable local PDF or Office tool can still list,
stat, hash, and read allowed UTF-8 documents, but cannot extract binary content.

## 4. Restart and verify

The JSON configuration is loaded once when the MCP process starts. Restart the
MCP client or its server process after changing the file or environment
variable.

Recommended verification sequence:

1. Call `external_runtime_status`; confirm `enabled: true`,
   `localHandoffAllowed: true`, and the expected logical root ID.
2. Call `external_roots_list`; confirm the root is `available`.
3. Call `external_list` with the root ID and a bounded depth.
4. Call `external_stat`, then `external_read` on a small UTF-8 pilot file.
5. If needed, call `external_handoff` on one allowed document and verify that
   the client can open the returned temporary copy.

Repository checks:

Unix:

```bash
npm run test:external-roots
MCP_EXTERNAL_ROOTS_FILE=/absolute/path/external-roots.json npm run smoke:external-roots
MCP_EXTERNAL_ROOTS_FILE=/absolute/path/external-roots.json npm run smoke:external-roots:mcp
```

PowerShell:

```powershell
npm run test:external-roots
$env:MCP_EXTERNAL_ROOTS_FILE = 'C:\Users\you\.config\optimike\external-roots.json'
npm run smoke:external-roots
npm run smoke:external-roots:mcp
```

These checks cover different boundaries:

- `test:external-roots` uses disposable fixtures and tests confinement,
  allowlists, handle identity, redaction, limits, temporary-copy lifecycle, the
  actual stdio proxy, and HTTP handoff denial;
- `smoke:external-roots` validates the configured service and a real pilot root;
- `smoke:external-roots:mcp` validates the MCP tool contract through the direct
  stdio server entrypoint with the configured root;
- the production client must still be checked through `dist/stdio-proxy.js`
  using the five calls above.

## 5. Handoff lifecycle and security

`external_handoff` does not return the source path. It reads through a verified
file handle and creates a process-owned copy with mode `0600` on platforms that
enforce POSIX file permissions.

- handoff is denied over HTTP;
- copies expire after one hour and are swept every five minutes;
- one service keeps at most 16 files and 512 MiB of handoff copies;
- oldest copies are evicted to make room;
- the process removes its directory on normal exit;
- a later configured service scavenges directories owned by dead processes or
  stale ownership heartbeats.

Treat the returned path as short-lived. A client should consume it during the
current operation and must not persist it as document provenance.

Portable provenance is the logical root ID, root-relative path, size,
modification time, and SHA-256 when returned—not the temporary path.

## 6. Rollback and troubleshooting

Rollback is fail-closed:

1. remove `MCP_EXTERNAL_ROOTS_FILE` from the MCP client configuration;
2. restart the MCP process;
3. call `external_runtime_status` and confirm `enabled: false`.

This does not delete or modify any source document. Existing temporary copies
remain bounded by their normal cleanup lifecycle.

Common failures:

| Error/state             | Check                                                                       |
| ----------------------- | --------------------------------------------------------------------------- |
| `configuration_invalid` | Absolute config path, valid JSON, version `1`, known fields, root ID rules. |
| `root_unavailable`      | The configured directory exists and the MCP process can access it.          |
| `capability_denied`     | The root declares the capability required by the operation.                 |
| `path_not_allowed`      | The relative file path matches `include` and does not match `exclude`.      |
| `path_link_unsupported` | Remove symlinks/junctions from the requested path.                          |
| `too_large`             | Root `maxFileBytes` and the aggregate handoff budget.                       |
| `unsupported`           | Use UTF-8 text for `external_read`, or stdio handoff for binary documents.  |
| Handoff denied          | Use a local stdio client; HTTP intentionally cannot disclose a path.        |

The server never infers a new root from a path found in an Obsidian note.
