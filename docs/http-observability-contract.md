# Streamable HTTP observability contract

Optimike MCP exposes signals for an external monitor or an OSS gateway. It does not implement an incident platform, a dashboard or a monitoring backend.

## Three endpoints, three meanings

### `GET /healthz`

Unauthenticated liveness only. HTTP `200` means the process and HTTP listener can answer. It does not claim that Obsidian Desktop, the filesystem vault, the shared cache, a bridge or a semantic provider is available.

The existing compatibility fields remain present:

```json
{
  "ok": true,
  "status": "healthy",
  "state": "live",
  "transport": "streamable-http",
  "endpoint": "/mcp"
}
```

### `GET /readyz`

Unauthenticated, sanitized readiness for the configured runtime profile. It returns:

- HTTP `200` for `ready` and `degraded`;
- HTTP `503` for `critical`.

A degraded service is still capable of serving a documented subset. A critical service cannot serve the expected profile safely.

### `GET /statusz`

Authenticated detailed status. It uses the same pre-authentication source protection, authentication and verified-identity quota as `/mcp`. It adds aggregate controls for sessions, admission and rate-limit map occupancy. It never returns bearer tokens, raw client identities, document content, document paths or personal vault paths.

## Readiness states

| State      | Meaning                                                                | HTTP on `/readyz` |
| ---------- | ---------------------------------------------------------------------- | ----------------: |
| `ready`    | The expected profile is available from a verified source               |             `200` |
| `degraded` | A bounded fallback is usable, or a non-critical dependency is degraded |             `200` |
| `critical` | No verified source can serve the expected profile safely               |             `503` |

The state includes machine-readable reasons such as `live_obsidian_unavailable_using_stale_fallback`, `cache_refresh_failed`, `headless_cache_unavailable` or `headless_vault_and_cache_unavailable`. Exception text from a failed refresh is never returned.

## Provenance and freshness

The status contract uses these response-source classes:

- `live-obsidian`;
- `filesystem`;
- `cache`;
- `snapshot`;
- `unknown`.

It also exposes the internal origin (`obsidian_api`, `filesystem`, `cache`, `snapshot` or `unknown`), observation timestamp, age in milliseconds, whether freshness is known and whether the result is stale.

A source is never called `live-obsidian` solely because the service runs in `live` mode. The transport probes the configured Obsidian REST service independently of the optional cache. A successful, recent authenticated probe therefore makes a live profile ready even when caching is disabled. A ready cache observation whose real refresh source is `rest` is also normalized to the public `obsidian_api` origin and must remain inside the freshness threshold. When that observation ages past the threshold, provenance becomes `snapshot` and the service is degraded. A known cache refresh failure is reported as sanitized degradation. A stale fallback is never presented as live.

The live probe cadence is the lower of 30 seconds and half the configured
freshness threshold. Lowering the threshold therefore cannot leave a healthy
cache-disabled live profile stale between fixed 30-second probes.
A recent direct probe takes precedence over older cache evidence: when it
reports the REST API unavailable, live reads and mutations are withdrawn
immediately even if a previous REST-backed cache snapshot remains usable.
Observation timestamps more than five seconds in the future are invalid
evidence. They never grant live readiness or mutations; a usable cached payload
may remain only as a stale fallback with a stable diagnostic reason.

Default freshness threshold:

```dotenv
MCP_OBSERVABILITY_STALE_AFTER_MS=900000
```

## Dependencies and temporary capability loss

Status distinguishes:

- whether Obsidian Desktop is required and verified;
- whether the configured filesystem vault exists;
- whether the shared cache read backend is ready;
- whether live reads, filesystem reads, cache reads and mutations are currently available.

`temporarilyUnavailable` contains stable capability identifiers, not exception text. Headless read-only operation can therefore be `ready` while `live-obsidian-reads` and `mutations` are unavailable by design. The configured vault path existing is not enough: headless readiness stays `critical` until the shared cache has completed a usable filesystem-backed build.

Hybrid operation follows the same evidence rule: without a verified live API observation or a ready bounded fallback, it is `critical`, not merely `degraded`. Mutation capability uses the centrally validated runtime write mode; observability does not reinterpret the raw environment.

## Structured request logs

Every HTTP request emits one completion event when its response body finishes, is cancelled by the client, or fails. Creating a streamed `Response` is not treated as completion. The event contains:

