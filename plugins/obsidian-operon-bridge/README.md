# Optimike Operon Bridge

Read-only Obsidian companion plugin that exposes Operon's **live in-memory index** through the extension API of Obsidian Local REST API.

## Why read-only

Operon 2.4.0 exposes a useful runtime index (`getAllTasks`, `getTask`, duplicate diagnostics), but no public, versioned mutation API. Operon's complete mutation path also coordinates workflow normalization, reindexing, dependencies, recurrence, aggregate totals, project serials, archiving, auto-unpin, and view refreshes. The bridge therefore refuses to present direct Markdown edits or private method calls as safe Operon mutations.

## Requirements

- Obsidian Desktop
- Operon `2.4.0` exactly. Later releases remain unavailable until their runtime
  contract has passed this Bridge's tests and Desktop recipe.
- Obsidian Local REST API

## Routes

Prefix: `/extensions/optimike-operon-bridge/v1`

- `GET /status`
- `GET /tasks?cursor=0&limit=100&includeProperties=false`
- `GET /tasks/:operonId`
- `POST /tasks/query`
- `GET /validate`

All routes inherit Local REST API authentication and local TLS settings.

## Build

```bash
npm ci
npm run check
```

CI also publishes `optimike-operon-bridge` containing `main.js` and
`manifest.json`. Copy those files to
`.obsidian/plugins/optimike-operon-bridge/` in a disposable validation vault.
Do not install the Bridge into a production vault before the manual recipe in
`docs/operon-local-validation.md` passes.
