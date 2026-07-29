# Optimike Obsidian MCP

French version: [README.fr.md](README.fr.md)
Documentation hub: [docs/README.md](docs/README.md)
Operations: [OPERATIONS.md](OPERATIONS.md)
Security: [SECURITY.md](SECURITY.md)

![Optimike Obsidian MCP hero](docs/assets/hero-optimike-obsidian-mcp.png)

Optimike Obsidian MCP gives MCP clients a governed operational surface over an
Obsidian vault. It combines live Desktop operations, resilient headless modes,
structured task and Bases support, semantic search, runtime observability, and
explicit read-only access to configured documents outside the vault.

## Capability map

| Area                    | What the MCP provides                                                  | Main dependency                                    |
| ----------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| Notes                   | Read, list, search, update, frontmatter and tags                       | Vault; Local REST API for the full live surface    |
| Bases and Canvas        | Bases query/write tools, format validation and bounded Canvas helpers  | Bases Bridge for live Bases                        |
| Tasks                   | Obsidian Tasks-compatible list/query plus 13 governed Operon tools     | Tasks; Kairélys/Operon Bridge for live mutations   |
| Semantic search         | Smart Connections index search with durable metadata cache             | `.smart-env` plus Ollama or OpenAI query embedding |
| Runtime                 | Shared SQLite cache, health, maintenance, degraded mode and exclusions | Local filesystem                                   |
| External documents      | Logical roots, list/stat/hash/read and explicit verified handoff       | Machine-local allowlist                            |
| Headless administration | Guarded note, metadata and filesystem operations                       | Copied or dedicated vault recommended              |

The current tool registry is documented in
[Tool Surface](docs/obsidian_mcp_tools_spec.md). Availability varies by runtime
mode; use the [Runtime Capability Matrix](docs/runtime-capability-matrix.md)
before enabling writes.

## Choose a profile

| Need                                       | Recommended profile                                     | Posture                 |
| ------------------------------------------ | ------------------------------------------------------- | ----------------------- |
| Codex or another local client              | `dist/stdio-proxy.js`                                   | Default local profile   |
| Obsidian Desktop automation                | `live` or `hybrid` through the stdio proxy              | Trusted Desktop         |
| CI, server or synchronized vault copy      | `headless-readonly`                                     | Safest headless profile |
| Bounded writes on a copied/dedicated vault | `headless-guarded` then `headless-filesystem`           | Explicit opt-in         |
| Direct HTTP on the same machine            | Authenticated loopback HTTP                             | Supported with limits   |
| Remote HTTP                                | Reviewed TLS reverse proxy and private network controls | Pilot only              |

The Node server must never be exposed directly to the public internet. See
[Security](SECURITY.md) and the
[HTTP delivery ADR](docs/adr/ADR-HTTP-External-Artifact-Delivery.md).

## Quick start from source

Requirements:

- Node.js `>=22.7.5`;
- Obsidian Desktop only when using live Desktop features;
- capability-specific plugins listed below.

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
node dist/stdio-proxy.js
```

For a package install, the explicit proxy binary is
`optimike-obsidian-mcp-proxy`. The legacy
`optimike-obsidian-mcp` binary still starts the backend directly.

Minimal Codex configuration:

```toml
[mcp_servers.optimike-obsidian-mcp-stdio]
command = "node"
args = ["/path/to/optimike-obsidian-mcp/dist/stdio-proxy.js"]

[mcp_servers.optimike-obsidian-mcp-stdio.env]
OBSIDIAN_VAULT = "/path/to/vault"
OBSIDIAN_RUNTIME_MODE = "live"
OBSIDIAN_BASE_URL = "http://127.0.0.1:27123"
OBSIDIAN_API_KEY = "<local-rest-api-key>"
```

Keep real paths, API keys and external-root configurations outside the
repository and outside distributable vault content.

## Optional Obsidian integrations

Enable only the surfaces you use:

- [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api):
  live note, metadata and tag operations;
- bundled **Bases Bridge (REST)**: live `.base` operations;
- **Smart Connections**: semantic index under `.smart-env`;
- **Kairélys 2.6.3+ / compatible Operon** and the bundled
  **Optimike Operon Bridge**: governed live task operations;
- **Obsidian Tasks**: canonical Tasks parsing and configuration.

Operon apply requires two explicit opt-ins:

```text
Optimike Operon Bridge setting: Allow task mutations
OPERON_MUTATIONS_ENABLED=true
```

Stale Operon snapshots remain read-only.

## External document roots

External roots are disabled by default. They are a read-only authorization
broker, not an external index, sync engine or backup system.

The same `external_handoff` tool selects a transport-aware delivery:

- local stdio returns a verified short-lived `local_path`;
- authenticated direct HTTP may return an opt-in, identity-bound, single-use
  `http_ticket`;
- neither mode discloses the physical source path or authorizes external
  mutation.

The MCP core does not embed PDF, Office or OCR engines. The calling client owns
binary extraction and must verify size and SHA-256.

Start with
[External document roots — setup and operations](docs/external-roots-setup.md).

## Semantic search

`smart_semantic_search` searches a local Smart Connections index. Query
embedding can remain local through Ollama or use OpenAI, depending on operator
configuration. A configured OpenAI provider therefore makes this tool
open-world even though the indexed vault data remains local.

See [Operations](OPERATIONS.md) for provider configuration and cache behavior.

## Verification

```bash
npm run build
npm run test:runtime
npm run check:operon
npm run test:external-roots
npm run test:docs
npm run test:package
npm run audit:production
```

The runtime suites use disposable vaults and include Linux/Windows CI coverage.
For production-like validation, keep the shared cache database outside the real
synced vault.

## Documentation

- Start here by audience and task: [Documentation hub](docs/README.md)
- Runtime and maintenance: [OPERATIONS.md](OPERATIONS.md)
- Security and deployment boundary: [SECURITY.md](SECURITY.md)
- Current tools: [Tool Surface](docs/obsidian_mcp_tools_spec.md)
- Runtime modes: [Runtime Capability Matrix](docs/runtime-capability-matrix.md)
- Agent routing: [MCP Routing Guide](docs/mcp-routing-guide.md)
- Headless deployment: [Headless Server Profile](docs/headless-server-profile.md)
- OSS gateway integration: [Gateway Compatibility](docs/gateway-compatibility.md)
- External documents: [External Roots Setup](docs/external-roots-setup.md)
- Architecture decisions and status: [ADR Index](docs/adr/README.md)
- Public ÉLYSIA task profile: [profiles/elysia-tasks/README.fr.md](profiles/elysia-tasks/README.fr.md)

## Credits

Created by **Optimike — Mickaël Ahouansou**.

## License

See [LICENSE](LICENSE).
