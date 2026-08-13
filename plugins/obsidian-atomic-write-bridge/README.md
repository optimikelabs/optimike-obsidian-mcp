# Optimike Atomic Write Bridge

This bundled Obsidian Desktop plugin adds a deliberately narrow Local REST API
extension for governed note writes. It uses Obsidian `Vault.process` so the
SHA-256 precondition and replacement happen inside the same atomic
read-modify-write operation.

## Routes

- `GET /extensions/obsidian-atomic-write-bridge/status`
- `POST /extensions/obsidian-atomic-write-bridge/notes/read`
- `POST /extensions/obsidian-atomic-write-bridge/notes/cas`

Every request body is strict and versioned with `contractVersion: 1`. The CAS
route accepts only an existing Markdown note, its exact lowercase SHA-256, and
the complete next content. A concurrent change returns HTTP `409` and does not
write.

Writes are disabled by default. The operator must explicitly enable **Allow
atomic writes** in this bridge's Obsidian settings. Read and status remain
available while the write gate is closed.

The bridge depends on the public extension API of **Local REST API**. It does
not depend on Operon or on Operon's Developer API grant UI.

## Install from source

```bash
npm ci
npm run check
```

Copy `build/main.js` and `build/manifest.json` to:

```text
<vault>/.obsidian/plugins/obsidian-atomic-write-bridge/
```

Enable Local REST API first, then enable Optimike Atomic Write Bridge.
