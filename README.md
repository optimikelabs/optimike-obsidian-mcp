# Optimike Obsidian MCP

[![Latest release](https://img.shields.io/github/v/release/optimikelabs/optimike-obsidian-mcp?display_name=tag&sort=semver)](https://github.com/optimikelabs/optimike-obsidian-mcp/releases/latest)
French version: [README.fr.md](README.fr.md) · Documentation hub: [docs/README.md](docs/README.md)
Operations: [OPERATIONS.md](OPERATIONS.md)
Security: [SECURITY.md](SECURITY.md)

![Overview of Optimike Obsidian MCP between agent clients, Obsidian, and governed external documents](docs/assets/readme/overview.en.svg)

Optimike Obsidian MCP gives MCP clients a governed operational surface over an
Obsidian vault. It combines Desktop operations, resilient headless operation,
Tasks and Operon, Bases, semantic search, runtime observability, and explicitly
governed access to authorized documents outside the vault.

## Capability map

| Domain                  | What the MCP provides                                                          | Main dependency                                                |
| ----------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Notes                   | Read, list, search, update, frontmatter, tags, and governed atomic replacement | Vault; Local REST API + Atomic Write Bridge for governed CAS   |
| Bases and Canvas        | Bases queries/writes, validation, and bounded Canvas helpers                   | Bases Bridge for live Bases                                    |
| Tasks                   | Tasks-compatible reads + 23 governed Operon tools                              | Operon Developer API V1 through the Bridge                     |
| Semantic search         | Smart Connections search with durable metadata cache                          | `.smart-env` + Ollama or OpenAI embedding                      |
| Runtime                 | Shared SQLite cache, health, maintenance, degraded mode, exclusions            | Local filesystem                                               |
| External documents      | Governed reads/handoff + opt-in local move with repair                         | Allowlist; local stdio for move                                |
| Headless administration | Bounded note, metadata, and vault-filesystem operations                        | Guarded/filesystem mode on a copied or dedicated vault         |

The current tool registry lives in the
[Tool Surface](docs/obsidian_mcp_tools_spec.md). Availability depends on runtime
mode; review the
[Runtime Capability Matrix](docs/runtime-capability-matrix.md) before enabling
writes.

## Choose a profile

| Need                                      | Recommended profile                           | Posture                        |
| ----------------------------------------- | --------------------------------------------- | ------------------------------ |
| Codex (verified) or local stdio client    | `dist/stdio-proxy.js`                         | Default local profile          |
| Obsidian Desktop automation               | `live` or `hybrid` through the stdio proxy    | Trusted desktop                |
| CI, server, or synchronized copy          | `headless-readonly`                           | Safest headless profile        |
| Bounded writes on copied/dedicated vaults | `headless-guarded`, then `headless-filesystem`| Explicit opt-in                |
| Direct HTTP on the same machine           | Authenticated loopback HTTP                   | Supported with limits          |
| Remote HTTP                               | Reviewed TLS proxy + private network          | Pilot only                     |

Never expose the Node server directly to the Internet. See [Security](SECURITY.md)
and the [HTTP delivery ADR](docs/adr/ADR-HTTP-External-Artifact-Delivery.md).

## Quick start from source

Requirements:

- Node.js `>=22.7.5`;
- Obsidian Desktop only for Desktop/live features;
- plugins only for the capabilities you actually enable.

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
node dist/stdio-proxy.js
```

The explicit package proxy binary is `optimike-obsidian-mcp-proxy`. The
historical `optimike-obsidian-mcp` binary still starts the backend directly.

Minimal Codex configuration:

```toml
[mcp_servers.optimike-obsidian-mcp-stdio]
command = "node"
args = ["/path/to/optimike-obsidian-mcp/dist/stdio-proxy.js"]

[mcp_servers.optimike-obsidian-mcp-stdio.env]
OBSIDIAN_VAULT = "/path/to/vault"
OBSIDIAN_RUNTIME_MODE = "live"
OBSIDIAN_BASE_URL = "http://127.0.0.1:27123"
OBSIDIAN_API_KEY = "<local-key>"
```

Keep real paths, API keys, and external-root configurations outside the repo
and outside distributable vault content.

## Optional Obsidian integrations

Enable only the surfaces you use:

- [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api):
  live note, metadata, and tag operations;
- bundled **Bases Bridge (REST)**: live `.base` operations;
- bundled **Optimike Atomic Write Bridge**: default-off atomic whole-note CAS
  behind the public governed `plan → apply → status → recover` surface;
- **Smart Connections**: semantic index under `.smart-env`;
- **Operon Developer API V1** and the bundled **Optimike Operon Bridge**: governed
  live task operations through the official Developer API V1;
- the Kairélys compatibility path remains as a bounded legacy/rollback route,
  but it is no longer the production engine;
- **Obsidian Tasks**: canonical Tasks parsing and configuration.

Operon apply requires two opt-ins:

```text
Optimike Operon Bridge setting: Allow task mutations
OPERON_MUTATIONS_ENABLED=true
```

Stale Operon snapshots remain read-only. The four governed note-replacement
tools are available only in live or hybrid-with-API mode, require the separate
default-off Atomic Write Bridge setting, and remain subject to the current MCP
write policy.

The MCP exposes a curated agent surface rather than every Operon CLI function.
Native diagnostics, finder/resolve, bounded relationships/context and timer
state are available read-only. Relationships and recurrence also have dedicated
write tools backed by sealed official plans. Agents use the MCP because it adds
bounded schemas, least privilege, dry-run, revision locking, durable
idempotency, postflight verification and exact-plan recovery. A generic CLI
relay would bypass those guarantees. Destructive or administrative commands
remain in the CLI. See the [Operon MCP contract](docs/operon-mcp-contract.md)
and [CLI / Developer API audit](docs/operon-cli-audit.md).

Compatibility note: Bridge `0.7.0` certifies already validated releases through
`3.2.1`; `3.2.0` remains the previous certified baseline. Operon `3.3.0` is
admitted as `compatible-provisional` when its official accessor exists and it
is not denied. Live use still requires `developerApi`, `ok`, `index.ready`, and
the exact advertised capability. Its complete pilot passed without returning
to a product allowlist. Frontmatter-date settlement and multi-window consent
were merged upstream before these versions. Saved-filter execution is now
available through the Developer API task-workflow surface after an exact grant,
but the official API does not publish the saved-filter catalog: provide the
exact `filterSetId` obtained from Operon UI/configuration or an operator
workflow. Adoption remains unavailable through the official API. Operon still
omits the declarative renderer for Developer API grant controls; the fix is
tracked in [#145](https://github.com/hasanyilmaz/operon/issues/145) and
[#146](https://github.com/hasanyilmaz/operon/pull/146). The MCP never falls back
to Markdown or private APIs. Implicit File Task rename remains tracked in
[#139](https://github.com/hasanyilmaz/operon/pull/139), and the bounded
`project-serial` transition case remains tracked in
[#99](https://github.com/hasanyilmaz/operon/issues/99) and
[#101](https://github.com/hasanyilmaz/operon/pull/101).

## External document roots

External roots are disabled by default. Normal reads and handoffs form a
default-deny authorization broker, not an external index, sync engine, or
backup.

The single `external_handoff` tool chooses delivery for the active transport:

- local stdio returns a verified temporary `local_path`;
- authenticated direct HTTP may return an opt-in, identity-bound, single-use
  `http_ticket`;
- neither mode discloses the source path or authorizes mutation.

One deliberately narrow mutation exists outside the handoff path: local stdio
in `headless-filesystem`, on a copied or dedicated vault, may move or rename one
regular file inside one opt-in root and repair exact ÉLYSIA references. It
requires durable inventory and plan, explicit write gates, hash/CAS
preconditions, journal, and compensating rollback. It is not exposed through
direct HTTP and adds no create, replace, delete, upload, or synchronization.

The core MCP embeds no PDF, Office, or OCR engine. The calling client extracts
binary content and verifies size and SHA-256.

Start with [External Roots Setup](docs/external-roots-setup.md).

## Semantic search

`smart_semantic_search` queries a local Smart Connections index. Query
embeddings can stay local through Ollama or use OpenAI, depending on
configuration. With OpenAI, the tool becomes open-world even though the vault
index remains local.

See [Operations](OPERATIONS.md) for providers and cache behavior.

## Validation

```bash
npm run build
npm run test:runtime
npm run test:operation-runtime
npm run test:governed-note-replace-mcp
npm run check:operon
npm run test:external-roots
npm run test:docs
npm run test:package
npm run audit:production
```

Runtime suites use disposable vaults and run in CI on Linux and Windows. For a
production-like test, keep the shared cache outside the real synchronized
vault. The live governed-note canary remains an explicit operator gate; see
[Governed atomic note replacement](docs/governed-note-replacement.md).

## Documentation

- Entry by audience and need: [Documentation hub](docs/README.md)
- Runtime and maintenance: [Operations](OPERATIONS.md)
- Security and deployment boundary: [Security](SECURITY.md)
- Current tools: [Tool Surface](docs/obsidian_mcp_tools_spec.md)
- Governed atomic note replacement: [contract and boundary](docs/governed-note-replacement.md)
- Runtime modes: [Runtime Capability Matrix](docs/runtime-capability-matrix.md)
- Agent routing: [MCP Routing Guide](docs/mcp-routing-guide.md)
- Operon tools and guarantees: [Operon MCP Contract](docs/operon-mcp-contract.md)
- Operon surface and CLI routing: [CLI / Developer API Audit](docs/operon-cli-audit.md)
- Headless deployment: [Headless Server Profile](docs/headless-server-profile.md)
- Linux headless multi-client pilot: [pilot and capability matrix](docs/headless-multiclient-pilot.md)
- OSS gateway integration: [Gateway Compatibility](docs/gateway-compatibility.md)
- External documents: [Root Configuration](docs/external-roots-setup.md)
- Architecture decisions: [ADR Index](docs/adr/README.md)
- Public ÉLYSIA Tasks profile: [profiles/elysia-tasks/README.fr.md](profiles/elysia-tasks/README.fr.md)

## Credits

Created by **Optimike — Mickaël Ahouansou**.

## License

See [LICENSE](LICENSE).
