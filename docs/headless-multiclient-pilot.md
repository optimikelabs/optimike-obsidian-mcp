# Linux headless multi-client pilot

French version: [headless-multiclient-pilot.fr.md](headless-multiclient-pilot.fr.md)

Related docs: [Headless Server Profile](headless-server-profile.md), [HTTP Multi-client Security](http-multiclient-security.md), [HTTP Concurrency and Backpressure](http-concurrency-backpressure.md), [HTTP Observability](http-observability-contract.md), [Gateway Compatibility](gateway-compatibility.md)

## Decision

The first multi-agent Linux profile is a **read-only pilot on a copied or
dedicated vault**. It does not certify a personal live vault, remote Internet
exposure, or Desktop/plugin parity.

The automated proof creates a disposable vault and cache, starts the real
Streamable HTTP server in `headless-readonly`, and connects multiple
independently authenticated clients. Run it with:

```bash
npm run test:http-headless-multiclient
```

The same test is required on Ubuntu and Windows CI. It proves the portable
server contract; a real Linux host remains an operational field gate.

## Capability matrix

| Capability                                                       | Linux `headless-readonly` | Required source                              | Pilot statement                                        |
| ---------------------------------------------------------------- | ------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| Streamable HTTP, sessions, JWT identity, quotas and backpressure | Yes                       | Optimike MCP process                         | Automated with distinct concurrent clients             |
| Liveness, readiness and sanitized status                         | Yes                       | HTTP runtime and filesystem cache            | Automated; path existence alone is not readiness       |
| Vault list, read and global search                               | Yes                       | Copied/dedicated vault plus filesystem cache | Automated on a disposable fixture                      |
| Legacy Markdown tasks                                            | Yes                       | Markdown/filesystem cache                    | Read-only; not the native Operon filter engine         |
| Bases list/query                                                 | Yes                       | Local `.base` and Markdown fallback          | Read-only local fallback                               |
| External-root read and HTTP ticket handoff                       | Optional                  | Explicit root allowlist and `external:read`  | Covered by the separate handoff and gateway suites     |
| Note, frontmatter, tag, Bases or Canvas writes                   | No                        | Guarded/filesystem write profile             | Write tools must not be registered in this pilot       |
| External move diagnostics                                        | No over direct HTTP       | Local stdio                                  | Scan/plan/status only; mutation is disabled everywhere |
| Live Obsidian reads/writes                                       | No                        | Obsidian Desktop and Local REST API          | Never inferred from filesystem freshness               |
| Operon native filters and mutations                              | No                        | Live Obsidian Operon Bridge                  | A validated snapshot may support bounded reads only    |

## Pilot environment

Keep the HTTP listener on loopback during the first run:

```bash
OBSIDIAN_RUNTIME_MODE=headless-readonly
OBSIDIAN_VAULT=/srv/obsidian/optimike-pilot-vault
OBSIDIAN_CACHE_SOURCE=filesystem
OBSIDIAN_SHARED_CACHE_DB_PATH=/var/lib/optimike-mcp/cache/shared-cache.sqlite
OBSIDIAN_ENABLE_CACHE=true
LOGS_DIR=/var/log/optimike-mcp
MCP_WRITE_MODE=readonly
MCP_TRANSPORT_TYPE=http
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3010
MCP_HTTP_PORT_RETRIES=0
MCP_AUTH_MODE=jwt
MCP_AUTH_SECRET_KEY=<secret-managed-outside-the-repository>
```

Use separate bearer identities for separate agents. Do not use a display label
as an authorization identity. Keep the cache, logs and secrets outside the
vault.

## Minimal systemd template

This template intentionally exposes only loopback. Adapt paths and secret
management to the host:

```ini
[Unit]
Description=Optimike Obsidian MCP headless pilot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=optimike-mcp
Group=optimike-mcp
WorkingDirectory=/opt/optimike-obsidian-mcp
EnvironmentFile=/etc/optimike-mcp/headless.env
ExecStart=/usr/bin/node /opt/optimike-obsidian-mcp/dist/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/srv/obsidian/optimike-pilot-vault
ReadWritePaths=/var/lib/optimike-mcp /var/log/optimike-mcp

[Install]
WantedBy=multi-user.target
```

Validate the effective unit and filesystem permissions before starting it. The
service account needs read access to the pilot vault and write access only to
the cache/log directories.

## Reverse proxy or gateway

A gateway is optional. It is useful only when an access plane must add TLS,
network policy or routing. Optimike MCP still verifies the bearer identity and
owns scopes, write policy, root permissions, CAS, idempotency and rollback.

For the first gateway pilot, use the tested
[agentgateway transparent HTTP route](agentgateway.transparent.example.yaml).
It must forward:

- `/mcp` and `/external-handoff`;
- `Authorization`, `Mcp-Session-Id` and `X-External-Handoff-Ticket`;
- streaming, cancellation, `429`, `503` and `Retry-After`.

Do not enable mutation retries. Do not trust `Forwarded` or `X-Forwarded-For`
unless the immediate proxy is explicitly configured and overwrites untrusted
values. Binding Optimike directly to `0.0.0.0` is not part of this pilot.

## Field run

1. Create a copied or dedicated, non-sensitive vault.
2. Keep any headless synchronization pull-only.
3. Store the cache outside the vault.
4. Run `npm run test:http-headless-multiclient`.
5. Run `npm run smoke:headless-server-profile` against the copied vault.
6. Start the loopback systemd service and connect two real agent clients with
   different bearer identities.
7. Verify `/healthz`, `/readyz` and authenticated `/statusz`.
8. Exercise list, read, search, tasks and Bases for at least 30 minutes.
9. Confirm that vault/Bases write tools are absent, Operon mutations fail closed
   without the live Bridge, and no vault file changed.

Go only when all steps are green. No log record may contain bearer tokens,
authentication secrets or note content; structured HTTP completion records
must also omit physical vault paths. Keep the deployment in pilot if a reverse
proxy, gateway, real OAuth issuer or remote network boundary has not been
reviewed on the target host.
