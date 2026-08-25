# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.1.1] - 2026-08-25

### Fixed

- Removed the duplicate product-version allowlist from Operon Developer API V1
  mutations. Non-denied future releases now remain writable when the negotiated
  V1 contract, exact capabilities, response schemas, live health, settled index
  and recovery support validate; malformed contracts and missing capabilities
  still fail closed.
- Added regression coverage proving that a future contract-compatible Operon
  release projects read-write capabilities while an invalid or incomplete
  runtime remains read-only.

### Changed

- Current live target: Operon `3.5.3`, Operon CLI `1.2.0` and Optimike Operon
  Bridge `0.8.1`.

## [3.1.0] - 2026-08-24

### Added

- Official Operon task adoption through the exact additive
  `tasks.adopt.preview` / `tasks.adopt.apply` grant pair. The MCP applies only
  Operon's opaque sealed plan and recovers only that same plan; it never falls
  back to a Markdown rewrite.
- Capability-gated Daily and Weekly Note tools:
  `operon_create_periodic_task` lets Operon own periodic routing and
  `operon_update_periodic_scheduling` lets it retain, detach or realign a task
  without moving the source Markdown.
- Typed Task Type and Task Image scalar fields plus lossless ordered Task
  Gallery arrays. The derived `__taskDataType` field remains read-only.

### Changed

- Candidate compatibility target: Operon `3.5.2`, Operon CLI `1.2.0` and
  Optimike Operon Bridge `0.8.0`. The patched acceptance candidate passed the
  complete live Desktop canary on 2026-08-24 with exact restoration and no
  pending recovery. The official Operon artifact remains
  `compatible-provisional` until upstream PRs `#182`, `#183` and `#184` ship
  and that stock release passes the same gate.
- The Operon contract now contains 25 tools. Live `tasks` contains 33 tools and
  live `full` contains 72; `standard` and `authoring` remain unchanged.

### Security

- Optional task-workflow grants are negotiated independently. A missing or
  denied adoption/periodic grant disables only its dependent tool and never
  invalidates established core reads or authorizes a broader fallback.

## [3.0.1] - 2026-08-23

### Fixed

- The stdio proxy no longer treats an HTTP application outcome such as
  backpressure `503` or an ordinary `404` as a broken shared transport. One
  rejected call therefore cannot close admitted sibling calls.
- Backend session rotation is now single-flight and generation-aware. Retired
  generations drain for a bounded interval, stale tool annotations cannot
  overwrite the active generation, and shutdown closes every tracked client.
- Network retry is limited to one call whose backend annotation proves
  `readOnlyHint: true` on both the exact failed generation and the exact
  replacement generation. Mutations are never replayed after an ambiguous
  network failure and return `backend_outcome_unknown` for explicit
  reconciliation.

### Added

- Deterministic Windows/Linux CI coverage for `8` admitted calls plus `2`
  admission failures, ordinary application `404`, concurrent session
  invalidation, stale tool metadata, bounded drain, one read-only replay and
  mutation non-replay.
- A redacted live stdio backpressure canary and profile diagnostics that
  distinguish Operon hidden by `standard` from an unavailable Desktop Bridge.
- The live canary requires an already tracked backend, validates the exact
  admission payload and fails closed instead of auto-spawning an unowned
  detached process.

## [3.0.0] - 2026-08-18

### Removed

- Removed the `smart_search` and `smart-search` compatibility aliases. Semantic
  search now has one registered MCP name: `smart_semantic_search`.

### Changed

- An unspecified stdio profile now selects `standard` instead of `full`.
- The unqualified HTTP `/mcp` route now selects `standard`; `/mcp/full` remains
  available as the explicit complete active-runtime surface.
- Full live/hybrid registration is now 70 tools, while the default `standard`
  live/hybrid surface remains 19 tools.

### Migration

- Replace every `smart_search` or `smart-search` call with
  `smart_semantic_search`.
- Clients that depended on implicit access to administration, external-root or
  specialized tools must explicitly select `full` with
  `MCP_TOOL_PROFILE=full`, `--tool-profile full`, or `/mcp/full`.

## [2.10.0] - 2026-08-18

### Added

