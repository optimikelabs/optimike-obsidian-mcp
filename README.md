# Optimike Obsidian MCP

[![Latest release](https://img.shields.io/github/v/release/optimikelabs/optimike-obsidian-mcp?display_name=tag&sort=semver)](https://github.com/optimikelabs/optimike-obsidian-mcp/releases/latest)
French version: [README.fr.md](README.fr.md) · [Documentation](docs/README.md) · [Operations](OPERATIONS.md) · [Security](SECURITY.md)

![Overview of Optimike Obsidian MCP between agent clients, Obsidian, and governed external documents](docs/assets/readme/overview.en.svg)

Optimike Obsidian MCP gives MCP clients a governed operational surface over an
Obsidian vault: notes, Tasks and Operon, Bases, semantic search, resilient
headless operation, runtime observability, and bounded access to authorized
external documents.

## Main capabilities

| Domain | Surface |
| --- | --- |
| Notes | Read, search, update, frontmatter, tags, and governed atomic whole-note replacement |
| Tasks | Tasks-compatible reads and 23 governed Operon tools through the official Developer API |
| Bases and Canvas | Bases queries/writes, validation, and bounded Canvas helpers |
| Search | Smart Connections with durable cache and Ollama or OpenAI embeddings |
| Runtime | Shared SQLite cache, health, maintenance, degraded mode, and headless profiles |
| External documents | Governed reads/handoff and opt-in local move with exact repair |

The [Tool Surface](docs/obsidian_mcp_tools_spec.md) owns individual contracts.
The [Runtime Matrix](docs/runtime-capability-matrix.md) owns availability.

## Profiles

- `live`: Obsidian Desktop and Local REST API, complete surface.
- `hybrid`: live tools while the API responds, degraded reads otherwise.
- `headless-readonly`: safest starting point for servers, CI, and Sync copies.
- `headless-guarded`: very bounded writes on a copy or dedicated vault.
- `headless-filesystem`: explicit preconditioned filesystem operations.

Do not expose the Node server directly to the Internet. Remote HTTP remains a
pilot behind reviewed TLS, authentication, private networking, and supervision.

## Start from source

Requires Node.js `>=22.7.5`:

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
node dist/stdio-proxy.js
```

The stdio proxy reuses the persistent local backend instead of rebuilding the
heavy vault state for every client.

## Governed atomic note replacement

The 2.6 candidate makes four domain tools public:

- `obsidian_note_replace_plan`
- `obsidian_note_replace_apply`
- `obsidian_note_replace_status`
- `obsidian_note_replace_recover`

They are registered only in `live`, or `hybrid` with API access. They reuse the
adapter and durable journal delivered in 2.5.0 without creating a second engine
or a generic `operation_*` surface.

Planning seals the target, backend binding, and SHA-256 proofs. Apply accepts
only the opaque `planRef` and matching idempotency key. After an uncertain
response, clients read status before exact-plan recovery. Recovery is not undo
and accepts no replacement payload.

The current MCP write policy, protected-frontmatter rules, and the default-off
Atomic Write Bridge gate are revalidated before every possible effect. The
atomic guarantee covers the target-note transition enforced by
`Vault.process`; sync, watchers, plugins, indexers, and external automations
remain outside that recovery boundary.

Contract: [governed tool surface](docs/obsidian_mcp_tools_spec.md#governed-atomic-note-replacement).

## Optional integrations

- Local REST API for live capabilities.
- Bases Bridge for live Bases.
- Atomic Write Bridge, disabled by default, for atomic whole-note CAS.
- Optimike Operon Bridge for governed live tasks.
- Smart Connections for semantic search.
- Obsidian Tasks for canonical task parsing.

The MCP does not generically relay CLIs. A public mutation needs a bounded
schema, least privilege, a precondition, durable idempotency, postflight proof,
and exact recovery where the backend can enforce them.

## External documents

External roots are disabled by default. Local stdio handoff returns a verified
temporary copy; authenticated HTTP can return a bounded single-use ticket.
Neither handoff mode authorizes mutation.

The only external mutation is a local-stdio same-root move with preconditions,
a journal, exact ÉLYSIA reference repair, and compensating rollback. It adds no
upload, create, replace, delete, or synchronization capability.

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

Suites use disposable vaults and run in Linux/Windows CI. The live Obsidian
canary remains an explicit operator gate before merge or release.

## Documentation

- [Documentation hub](docs/README.md)
- [Tool Surface](docs/obsidian_mcp_tools_spec.md)
- [Runtime Matrix](docs/runtime-capability-matrix.md)
- [Operations](OPERATIONS.md)
- [Security](SECURITY.md)
- [Operon MCP Contract](docs/operon-mcp-contract.md)
- [External Roots Setup](docs/external-roots-setup.md)
- [Architecture decisions](docs/adr/README.md)

Created by **Optimike — Mickaël Ahouansou**. License: [LICENSE](LICENSE).
