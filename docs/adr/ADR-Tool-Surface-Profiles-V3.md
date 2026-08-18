# ADR: Portable tool-surface profiles for Optimike MCP 3.0

- Status: accepted and implemented on the 3.0 migration branch
- Date: 2026-08-18
- Scope: MCP tool discovery, invocation and multi-client transport contracts
- Supersedes: exposing every runtime-registered tool to every client session

## Context

Optimike Obsidian MCP 2.9 exposes a broad governed operational surface. In a live runtime that surface contains 72 names. The cross-runtime union contains 76 names because `headless-filesystem` adds direct administration helpers that do not exist in live mode.

A broad catalogue is useful, but presenting every name to every model creates avoidable schema cost, latency and routing ambiguity. Several overlaps are intentional: direct and governed operations serve different guarantees; Tasks-compatible reads and Operon serve different owners; compatibility aliases preserve old clients. Removing these capabilities arbitrarily would reduce coverage or safety.

The MCP is public and must remain portable across Codex, Gemini CLI, Claude Code, Hermes Agent, OpenClaw and generic MCP clients. Client-specific allowlists or deferred loading cannot be the primary contract because support and semantics differ between harnesses.

## Decision

Optimike MCP 3.0 adopts a **server-owned, client-assisted** tool surface.

The server compiles one immutable profile before MCP initialization and before `tools/list`. Clients may filter or defer the result further, but they do not define Optimike’s canonical surface or security boundary.

The four public profiles are:

- `standard`;
- `authoring`;
- `tasks`;
- `full`.

Runtime mode and profile are orthogonal:

```text
runtime mode → structural implementations available
profile      → tools visible and callable in this session
permissions  → effects authorized at invocation time
```

## Catalogue and compiler

The 3.0 catalogue contains 74 cross-runtime names. It is the 2.9 union minus the former semantic aliases `smart_search` and `smart-search`.

Each entry declares one group, family, role and optional bundle/fallback metadata. Profiles compose groups; tools do not duplicate profile membership.

All registrations pass through a fail-closed runtime gate:

- uncatalogued names are rejected;
- complete MCP safety annotations are required;
- hidden names are not registered and cannot be called;
- the final surface is checked against the compiler before `connect`;
- partial bundles are rejected.

## Atomic bundles

Governed `plan/apply/status/recover` families are indivisible. The same closure rule covers:

- governed note replacement;
- governed Frontmatter projection;
- governed Base formulas;
- governed Canvas mutation;
- External Move inventory/plan/status/apply/rollback;
- Operon pending-recovery/recover.

Profiles affect visibility only. Durable plans, journals, idempotency and recovery authority remain profile-independent. A reconnecting client can recover from another session exposing the same family.

## Semantic search

3.0 exposes only:

```text
smart_semantic_search
```

The aliases `smart_search` and `smart-search` are removed from registration, discovery, routing documentation, tests and public call paths. This is a deliberate SemVer-major change.

## Stdio

The direct binary accepts:

```text
--tool-profile <profile>
MCP_TOOL_PROFILE=<profile>
```

CLI selection wins over the environment. Invalid, empty or duplicate values fail closed. The 3.0 default is `standard`.

The public stdio proxy composes the established local proxy rather than duplicating External Roots and move logic. It filters both discovery and calls, including local proxy-owned handlers.

## Streamable HTTP

The public paths are:

```text
/mcp/standard
/mcp/authoring
/mcp/tasks
/mcp/full
```

`/mcp` remains an explicit compatibility alias of `/mcp/full` in 3.0.

The HTTP boundary selects the profile before handing the request to the existing authenticated, rate-limited and backpressured transport. It stores a bounded session-to-profile binding and rejects reuse on another profile with an opaque invalid-session response. The original transport continues to own identity binding, MCP lifecycle and all effect authorization.

## Static versus transient availability

Compilation may use static configuration such as runtime mode or the presence of External Roots configuration. Temporary backend health never changes a connected session’s surface. Tools remain stable and return explicit degraded/unavailable diagnostics.

## Consequences

Positive:

- smaller, domain-coherent model surfaces;
- portable behaviour across MCP clients;
- fewer alias and direct/governed routing collisions;
- unchanged authorization and durable recovery contracts;
- explicit profile/session observability;
- fail-closed future tool additions.

Costs:

- profile membership becomes a public compatibility contract;
- every new tool must be catalogued and assigned deliberately;
- HTTP and proxy conformance need dedicated tests;
- clients migrating from 2.x must replace semantic aliases and may need an explicit profile.

## Rejected alternatives

### Client-only filters

Rejected because client support is inconsistent and generic clients may expose all server tools.

### One process-wide `MCP_TOOL_GROUPS`

Rejected because a shared HTTP backend serves multiple clients and identities.

### Dynamic profile-selection tool

Rejected because discovery cost has already occurred and the surface would change during a session.

### Collapsing governed lifecycles into one action tool

Rejected because separate plan, apply, status and recover names make authority and lost-response handling explicit.

### Arbitrary group query parameters

Rejected because they create an unbounded compatibility and test matrix.

## Release gates

3.0 is not admitted unless:

- Linux and Windows builds pass;
- all four profiles expose exact deterministic name sets per runtime fixture;
- no removed alias appears in `tools/list` or succeeds through `tools/call`;
- all bundles are complete;
- HTTP session/profile mismatch is rejected for `POST`, `GET` and `DELETE`;
- the stdio proxy rejects hidden local tools;
- governed status/recovery works across sessions exposing the same family;
- package contents and documentation include the profile contract;
- existing operation-runtime and security suites remain green.
