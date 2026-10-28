# Optimike Atomic Write Bridge

This bundled Obsidian Desktop plugin adds a deliberately narrow Local REST API
extension for governed note and JSON Canvas writes. It uses Obsidian `Vault.process` so the
SHA-256 precondition and replacement happen inside the same atomic
read-modify-write operation.

## Routes

- `GET /extensions/obsidian-atomic-write-bridge/status`
- `POST /extensions/obsidian-atomic-write-bridge/notes/read`
- `POST /extensions/obsidian-atomic-write-bridge/notes/links` (read-only semantic observation)
- `POST /extensions/obsidian-atomic-write-bridge/notes/cas`
- `POST /extensions/obsidian-atomic-write-bridge/canvas/read`
- `POST /extensions/obsidian-atomic-write-bridge/canvas/cas`
- `POST /extensions/obsidian-atomic-write-bridge/effect-fence/resolve`

Every request body is strict and versioned with `contractVersion: 1`. The CAS
routes accept only an existing resource of the declared type, the sealed backend binding
fingerprint, its exact lowercase SHA-256, and the complete next content. Canvas
CAS also rejects malformed graphs or edges that reference missing nodes. A
backend or content mismatch returns HTTP `409` before `Vault.process` writes.

Note and Canvas writes have independent gates, both disabled by default. The
operator must explicitly enable the required capability in this bridge's
Obsidian settings. Read and status remain
available while the write gate is closed.

Effect fence: every write route accepts an optional `fence`
`{ contractVersion: 1, epoch, attemptId }` and admits it synchronously at the
effect point (inside the `Vault.process` callback, immediately before an
exclusive create, a native rename or the FDM preparation leaf). A revoked,
replayed or superseded token is refused with HTTP `403` `effect_fence_refused`
and no effect. `effect-fence/resolve` inspects or irreversibly revokes tokens;
`status.effectFence` exposes the epoch of this plugin load. The setting
**Require a fence token for every write** (off by default) also refuses
unfenced writes; it is required to close attempts dispatched by older MCP
clients. See [Administrative closure](../../docs/administrative-closure.md).

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

Version 0.5.1 permanently supervises Local REST registration and is distributed
through the exact-SHA Optimike Bridge bundle. Late startup or
a Local REST reload remounts exactly one route generation without restarting
the MCP. The status `lifecycle` field reports registration only and never
changes the independent Note/Frontmatter or Canvas write gates.

Version 0.6.0 adds the read-only `notes/links` route. It observes links, embeds, frontmatter links, resolution, subpaths, unresolved aggregates and resolved backlinks through Obsidian Desktop public `MetadataCache` APIs. Responses are bounded and report cache freshness as unknown when the public API cannot prove it. The route never writes or claims graph preservation.

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

## Version 0.9.0 — exclusive Base and Canvas creation

Two independent settings, false by default: `allowBaseCreates` and `allowCanvasCreates`. POST `/extensions/obsidian-atomic-write-bridge/base-create/preflight`, `/apply`, `/inspect` and the same three routes under `canvas-create` are used by the MCP families `bases_create_*` and `obsidian_canvas_create_*`. They reuse the exclusive create of notes (`O_CREAT | O_EXCL`, data fsync, existing parent only, never overwrite or suffix) with the `.base` or `.canvas` extension, a binding fingerprint per kind, the effect fence and no date policy. Before the effect the Bridge parses the content again: YAML mapping (Obsidian `parseYaml`) for a Base, JSON object with `nodes` and `edges` arrays for a Canvas. A missing parent answers `404 file_create_parent_missing`. The status reports `baseCreate` and `canvasCreate`. See [governed Base and Canvas creation](../../docs/governed-file-create.md).

## Version 0.8.0 — exclusive note creation

The independent `allowNoteCreates` setting is false by default. POST `/extensions/obsidian-atomic-write-bridge/note-create/preflight`, `/apply`, and `/inspect` are used by the MCP durable create family. Only apply can create an absent explicit Markdown file. Data is fsynced without overwrite or suffixing; indexing is eventual via the vault watcher. Partial/crashed writes are not automatically repaired or removed. Qualified automatic date fields reuse the existing strict settlement contract. Real Desktop/Pilot2 qualification is mandatory before deployment.
