# ADR: HTTP multiclient and headless architecture

- Status: Proposed
- Date: 2026-07-29
- Baseline: `726370b36e685abd771cd4dc94f6ac7700d804df`
- Scope: M0 architecture audit and the safety constraints for M1 to M5

## Context

Optimike Obsidian MCP already supports two client-facing paths:

```text
local MCP client
  -> direct stdio server

local MCP client
  -> stdio proxy
  -> persistent Streamable HTTP backend

remote or local MCP client
  -> direct Streamable HTTP backend
```

The persistent backend then reaches one or more knowledge sources:

```text
Streamable HTTP backend
  -> Obsidian Local REST API
  -> vault filesystem
  -> persistent SQLite cache and snapshots
  -> Bases and Operon bridges
  -> bounded external document roots
```

The existing HTTP implementation authenticates requests, but its shared functional rate limiter is applied before authentication and is keyed by an IP address. The default is 100 requests per 15 minutes. Multiple agents on loopback therefore share `127.0.0.1`, and every client behind a gateway can share the gateway address. The existing `MCP_TRUST_PROXY=true` switch also trusts the first `X-Forwarded-For` value without identifying the trusted proxy that supplied it.

This ADR defines the actual baseline, the required trust model, and the implementation boundaries for the stacked M1 to M5 branches.

## Sources of authority reviewed

The audit used the current `main` versions of:

- `src/config/index.ts`
- `src/index.ts`
- `src/mcp-server/server.ts`
- `src/mcp-server/transports/httpTransport.ts`
- `src/mcp-server/transports/stdioTransport.ts`
- `src/mcp-server/transports/auth/**`
- `src/runtime/localBackend.ts`
- `src/stdio-proxy.ts`
- `src/utils/security/rateLimiter.ts`
- `src/services/runtimeState.ts`
- `src/services/obsidianRestAPI/**`
- `src/services/obsidianRestAPI/vaultCache/**`
- `src/services/externalRootsService.ts`
- `src/services/externalTransferBroker.ts`
- `src/services/externalReferences/**`
- Operon and Bases bridge contracts
- runtime, external-root, HTTP handoff, package, documentation and migration tests

The existing security, write-policy, path-confinement, CAS, idempotency, journal, rollback and external-handoff contracts remain authoritative. This roadmap must not weaken them.

## Baseline transport map

### Direct stdio

A single MCP server process owns a single SDK server instance. Authentication is delegated to the local host boundary. This path does not use the HTTP middleware.

### Stdio proxy

Each proxy process exposes stdio to its caller and connects to the persistent Streamable HTTP backend. External-root reads and `external_move_*` are intercepted locally by the proxy where required. Other tools are forwarded to the backend.

At the audited baseline, the proxy creates its backend HTTP transport without an Authorization header. It therefore relies on the development authentication bypass when the backend has no configured JWT secret. Secure shared deployments need an explicit backend bearer credential. Two proxies that use the same verified credential are intentionally the same backend identity and must share quotas. A client-supplied identity header cannot provide real isolation.

### Direct Streamable HTTP

Each MCP session owns an in-memory `WebStandardStreamableHTTPServerTransport` and a per-session `McpServer` instance. Shared REST, cache and bridge services live outside those sessions. Sessions are process-local and are not a cluster or serverless contract.

### Gateway path

A gateway is an access plane, not an Optimike permission authority. It may terminate transport, authentication or TLS, but Optimike MCP still owns scopes, write policy, root capabilities, filesystem confinement, CAS, idempotency and rollback. A gateway assertion is usable only when the immediate gateway is explicitly trusted and authenticated, and the assertion format is explicitly configured. M1 does not introduce such assertions. The default gateway contract is bearer propagation so Optimike can verify the client identity itself.

## Authentication and identity availability

The authenticated identity becomes available after `jwtAuthMiddleware` or `oauthMiddleware` succeeds. Both strategies currently attach an SDK-compatible `AuthInfo` object to the incoming request and to `AsyncLocalStorage`.

Verified material available today:

