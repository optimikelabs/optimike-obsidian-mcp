# Optimike Kairélys / Operon Bridge

Obsidian companion plugin exposing Kairélys or Operon's live task engine through the extension API of Obsidian Local REST API.

Reads use the loaded engine's in-memory V8 index. Official Operon 3.x reads and typed mutations go through its host-verified Developer API V1; they do not inspect private index/settings fields. Mutations are advertised only when the loaded plugin exposes the supported preview/apply contract and the operator enables them in Bridge settings. No Markdown/private-method fallback exists.

The Bridge accepts exactly one loaded task engine:

- Kairélys (`kairelys`), the temporary Optimike fork;
- official Operon (`operon`), for upstream convergence and rollback.

If both plugins are enabled, the Bridge refuses to choose an owner. Disable one before reading or mutating tasks.

## Requirements

- Obsidian Desktop
- Operon `2.4.0` or `2.5.0` for legacy reads
- Operon exposing the negotiated Developer API V1 contract (`contractVersion: 1`, `runtimeApi: 1`)
- certified Developer API releases: `3.0.1`, `3.1.0`, `3.1.1`, `3.2.0`, and `3.2.1`; later compatible releases are admitted provisionally by contract rather than product-version allowlist
- Kairélys `2.5.1` through `2.5.3` (based on Operon `2.5.0`) and Kairélys `2.6.1` through `2.6.3`
  (based on Operon `2.6.0`) with Public API v1 for mutations
- Obsidian Local REST API

Operon `3.2.0` and `3.2.1` use the official Developer API V1 for live reads, previews,
applies, durable recovery, and the additive `tasks.filter-query` capability.
Saved-filter execution requires an exact grant and exact `filterSetId`; the
official API does not expose the saved-filter catalog. Adoption, unmanaged
properties, and arbitrary `targetFolder` destinations remain unsupported and
are rejected explicitly. The complete live pilot used the local 3.2.0 build.
Operon `3.3.0` is admitted as `compatible-provisional` because the non-denied
version exposes the Developer API V1 accessor. Its complete live pilot passed
the separate developer-API, schema, index, capability, and readiness gates;
Bridge `0.7.0` deliberately preserves the contract-first provisional path
instead of making a product-version allowlist authoritative again.
The Settings UI fix is tracked in upstream
[#145](https://github.com/hasanyilmaz/operon/issues/145) and
[#146](https://github.com/hasanyilmaz/operon/pull/146). Uncertain outcomes remain fail-closed;
the Bridge never retries blindly or falls back to Markdown/private APIs. File
Task rename safety remains tracked in [#139](https://github.com/hasanyilmaz/operon/pull/139),
and the transition edge in [#99](https://github.com/hasanyilmaz/operon/issues/99)
and [#101](https://github.com/hasanyilmaz/operon/pull/101).

Compatibility is reported explicitly:

- `certified`: the product version belongs to the Bridge's explicit certified
  set and its Developer API boundary is admitted;
- `compatible-provisional`: the product version is outside that set but is not
  denied and its Developer API V1 boundary is admitted;
- `incompatible`: the contract boundary is absent, denied, or fails validation.

Compatibility is admission, not live readiness. Check top-level `ok`,
`index.ready`, and the advertised `capabilities` before using a route; an
admitted runtime can still be temporarily unready while its index settles or
recovers.

The product version remains diagnostic metadata and may select a narrowly
documented denylist entry. It is not the primary admission key for Operon 3.x.
An unavailable optional capability removes only the dependent route; it does
not tear down already verified core reads or mutations.

## Routes

Prefix: `/extensions/optimike-operon-bridge/v1`

- `GET /status`
- `GET /tasks`
- `GET /tasks/:operonId`
- `POST /tasks/query`
- `POST /tasks/filter`
- `GET /validate`
- `POST /tasks/adopt`
- `POST /tasks`
- `POST /tasks/:operonId/update`
- `POST /tasks/:operonId/transition`
- `POST /tasks/:operonId/convert`
- `POST /tasks/:operonId/relocate`
- `POST /tasks/:operonId/relationships`
- `POST /tasks/:operonId/recurrence`
- `GET /mutations/pending-recoveries`
- `POST /mutations/recover`

All routes inherit Local REST API authentication and local TLS settings. Saved filters run through Operon's native filter evaluator with an exact caller-supplied `filterSetId`; the official 3.2 API does not list saved filters. Mutations require idempotency; an idempotency key is bound to one canonical request and conflicting reuse is rejected before later payload validation. Existing-task mutations require the live revision; in-place adoption instead requires an exact one-based line plus `expectedLine` on engines that advertise it. Dry-run is the default.

Mutation paths are strict, exact vault-relative paths. The MCP and Bridge reject leading or trailing whitespace, backslashes, absolute paths, empty segments, traversal, and non-Markdown `targetPath` values; they never trim or rewrite an invalid destination into a valid one.

Mutation apply is disabled by default. Operon 3.2.x mutation routes are advertised only when the Bridge setting is enabled, the official grant exposes the matching preview/apply capabilities, and the MCP runtime has the separate `OPERON_MUTATIONS_ENABLED` opt-in. Relationship apply rereads the source and inverse dependency edges; recurrence uses the official scoped recurrence plan and never passes through the generic update route.

## Build

```bash
npm ci
npm run check
```

CI publishes `optimike-operon-bridge` containing `main.js` and `manifest.json`. Install only in a disposable validation vault until the manual recipe in `docs/operon-local-validation.md` passes and production activation is explicitly approved.

The CLI/Developer API comparison and the intentionally limited MCP extension
plan live in `docs/operon-cli-audit.md`.