- One canonical registry describes every MCP tool name, family, lifecycle,
  runtime requirement and static dependency across live, hybrid and headless
  modes.
- Portable `standard`, `authoring`, `tasks` and `full` tool profiles can be
  selected through `MCP_TOOL_PROFILE`, `--tool-profile`, per-client stdio
  proxy configuration, or the `/mcp/{profile}` HTTP routes.
- A 31-case harness-neutral routing corpus and JSONL scorer measure first-tool
  accuracy, forbidden calls, success, per-case minimum call counts, latency and
  token use without publishing fabricated model scores.

### Changed

- The 2.x default remains `full`, preserving the existing client surface.
  `standard` exposes 19 tools, `authoring` 30, and live `tasks` 31; snapshot
  task profiles retain only snapshot-safe Operon reads.
- `smart_semantic_search` is the sole semantic-search name taught by routing
  documentation and exposed outside `full`. The deprecated `smart_search` and
  `smart-search` aliases remain physically available only in `full` until the
  planned 3.0 removal.
- Governed `plan` / `apply` / `status` / `recover` families become visible
  atomically only when their complete quartet is registered. A direct fallback
  remains available while a governed family is incomplete.
- `bases_upsert_config` remains a full-only whole-Base compatibility operation;
  it is not exposed as an authoring or formula fallback.

### Security

- Tool visibility remains separate from write authorization. Profiles do not
  weaken write policy, scope, Bridge gates, CAS, idempotency, confirmation or
  durable recovery authority.
- Hidden tools are rejected on direct `tools/call`, not merely omitted from
  `tools/list`. HTTP sessions are bound to both verified identity and their
  selected profile, preventing cross-route session reuse.
- The byte-exact atomic-note canary now refuses before mutation for every
  advertised active modified-time writer, including protection-only and
  unsupported configurations. Modified-time settlement remains a separate,
  bounded live gate.

### Validation

- The exact feature head `c5e0ef0a4c` passed 27/27 P0-P4, Operon Bridge and
  Runtime checks plus an exact-head Codex Review with no major issue.
- Two live Obsidian Desktop canaries passed in the disposable Operon Bridge
  pilot vault: bounded modified-time settlement with lost-response recovery,
  and the `standard` profile's byte-exact governed note lifecycle with exact
  restoration. The active modified-time preflight also proved no mutation.
- Post-merge `main` passed all 13 Runtime jobs on
  `2d227d86d83f505a4e8da87f1a9ed9fad409fce3`.

## [2.9.0] - 2026-08-17

### Added

- Governed JSON Canvas P3 surface:
  `obsidian_canvas_patch_plan`, `obsidian_canvas_patch_apply`,
  `obsidian_canvas_patch_status`, and `obsidian_canvas_patch_recover`.
- Atomic Write Bridge `0.4.0` adds an independent default-off Canvas write
  gate, typed read/CAS routes, vault binding, SHA-256 compare-and-swap inside
  `Vault.process`, and JSON Canvas 1.0 graph validation.
- The MCP routing guide is now exposed as the canonical
  `optimike://guides/tool-routing` resource over stdio and HTTP.

### Changed

- Tool descriptions and routing documentation now direct governed note,
  Frontmatter, Base, Canvas, and Operon mutations to their canonical lifecycle
  while keeping direct helpers as explicit compatibility paths.
- Canvas node and edge intentions project over the shared durable operation
  runtime; no generic public `operation_*` API is introduced.

### Security

- Planning and CAS reject malformed standard JSON Canvas fields, dangling
  edges, duplicate or ambiguous entity histories, padded/non-canonical paths,
  sources or projections above 5 MiB, and projected effects above the active
  guarded policy before any durable write is admitted.
- Localized edge deletion preserves untouched JSON literals and each surviving
  edge's original adjacent separator instead of reparsing or globally
  normalizing unknown values.

### Validation

- The governed Canvas feature head passed 19 Windows/Linux PR checks and an
  independent hostile contract audit. The exact release candidate passed its
  15 triggered checks and the live Operon Bridge pilot-vault canary. The
  canary proved no-write planning, invalid-graph rejection, exact-plan recovery
  after a pre-dispatch interruption, post-write lost-response reconciliation,
  idempotent replay, stale-plan conflict, and exact restoration of the original
  Canvas SHA-256.

