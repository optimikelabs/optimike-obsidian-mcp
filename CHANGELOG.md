# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Default-deny external document roots with logical root IDs, bounded listing,
  metadata, hashing, UTF-8 reads, and explicit local stdio handoff for clients
  with their own PDF or Office tools.
- Opt-in authenticated HTTP artifact handoff with one-use identity-bound tickets,
  logical provenance, SHA-256 verification, bounded in-memory snapshots, and no
  source-path disclosure.
- Bilingual external-roots setup and operations guides with Windows and Unix
  examples, local and HTTP transport profiles, schema and ticket limits, client
  compatibility, verification, rollback, and troubleshooting.
- Architecture decision record covering direct HTTP profiles, transport-aware
  delivery, the external-mutation hold, threat model, and rollback.
- ÉLYSIA Tasks profile 1.1 with global Inbox, This Week, bounded Now, Backlog, periodic-note leakage detection, and a P90-J admission gate.
- Public task-governor guidance for distinct dry-run/apply idempotency keys and post-mutation visibility proof.
- Regression coverage for Obsidian wikilink normalization in the Bases Bridge.
- CI coverage and installable package artifacts for both the Bases and Operon Bridges.
- MCP safety annotations for all tool registrations, with regression coverage.
- A production dependency audit gate that fails on high or critical findings.

### Fixed

- Direct HTTP now validates supplied origins, ignores forwarding headers unless a
  trusted proxy is explicit, and uses a deterministic configured port by default.
- Semantic-search tools now declare `openWorldHint: true` because OpenAI can be selected as the query embedder.
- Bases Bridge now evaluates `collection.contains(link(...))` correctly when frontmatter stores Obsidian wikilinks such as `[[Projets]]`.
- Bases Bridge now treats the Bases literal `null` as a missing value instead of the string `"null"`, restoring missing-property filters and dependent formulas.
- Bases Bridge now evaluates bare `file.*`, `note.*`, and `formula.*` truthy references used by negated filters such as `!formula.next_action_ok`.
- Bases Bridge now warns when a requested view does not exist instead of silently returning an unfiltered view result.

### Security

- External-root access uses canonical-path confinement, strict include/exclude
  policies, link/junction rejection, handle identity revalidation, and
  path-redacted responses.
- Local stdio handoff returns a verified process-owned temporary copy instead of
  the source path, with a one-hour TTL, five-minute sweep, 16-file/512-MiB caps,
  stale-owner scavenging, and regression coverage on Linux and Windows.
- HTTP handoff remains disabled by default and requires both the root `handoff`
  capability and a non-development authenticated identity. Tickets are bound to
  the token fingerprint, client ID and subject, are single-use, short-lived and
  absent from URLs and logs.
- HTTP ticket snapshots have independent file, aggregate-memory, count and TTL
  limits. The broker does not delete or mutate the local handoff cache owned by
  `ExternalRootsService`.
- No upload, create, replace, move, delete or sync capability is introduced for
  external roots.
- Marked every legacy MCP tool as read-only, mutating, maintenance, or destructive for approval-aware clients.
- Moved MCP Inspector to development dependencies and updated `fast-uri` to a patched release, removing the high-severity production audit finding.

## [2.3.0] - 2026-07-21

### Added

- Thirteen Operon MCP tools for live configuration, indexed reads, native saved-filter queries, validation, adoption, creation, update, workflow transition, inline/file conversion, and identity-preserving inline relocation.
- Bundled Optimike Operon Bridge `0.3.0`, exposing a versioned REST contract through Obsidian Local REST API.
- Durable SQLite snapshots and mutation journal with optimistic revisions and idempotency reservations that survive process restarts.
- Stable pipeline/status IDs so French and English UI labels do not become automation identifiers.

### Changed

- Operon apply now requires two explicit operator opt-ins: the Bridge setting and `OPERON_MUTATIONS_ENABLED=true` in the MCP runtime.
- Stale Operon snapshots are always read-only, regardless of the capabilities cached while Obsidian was live.
- Mutation results are accepted only after the final indexed task matches the requested fields, status, source, and destination.

