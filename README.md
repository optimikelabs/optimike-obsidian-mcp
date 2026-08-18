# Optimike Obsidian MCP

French version: [README.fr.md](README.fr.md) · [Documentation](docs/README.md) · [Operations](OPERATIONS.md) · [Security](SECURITY.md)

Optimike Obsidian MCP gives MCP clients a governed operational surface over an Obsidian vault. It combines live Desktop operations, resilient headless modes, structured Tasks and Operon support, Bases and Canvas, semantic search, runtime observability and bounded access to configured external documents.

## What changed in 3.0

Version 3.0 introduces portable **tool-surface profiles**. The server now decides which coherent tool set a session discovers before `tools/list`; client-side filters remain optional optimizations.

- `standard` — general vault work;
- `authoring` — Notes, Frontmatter, Bases and Canvas;
- `tasks` — complete 23-tool Operon surface plus task context;
- `full` — every tool structurally available in the runtime.

The default is `standard`. Runtime mode and write policy still own effect authorization.

Semantic search now has one public name:

```text
smart_semantic_search
```

The former `smart_search` and `smart-search` aliases were removed in this major release.

See [Tool surface profiles](docs/tool-surface-profiles.md) and the [routing guide](docs/mcp-routing-guide.md).

## Capability map

| Area | What the MCP provides | Main dependency |
| --- | --- | --- |
| Notes | Read/search/direct edits plus governed atomic replacement | Vault; Local REST API + Atomic Write Bridge for governed CAS |
| Frontmatter | Direct fallback plus source-preserving governed projection | Local REST API + Atomic Write Bridge |
| Bases and Canvas | Reads, bounded writes, governed formulas and governed Canvas graphs | Bases Bridge; Atomic Write Bridge 0.4.0 |
| Tasks | Tasks-compatible Markdown plus 23 Operon tools | Cache/filesystem; Operon Developer API V1 through the Bridge |
| Semantic search | Smart Connections index search with durable metadata cache | `.smart-env` plus Ollama or OpenAI-compatible query embedding |
| Runtime | Shared SQLite cache, health, maintenance, degraded mode and exclusions | Local filesystem |
| External documents | Default-deny reads/handoff plus opt-in local move with exact link repair | Explicit root allowlist; local stdio for move |
| Headless administration | Guarded metadata and vault-filesystem operations | Copied or dedicated vault |

The canonical name registry is documented in [Tool Surface](docs/obsidian_mcp_tools_spec.md). Availability varies by runtime and profile.

## Quick start

Requirements:

- Node.js `>=22.7.5`;
- Obsidian Desktop only for live features;
- capability-specific plugins listed below.

From source:

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
node dist/stdio-surface-proxy.js --tool-profile standard
```

Package binaries:

```text
optimike-obsidian-mcp         direct stdio/HTTP server
optimike-obsidian-mcp-proxy   local stdio proxy with the same profile contract
```

Direct stdio profile selection:

```bash
optimike-obsidian-mcp --tool-profile authoring
# or
MCP_TOOL_PROFILE=authoring optimike-obsidian-mcp
```

An unknown, empty or repeated profile fails closed. CLI selection wins over the environment.

Minimal Codex configuration:

```toml
[mcp_servers.optimike-obsidian]
command = "node"
args = ["/path/to/optimike-obsidian-mcp/dist/stdio-surface-proxy.js", "--tool-profile", "standard"]