## [2.8.3] - 2026-08-17

### Fixed

- Governed note and Frontmatter writes now derive the configured creation,
  modification and last-viewed property names from supported active Obsidian
  date plugins instead of assuming `création` and `modification`.
- A successful CAS now waits for the plugin-advertised bounded observation
  delay and re-reads the note before committing its receipt, covering deferred
  timestamp writes even when the original CAS response was received normally.
- The observation window now starts at the durable post-CAS boundary rather
  than at preflight, and concurrent status/recovery cannot commit either a
  sealed or partial settlement proof before the longest configured delay ends.

### Security

- Creation and last-viewed properties are protected but never ignored during
  reconciliation. An active creation property must already exist before a plan
  is admitted.
- Unsupported multi-effect date-plugin configurations fail closed. In
  particular, Frontmatter Date Manager update counters, post-update commands,
  inversion repair, numeric values, forced timezones and excessive delays are
  never treated as a one-line timestamp settlement.
- Legacy settlement advertisements without an explicit bounded delay fail
  closed; active date integrations require Atomic Write Bridge 0.3.0 or later,
  and legacy non-terminal receipts without a sealed delay remain unrecoverable
  rather than guessing a zero wait.
- Active creation, modification or last-viewed properties whose configured
  names cannot be represented as source-stable plain YAML keys are now reported
  explicitly by plugin and role and rejected before CAS instead of disappearing
  from the protection contract.

### Changed

- Atomic Write Bridge `0.3.0` exposes additive date-property protection and a
  bounded settlement observation delay. Static
  `MCP_PROTECTED_FRONTMATTER_KEYS` remains an additive policy for custom or
  unsupported fields, not a duplicate configuration requirement.

### Validation

- Deterministic Bridge and real stdio MCP tests cover custom property names,
  last-viewed protection, missing creation fields, apply-time configuration
  changes, invalid active names, shared-property plugins, unsafe FDM options and delayed settlement
  after a successful CAS response. Concurrent observers are also proven unable
  to terminalize either the sealed hash or an early timestamp settlement before
  that delay expires, even when preflight itself outlasts the delay.

## [2.8.2] - 2026-08-17

### Fixed

- Governed Markdown-note and frontmatter reconciliation now accepts the one
  strictly bounded `modification`-style timestamp update that a supported
  Obsidian date plugin can apply immediately after the sealed write. Lost
  responses no longer become false `outcome_unknown` receipts when that is the
  only observed difference.

### Changed

- Atomic Write Bridge `0.2.0` reports active supported modified-time
  integrations and the host UTC offset so the MCP can seal an exact settlement
  policy with each plan.

### Security

- Modified-time settlement does not weaken pre-effect CAS: the permitted key
  must also be protected by MCP policy, exactly one canonical monotonic YAML
  line may advance inside the real apply window (at most five minutes), and
  restoring that line must make the observed note byte-identical to the sealed
  target. Every other drift remains uncertain or conflicting.

### Validation

- The dedicated Operon Bridge pilot vault passed the release canary with
  Frontmatter Date Manager `1.2.1` at both supported minute and second
  resolutions: two successful CAS responses and their first reconciliation
  reads were deliberately lost, timestamp-only settlement reconciled to
  `committed`, additional body drift remained `outcome_unknown`, and the
  disposable note was restored to its exact original SHA-256.

## [2.8.1] - 2026-08-15

### Fixed

- The Atomic Note live canary now respects the runtime log-directory boundary,
  announces its transient log path before connecting, and keeps retained
  recovery metadata aligned if those logs are moved after a failed restore.

## [2.8.0] - 2026-08-15

### Added

- Governed source-preserving Base formula P2 surface:
  `bases_formula_patch_plan`, `bases_formula_patch_apply`,
  `bases_formula_patch_status`, and `bases_formula_patch_recover`.
- Bases Bridge Atomic V1 with vault binding, exact SHA-256 CAS through
  `Vault.process`, an independent default-off write gate, deterministic
  Windows/Linux gates, and a live pilot-vault canary on a disposable exact copy
  of `PROJETS.base`.

