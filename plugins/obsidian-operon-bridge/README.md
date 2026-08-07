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
- Operon `3.1.1` for Developer API V1 reads and governed mutations (`3.0.1` and `3.1.0` remain explicitly allowlisted)
- Kairélys `2.5.1` through `2.5.3` (based on Operon `2.5.0`) and Kairélys `2.6.1` through `2.6.3`
  (based on Operon `2.6.0`) with Public API v1 for mutations
- Obsidian Local REST API

Operon `3.1.1` uses the official Developer API V1 for live reads, previews, applies, and durable recovery. Its inline task-update settlement path has been revalidated with modified-time frontmatter writes that occur during apply on the patched local acceptance build. No Markdown/private-API fallback is used. `adopt`, unmanaged properties, and arbitrary `targetFolder` destinations remain unsupported on this path and are rejected explicitly.

Stock `3.1.1` remains the supported target for reads and most governed
mutations, but the full acceptance evidence is currently carried by that local
build while upstream fixes are reviewed in [#135](https://github.com/hasanyilmaz/operon/pull/135),
[#137](https://github.com/hasanyilmaz/operon/pull/137), and
[#139](https://github.com/hasanyilmaz/operon/pull/139). The known transition
settlement issue is tracked in [#99](https://github.com/hasanyilmaz/operon/issues/99)
and [#101](https://github.com/hasanyilmaz/operon/pull/101). Uncertain outcomes
remain fail-closed; the Bridge never retries blindly or falls back to Markdown
or private APIs.

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
- `GET /mutations/pending-recoveries`
- `POST /mutations/recover`

All routes inherit Local REST API authentication and local TLS settings. Saved filters run through Operon's native filter evaluator. Mutations require idempotency; an idempotency key is bound to one canonical request and conflicting reuse is rejected before later payload validation. Existing-task mutations require the live revision; in-place adoption instead requires an exact one-based line plus `expectedLine`. Dry-run is the default.

Mutation paths are strict, exact vault-relative paths. The MCP and Bridge reject leading or trailing whitespace, backslashes, absolute paths, empty segments, traversal, and non-Markdown `targetPath` values; they never trim or rewrite an invalid destination into a valid one.

Mutation apply is disabled by default. Operon 3.1.1 mutation routes are advertised only when the Bridge setting is enabled, the official grant exposes the matching preview/apply capabilities, and the MCP runtime has the separate `OPERON_MUTATIONS_ENABLED` opt-in.

## Build

```bash
npm ci
npm run check
```

CI publishes `optimike-operon-bridge` containing `main.js` and `manifest.json`. Install only in a disposable validation vault until the manual recipe in `docs/operon-local-validation.md` passes and production activation is explicitly approved.

The CLI/Developer API comparison and the intentionally limited MCP extension
plan live in `docs/operon-cli-audit.md`.
