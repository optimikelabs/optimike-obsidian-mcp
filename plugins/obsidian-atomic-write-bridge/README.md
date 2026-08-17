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
route accepts only an existing Markdown note, the sealed backend binding
fingerprint, its exact lowercase SHA-256, and the complete next content. A
backend or content mismatch returns HTTP `409` before `Vault.process` writes.

Writes are disabled by default. The operator must explicitly enable **Allow
atomic writes** in this bridge's Obsidian settings. Read and status remain
available while the write gate is closed.

The bridge depends on the public extension API of **Local REST API**. It does
not depend on Operon or on Operon's Developer API grant UI.

Version 0.2.0 adds an optional status-only settlement contract. When one of the
following enabled plugins exposes a supported string-datetime configuration,
the status route reports its exact modified-time property and the Obsidian host
UTC offset:

- Frontmatter Date Manager;
- Update Time;
- Update time on edit.

The Bridge never relaxes CAS and never decides that a changed note is
equivalent. Optimike MCP may use this metadata only after an effect, within a
bounded attempt window, and only when the configured property is protected and
the rest of the observed note is byte-identical to the sealed result.
Property names containing a colon, comma, newline, surrounding whitespace, or
more than 128 characters are not advertised. The comma boundary is required
because `MCP_PROTECTED_FRONTMATTER_KEYS` is a comma-delimited fail-closed list.

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