### Changed

- The proven durable operation journal and concurrency fencing now serve a
  second typed backend through an internal atomic-resource profile. No generic
  public `operation_*` surface is introduced.
- Legacy whole-file Base config/create effects are disabled by default and
  require an explicit compatibility toggle; validation-only requests remain
  available.

### Security

- Named formula set/delete preserves every byte outside authorized source
  ranges and fails closed on ambiguous YAML, aliases, tags, merge keys,
  duplicate/case-colliding names, mixed line endings and final-formula delete.
- Parsed YAML node ranges fence formula ownership, including block-scalar
  content that resembles comments or blank trivia. Governed state-changing
  HTTP calls use mutation backpressure by default.
- The live pilot proved no-write planning, apply/status, replay, stale-plan
  conflict and exact final SHA restoration in the dedicated Operon Bridge test
  vault.

## [2.7.0] - 2026-08-14

### Added

- Governed source-preserving Frontmatter P1 surface:
  `obsidian_frontmatter_patch_plan`, `obsidian_frontmatter_patch_apply`,
  `obsidian_frontmatter_patch_status`, and
  `obsidian_frontmatter_patch_recover`.
- Executable authority/admission model, conservative top-level YAML compiler,
  real stdio and HTTP multi-session gates, and a fail-closed live Obsidian
  canary with exact backup/restoration.

### Changed

- Frontmatter intentions compile into complete Markdown candidates and reuse the
  released P0 journal, leases, attempt fencing, CAS, receipts, status, and
  exact-plan recovery. No second transaction engine or generic public
  `operation_*` surface is introduced.
- P0 accepts optional internal projection metadata and expected source proof
  while preserving direct note-replacement digest semantics.

### Security

- Every byte outside explicitly authorized top-level Frontmatter entry ranges
  remains unchanged. Ambiguous YAML and comment ownership fail closed; cache
  state is never an admission or mutation authority.

## [2.6.0] - 2026-08-14

### Added

- Public governed atomic replacement for one existing Markdown note through
  `obsidian_note_replace_plan`, `obsidian_note_replace_apply`,
  `obsidian_note_replace_status`, and `obsidian_note_replace_recover`.
- Real MCP integration coverage using the compiled server, the SDK stdio client,
  and a controlled Atomic Write boundary, including idempotent replay,
  lost-response reconciliation, process restart, concurrent apply/recover,
  stale CAS, protected frontmatter, current-policy revalidation, and sealed
  content redaction.
- Real Streamable HTTP coverage proving that one sealed plan remains authoritative
  across three independently created MCP sessions while producing exactly one
  backend CAS and closing the shared journal cleanly at process shutdown.
- Fail-closed live Obsidian canary with an explicit disposable note, durable
  pre-mutation backup, direct Bridge CAS-conflict proof, replay, status,
  deterministic conflict, restoration, and a redacted evidence record.

### Changed

- The existing 2.5 note-replacement adapter and journal now live in one
  process-wide application service shared by stdio and every HTTP MCP session;
  no session opens a competing SQLite authority or a second REST client.
- Planning validates protected frontmatter and conservative Obsidian Markdown
  against the same Bridge read that seals the before hash. Apply and recover
  revalidate the current MCP write policy before any possible effect.
- The live operator canary passed on 2026-08-14 with exact restoration of the
  disposable note. Package and lockfile now identify the stabilized `2.6.0`
  release. No generic public `operation_*` surface is part of this release.

## [2.5.0] - 2026-08-13

### Added

- Bundled Atomic Write Bridge with a default-off write gate and an Obsidian
  `Vault.process` SHA-256 compare-and-replace route for existing Markdown notes.
- Second common-operation-runtime adapter for atomic note replacement, with a
  private SQLite journal, sealed plan binding, terminal retention, idempotent
  replay, conflict proof, lost-response reconciliation and exact-plan recovery.

- Operon `3.2.1` / CLI `1.1.0` compatibility through Bridge `0.6.0`, retaining
  explicit `3.2.0` support and including
  native saved-filter execution via the additive `tasks.filter-query` grant and
  opaque pagination.