- `requestId` (a generated UUID also returned as `X-Request-Id`);
- pseudonymous verified client identity when authentication succeeded;
- transport;
- HTTP method and route;
- MCP method or tool name when safely classified;
- duration;
- result and HTTP status;
- quota outcomes;
- admission/backpressure outcome;
- operation class and queue wait;
- current provenance and stale flag;
- optional per-process HMAC fingerprints of caller-supplied `correlationId` and
  `incidentId` values. The raw values are never retained in clear text.

Mapped application errors use the status of the actual error response and are
logged only after that body completes. If a response body fails after headers
were produced, the event preserves the status placed on the wire and reports
`result: exception` instead of inventing a later HTTP `500`.

## Public HTTP error envelope

Every HTTP rejection, including pre-auth rate limits, authentication, origin
denial, session capacity, admission backpressure, invalid profile routing and
the Hono fallback, uses one JSON-RPC envelope. `error.data.requestId` is the
same UUID as `X-Request-Id` and as the structured ErrorHandler entry. The
protocol field `error.code` is always an integer JSON-RPC code. The closed
application category remains available only as
`error.data.applicationCode`. The envelope otherwise contains only a catalog
message and allowlisted server-owned diagnostics; it never reflects a request
body, a profile path, a token or an exception message.

The stable transport mappings are `503` for `SERVICE_UNAVAILABLE` and `504`
for `TIMEOUT`. A JSON-RPC identifier is reflected only from a valid `2.0`
request envelope and only when it is `null`, a string or a finite number
(including `0`); invalid envelopes, objects and arrays produce `null`.

Caller-controlled JSON-RPC methods and tool names are logged only when they match a strict 128-character identifier grammar. Other values are replaced by the controlled HTTP route label, preventing control characters, document content and oversized values from entering the operation field.

Clients may send correlation hints:

```http
X-Correlation-Id: incident-42:retry.1
X-Incident-Id: inc_2026-07-29_001
```

Only 1 to 128 characters from `[A-Za-z0-9._:-]` are accepted. Invalid values
are ignored rather than logged. Accepted values are HMAC-fingerprinted with a
secret generated for the running process; the fingerprint is therefore useful
for correlating events within that process lifetime, but is not stable across
restarts. The `X-Request-Id` UUID remains the public, clear-text correlation
handle for an individual request. These headers are correlation hints, never
authentication or authorization evidence.

Logs do not include by default:

- `Authorization` or any bearer token;
- authentication secrets;
- raw issuer, subject or client ID;
- request or response bodies;
- MCP tool arguments;
- note content;
- physical vault or external-root paths;
- external handoff tickets.

## Example sanitized readiness

```json
{
  "schemaVersion": "1",
  "state": "degraded",
  "ready": true,
  "degraded": true,
  "critical": false,
  "runtimeMode": "hybrid",
  "provenance": {
    "source": "snapshot",
    "origin": "obsidian_api",
    "observedAt": "2026-07-29T11:45:00.000Z",
    "freshnessMs": 1200000,
    "stale": true,
    "freshnessKnown": true
  },
  "capabilities": {
    "liveObsidianReads": false,
    "filesystemReads": true,
    "cacheReads": true,
    "mutations": false,
    "temporarilyUnavailable": ["live-obsidian-reads", "mutations"]
  },
  "reasons": ["live_obsidian_unavailable_using_stale_fallback"]
}
```

## Compatibility and limits

- `/healthz` remains unauthenticated and preserves the prior `ok`, `status`, `transport` and `endpoint` fields.
- `/readyz` contains no secret or path and is suitable for a load balancer readiness probe.
- `/statusz` is authenticated and rate-limited, but it is still an operational surface and should not be exposed publicly without TLS and network policy.
- Health is process-local. It does not claim clustered high availability or distributed session state.
- The server exposes signals only. Alerting, retention, dashboards and incident response remain external concerns.

## Tests

```bash
npm run test:http-observability
```

The suite runs on Ubuntu and Windows and proves the real `rest` cache vocabulary, direct live API readiness without cache, strict hybrid readiness, usable filesystem-backed cache, sanitized refresh failure, stale snapshot, degraded and critical states, body-stream completion and cancellation, bounded operation names, origin-rejection completion logging, endpoint status codes, authentication of `/statusz`, sanitized aggregate controls and absence of tokens, secrets, document content and personal paths from the observability surfaces.
