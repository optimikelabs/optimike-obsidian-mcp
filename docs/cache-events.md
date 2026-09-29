# Opt-in event-assisted vault cache

This candidate adds `OBSIDIAN_CACHE_EVENTS_ENABLED=true` for live/hybrid runtimes
with a REST service. It is disabled by default and does not upgrade any plugin.
Local REST API 5.3.1 is the characterized upstream target, not an installed-runtime
certification. An older host remains on periodic caching with an explicit
`unsupported` event diagnostic. Headless modes do not start subscriptions.

The cache instance owns four authenticated subscriptions: vault create, modify,
delete and rename. MCP sessions share that instance. No upstream MCP connection
or signed URL capability is needed. Signed query strings returned in grants are
not used: their origin/path is validated, then the existing authenticated REST
client opens the verified route. Redirects are refused.

## Guarantees and limits

- Events are hints to reread the configured source, not authoritative note content
  or proof of a mutation. The adapter discards note bodies, frontmatter, links,
  raw IDs and other metadata before queuing paths.
- The numeric counter is global and assigned before filters: gaps are normal.
  In pinned Local REST 5.3.1 `EventStreams.dispatch()` increments the shared
  counter before `matches(subscription, payload)`, so a per-subscription gap is
  not sufficient evidence of loss. No gap-based scan and no Last-Event-ID replay
  are implemented.
- Initial connection, reconnect, epoch change, folder changes, overflow and failed
  processing request coalesced reconciliation. A reconciliation rereads all
  selected Markdown files, even if their mtime and size did not change.
- The existing ten-minute inventory interval is unchanged. Ordinary inventory
  passes still use mtime/size to skip unchanged contents. This is not a globally
  atomic snapshot or a byte-verification guarantee between observations.
- Events generated during a scan remain queued; cache writes and scans are
  serialized. Requests arriving during reconciliation are not silently discarded.
  Failed subtree listings cannot be mistaken for authoritative empty inventories.
- REST and filesystem reads apply the same exclusions. Auto mode picks the same
  source for full and incremental reads. Static filesystem links escaping the
  configured vault are refused. This is not a native handle-relative write API.
- When using a filesystem source, the REST endpoint must observe the intended
  vault for useful low-latency hints. The API does not prove filesystem/REST
  identity; filesystem changes not yet observed by Obsidian remain dependent on
  reconciliation. Event payloads never overwrite cached content directly.

## Bounds and diagnostics

Four streams per cache/process; at most 512 coalesced pending paths and 32 updates
per drain. The cache serialization queue has a 1024-work-item bound. Overflow
marks uncertainty and requests reconciliation instead of retaining unlimited
paths. Handshake timeout is five seconds, stream inactivity timeout 45 seconds,
retry backoff one to 60 seconds. Sustained connections reset the backoff; fast
connect/disconnect loops do not. Reconciliation attempts are spaced by at least
five seconds. Stop aborts streams and drains owned work before database closure.

The parser is the pinned `eventsource-parser` 4.1.1 with a 262144-character buffer
limit; oversized, malformed or wrongly typed streams lose coverage explicitly.

`obsidian_runtime_status.sharedCache` exposes allowlisted counters, not payloads:
`freshness`, failed-file/update counts, pending work and `eventCache` status,
connected streams, reconnects, overflows, reconciliations and last observations.
Latency p50/p95 use at most 128 event-reception-to-verified-cache samples. They are
not server-event-to-cache or user-edit-to-model latency measurements.

`reconciledAndConnected` means the last requested reconciliation succeeded, four
streams are connected and the known queue is empty. It does not prove upstream
never dropped an event. `freshness: observed` describes the last observation, not
continuous or linearizable freshness. The semantic embedding index and governed
operation receipts are independent and unchanged.

## Validation and rollback

    npm ci
    npm run test:cache-events
    npm run test:log-privacy
    npm run test:profiles
    npm run test:runtime

The dedicated workflow runs the cache/event suites on Windows/Linux, Node 22/24.
Fixtures exercise real HTTP sockets, the production REST adapter and real SQLite;
they are not Obsidian Desktop. One preparation fixture observed p50 57 ms and p95
61 ms across five updates; that is not a production SLO or performance claim.

Real Desktop 5.3.1, hidden-window behavior, a representative vault, same-vault
source binding and the actual client transports remain separate pilot gates.
No production installation or switch is changed by these tests.

Disable the option and restart the candidate to return to periodic-only behavior.
No note migration, index deletion, API grant or mutation receipt rewrite is
needed. Preserve the package/Bridge rollback procedure for any later deployment.

## Subscription lifecycle

Each REST client retains at most one grant per vault event (four slots), not one
per connection. A reconnect reopens the authenticated route until expiry; a
missing GET subscription (404/410) clears only that grant and retries registration
on the next supervised attempt. It does not mean events are unsupported.
Transient failures retain the grant. Concurrent same-client/event opens are refused.
Grant origin/path and expiry are validated; signed query values are never retained.
A requested 30-second TTL bounds abandoned registrations after lost POST replies
(independent of the host default, which allows up to 24 hours). This lifetime
and the production reconnect backoff bound pressure from a continuously running
owner; they do not guarantee the shared quota against other clients or repeated
process restarts.
Already-open streams outlive the grant TTL; no timer closes a healthy stream.