- Regression coverage proving that a pending filter grant cannot hide already
  approved core reads or mutations.
- Saved-filter pagination and Bridge HTTP error mapping coverage, preserving
  typed `404`/`422` failures instead of reporting generic internal errors.
- Contract-negotiated Operon compatibility: unknown releases such as `3.3.0`
  receive version/accessor admission as `compatible-provisional` when they are
  not denied and expose `getDeveloperApiV1()`. Actual use still requires a
  valid `developerApi` status, top-level `ok`, `index.ready`, and the exact
  advertised capability.
- Complete live acceptance of Operon `3.3.0` with Bridge `0.7.0`: persisted
  grants, bounded startup retry, governed apply/replay/conflict/postflight,
  thirty tasks, zero validation violations and zero pending recoveries.
- Common governed operation runtime contract with `plan`, `apply`, `status`,
  durable receipts and exact-plan `recover`, proven first through the existing
  `external_move` transaction and disposable restart fixtures.

### Changed

- Saved-filter documentation now distinguishes execution from catalog
  discovery: Operon 3.2 requires an exact caller-supplied `filterSetId` because
  its official Developer API does not list the saved-filter catalog.
- ÉLYSIA Task Gouverneur active skill `2.2` and distributed profile skill
  `1.3.0` align with the 3.2 capability boundary. Adoption remains unavailable
  without a Markdown or CLI fallback.
- Optimike Operon Bridge `0.7.0` no longer blocks all users on an unknown Operon
  product version when the negotiated Developer API contract remains valid;
  malformed or unavailable contracts still fail closed.
- Transient Operon startup states are retried for a bounded window before the
  Bridge reports structured unavailability.
- Compensated terminal `external_move` plans reject delayed apply retries and
  cannot be reactivated after rollback.

## [2.4.0] - 2026-08-09

### Added

- ÉLYSIA Task Gouverneur `1.2.0`, aligned with the complete 23-tool Operon
  surface, capability-gated adoption/saved filters, governed relationships and
  recurrence, exact-plan recovery, and the explicit MCP/CLI boundary.

- Bilingual Operon MCP contract and CLI audit documenting the complete 23-tool
  surface, the governed MCP-versus-CLI boundary, stock 3.1.1 capability limits,
  and the completed relationship and recurrence acceptance evidence.

- Six bounded, read-only Operon 3.1.1 Developer API tools for native
  diagnostics, ranked finder, entity resolution, relationships, context packs,
  and timer state; no CLI passthrough or new mutation class is exposed.

- Official Operon 3.1.1 Developer API V1 adapter coverage for governed task
  reads, typed preview/apply/recovery mutations, stable status identities,
  postflight evidence, and same-plan idempotent replay through the Bridge.
- Explicit compatibility note for stock Operon 3.1.1 versus the patched local
  acceptance build while upstream PRs #135, #137, and #139 are under review.

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
- Local-stdio external reference integrity workflow with
  `external_references_scan`, durable move plan/status, guarded apply and
  rollback for one same-root regular file.
- Canonical adjacent reference identity
  `external-ref:<rootId>::<percent-encoded-relative-path>` for exact repair of
  clickable `file:///` links without turning physical paths into authority.
- Machine-local SQLite move journal, idempotency binding, exact note preimages,
  no-clobber hard-link/unlink file moves, conditional note repairs and
  compensating rollback.
- Bilingual ADR and operator guidance for the external move/repair pilot,
  including HTTP denial and the explicit create/replace/upload/delete/sync
  exclusions.
- ÉLYSIA Tasks profile 1.1 with global Inbox, This Week, bounded Now, Backlog, periodic-note leakage detection, and a P90-J admission gate.
- Public task-governor guidance for distinct dry-run/apply idempotency keys and post-mutation visibility proof.
- Regression coverage for Obsidian wikilink normalization in the Bases Bridge.
- CI coverage and installable package artifacts for both the Bases and Operon Bridges.
- MCP safety annotations for all tool registrations, with regression coverage.
- A production dependency audit gate that fails on high or critical findings.
- Reproducible agentgateway v1.4 transparent-routing harness covering
  Streamable HTTP sessions, identity isolation, bounded overload,
  cancellation, authenticated status and the auxiliary external-handoff
  ticket flow.
