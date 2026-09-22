# MCP 2026 dual-stack qualification

Base: `4e59b8ec28d01b8ccde8c04e1b8f53ea1dd13c78` (VNext Reliability P0, PR #102).
This change is a protocol/SDK migration, not a release or a production deployment.

## Activation and rollback

`MCP_PROTOCOL_MODE=legacy` is the default. It retains the initialize/initialized
handshake, identity/profile-bound HTTP sessions, GET/SSE, DELETE and the existing
stdio proxy retry policy. `MCP_PROTOCOL_MODE=dual` explicitly adds protocol
`2026-07-28` on those same profile endpoints and both stdio entry points. Invalid
values fail startup without reflecting the supplied value.

To disable modern serving, restore `MCP_PROTOCOL_MODE=legacy` and restart the
candidate. This keeps SDK v2. A full binary rollback restores the pre-upgrade
package and lockfile/build, with the same application journal locations. Neither
rollback deletes receipts, replays mutations, or rewinds the vault. Stop/drain
in-flight work and inspect status before resuming an uncertain operation.

## Normative sources and pinned dependencies

- [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [SDK protocol migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
- [SDK protocol eras](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)

`@modelcontextprotocol/server`, `client` and `core` are pinned to `2.0.0`.
`@modelcontextprotocol/sdk@1.30.0` remains a **dev-only** dependency so regression
tests still include a genuine old client. The production entry points and shipped
smoke clients use v2. There is no private SDK hook and no package patch.

The official v2 codemod performs the mechanical import and registration migration.
The MCP-only `mcpSchema()` adapter uses public `fromJsonSchema` plus the original
Zod 3 validator and `zod-to-json-schema@3.25.2`. It retains draft-07, input schema,
defaults, coercion, stripping, asynchronous refinements and output transforms.
Business validation was not globally migrated to Zod 4. A golden test compares
actual SDK v1 and v2 wire schemas and validator results. Legacy tool catalogues keep
v1's explicit `execution.taskSupport=forbidden`; modern catalogues omit that
removed legacy Tasks field.

## Cause/impact and state ownership

- `server.ts`: public factory accepts the official request context; process-shared
  services are injected, not created in protocol state. Modern per-request server
  construction does not start a cache rebuild for every request.
- `httpTransport.ts`: the existing legacy session branch remains; the modern branch
  uses `isLegacyRequest` and `createMcpHandler(..., {legacy: 'reject'})`. Auth,
  origin checks, bounded request-body reads, identity quotas and admission control
  still run before dispatch. Modern requests never enter the legacy session map.
- `stdioTransport.ts`, `dualStdio.ts`: legacy direct transport remains available;
  dual mode uses the official `serveStdio` factory and a narrow version guard.
- `stdio-proxy.ts`: backend negotiation is `auto` only in dual mode. The official
  SDK owns discovery and fallback. Generation leases/read-only proofs still fence
  retries. A session-invalid exception is only meaningful for a **legacy** backend.
  Modern network uncertainty never makes a mutation replayable. A hop rebuilds
  its reserved MCP metadata rather than forwarding client-supplied capabilities
  and identity as the proxy's own. Custom non-reserved metadata is preserved.
- `toolErrorBoundary.ts`: public registration/handler wrappers replace the audited
  v1 private hook. SDK validation errors stay redacted; application failures retain
  their closed codes and recovery details. Modern unknown tools use a redacted
  protocol error; legacy clients retain the established opaque tool-error result.
- `toolProfileRuntime.ts`: the registration gate uses public `registerTool` handles.
  Existing profiles, names, groups, complete governed families and registry remain.
- Auth context, request IDs, quotas, cache, durable journals and backend generation
  fencing are application/request state, **not** forbidden protocol session state.
  MCP clientInfo is never an authentication identity.

No operation adapter, receipt schema, CAS contract, authorization grant, Bridge
binary or retry classification in the business engine is changed. A proxy's
internal generation/attestation `sessionId` is deliberately retained: it is its own
nonce, not the removed `Mcp-Session-Id` wire header.

## SDK 2.0.0 gaps closed by explicit tests

1. Modern HTTP accepted a missing `MCP-Protocol-Version` header. A narrow
   modern-only pre-dispatch guard returns HTTP 400 / -32020. Existing legacy
   headerless requests are unchanged.
2. `isLegacyRequest` classifies bodyless GET/DELETE as legacy. An explicit modern
   version routes those requests to the official strict handler, which returns 405. It does not accidentally consult or consume a legacy session.
3. `serveStdio` validates the opening version but accepted an unsupported version
   on a subsequent ordinary request. `serveDualStdio` decorates the public
   transport only after the SDK selected the modern era, and uses the official
   `UnsupportedProtocolVersionError` before dispatch. The SDK continues to own
   framing, discovery, capability validation, request context and serving.

These are compatibility boundaries, not a hand-written implementation of MCP.
Tests cover both the original failing condition and unaffected valid/legacy calls.

## Executable matrix

`npm run test:mcp-2026` runs the targeted modern/dual suite and the P0 benchmark in
both eras. `npm run test:mcp-2026:all` additionally runs the existing regression
scripts. `MCP_EVIDENCE_DIR` controls the log/result location (outside the worktree
by default). Results are per script and include exit code, timeout and duration.
No test is marked successful merely because a process returned HTTP 200.

| Property              | Legacy proof                              | Modern / coexistence proof                                                                         |
| --------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Bootstrap/list/call   | genuine SDK 1.30 client, default and dual | pinned 2026 client; no initialize or session; stdio request without discovery                      |
| Four profiles         | existing profiles/registry suites         | HTTP + stdio counts, schemas, annotations, hidden-call rejection                                   |
| Per-request isolation | HTTP identity/session tests               | concurrent clients with identical untrusted clientInfo, distinct JWT/profile/capabilities          |
| Governed lifecycle    | existing MCP/HTTP note-replace suites     | same assertions with `MCP_TEST_PROTOCOL_ERA=modern`, real SQLite and restart                       |
| Lost response         | P0 and proxy reliability                  | real HTTP loss after CAS, process restart, status-only reconciliation; exactly one dispatch/effect |
| Backpressure          | existing admission/queue/stream suites    | real Hono boundary, per-identity queues, rejected/aborted requests never dispatched, lease release |
| Proxy recovery        | genuine v1 client and backend fixture     | modern backend, safe read retry, generation fences, fake session 404, mutation no-replay           |
| Errors/auth/version   | existing privacy/auth suites              | invalid/missing headers, unsupported later stdio revision, protocol errors, redacted validation    |
| SDK schema semantics  | golden SDK v1 output                      | exact legacy wire catalogue and default/coercion/refinement/transform results                      |
| P0 behavior           | same ten scenarios, five repeats          | same scenarios via official per-request Web Fetch HTTP handler                                     |

The modern benchmark uses in-process Web Fetch HTTP, simulated vault backends and
a real SQLite journal; it is not a Desktop or production-latency benchmark. The
separate modern loss fixture uses actual loopback HTTP sockets. The original
`VNEXT_DIST_ROOT` comparison to a v1 baseline remains supported in legacy mode.

## Desktop handoff (not claimed by CI)

`MCP_CANARY_PROTOCOL_ERA=modern node scripts/smoke-vnext-pilot2.mjs` pins the
existing explicitly disposable Pilot2 canary to 2026 and records the era. Default
`legacy` exercises the old path. All original disposable-vault checks, revisions,
no-replay assertions and cleanup/restoration rules remain. This requires a real
Desktop/Bridges/Operon environment and is not substituted by simulated fixtures.
Do not reuse the historical P0 12/12 as proof that this SDK migration passed live.

Skills over MCP is a separate opt-in extension change; no `skills/*` implementation,
new profile, generic operation facade or Context Engine is included here.
