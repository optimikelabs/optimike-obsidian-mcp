# Optimike Kairélys / Operon Bridge

Obsidian companion plugin exposing Kairélys or Operon's live task engine through the extension API of Obsidian Local REST API.

Reads use the loaded engine's in-memory V8 index. Mutations are advertised only when the loaded plugin exposes versioned `OperonPublicApiV1` and the operator enables them in Bridge settings. No Markdown/private-method fallback exists.

The Bridge accepts exactly one loaded task engine:

- Kairélys (`kairelys`), the temporary Optimike fork;
- official Operon (`operon`), for upstream convergence and rollback.

If both plugins are enabled, the Bridge refuses to choose an owner. Disable one before reading or mutating tasks.

## Requirements

- Obsidian Desktop
- Operon `2.4.0` or `2.5.0` for reads
- Kairélys `2.5.1` through `2.5.3` (based on Operon `2.5.0`) and Kairélys `2.6.1` through `2.6.3`
  (based on Operon `2.6.0`) with Public API v1 for mutations
- Obsidian Local REST API

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

All routes inherit Local REST API authentication and local TLS settings. Saved filters run through Operon's native filter evaluator. Mutations require idempotency; an idempotency key is bound to one canonical request and conflicting reuse is rejected. Existing-task mutations require the live revision; in-place adoption instead requires an exact one-based line plus `expectedLine`. Dry-run is the default.

Mutation paths are strict, exact vault-relative paths. The MCP and Bridge reject leading or trailing whitespace, backslashes, absolute paths, empty segments, traversal, and non-Markdown `targetPath` values; they never trim or rewrite an invalid destination into a valid one.

Mutation apply is disabled by default. Enable **Allow task mutations** in the plugin settings only after the live validation recipe passes. The MCP runtime has a separate `OPERON_MUTATIONS_ENABLED` opt-in.

## Build

```bash
npm ci
npm run check
```

CI publishes `optimike-operon-bridge` containing `main.js` and `manifest.json`. Install only in a disposable validation vault until the manual recipe in `docs/operon-local-validation.md` passes and production activation is explicitly approved.
