# Optimike Obsidian MCP

[![Latest release](https://img.shields.io/github/v/release/optimikelabs/optimike-obsidian-mcp?display_name=tag&sort=semver)](https://github.com/optimikelabs/optimike-obsidian-mcp/releases/latest)

French version: [README.fr.md](README.fr.md)
Documentation hub: [docs/README.md](docs/README.md)
Operations: [OPERATIONS.md](OPERATIONS.md)
Security: [SECURITY.md](SECURITY.md)

![Overview of Optimike Obsidian MCP between agent clients, Obsidian and governed external documents](docs/assets/readme/overview.en.svg)

Optimike Obsidian MCP gives MCP clients a governed operational surface over an
Obsidian vault. It combines live Desktop operations, resilient headless modes,
structured task and Bases support, semantic search, runtime observability, and
explicitly governed access to configured documents outside the vault.

## Capability map

| Area                    | What the MCP provides                                                  | Main dependency                                    |
| ----------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| Notes                   | Read, list, search, update, frontmatter and tags                       | Vault; Local REST API for the full live surface    |
| Bases and Canvas        | Bases query/write tools, format validation and bounded Canvas helpers  | Bases Bridge for live Bases                        |
| Tasks                   | Obsidian Tasks-compatible list/query plus 23 governed Operon tools     | Operon 3.1.1 Developer API V1 through the Bridge   |
| Semantic search         | Smart Connections index search with durable metadata cache             | `.smart-env` plus Ollama or OpenAI query embedding |
| Runtime                 | Shared SQLite cache, health, maintenance, degraded mode and exclusions | Local filesystem                                   |
| External documents      | Governed reads/handoff plus opt-in local move with exact link repair   | Allowlist; local stdio for move                    |
| Headless administration | Guarded note, metadata and vault-filesystem operations                 | Guarded/filesystem mode on a copied vault          |

The current tool registry is documented in
[Tool Surface](docs/obsidian_mcp_tools_spec.md). Availability varies by runtime
mode; use the [Runtime Capability Matrix](docs/runtime-capability-matrix.md)
before enabling writes.

## Choose a profile

| Need                                       | Recommended profile                                     | Posture                 |
| ------------------------------------------ | ------------------------------------------------------- | ----------------------- |
| Codex (verified) or a local stdio client   | `dist/stdio-proxy.js`                                   | Default local profile   |
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
- **Operon 3.1.1** and the bundled **Optimike Operon Bridge**: governed live
  task operations through the official Developer API V1;
- Kairélys compatibility remains available as a bounded legacy/rollback path,
  not as the production owner;
- **Obsidian Tasks**: canonical Tasks parsing and configuration.

Operon apply requires two explicit opt-ins:

```text
Optimike Operon Bridge setting: Allow task mutations
OPERON_MUTATIONS_ENABLED=true
```

Stale Operon snapshots remain read-only.

The MCP exposes a curated agent surface rather than every Operon CLI function.
Native diagnostics, finder/resolve, bounded relationships/context and timer
state are available as read-only tools. Dedicated relationship and recurrence
writes use official sealed preview/apply plans; destructive and operator
commands stay in the CLI. Agents use MCP because it adds bounded schemas,
least-privilege capability checks, dry-run, revision locking, durable
idempotency, postflight verification and exact-plan recovery. A generic CLI
passthrough would bypass those guarantees. See the
[Operon MCP contract](docs/operon-mcp-contract.md) and
[Operon CLI / Developer API audit](docs/operon-cli-audit.md).
Transition apply is available through the Bridge. Elevated or destructive plans
still require fresh confirmation in the owning Obsidian vault window and fail
closed after 45 seconds when no confirmation can be presented.

Compatibility note: the adapter targets official Operon `3.1.1`, but the full
acceptance evidence in this repository uses our patched local Operon build while
upstream fixes are under review in [#135](https://github.com/hasanyilmaz/operon/pull/135),
[#137](https://github.com/hasanyilmaz/operon/pull/137), and
[#139](https://github.com/hasanyilmaz/operon/pull/139). Stock Operon `3.1.1`
remains usable for reads and most governed mutations, but modified-time
frontmatter settlement, consent across multiple Obsidian windows, and implicit
File Task renames retain the upstream limitations described in those PRs. The
MCP does not fall back to Markdown or private APIs when one of these cases is
not supported. The unscoped transition edge case remains tracked in
[#99](https://github.com/hasanyilmaz/operon/issues/99) and
[#101](https://github.com/hasanyilmaz/operon/pull/101).

## External document roots

External roots are disabled by default. Their ordinary reads and handoffs form
a default-deny authorization broker, not an external index, sync engine or
backup system.

The same `external_handoff` tool selects a transport-aware delivery:

- local stdio returns a verified short-lived `local_path`;
- authenticated direct HTTP may return an opt-in, identity-bound, single-use
  `http_ticket`;
- neither delivery mode discloses the physical source path or authorizes a
  mutation.

One deliberately narrow mutation exists outside the handoff path: local stdio
through `headless-filesystem` on a copied or dedicated vault can move or rename
one regular file within the same opted-in root and repair exact ÉLYSIA
references. It requires an inventory and durable plan, explicit write gates,
hash/CAS preconditions, a journal and compensating rollback. It is not exposed
over direct HTTP and does not add create, replace, delete, upload or sync.

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
- Operon tools and guarantees: [Operon MCP Contract](docs/operon-mcp-contract.md)
- Operon surface and CLI routing: [Operon CLI / Developer API audit](docs/operon-cli-audit.md)
- Headless deployment: [Headless Server Profile](docs/headless-server-profile.md)
- Linux headless multi-client pilot: [Pilot and capability matrix](docs/headless-multiclient-pilot.md)
- OSS gateway integration: [Gateway Compatibility](docs/gateway-compatibility.md)
- External documents: [External Roots Setup](docs/external-roots-setup.md)
- Architecture decisions and status: [ADR Index](docs/adr/README.md)
- Public ÉLYSIA task profile: [profiles/elysia-tasks/README.fr.md](profiles/elysia-tasks/README.fr.md)

## Credits

Created by **Optimike — Mickaël Ahouansou**.

## License

See [LICENSE](LICENSE).