- `clientId`, from JWT `cid` or `client_id`, or OAuth `client_id`;
- `subject`, from `sub`, when present;
- scopes;
- the verified bearer token, retained for downstream ticket binding;
- OAuth issuer, known from server configuration.

The raw bearer token must never become a rate-limit key, error field or log field. The functional identity key will be a server-side, non-reversible digest over verified identity material. Token fingerprinting is permitted only as a fallback discriminator and must also be non-reversible.

## Capability matrix

| Capability | Direct stdio | Stdio proxy | Direct HTTP | Linux headless | Desktop or plugin dependency | Stale or degraded behavior |
| --- | --- | --- | --- | --- | --- | --- |
| MCP lifecycle and tool discovery | Yes | Yes, through backend | Yes | Yes | None | Available while process is alive |
| Authenticated client identity | Host boundary only | Backend credential when configured | JWT or OAuth | Yes for HTTP | None | Invalid or absent credential is rejected in secured mode |
| Obsidian live reads | Yes | Yes | Yes | Only when Local REST API is reachable | Obsidian Desktop and Local REST API | Cache/filesystem fallback only where the tool contract allows it |
| Obsidian live writes | Yes | Yes | Yes | No in read-only; bounded filesystem writes in guarded profiles | Local REST API for live profile | Never inferred from stale cache |
| Vault filesystem reads | Runtime dependent | Runtime dependent | Runtime dependent | Yes in filesystem/headless profiles | Vault copy, no Desktop required | Freshness follows filesystem scan time |
| Persistent shared cache | Yes | Yes | Yes | Yes | No Desktop after a valid snapshot exists | Must report cache timestamp and stale state |
| Smart Connections vectors | Yes | Yes | Yes | Yes from copied `.smart-env` snapshot | Plugin needed to refresh source index | Snapshot can become stale; it is never labelled live |
| Bases live semantics | Yes | Yes | Yes | No without plugin/REST | Obsidian and Bases bridge | Local subset only where explicitly documented |
| Operon live mutations | Yes with all gates | Yes with all gates | Yes with all gates | No | Obsidian, Operon or Kairélys bridge, Local REST API | Cached reads may remain available; apply is denied |
| External roots list/stat/read | Yes | Local proxy authoritative | Yes where configured | Yes | None | Filesystem truth at access time |
| `external_handoff` | Local path | Local path | One-use HTTP ticket | Yes | None | Ticket expires and is process-local |
| `external_move_*` | Local-only | Proxy-only | Absent | Local stdio only | Live vault repair path and explicit gates | Never exposed over HTTP in this roadmap |
| Liveness | Process | Backend process plus proxy | Process | Yes | None | Must not imply dependency readiness |
| Readiness | Profile dependent | Backend profile dependent | Profile dependent | Yes | Depends on requested profile | Separate from liveness |

## Risks found in the baseline

### Quota bypass and false sharing

- IP-only functional limits merge distinct clients behind loopback or a gateway.
- Horizontal source-IP changes can evade IP-only quotas.
- A global trust-proxy boolean permits spoofing if the service is reachable without the intended proxy.

### Identity spoofing

- `X-Forwarded-For`, `Forwarded`, `X-Client-Id` and similar request headers are declarations, not proof.
- A stdio proxy label is not a verified backend identity.
- Gateway identity assertions need an explicit authenticated trust relationship and cannot be accepted by default.

### Unbounded process state

- The legacy limiter cleans expired counters but has no maximum cardinality.
- HTTP sessions and future queues are process-local and need explicit bounds and cleanup.

### Secret leakage

- Raw bearer tokens must not appear in keys, errors or logs.
- Authentication debug logging must not serialize the complete `AuthInfo` object.
- Health and observability surfaces must not expose vault paths, cache paths, document content or credentials.

### Mutation retry

- Gateways may retry requests. Optimike must preserve existing CAS and idempotency semantics.
- The transport layer must not implement an automatic retry of a mutation.
- Backpressure responses must be explicit so clients can distinguish admission failure from an unknown mutation outcome.

### Dependency saturation