- Bilingual OSS gateway audit selecting agentgateway for the first pilot while
  keeping authorization, scopes, CAS, idempotency and rollback in Optimike MCP.
- Generated bilingual SVG explainers for the product overview, documentation
  hub, operations, security, runtime profiles and agent routing, with a
  deterministic generator and visual-contract tests.

### Changed

- The live adapter now requires Local REST API 5.0.2 or later within the
  supported 5.x line and sends native JSON PATCH instructions with typed
  frontmatter values instead of deprecated 1.x PATCH headers.

### Removed

- Removed the obsolete core `/periodic/...` service routes and the
  `periodicNote` target from `obsidian_update_note` and
  `obsidian_search_replace`. Periodic notes must now be addressed through an
  explicit vault-relative path; the optional upstream Periodic Notes API
  extension remains a separate integration.

### Fixed

- Documentation entrypoints now distinguish local stdio, authenticated loopback
  HTTP and pilot-only remote HTTP without contradictory stdio-only claims.
- Runtime matrices now describe Operon as a common tool family and restrict
  Canvas, move and admin tools to the modes that actually register them.
- External-root documentation now distinguishes the default read/handoff
  contract from the separately gated local-stdio move/repair transaction.
- README entrypoints now expose the local move/repair exception without
  presenting HTTP handoff or external roots as a generic mutation surface.
- The bundled Inspector HTTP example is now explicitly development-only instead
  of presenting an unused JWT secret as authentication.
- HTTP and Inspector launch scripts now use cross-platform Node wrappers.
- Direct HTTP now validates supplied origins, ignores forwarding headers unless a
  trusted proxy is explicit, and uses a deterministic configured port by default.
- Semantic-search tools now declare `openWorldHint: true` because OpenAI can be selected as the query embedder.
- Bases Bridge now evaluates `collection.contains(link(...))` correctly when frontmatter stores Obsidian wikilinks such as `[[Projets]]`.
- Bases Bridge now treats the Bases literal `null` as a missing value instead of the string `"null"`, restoring missing-property filters and dependent formulas.
- Bases Bridge now evaluates bare `file.*`, `note.*`, and `formula.*` truthy references used by negated filters such as `!formula.next_action_ok`.
- Bases Bridge now warns when a requested view does not exist instead of silently returning an unfiltered view result.

### Security

- Added bilingual security and documentation hubs with one authoritative route
  for tools, runtime modes, external roots, deployment posture and ADR status.
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
  limits, including reservations for requests still buffering. The broker does
  not delete or mutate the local handoff cache owned by `ExternalRootsService`.
- No upload, create, replace, directory/cross-root move, overwrite, delete or
  sync capability is introduced for external roots. The only mutation is an
  opt-in same-root regular-file move through local stdio.
- External move apply and rollback require `MCP_WRITE_MODE=full`,
  `MCP_EXTERNAL_MOVE_ENABLED=true` and the root `move` capability. Ambiguous,
  legacy or historical references block apply.
- The move verifies source size, mtime and SHA-256, requires an absent target
  under an existing real parent, and uses a no-clobber same-volume
  hard-link/unlink sequence.
- Exact note repairs use SHA-256 preconditions in `headless-filesystem` on a
  copied or dedicated vault. Live apply fails closed because Local REST API
  4.1.7 does not enforce `If-Match` on whole-note writes. Direct HTTP refuses
  scan, plan/status, apply and rollback.
- Marked every legacy MCP tool as read-only, mutating, maintenance, or destructive for approval-aware clients.
- Moved MCP Inspector to development dependencies and updated `fast-uri` to a patched release, removing the high-severity production audit finding.

## [2.3.0] - 2026-07-21

### Added

