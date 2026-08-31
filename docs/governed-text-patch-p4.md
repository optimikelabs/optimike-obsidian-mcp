# Governed Markdown body text patches (P4)

Optimike MCP exposes one bounded body-only text patch family for existing
Markdown notes:

```text
obsidian_text_patch_plan → apply → status → recover
```

The family is a projection over the existing durable `obsidian.note.replace`
runtime. It does not create another journal or CAS implementation. Planning
reads the live Atomic Write binding, compiles the complete next note, seals its
before hash and private content, and returns only an opaque receipt.

## Supported intentions

- `append_body`: append non-empty literal text to the Markdown body;
- `prepend_body`: prepend non-empty literal text to the Markdown body;
- `replace_literal`: replace one exact literal occurrence by default;
- `replace_literal` with `occurrence: all` requires the explicit sealed
  `intent: replace_all`.

Operations are ordered and bounded. Regex, active-file targets, file creation,
non-Markdown resources, malformed frontmatter and ambiguous default literal
matches fail before a child plan is created. Frontmatter bytes are preserved.
Real Markdown task lines are protected, while task examples inside fenced code
blocks remain ordinary body text.

## Text representation and task protection

LF, CRLF, and mixed line endings are supported. A bare CR or a UTF-8 BOM is
rejected fail-closed before planning. Public offsets and guarded character
counts use JavaScript UTF-16 code units; byte admission limits use UTF-8
bytes.

Task-shaped examples inside a fenced block are editable only when both the
CommonMark-like scanner and Operon parsing classify that content as fenced.
Any disagreement remains protected, including a blockquote fence ambiguity.

## Concurrency and recovery

Two plans may seal the same before state, but only the first matching Atomic
Write CAS can commit. The other receipt becomes a conflict without overwriting
the winner. After a timeout or lost response, call `status` first and `recover`
only for the same `planRef` and idempotency key. Never create a blind second
patch.

Configured created, modified and viewed property names come from the Atomic
Write Bridge status. P4 inherits the existing modified-time settlement policy:
only one valid configured modified timestamp inside the sealed observation
window can be reconciled; every other body or frontmatter drift remains
fail-closed. Cache data is refreshed after an independently established commit
and is never CAS evidence.

## Direct compatibility tools

When the complete P4 quartet is available, curated live profiles prefer it and
hide `obsidian_update_note` and `obsidian_search_replace`. The explicit `full`
profile and headless fallback modes retain those direct tools. They do not gain
a durable receipt or CAS guarantee.

## Pilot 2 live canary

Run the live canary only against one existing disposable Markdown note in the
open Pilot 2 vault. The command requires the vault name, Local REST API key,
explicit confirmation and the exact 40-character candidate commit:

```powershell
$env:OBSIDIAN_TEXT_PATCH_CANARY_PATH="Canary/modified-time-settlement.md"
$env:OBSIDIAN_TEXT_PATCH_CANARY_VAULT="operon-bridge-pilot-vault-2.5.0"
$env:OBSIDIAN_TEXT_PATCH_CANARY_CONFIRM="I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_PATCHED"
$env:OBSIDIAN_TEXT_PATCH_CANARY_EXPECTED_COMMIT="<exact candidate SHA>"
$env:OBSIDIAN_API_KEY="<Local REST API key>"
$env:MCP_WRITE_MODE="full"
npm run smoke:governed-text-patch-live
```

The canary verifies all four tools, body append/prepend/literal replacement,
one stale-plan conflict, the configured modified-time settlement and a
byte-exact restoration. The property name is discovered from the live Atomic
Write contract; it is never hard-coded. The supported date plugin is disabled
only during a direct CAS restoration fenced by the already attested Atomic
Write backend binding, then re-enabled and checked. Restoration does not create
a new governed plan after removing the dynamic settlement role.

The script prints the exact recovery directory before connecting. Private
backup and journal files live under the operating-system temporary directory.
Runtime logs live under the repository-ignored
`logs/governed-text-patch-live/` boundary required by server configuration.
On success, or on a handled failure before any mutation, those private
directories are removed. If exact restoration or plugin-state restoration
cannot be proved, they are retained and their exact paths are printed. The
redacted JSON evidence is written to the operating-system temporary directory
and its exact path is printed. A lost-response path is covered by deterministic
runtime tests because the live stdio canary exposes no response-loss injector.
