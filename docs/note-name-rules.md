# Note name rules (valid on every platform)

French version: [note-name-rules.fr.md](note-name-rules.fr.md)

A vault is often opened on several systems (Windows, macOS, iOS, Android) and
synchronized. A name that one system accepts can be refused, silently dropped or
turned into a broken link by another. The MCP therefore applies **one shared
rule** to every name it **creates**: a new note, a move destination, and a file
written by the headless filesystem tools. The rule is `src/services/noteNameRules.ts`
(pure, no dependency; the Atomic Write Bridge bundles the same file).

The rule is applied to **new names only**. Existing notes keep whatever name they
have: they stay readable, editable and movable, and moving one to a valid name is
the repair path.

## The rule in one paragraph

A vault-relative path made of `/`-separated names, ending in `.md` (any extension
for headless `.canvas`/`.base` writes). In every folder or file name: none of
`\ : * ? " < > | # ^ [ ] %%`, no control character, no invisible or no-break space
character (U+00A0, U+202F, zero-width, direction marks, BOM...), no lone surrogate or
noncharacter, Unicode **NFC**, no leading dot, no leading or trailing space, no
trailing dot on a folder, no Windows reserved name (`CON PRN AUX NUL COM0-9 LPT0-9`,
superscript digits included, with or without extension). Each name is at most 255
UTF-8 bytes and the whole path at most 240 characters. A new name must not differ
from an existing sibling only by letter case or Unicode form. Accents, em dashes,
typographic apostrophes, `·`, `€`, `&`, parentheses, emoji and non-Latin scripts are
valid. ZWJ/ZWNJ are accepted only between letters or emoji (emoji sequences,
Persian, Indic scripts).

## Where each constraint comes from

