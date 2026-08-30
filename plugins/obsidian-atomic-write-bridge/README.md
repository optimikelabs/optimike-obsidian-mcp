# Optimike Atomic Write Bridge

This bundled Obsidian Desktop plugin adds a deliberately narrow Local REST API
extension for governed note and JSON Canvas writes. It uses Obsidian `Vault.process` so the
SHA-256 precondition and replacement happen inside the same atomic
read-modify-write operation.

## Routes

- `GET /extensions/obsidian-atomic-write-bridge/status`
- `POST /extensions/obsidian-atomic-write-bridge/notes/read`
- `POST /extensions/obsidian-atomic-write-bridge/notes/cas`
- `POST /extensions/obsidian-atomic-write-bridge/canvas/read`
- `POST /extensions/obsidian-atomic-write-bridge/canvas/cas`

Every request body is strict and versioned with `contractVersion: 1`. The CAS
routes accept only an existing resource of the declared type, the sealed backend binding
fingerprint, its exact lowercase SHA-256, and the complete next content. Canvas
CAS also rejects malformed graphs or edges that reference missing nodes. A
backend or content mismatch returns HTTP `409` before `Vault.process` writes.

Note and Canvas writes have independent gates, both disabled by default. The
operator must explicitly enable the required capability in this bridge's
Obsidian settings. Read and status remain
available while the write gate is closed.

The bridge depends on the public extension API of **Local REST API**. It does
not depend on Operon or on Operon's Developer API grant UI.

Version 0.3.0 adds protection and settlement status contracts for these enabled
plugins:

- [Frontmatter Date Manager](https://github.com/SmetDenis/obsidian-frontmatter-date-manager);
- [Update Time](https://github.com/dsebastien/obsidian-update-time);
- [Update time on edit](https://github.com/beaussan/update-time-on-edit-obsidian).

Version 0.4.0 adds the separate Canvas read/CAS capability and write gate. It
does not make the legacy filesystem Canvas helper durable or governed; the MCP
must still compile a bounded graph intent and seal it before calling CAS.

Version 0.5.0 permanently supervises Local REST registration. Late startup or
a Local REST reload remounts exactly one route generation without restarting
the MCP. The status `lifecycle` field reports registration only and never
changes the independent Note/Frontmatter or Canvas write gates.

The protection contract reports each configured active creation, modification
and last-viewed property. Optimike MCP automatically adds those names to its
structural frontmatter protection; `MCP_PROTECTED_FRONTMATTER_KEYS` remains an
additive fail-closed list for custom fields. Creation must already exist before
planning because a plugin may otherwise insert it after the CAS. Last-viewed is
protected only: opening a note is a user event, so its timestamp is never
treated as part of write settlement.

The settlement contract reports only a supported modification property, the
Obsidian host UTC offset and a bounded observation delay derived from the
plugin's debounce/rate-limit settings. The MCP waits that delay and re-reads the
note after a successful CAS response as well as during uncertain
reconciliation. The Bridge never relaxes CAS and never decides that a changed
note is equivalent. Optimike MCP may accept this metadata only after an effect,
inside the durable attempt window, when the rest of the observed note is
byte-identical to the sealed result.

Configurations with additional managed effects are protection-only and make a
governed write fail closed rather than pretending one timestamp explains the
result. For Frontmatter Date Manager this includes an enabled update counter, a
post-update command or inversion repair. Numeric properties, forced timezones,
unsupported formats and delays beyond four minutes are also not
settlement-compatible. Folder/filter settings and minimum-update thresholds
can suppress an update but do not authorize any additional drift.
Only source-stable plain YAML property names are advertised: Unicode
letters/marks/numbers, `_`, `.`, `-`, and internal spaces, starting with a letter
or `_`. YAML boolean/null words, purely numeric starts, colon, comma, newline,
surrounding whitespace, quoting indicators such as `#`, and names longer than
128 JavaScript string code units are rejected. An active property with such a
name is reported as an unsupported plugin/role configuration (without echoing
the unsafe raw name), and Optimike MCP refuses the governed write before CAS;
it is never silently treated as if the plugin were inactive. The comma boundary also
preserves compatibility with the additive comma-delimited
`MCP_PROTECTED_FRONTMATTER_KEYS` policy.

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
