# Optimike Operon Bridge

Obsidian companion plugin exposing Operon's live task engine through the extension API of Obsidian Local REST API.

Reads use Operon's in-memory V8 index. Mutations are advertised only when the loaded Operon plugin exposes versioned `OperonPublicApiV1`; official Operon remains read-only and no Markdown/private-method fallback exists.

## Requirements

- Obsidian Desktop
- Operon `2.4.0` or `2.5.0` for reads
- Optimike Operon `2.5.0` with Public API v1 for mutations
- Obsidian Local REST API

## Routes

Prefix: `/extensions/optimike-operon-bridge/v1`

- `GET /status`
- `GET /tasks`
- `GET /tasks/:operonId`
- `POST /tasks/query`
- `GET /validate`
- `POST /tasks`
- `POST /tasks/:operonId/update`
- `POST /tasks/:operonId/transition`
- `POST /tasks/:operonId/convert`

All routes inherit Local REST API authentication and local TLS settings. Mutations require idempotency; an idempotency key is bound to one canonical request and conflicting reuse is rejected. Existing-task mutations require the live revision; dry-run is the default.

## Build

```bash
npm ci
npm run check
```

CI publishes `optimike-operon-bridge` containing `main.js` and `manifest.json`. Install only in a disposable validation vault until the manual recipe in `docs/operon-local-validation.md` passes and production activation is explicitly approved.