### Security

- Operon mutations are dry-run-first, path-scoped, revision-checked, and pass through the central MCP write policy.
- Protected frontmatter keys are refused in every write mode, including `full` and dry-run.
- Vault-relative paths reject absolute paths and `.`/`..` traversal segments.
- No mutation falls back to raw Markdown or private Operon methods.

## [2.2.0] - 2026-05-21

### Added

- `obsidian_validate_format` readonly tool for Obsidian Markdown, `.base`, and JSON Canvas validation.
- `obsidian_manage_canvas` headless filesystem tool for validating, creating, adding text nodes, and connecting JSON Canvas nodes.
- Realistic smoke fixtures for Obsidian Markdown, `.base` formulas/views, and `.canvas` nodes/edges.
- MCP routing guide explaining when to use MCP, Desktop/API, filesystem tools, CLI, and format skills.

### Changed

- Runtime smokes now validate Obsidian-facing formats before and during headless filesystem write coverage.
- Documentation now separates format guidance from execution tools and clarifies what headless validation can and cannot guarantee.

### Security

- Canvas writes are limited to `headless-filesystem`, dry-run by default, structurally validated before write, and use the existing guarded filesystem path safety.

## [2.1.0] - 2026-05-21

### Added

- Dedicated headless server profile assets: `.env.server.example`, vault snapshot helper, long-run validation script, and cross-platform runtime CI workflow.
- `obsidian_admin_filesystem` for dry-run-first archive, batch move, and batch delete operations with per-file preconditions.
- Advanced headless tag operations: local tag audit and guarded tag rename across frontmatter and inline Markdown tags.
- Richer local Bases query filters for equality, arrays, `contains`, `in`, and numeric/date comparisons.

### Changed

- `headless-filesystem` now exposes explicit filesystem admin features while keeping Desktop/UI/Bases-engine parity out of scope.
- Package contents now include server docs, examples, and operational scripts for backend deployment validation.

### Security

- Admin filesystem apply paths require `expectedHash` or `expectedMtime`; dry-run remains the default.
- Server validation guidance keeps cache/output outside the synced vault and recommends snapshots before write tests.

## [2.0.7-optimike.2] - 2026-05-21

### Added

- Runtime modes: `live`, `hybrid`, `headless-readonly`, and `headless-guarded`.
- Headless readonly smoke coverage for list, read, search, Tasks, semantic tools, and runtime status.
- Hybrid smoke coverage with and without Local REST API availability.
- Guarded filesystem writes for append/prepend note updates, exact search/replace, and frontmatter set.
- `npm run test:runtime` to run build plus all runtime mode smokes.
- Local Bases fallback for `bases_list`, `bases_get_schema`, and `bases_query` in headless modes.

### Changed

- `OBSIDIAN_API_KEY` is required only in `live` mode.
- Hybrid startup no longer blocks on Local REST API availability.
- Cache readiness is exposed through runtime stats and read/search/task fallbacks wait for readiness before failing.
- Runtime documentation now distinguishes Optimike MCP headless on a synchronized Markdown vault from a full Obsidian Desktop runtime.
- `npm run test:runtime` now includes the HTTP health/status smoke.

### Security

- Guarded filesystem writes reject path traversal and resolved real paths outside the vault root.
- Guarded writes support `expectedHash` and `expectedMtime` preconditions so stale synced-vault writes fail as conflicts.
- Headless guarded mode keeps destructive operations, broad overwrite, delete, and large batch writes out of the default public surface.
- Local Bases fallback treats invalid note frontmatter as empty frontmatter instead of failing a whole-vault query.

## [2.0.7-optimike.1] - 2026-01-18

### Added

- **Rebrand Optimike**: package, CLI, and docs updated for Optimike distribution.
- **Embedder-agnostic alignment**: query embeddings auto-match Smart Connections (.smart-env) model/dimension.
- **Docs**: companion plugin requirements and WSL/Ollama notes.

## [2.0.7] - 2025-06-20

### Changed

- Initial public Optimike baseline.