| Constraint | Source of the constraint | What happens if ignored |
|---|---|---|
| `* " \ / < > : \| ?` | Windows reserved characters ([Microsoft Learn: Naming Files, Paths, and Namespaces](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)); Obsidian shows a red tooltip on Windows with exactly this list ([forum: list of all forbidden filename characters](https://forum.obsidian.md/t/list-of-all-forbidden-filename-characters/103977)) | Refused by Windows/Obsidian; on a synced vault the file is skipped or vanishes on the other system ([iOS name vanishes on Windows](https://forum.obsidian.md/t/filew-disappearing-between-platforms-bc-of-unconsistent-forbidden-characters-list/106217); [Android Sync ignores illegal names](https://forum.obsidian.md/t/files-with-invalid-characters-like-do-not-get-synced-on-android/108206)) |
| `\ / :` | macOS, iOS, iPadOS, Linux set in the same Obsidian list; `\ / : * ? < > "` on Android | Refused in Obsidian on those systems |
| `# ^ [ ] \|` | Obsidian link syntax (`[[Note#Heading]]`, `[[Note^block]]`, `[[Note\|alias]]`). The official help states a string with `# \| ^ : %% [[ ]]` "may not work as a link" ([Obsidian Help: Internal links](https://obsidian.md/help/links)) | Accepted by some filesystems and, in practice, by Obsidian when the file is created outside its UI, but the note cannot be reached with a wikilink |
| Leading dot | Hidden files; "Filename must not start with a dot" in the Obsidian list; a dotted file is not indexed and gives no error | The note does not appear in the vault |
| Control characters 0–31 | Windows rule above | Refused |
| Trailing space or dot | "Do not end a file or directory name with a space or a period" (Microsoft Learn) | The Windows shell and user interface do not support it; links to such a name are fragile |
| Reserved names `CON PRN AUX NUL COM1-9 LPT1-9`, `COM¹²³` `LPT¹²³`, also followed by an extension | Microsoft Learn: "NUL.txt and NUL.tar.gz are both equivalent to NUL" | Cannot be created or deleted normally on Windows |
| Unicode NFC | macOS can store names decomposed (NFD); Windows file systems do not normalize ([Microsoft Learn: Maximum Path Length Limitation](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation): names are "an opaque sequence of WCHARs"). Obsidian reports: [NFD names handled as NFC with duplicate lookups](https://forum.obsidian.md/t/incorrect-handling-not-nfc-normalized-file-names/101950), [NFD notes disappearing on macOS in 1.13.5/1.13.6](https://forum.obsidian.md/t/macos-notes-with-nfd-normalized-filenames-disappear-from-file-explorer-and-search-when-edited-regression-in-1-13-5-1-13-6-watcher-existence-check-compares-raw-nfd-event-name-against-nfc-normalized-listing/117189) | Same visible name, two byte sequences: link not found, duplicate pairs, notes vanishing after edit |
| Invisible characters (U+00A0, U+202F, zero-width, bidi marks, BOM) | Valid on every file system but indistinguishable from a normal space or from nothing; a link typed with a normal space does not match | Valid name, broken link |
| 255 bytes per name | Common component limit (`lpMaximumComponentLength` is commonly 255 on Windows; 255 bytes on Linux/Android/APFS); platforms count UTF-16 units or UTF-8 bytes, so accents and emoji weigh more ([forum: title cut at ~252 characters](https://forum.obsidian.md/t/new-file-with-long-title-automatically-removed/111807), [emoji miscounted against the Windows limit](https://forum.obsidian.md/t/emojis-in-the-file-name-are-not-counted-correctly-for-windows-path-length-limits/79248)) | Title silently lost or truncated on save; copy/backup failures |
| 240 characters per path | Windows `MAX_PATH` is 260 including drive, backslash and terminating NUL; the long-path opt-in needs a registry key and an app manifest (Microsoft Learn). 240 leaves room for a vault root of about 19 characters. Obsidian itself accepts longer names, which then fail in sync and backups ([forum: copying titles > 259 characters](https://forum.obsidian.md/t/problems-with-copying-note-titles-259-characters/107769)) | Accepted by desktop Obsidian, rejected later by mobile sync ("illegal characters") or by other tools |
| Case and Unicode-form collisions | Windows and macOS are case-insensitive by default; macOS (APFS) treats canonically equivalent Unicode names as the same file. Linux and many sync backends are case-sensitive ([forum: handle filename casing consistently](https://forum.obsidian.md/t/handle-filename-casing-illegal-characters-consistently-across-os-es/22543), [Sync and case differences](https://forum.obsidian.md/t/sync-does-not-handle-case-differences-in-path-filename-rename-deleting-files-during-sync/47768)) | Two files become one on Windows/macOS: one of them is lost or overwritten during sync |

Statements about APFS normalization and case-insensitivity are general platform
knowledge; the Apple reference page could not be machine-read when this document was
written. The Obsidian lists come from the community-compiled in-app tooltips for
v1.8.10 and may change; the MCP keeps the union of Windows, macOS/iOS/Android and
link-breaking sets so the result is valid whatever the platform.

### Decisions

- **Brackets `[ ]`**: Obsidian's rename tooltip refuses them and wikilinks cannot
  contain them, but existing vaults can hold such notes. They are
  refused **for new names only**; `(Guide)` is proposed instead of `[Guide]`.
- **NFC**: refused with a proposal, never normalized silently, consistent with the
  rule that the MCP verifies and refuses rather than rewrites. Asset import already
  requires NFC.
- **Emoji**: accepted (valid everywhere), but they count for 2 UTF-16 units and 4
  UTF-8 bytes in the length limits.
- **Not enforced**: private-use and unassigned code points, names such as
  `desktop.ini`/`Thumbs.db`/`~$…` that some sync products ignore, the real length of
  the operator's vault root (the 240 budget is fixed), and case differences in
  *folder* segments of a path.

## What a refusal looks like

The public error keeps the P0 privacy contract (closed fields, no submitted path):

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The note path is not a valid name on every platform and in Obsidian. See hint and suggestedPath.",
    "details": {
      "reasonCode": "note_name_forbidden_character",
      "hint": "A colon (:) is not allowed in a name (Windows, macOS, iOS, Android, Obsidian). [segment 2]",
      "suggestedPath": "Projets/Réunion — suite.md",
      "suggestedName": "Réunion — suite.md"
    }
  }
}
```

- `reasonCode` is one of the closed `note_name_*` codes (`invalid_type`, `empty`,
  `empty_segment`, `not_nfc`, `control_character`, `forbidden_character`,
  `link_character`, `invisible_character`, `invalid_unicode`, `leading_dot`,
  `edge_space`, `trailing_dot`, `reserved_name`, `extension`, `segment_too_long`,
  `too_long`, `case_collision`).
- `hint` is a fixed sentence naming the rule or the character, optionally followed by
  `[segment N]` (1 = first folder) and `[U+XXXX]` for invisible characters. The error
  boundary releases only hints this module can generate.
- `suggestedPath` / `suggestedName` are returned to the caller only when they satisfy
  the same rule; they are derived from the caller's own text, so they never go to the
  log sink (a deliberate, documented exception to "no caller-derived string in the
  public envelope", decided for this feature). Nothing is renamed or created: the
  agent resubmits the proposal if it accepts it.

## Proposal (deterministic)

Conforming input is returned unchanged. Otherwise: `\` becomes `/`; `:` becomes
` — ` (a time `12:30` becomes `12-30`); `|` becomes `-`; `"` becomes `'`; `[ ]` become
`( )`; `* ? < > # ^` and `%%` are dropped; control characters and no-break spaces
become a space; invisible characters are dropped; the result is NFC; empty segments,
leading dots and edge spaces are removed; a reserved Windows name gets a `_` suffix
(`CON.md` → `CON_.md`); a missing `.md` is appended. Spaces created next to a
replacement are collapsed; text that was already valid is left alone. No proposal is
made when the result would be empty, or when a name or the path is too long:
shortening a title is the caller's decision.

## Read-only check before writing

`obsidian_validate_format` with `kind: "note_name"` and `filePath` applies the same
rule and returns `{ ok, reasonCode, hint, suggestedPath, suggestedName }`. It reads
nothing and creates nothing; `.md`, `.base` and `.canvas` are accepted. It checks the
form only: case collisions need the directory and are reported by the planning tools.

## Write paths

| Path | Rule applied |
|---|---|
| `obsidian_note_create_plan` / `_apply` (MCP) and Atomic Write Bridge `note-create` | Shared rule at plan (public refusal), at Bridge preflight and apply; case/Unicode-folded sibling refused by the MCP (directory listing) and by the Bridge (real directory) |
| `obsidian_note_move_plan` / `_apply` (MCP) and Bridge `native-note-move` | **Destination** only (source and neighbourhood stay on the legacy structural check); folded sibling refused by the MCP and by the Bridge `absent` check |
| Headless `obsidian_move_note`, `obsidian_admin_filesystem` (batch move), `obsidian_update_note`, `obsidian_manage_canvas`, `bases_*` writes through `VaultFileService` | Shared rule for files that do not exist yet, any extension; folded sibling refused; dry runs apply it too. Backslash paths are now refused (use `/`) |
| Asset import | Its own stricter segment rule already requires NFC and refuses `<>:"/\|?*[]#^`, leading dot, trailing dot/space and reserved names (limit 160 characters). It does not refuse invisible characters |
| Bases Bridge legacy `bases_create` / `bases_upsert_config` | Not covered: independent plugin, disabled by default (`allowLegacyConfigWrites`) |
| External roots (`external_*`) | Out of scope: operator-configured paths outside the vault with their own `EXTERNAL_ROOT_PATH_*` contract |

## Limits

- Folder segments created implicitly by headless writes are validated, but a
  case-different *existing* parent folder is not detected on a case-sensitive
  filesystem.
- `same_or_case_only_path` still refuses case-only renames; an NFD→NFC rename of the
  same note on macOS may be a no-op for the file system.
- The 240-character budget is conservative; a vault on a short root could accept
  more, and Windows with long paths enabled can hold more.