- Thirteen Operon MCP tools for live configuration, indexed reads, native saved-filter queries, validation, adoption, creation, update, workflow transition, inline/file conversion, and identity-preserving inline relocation.
- Bundled Optimike Operon Bridge \`0.3.0\`, exposing a versioned REST contract through Obsidian Local REST API.
- Durable SQLite snapshots and mutation journal with optimistic revisions and idempotency reservations that survive process restarts.
- Stable pipeline/status IDs so French and English UI labels do not become automation identifiers.

### Changed

- Operon apply now requires two explicit operator opt-ins: the Bridge setting and \`OPERON_MUTATIONS_ENABLED=true\` in the MCP runtime.
- Stale Operon snapshots are always read-only, regardless of the capabilities cached while Obsidian was live.
- Mutation results are accepted only after the final indexed task matches the requested fields, status, source, and destination.

### Security

- Operon mutations are dry-run-first, path-scoped, revision-checked, and pass through the central MCP write policy.
- Protected frontmatter keys are refused in every write mode, including \`full\` and dry-run.
- Vault-relative paths reject absolute paths and \`.\`/\`..\` traversal segments.
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
- `npm run smoke:headless-status` for HTTP health/status monitoring validation.

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

- **Package Update**: Fixed README & incremented version to 2.0.7 to ensure the latest changes are reflected in the npm package.

## [2.0.6] - 2025-06-20

### Changed

- **Tool Renaming**: Renamed `obsidian_read_file`, `obsidian_delete_file`, and `obsidian_list_files` to `obsidian_read_note`, `obsidian_delete_note`, and `obsidian_list_notes` respectively. This change improves semantic clarity and aligns the tool names more closely with Obsidian's terminology, reducing ambiguity for AI agents.
- **Dependency Updates**: Updated all dependencies to their latest versions.
- **Documentation Improvements**: Updated `.clinerules` to reflect the new tool names and ensure all documentation is current.

## [2.0.5] - 2025-06-20

### Changed

- **Tool Renaming**: Renamed the `obsidian_update_file` tool to `obsidian_update_note` to avoid conflicts and better reflect its function. During agentic use, LLMs confused this tool with filesystem operations, leading to errors. The new name clarifies that it operates on Obsidian notes specifically.
- **HTTP Transport Refactor**: Restructured the HTTP transport layer for improved clarity and robustness. Authentication logic is now more modular, and a centralized error handler has been implemented.
- **Dependency Updates**: Updated all dependencies to their latest versions.
- **Documentation Improvements**: Enhanced the documentation around installation & MCP Client configuration. Suggested by [@bgheneti](https://github.com/bgheneti) in [PR #14](https://github.com/cyanheads/obsidian-mcp-server/pull/14). Thanks!

## [2.0.4] - 2025-06-13

### Added

- **Recursive File Listing**: The `obsidian_list_files` tool now supports recursive listing of directories with a `recursionDepth` parameter.

### Changed

- **Documentation**:
  - Consolidated tool specifications into `obsidian_mcp_tools_spec.md`.
  - Updated `.clinerules` with a detailed logger implementation example for the agent.
  - Updated the repository's directory tree documentation.

## [2.0.3] - 2025-06-12

### Fixed

- **NPM Package Display**: Explicitly included `README.md`, `LICENSE`, and `CHANGELOG.md` in the `files` array in `package.json` to ensure they are displayed correctly on the npm package page.

## [2.0.2] - 2025-06-12

### Fixed

- **NPM Package Version**: Bad npm package. Bumping to v2.0.2 for publishing.

## [2.0.1] - 2025-06-12

### Added

- **Enhanced Documentation**:
  - Added a warning to the `VaultCacheService` documentation about its potential for high memory usage on large vaults.
  - Added a code comment in `obsidianManageFrontmatterTool` to clarify the regex-based key deletion strategy.

### Changed

- **Improved SSL Handling**: The `OBSIDIAN_VERIFY_SSL` environment variable is now correctly parsed as a boolean, ensuring more reliable SSL verification behavior.
- **API Service Refactoring**: Simplified the `httpsAgent` handling within the `ObsidianRestApiService` to improve code clarity and remove redundant agent creation on each request.

### Fixed

- **Path Import Correction**: Corrected a path import in the `obsidianGlobalSearchTool` to use `node:path/posix` for better cross-platform compatibility.

## [2.0.0] - 2025-06-12

Version 2.0.0 is a complete overhaul of the Obsidian MCP Server, migrating it to my [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template). This release introduces a more robust architecture, a streamlined toolset, enhanced security, and significant performance improvements. It is a breaking change from the 1.x series.

### Added

- **New Core Architecture**: The server is now built on the [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template), providing a standardized, modular, and maintainable structure.
- **Hono HTTP Transport**: The HTTP transport has been migrated from Express to Hono, offering a more lightweight and performant server.
- **Vault Cache Service**: A new in-memory `VaultCacheService` has been introduced. It caches vault content to improve performance for search operations and provides a resilient fallback if the Obsidian API is temporarily unavailable. It also refreshes periodically.
- **Advanced Authentication**:
  - Added support for **OAuth 2.1** bearer token validation alongside the existing secret key-based JWTs.
  - Introduced `authContext` using `AsyncLocalStorage` for secure, request-scoped access to authentication details.
- **New Tools**:
  - `obsidian_delete_file`: A new tool to permanently delete files from the vault.
  - `obsidian_search_replace`: A powerful new tool to perform search and replace operations with regex support.
- **Enhanced Utilities**:
  - **Request Context**: A robust request context system (`requestContextService`) for improved logging and tracing.
  - **Error Handling**: A centralized `ErrorHandler` for consistent and detailed error reporting.
  - **Async Utilities**: A `retryWithDelay` utility is now used across the application to make API calls more resilient.
- **New Development Scripts**: Added `docs:generate` (for TypeDoc) and `inspect:stdio`/`inspect:http` (for MCP Inspector) to `package.json`.

### Changed

- **Project Structure**: The entire project has been reorganized to align with the [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template), improving separation of concerns (e.g., `services`, `mcp-server`, `types-global`).
- **Tool Consolidation and Enhancement**: The toolset has been redesigned for clarity and power:
  - `obsidian_list_files` replaces `obsidian_list_files_in_vault` and `obsidian_list_files_in_dir`, offering more flexible filtering.
  - `obsidian_read_file` replaces `obsidian_get_file_contents` and now supports returning content as structured JSON.
  - `obsidian_update_file` replaces `obsidian_append_content` and `obsidian_update_content` with explicit modes (`append`, `prepend`, `overwrite`).
  - `obsidian_global_search` replaces `obsidian_find_in_file` with added support for path/date filtering and pagination.
  - `obsidian_manage_frontmatter` replaces `obsidian_get_properties` and `obsidian_update_properties` with atomic get/set/delete operations.
  - `obsidian_manage_tags` replaces `obsidian_get_tags` and now manages both frontmatter and inline tags.
- **Configuration Overhaul**: Environment variables have been renamed for consistency and clarity.
  - `OBSIDIAN_BASE_URL` now consolidates protocol, host, and port.
  - New variables like `MCP_TRANSPORT_TYPE`, `MCP_LOG_LEVEL`, and `MCP_AUTH_SECRET_KEY` have been introduced.
- **Dependency Updates**: All dependencies, including the MCP SDK, have been updated to their latest stable versions.
- **Obsidian API Service**: The `ObsidianRestApiService` has been completely refactored into a modular class, providing a typed, resilient, and centralized client for all interactions with the Obsidian Local REST API.

### Removed

- **Removed Tools**: The following tools from version 1.x have been removed and their functionality integrated into the new, more comprehensive tools:
  - `obsidian_list_files_in_vault`
  - `obsidian_list_files_in_dir`
  - `obsidian_get_file_contents`
  - `obsidian_append_content`
  - `obsidian_update_content`
  - `obsidian_find_in_file`
  - `obsidian_complex_search` (path-based searching is now a filter in `obsidian_global_search`)
  - `obsidian_get_tags`
  - `obsidian_get_properties`
  - `obsidian_update_properties`
- **Removed Resources**: The `obsidian://tags` resource has been removed. Tag information is now available through the `obsidian_manage_tags` tool. I may add the resource back in the future if there is demand for it. Please open an issue if you would like to see it return.
- **Old Configuration**: All old, non-prefixed environment variables (e.g., `VERIFY_SSL`, `REQUEST_TIMEOUT`) have been removed in favor of the new, standardized configuration schema.
