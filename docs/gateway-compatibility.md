# OSS gateway compatibility

French version: [gateway-compatibility.fr.md](gateway-compatibility.fr.md)

This document records the M4 gateway audit and the reproducible end-to-end
proof. A gateway is optional. It is an access plane, not an Optimike MCP
permission authority.

## Decision

Use **agentgateway in transparent HTTP routing mode** for the first gateway
pilot.

Optimike MCP must still:

- verify the original bearer token and derive the functional client identity;
- enforce scopes, write policy and external-root capabilities;
- bind MCP sessions and HTTP handoff tickets to that identity;
- enforce rate limits, concurrency, CAS, idempotency and rollback.

The gateway may add TLS, network policy, routing and independent outer limits.
It must not replace or widen those controls.

## Audited projects

| Project                                                           | Fit for this pilot                                                                                                                  | Decision                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [agentgateway](https://github.com/agentgateway/agentgateway)      | Standalone Apache-2.0 binary; transparent HTTP routes and MCP-aware features; current v1.4.0 binary available for Windows and Linux | Selected and tested end to end                                          |
| [IBM ContextForge](https://github.com/IBM/mcp-context-forge)      | Broad registry, federation, transformation, authentication and administration platform                                              | Credible future enterprise option; too broad for the first narrow pilot |
| [Microsoft MCP Gateway](https://github.com/microsoft/mcp-gateway) | Session-aware MCP routing and lifecycle management centered on Kubernetes, Azure and Entra ID                                       | Not selected for the local/headless pilot                               |

This comparison does not claim that the two unselected projects are unsafe or
incompatible. Their fit was assessed from their official architecture and
documentation. Their auxiliary-route behavior was not proven end to end.

## Why transparent HTTP mode

Optimike exposes both:

- the Streamable HTTP endpoint `/mcp`;
- the authenticated auxiliary download endpoint `/external-handoff`.

An MCP-only virtual target proves only `/mcp`. The selected agentgateway route
forwards the complete bounded HTTP surface, so the same bearer token,
`Mcp-Session-Id`, `X-External-Handoff-Ticket`, correlation headers, streaming
body and status codes reach Optimike unchanged.

Use the reviewed example:
[agentgateway.transparent.example.yaml](agentgateway.transparent.example.yaml).

Do not configure retries for mutations at the gateway. A read may be retried
according to its own semantics. A mutation must retain its original
idempotency key and CAS preconditions, and a response lost after admission
must be reconciled with Optimike status/journal tools instead of replayed
blindly.

## Reproducible proof

The harness is
[`scripts/test-agentgateway-compatibility.mjs`](../scripts/test-agentgateway-compatibility.mjs).
It requires an explicitly supplied, checksum-verified agentgateway binary:

```powershell
$env:AGENTGATEWAY_BIN = "C:\path\to\agentgateway-windows-amd64.exe"
$env:AGENTGATEWAY_COMMIT = "<upstream commit>"
npm run test:gateway:agentgateway
```

The verified run on 2026-07-29 used agentgateway `v1.4.0`, upstream commit
`83c952731ee79b4372e3a031382c4ff419ddfee1`, with Windows asset SHA-256:

```text
f60ac4318c0352a18c2419842fe1cc1fdca0521500848260a3f03a2f98d4ac87
```

It passed:

- Streamable HTTP initialization and session-header forwarding;
- two verified identities behind the same gateway IP;
- session ownership enforcement;
- concurrent requests and bounded overload responses;
- `429` and `Retry-After` propagation;
- deterministic read retry;
- stream cancellation followed by a healthy request;
- `/external-handoff` authorization and ticket-header forwarding;
- wrong-identity denial, one-use replay denial and expiry;
- absence of physical external-root paths in MCP, download and status results;
- authenticated `/statusz` and correlation-header forwarding.

The mutation replay probe was intentionally unavailable in the
`headless-readonly` profile. Mutation safety remains owned by the dedicated
CAS/idempotency tests and the M5 pilot on a copied or dedicated vault.

## Deployment boundary

This proof is a compatibility result, not approval for public Internet
exposure.

For a remote pilot, additionally require:

- TLS termination with a reviewed trust boundary;
- a private network or explicit ingress allowlist;
- bearer/JWT issuer, audience and scope validation by Optimike;
- no trust in `X-Forwarded-For` unless the immediate proxy is explicitly
  configured as trusted;
- explicit timeouts and no automatic mutation retries;
- monitoring of `/healthz`, `/readyz`, authenticated `/statusz`, `429`, `503`
  and structured request logs.

No custom Optimike gateway is required.