[mcp_servers.optimike-obsidian.env]
OBSIDIAN_VAULT = "/path/to/vault"
OBSIDIAN_RUNTIME_MODE = "live"
OBSIDIAN_BASE_URL = "http://127.0.0.1:27123"
OBSIDIAN_API_KEY = "<local-rest-api-key>"
```

Keep real paths, API keys, journals and external-root configuration outside the repository and distributable vault content.

## Streamable HTTP

Explicit profile endpoints:

```text
/mcp/standard
/mcp/authoring
/mcp/tasks
/mcp/full
```

`/mcp` remains a compatibility alias of `/mcp/full` in 3.0. A session is bound to the canonical profile used at initialization and cannot be reused on another profile path.

The Node server must never be exposed directly to the public internet. Loopback HTTP is supported with authentication and bounded controls. Remote HTTP remains pilot-only behind reviewed TLS reverse proxy, private network controls and verified identity. See [Security](SECURITY.md).

## Runtime modes

| Runtime | Best for | Writes |
| --- | --- | --- |
| `live` | Full local Obsidian automation | REST and governed Bridges |
| `hybrid` | Desktop workflows with durable degraded reads | Live writes while API exists |
| `headless-readonly` | Server, CI or synchronized copy validation | None |
| `headless-guarded` | Cautious writes on a copied/dedicated vault | Append/prepend, exact replace, Frontmatter set |
| `headless-filesystem` | Explicit local filesystem administration | Bounded filesystem writes with preconditions |

Start a real synchronized copy in `headless-readonly`. Validate write modes on a copied or dedicated vault first.

## Optional Obsidian integrations

Enable only the surfaces you use:

- [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) for live note, metadata and tag operations;
- bundled **Bases Bridge** for live Bases and governed formula CAS;
- bundled **Optimike Atomic Write Bridge** for governed Note, Frontmatter and Canvas `plan → apply → status → recover`;
- **Smart Connections** for the local semantic index;
- **Operon Developer API V1** and bundled **Optimike Operon Bridge** for governed task operations;
- **Obsidian Tasks** for Tasks-compatible Markdown parsing.

Operon apply requires both explicit opt-ins:

```text
Optimike Operon Bridge: Allow task mutations
OPERON_MUTATIONS_ENABLED=true
```

Stale Operon snapshots remain read-only. No Operon route falls back to raw Markdown or private APIs.

## Governed operations

Governed Note, Frontmatter, Base formula and Canvas families are exposed atomically:

```text
plan → apply → status → recover
```

After a timeout or lost response, call `status` before `recover`; never create a blind replacement mutation. Durable plans are not bound to the session profile and remain recoverable after reconnecting through any profile that exposes the same complete family.

## External document roots

External roots are disabled by default and use logical root IDs rather than exposed physical paths.

`external_handoff` selects a transport-aware delivery:

- local stdio returns a verified short-lived `local_path`;
- authenticated direct HTTP may return an opt-in, identity-bound, single-use `http_ticket`;
- neither delivery grants mutation authority.

A separate local-stdio transaction can move one regular file within the same configured root and repair exact ÉLYSIA references. It requires inventory, a durable plan, hash/CAS preconditions, journaling and compensating rollback. It does not add generic create, replace, delete, upload or sync.

The MCP core does not embed PDF, Office or OCR engines. The calling client owns binary extraction and verifies size and SHA-256.

## Semantic search

`smart_semantic_search` searches the local Smart Connections index. Query embedding may remain local through Ollama or use an OpenAI-compatible provider. The tool is therefore annotated read-only/open-world even though indexed vault data remains local.

## Verification

```bash
npm run build
npm run test:tool-surface-v3
npm run test:runtime
npm run test:external-roots
npm run test:http-multiclient
npm run test:docs
npm run test:package
npm run audit:production
```

The suites use disposable vaults and run on Linux and Windows.

## Documentation

- [Tool surface profiles](docs/tool-surface-profiles.md)
- [Tool Surface reference](docs/obsidian_mcp_tools_spec.md)
- [Runtime Capability Matrix](docs/runtime-capability-matrix.md)
- [MCP Routing Guide](docs/mcp-routing-guide.md)
- [Operon MCP Contract](docs/operon-mcp-contract.md)
- [External Roots Setup](docs/external-roots-setup.md)
- [Headless Server Profile](docs/headless-server-profile.md)
- [ADR index](docs/adr/README.md)

## Credits and license

Created by **Optimike — Mickaël Ahouansou**. See [LICENSE](LICENSE).