- Rate limiting controls frequency, not simultaneous work.
- Obsidian, SQLite, filesystem scans, semantic embedding, external handoff and bridges need independent concurrency protection.
- Queues must be bounded and must release every slot after success, failure, timeout or cancellation.

### Health ambiguity

- The baseline `/healthz` always reports `healthy` when the process can answer.
- This conflates liveness with profile readiness.
- A stale snapshot must never be presented as live Obsidian data.

## Decisions

### D1. Two independent rate-limit planes

M1 will implement:

1. a pre-authentication source-IP defence for malformed, absent or invalid credentials;
2. a post-authentication functional quota keyed by verified client identity.

The two counters have separate limits, windows and capacity bounds. Passing one does not bypass the other.

### D2. Verified identity only

The functional identity is derived from verified authentication material. No caller-controlled identity header is accepted. Same verified identity across sessions shares a quota. Distinct verified identities behind one IP have isolated quotas.

For stdio proxies:

- one credential per agent provides real backend isolation;
- sharing a credential deliberately shares quota and concurrency;
- no unverified proxy header will simulate isolation;
- the simple personal-development profile can retain the existing development identity, with the resulting shared quota documented.

### D3. Explicit trusted proxies

Proxy headers are ignored by default. The immediate socket peer must match an explicit IP or CIDR allowlist before `Forwarded` or `X-Forwarded-For` is considered. The chain is evaluated from the trusted edge toward the client, and invalid values fail closed to the socket address.

### D4. Bounded state

Every limiter, queue, session registry and metric label set introduced by this roadmap has a configured maximum. Expired state is cleaned, and capacity exhaustion returns a deterministic response instead of allocating unbounded memory.

### D5. Admission before expensive work

M2 will admit requests before parsing or executing large operations whenever possible. It will enforce global, per-identity and expensive-operation ceilings, with a bounded fair queue and abort-aware cleanup.

### D6. Preserve mutation authority

The access plane cannot widen Optimike scopes or write permissions. HTTP never gains `external_move_*` in this roadmap. Existing CAS, idempotency, journal and rollback behavior remain unchanged.

### D7. Separate health states

M3 will retain `/healthz` as a backward-compatible liveness surface and add explicit readiness and detailed, sanitized status surfaces. States are `live`, `ready`, `degraded` and `critical`, with source, freshness, stale flag and dependency reasons.

### D8. Test gateways, do not build one

M4 will audit current OSS gateways from their code, licences and reproducible tests. At least one will be exercised end to end where infrastructure permits. An auxiliary endpoint routing limitation is documented as configuration, narrow deployment adaptation or incompatibility, not as a reason to create an Optimike gateway.

### D9. Honest headless pilot

M5 will use a fixture or copied test vault, never a personal vault. CI can prove deterministic Linux and Windows behavior. Anything requiring a real Desktop/plugin deployment remains an explicit field gate with an exact runbook.

## Roadmap adjustments after M0

The requested M1 to M5 sequence remains sound. Two details are made explicit:

1. secure stdio-proxy multi-agent isolation requires credentials propagated to the backend; labels alone are insufficient;
2. gateway compatibility is evaluated against both `/mcp` and `/external-handoff`, because MCP routing alone does not prove the auxiliary delivery contract.

No gateway, reverse proxy, SaaS tenancy layer, David-specific infrastructure or generic external write surface is added.

## Rollback

Each milestone is a stacked branch and can be reverted independently in reverse order. M1 defaults preserve the existing functional quota magnitude but change its key from IP to verified identity, while retaining a separate source-IP defence. Removing the M1 configuration or reverting its branch restores the baseline HTTP limiter behavior.

## Validation gates

- configuration parsing fails at startup for invalid limits, windows, proxy CIDRs or cardinality bounds;
- two verified identities on one IP receive isolated functional quotas;
- one identity across connections shares quota;
- invalid authentication is still covered by pre-auth protection;
- untrusted proxy headers are ignored;
- no token or secret appears in logs or responses;
- Linux and Windows CI remain green;
- no branch is merged automatically.
