# Optimike Obsidian MCP

[![Latest release](https://img.shields.io/github/v/release/optimikelabs/optimike-obsidian-mcp?display_name=tag&sort=semver)](https://github.com/optimikelabs/optimike-obsidian-mcp/releases/latest)
French: [README.fr.md](README.fr.md) · [Docs](docs/README.md) · [Operations](OPERATIONS.md) · [Security](SECURITY.md)

![Optimike Obsidian MCP overview](docs/assets/readme/overview.en.svg)

Optimike Obsidian MCP gives agents a governed surface over an Obsidian vault:
notes, Tasks and Operon, Bases, semantic search, resilient headless operation,
runtime observability, and bounded external-document access.

## Runtime profiles

- `live`: Obsidian Desktop and Local REST API.
- `hybrid`: live tools while the API responds, degraded reads otherwise.
- `headless-readonly`: safest server, CI, and Sync-copy profile.
- `headless-guarded`: very bounded writes on a copy or dedicated vault.
- `headless-filesystem`: explicit preconditioned filesystem operations.

Do not expose the Node server directly to the Internet. Remote HTTP remains a
pilot behind reviewed TLS, authentication, private networking, and supervision.

## Start

Requires Node.js `>=22.7.5`:

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
node dist/stdio-proxy.js
```

## Governed atomic note replacement

The 2.6 candidate exposes four domain tools:

- `obsidian_note_replace_plan`
- `obsidian_note_replace_apply`
- `obsidian_note_replace_status`
- `obsidian_note_replace_recover`

They are registered only in `live`, or `hybrid` with API access. They reuse the
2.5 adapter and durable journal without creating a second engine or a generic
`operation_*` surface.

Planning seals the target, backend binding, and SHA-256 proofs. Apply accepts
only the opaque `planRef` and matching idempotency key. After an uncertain
response, read status before exact-plan recovery. Recovery is not undo and
accepts no replacement payload.

The current MCP write policy, protected-frontmatter rules, and default-off
Atomic Write Bridge gate are revalidated before every possible effect. The
atomic guarantee covers the target-note transition enforced by
`Vault.process`; sync, watchers, plugins, indexers, and external automations are
outside that recovery boundary.

See the [Tool Surface](docs/obsidian_mcp_tools_spec.md#governed-atomic-note-replacement)
and [Runtime Matrix](docs/runtime-capability-matrix.md).

## External documents

External roots are disabled by default. Local stdio handoff returns a verified
`local_path`; authenticated HTTP can return a bounded single-use `http_ticket`.
Neither mode authorizes mutation.

The only external mutation is a local-stdio same-root move with preconditions,
a journal, exact ÉLYSIA reference repair, and compensating rollback. It adds no
upload, create, replace, delete, or synchronization capability.

## Validation

```bash
npm run build
npm run test:runtime
npm run test:operation-runtime
npm run test:governed-note-replace-mcp
npm run test:external-roots
npm run test:docs
npm run test:package
npm run audit:production
```

CI runs on Linux and Windows with disposable vaults. The live Obsidian canary
remains an explicit operator gate before merge or release.

Created by **Optimike — Mickaël Ahouansou**. License: [LICENSE](LICENSE).
