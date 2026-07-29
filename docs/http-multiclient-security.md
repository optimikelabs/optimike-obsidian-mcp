# Streamable HTTP multiclient security

This document describes the M1 HTTP identity and quota contract. It applies to direct Streamable HTTP, the persistent backend used by the stdio proxy, and deployments behind an OSS gateway.

## Trust boundary

Optimike MCP accepts a functional client identity only after JWT or OAuth verification. The identity is derived from verified issuer, client ID and subject claims. If a verified token has no subject, a server-side HMAC fingerprint of the token is used as a fallback discriminator.

The following values are never client identity proof:

- `X-Client-Id` or a similar declarative header;
- `Forwarded` or `X-Forwarded-For`;
- an MCP session ID;
- the name reported in MCP `clientInfo`;
- a stdio process label.

Raw bearer tokens are retained only where an existing downstream contract needs them, such as identity-bound external handoff tickets. They are never used as log fields, error fields or plaintext rate-limit keys.

## Two independent quota planes

### Pre-authentication source protection

Every `/mcp` and `/external-handoff` request first consumes a bounded source-address allowance. This protects authentication and parsing work from missing, malformed or invalid credentials.

The verified-identity functional quota applies when the MCP tool issues the
handoff ticket. Redeeming that one-use, identity-bound ticket remains protected
by the source-address limit and authentication but does not consume a second
identity allowance. A ticket issued on the final allowance of a window must
remain usable.

Default:

```text
window: 900000 ms
requests per non-loopback source: 600
loopback policy: elevated
requests per loopback source: 3000
maximum tracked source keys: 5000
```

### Functional client quota

After successful authentication, the request consumes a second allowance keyed by the verified client identity.

Default:

```text
window: 900000 ms
requests per verified identity: 100
maximum tracked identities: 10000
```

Consequences:

- two verified identities behind one IP have isolated functional quotas;
- one verified identity across several connections shares one quota;
- a source-IP change does not reset the functional quota;
- absent or invalid authentication is still covered by the pre-authentication limit;
- all stores are bounded and expired counters are cleaned periodically.

A rejected request returns HTTP `429`, a JSON error, `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and `X-Optimike-Rate-Limit-Scope`.

## Loopback policy

Loopback is not bypassed. The default `elevated` policy gives local proxy traffic a larger pre-authentication allowance while preserving a bound. Set `MCP_HTTP_LOOPBACK_POLICY=shared` to use the normal source limit on loopback as well.

This distinction affects only the secondary source defence. Functional quotas remain per verified identity.

## Trusted proxies

Proxy headers are ignored by default. Configure `MCP_TRUSTED_PROXIES` with explicit immediate proxy IPs or CIDRs only:

```dotenv
MCP_TRUSTED_PROXIES=10.20.0.10/32,2001:db8:42::10/128
```

When the socket peer is trusted, the forwarding chain is evaluated from the trusted edge toward the first untrusted hop. Invalid chains fail closed to the socket address.

`MCP_TRUST_PROXY=true` is no longer sufficient. If the legacy flag is true without an explicit allowlist, startup fails.

A private network does not replace TLS, bearer verification or a proxy trust policy.

## Stdio proxy identity

The stdio proxy connects to the same persistent HTTP backend as direct HTTP clients. A secured backend therefore requires:

```dotenv
MCP_BACKEND_BEARER_TOKEN=<agent-specific verified token>
```

Provision one credential per agent when quota and concurrency isolation is required. Reusing one credential deliberately shares identity, quota and later per-client admission limits. Optimike MCP does not accept a proxy-supplied identity label as proof.

The personal development profile can run without configured authentication outside production. All such proxy processes receive the same explicit development identity and therefore share the same functional quota.

## Session binding

An HTTP MCP session is bound to the verified identity that initialized it. A different authenticated identity cannot reuse the session ID. The response is intentionally indistinguishable from an absent or expired session.

The process-local session registry is bounded by `MCP_HTTP_MAX_SESSIONS`, default 500. Capacity exhaustion returns `503` and `Retry-After`. This is a single-process contract, not a clustered session store.

## Configuration

| Variable                                   |                          Default | Meaning                                            |
| ------------------------------------------ | -------------------------------: | -------------------------------------------------- |
| `MCP_HTTP_PREAUTH_RATE_LIMIT_WINDOW_MS`    |                         `900000` | Source defence window                              |
| `MCP_HTTP_PREAUTH_RATE_LIMIT_MAX`          |                            `600` | Non-loopback requests per source/window            |
| `MCP_HTTP_LOOPBACK_POLICY`                 |                       `elevated` | `shared` or `elevated`                             |
| `MCP_HTTP_LOOPBACK_PREAUTH_RATE_LIMIT_MAX` |                           `3000` | Loopback requests/window under `elevated`          |
| `MCP_HTTP_IDENTITY_RATE_LIMIT_WINDOW_MS`   |                         `900000` | Functional quota window                            |
| `MCP_HTTP_IDENTITY_RATE_LIMIT_MAX`         |                            `100` | Requests per verified identity/window              |
| `MCP_HTTP_PREAUTH_RATE_LIMIT_MAX_KEYS`     |                           `5000` | Bound on source counters                           |
| `MCP_HTTP_IDENTITY_RATE_LIMIT_MAX_KEYS`    |                          `10000` | Bound on identity counters                         |
| `MCP_HTTP_RATE_LIMIT_CLEANUP_INTERVAL_MS`  |                         `300000` | Counter cleanup interval                           |
| `MCP_HTTP_MAX_SESSIONS`                    |                            `500` | Process-local session bound                        |
| `MCP_TRUSTED_PROXIES`                      |                            empty | Trusted proxy IP/CIDR allowlist                    |
| `MCP_HTTP_IDENTITY_HASH_KEY`               | JWT secret or random process key | Optional dedicated HMAC key, minimum 32 characters |
| `MCP_BACKEND_BEARER_TOKEN`                 |                            empty | Stdio proxy credential for a secured backend       |

All numeric values are validated at startup. Invalid or unsafe values stop the process before the HTTP listener is opened.

## What this milestone does not change

- scopes and tool authorization;
- origin validation;
- write policy and protected frontmatter;
- vault and external-root confinement;
- symlink and junction rejection;
- CAS and mutation idempotency;
- mutation journals and rollback;
- one-use external handoff tickets;
- the stdio-only status of `external_move_*`.

A gateway cannot widen any of those permissions.
