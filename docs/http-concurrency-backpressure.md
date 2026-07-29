# Streamable HTTP concurrency and backpressure

Rate limits control request frequency. They do not protect Obsidian, the shared cache, semantic providers, filesystem scans or bridges from too many simultaneous operations. M2 therefore adds bounded admission after authentication and identity quota checks, before MCP tool execution.

## Admission layers

Every admitted HTTP operation must fit all applicable ceilings:

1. global operations in flight;
2. operations in flight for the verified client identity;
3. expensive operations in flight, globally and for that identity;
4. mutations in flight, globally and for that identity.

Mutations also consume expensive-operation capacity. A request that cannot run immediately enters a bounded queue. Queueing never creates a new client identity and never trusts a declarative header.

The long-lived `GET /mcp` event stream does not hold an operation slot for its whole connection. Its process impact is bounded by the M1 session registry. `POST /mcp`, `DELETE /mcp` and `GET /external-handoff` use admission control. External artifact streaming remains additionally bounded by the existing handoff broker's pending, in-flight and transfer-time limits.

## Defaults

| Variable                                        |   Default | Meaning                                         |
| ----------------------------------------------- | --------: | ----------------------------------------------- |
| `MCP_HTTP_MAX_IN_FLIGHT`                        |      `32` | All admitted HTTP operations                    |
| `MCP_HTTP_MAX_IN_FLIGHT_PER_IDENTITY`           |       `8` | Operations for one verified identity            |
| `MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT`              |       `4` | Expensive operations globally                   |
| `MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT_PER_IDENTITY` |       `2` | Expensive operations for one identity           |
| `MCP_HTTP_MUTATION_MAX_IN_FLIGHT`               |       `4` | Mutations globally                              |
| `MCP_HTTP_MUTATION_MAX_IN_FLIGHT_PER_IDENTITY`  |       `1` | Mutations for one identity                      |
| `MCP_HTTP_MAX_QUEUED`                           |      `64` | Total queued operations                         |
| `MCP_HTTP_MAX_QUEUED_PER_IDENTITY`              |       `8` | Queued operations for one identity              |
| `MCP_HTTP_QUEUE_WAIT_TIMEOUT_MS`                |    `5000` | Maximum queue wait                              |
| `MCP_HTTP_MAX_REQUEST_BODY_BYTES`               | `1048576` | Maximum JSON-RPC request body before HTTP `413` |
| `MCP_HTTP_REQUEST_BODY_READ_TIMEOUT_MS`         |    `5000` | Server deadline for a complete request body     |
| `MCP_HTTP_BACKPRESSURE_RETRY_AFTER_SECONDS`     |       `1` | Conservative retry hint                         |

All values are validated before the HTTP listener starts. Per-identity limits cannot exceed their global limits. Mutation capacity cannot exceed expensive-operation capacity, and expensive capacity cannot exceed global capacity.

A zero queue is allowed only when both queue limits are zero. This produces immediate deterministic rejection whenever capacity is unavailable.

The source-IP limiter runs before any request-body buffering. Its pre-auth
`429` response uses JSON-RPC `id: null`, never clones or parses the untrusted
body, and cancels the incoming stream. After that source check, a transport
guard reads at most the configured body limit before authentication or the
identity quota can inspect a JSON-RPC id. Declared and streamed bodies above the
limit are rejected with HTTP `413`. A chunked body that does not complete
before the server deadline is cancelled and rejected with HTTP `408`.

Raw body guards share a separate anonymous global admission pool using the
configured global in-flight, queue and timeout magnitudes. A burst across many
allowed source addresses therefore cannot start an unbounded number of
near-limit buffers before authentication. Guard rejection cancels the unread
body.

After identity verification, `POST` body inspection still holds a standard
admission slot. The same byte limit and server deadline apply to that admitted
read; timeout or size rejection releases the slot exactly once.

The HTTP profile accepts exactly one JSON-RPC envelope per `POST`. A top-level
JSON array is rejected fail-closed with HTTP `400` before the MCP handler runs,
because treating a batch as one admitted operation would bypass the concurrency
contract. Clients must send batch members as separate requests.

## Explicit operation classes

The default expensive set contains semantic search aliases, runtime maintenance, global search, Bases queries, Tasks scans and queries, selected Operon rebuild/validation operations, external reads and external handoff.

The mutation set contains the registered note, frontmatter, tag, canvas, filesystem, Bases and Operon mutation tools. The sets are explicit and configurable through:

```dotenv
MCP_HTTP_EXPENSIVE_TOOLS=smart_semantic_search,obsidian_global_search,bases_query,query_tasks,external_handoff
MCP_HTTP_MUTATION_TOOLS=obsidian_update_note,obsidian_search_replace,operon_update_task
```

Changing these lists is a capacity-policy change. Use exact registered tool names and review the result. Unknown tools remain standard rather than being guessed from their name.

## Fair bounded queue

The queue is partitioned by verified identity and dispatched in round-robin order. Operations preserve FIFO order inside one identity. This prevents one client with many queued calls from starving other identities.

Queue state is bounded by the global and per-identity limits. Active and queued identity maps are removed when their counts return to zero. No bearer token, document path or request content is retained in admission state.

A request keeps one wait deadline while its bounded body is parsed and its
standard parsing slot is reclassified as expensive or mutation capacity. Body
parsing and both admission steps cannot each receive a fresh timeout.
`X-Optimike-Queue-Wait-Ms` reports the cumulative wait from the first admission
attempt when reclassification occurs.

## Rejection semantics

Admission rejection returns HTTP `503` with:

- `Retry-After`;
- `X-Optimike-Backpressure`: `queue-full`, `identity-queue-full`, `timeout` or `cancelled`;
- `X-Optimike-Operation-Class`: `standard`, `expensive` or `mutation`;
- `X-Request-Id`;
- a JSON-RPC error payload with `data.retryable` and `data.admission`.

An admitted response exposes `X-Optimike-Operation-Class` and `X-Optimike-Queue-Wait-Ms`.

`503` means the operation was not admitted. The transport does not retry it. A gateway may retry only under the tool's own semantics. Reads can normally be retried. Mutations must carry the existing idempotency key and CAS preconditions; a gateway must never invent or remove them.

## Slot release guarantees

A granted slot is released exactly once after downstream error, response-body
completion or response-body cancellation. Creating a streaming `Response` does
not release the slot while bytes are still being delivered. A queued request
removed by timeout or cancellation never consumes an in-flight slot. Abort
listeners and timers are removed when a queue item settles.

The controller exports aggregate snapshots only: active counts, queue counts, admitted totals, rejection totals and observed maxima. It does not label metrics by raw identity, token, path or tool arguments.

## Mutation safety

M2 changes admission only. It does not change:

- CAS preconditions;
- idempotency keys;
- write policy and scopes;
- mutation journals;
- rollback;
- protected frontmatter;
- path confinement;
- the stdio-only status of `external_move_*`.

The CI suite runs deterministic concurrent load plus existing note CAS, exact search-replace, external move and Operon mutation contracts. Backpressure is not a substitute for those guarantees.

## Test command

```bash
npm run test:http-backpressure
```

The suite runs on Ubuntu and Windows and proves global, per-client, expensive and mutation ceilings, queue bounds, fairness, timeout, cancellation, slot cleanup, retry headers and deterministic load without using a personal vault.
