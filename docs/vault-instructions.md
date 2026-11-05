# Vault agent instructions (AGENTS.md)

French version: [vault-instructions.fr.md](vault-instructions.fr.md)

Many vaults keep rules for agents in `AGENTS.md`, at the root and in folders that need local rules. An agent started at the vault root (Codex, Claude Code) reads the root file itself. An agent that sees the vault only through this server (ChatGPT, Claude Desktop, an agent started elsewhere) never receives these files: nothing tells it they exist before it writes.

The server closes that gap without assuming anything about the vault:

- its MCP instructions tell the agent to read the instruction files before writing;
- every write plan and direct write lists the instruction files that apply to its target path, and says which ones the agent has not read in their current version;
- optionally, the write is refused until they are read.

A vault without instruction files sees no difference: no instructions, no extra field, no refusal, in every mode.

## Settings

| Variable | Values | Default | Role |
| --- | --- | --- | --- |
| `MCP_VAULT_INSTRUCTIONS` | `off`, `advise`, `enforce` | `advise` | Mode of this server, or of this client when set on a stdio proxy. |
| `MCP_VAULT_INSTRUCTIONS_MIN` | `off`, `advise`, `enforce` | `off` | Administrative minimum. No client can choose a lower mode. |
| `MCP_VAULT_INSTRUCTIONS_FILES` | 1 to 8 file names, comma-separated | `AGENTS.md` | Instruction file names, for example `AGENTS.md,CLAUDE.md`. Plain names only, no folder. |
| `MCP_VAULT_INSTRUCTIONS_JOURNAL_PATH` | absolute path | machine-local state folder | SQLite journal of plan seals. Never inside a synchronized vault. |

An invalid value stops the server at startup without echoing the value.

### Modes

- `off`: the server behaves exactly as before this feature.
- `advise` (default): server instructions plus a `vaultInstructions` field in the result of every write plan and direct write whose target has instruction files. Nothing is ever refused.
- `enforce`: the same, and a write plan or direct write is refused before the tool runs while an applicable file is unread or changed since it was read. The apply or recover of a plan is refused if the rules changed after the plan was made.

### Choosing the mode per client

The right mode depends on where the agent runs:

| Client | Suggested mode | Why |
| --- | --- | --- |
| Codex or Claude Code started at the vault root | `advise` or `off` | They read the root `AGENTS.md` themselves; `advise` still points to the local files of the target folders. |
| Claude Desktop, ChatGPT, any agent that sees the vault only through MCP | `enforce` | Nothing else makes it read the rules. |

With the usual local setup, each client starts its own stdio proxy and all proxies share one HTTP backend. Set `MCP_VAULT_INSTRUCTIONS` in the environment of each client's proxy: the proxy sends it to the backend on every request (`X-Optimike-Vault-Instructions` header) and never passes it to a backend it starts, so one client in `enforce` does not change the others. A direct HTTP client that sends no header gets the backend's own `MCP_VAULT_INSTRUCTIONS`. Use `MCP_VAULT_INSTRUCTIONS_MIN=enforce` on the backend when no client may write without reading the rules, for example behind a remote tunnel.

## Which files apply to a path

For a target `Projects/Client/Note.md`, the server looks for each configured name in the vault root, `Projects/` and `Projects/Client/`, in that order (folder depth, then the order of `MCP_VAULT_INSTRUCTIONS_FILES`). Every file that exists applies; more local files refine the root rules.

- A move applies the chains of the source and of the destination.
- Batch tools apply the union of the chains of all their target notes.
- `asset_import_plan` uses the configured asset folder (`MCP_ASSET_FOLDER`).
- Operon mutations use the note that holds the task (resolved from `operonId`) and any explicit `targetPath`.
- Read operations of mixed tools (`get`, `list`, `validate`, `validateOnly`) are never checked.

When the target path cannot be known (`targetType: "activeFile"`, periodic Operon task creation, an unknown `operonId`), `advise` lists the root files with `targetResolved: false`, and `enforce` refuses with `vault_instructions_target_unresolved` and the explicit-path form to use instead.

The server never scans the vault: each check probes only the folders on the chains of its targets (deduplicated, at most 4 probes at a time, 2.5 s each). The cost depends on folder depth, not on vault size.

## Read proof

The agent reads an instruction file with `obsidian_read_note`, using the exact path listed. The server then records, for this reader, the SHA-256 of the content it served (line endings normalized), after checking it against the authoritative copy (Local REST API in live mode, the file on disk in headless mode). Search results and semantic snippets never count.

A file edited after the read is reported `changed` and must be read again. The proof only shows that the content was served to this reader, not that the model used it.

The reader is:

- the MCP session on legacy Streamable HTTP (a stdio proxy has one session per process);
- the process for a direct stdio server;
- on session-less (2026-07-28) HTTP, the verified identity plus the proxy's per-process reader context (`X-Optimike-Reader-Context`); without that header, the identity alone, reported as `readerScope: "identity"`: agents sharing one credential then share their reads.

Proofs live in memory (bounded, 24 hours of inactivity) and are lost on restart; the agent then reads the files again.

## Plan seals

When a governed plan is made in `enforce` (or in `advise` when files apply), the server seals the plan's targets and rules (`rulesDigest`) in its own SQLite journal, apart from the operation journals. Its apply or recover recomputes the rules of the sealed targets:

- same rules and current proofs: the tool runs;
- rules changed (`changed`, `added` or `removed` files): `enforce` refuses with `vault_instructions_changed_since_plan`, `advise` runs and reports `changedSincePlan: true`;
- no seal (plan made before this feature, with the mode off, or older than 90 days): `enforce` refuses with `vault_instructions_plan_unsealed`.

A refusal happens before the tool runs, so it never changes the operation state. `status` tools are never checked. Planning again with the same idempotency key and intent returns the same plan and seals it again under the new rules.

## Refusals (`enforce`)

Every refusal is a tool error with `error.details.reasonCode`, a message that says what to do, and a `vaultInstructions` object.

| `reasonCode` | Meaning | What the agent does |
| --- | --- | --- |
| `vault_instructions_unread` | An applicable file is `unread` or `changed`. | Read each listed file with `obsidian_read_note` (see `nextActions`), then call the same tool again with the same arguments. |
| `vault_instructions_changed_since_plan` | The rules changed after the plan. | Call the family's `status` first. Only if the plan is still `planned`: read the `changed` or `added` files, then plan again, reusing the arguments only if the new rules do not change the intent. |
| `vault_instructions_plan_unsealed` | The plan has no seal. | Call `status` first. Only if the plan is still `planned`: read the instruction files, then plan again. |
| `vault_instructions_target_unresolved` | The written path cannot be known. | Use the explicit-path form named in the message. Not retryable as is. |
| `vault_instructions_unavailable` | The instruction files could not be read. | Retry the same call later. Nothing was planned or written. |

Example refusal:

```json
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "This vault has agent instructions that apply to this write. Nothing was planned or written. Read each file listed with state unread or changed using obsidian_read_note, then call obsidian_text_patch_plan again with the same arguments.",
    "details": { "reasonCode": "vault_instructions_unread", "retryable": true }
  },
  "vaultInstructions": {
    "contractVersion": 1,
    "mode": "enforce",
    "readerScope": "session",
    "rulesDigest": "…",
    "complete": false,
    "files": [
      { "path": "AGENTS.md", "sha256": "…", "state": "read" },
      { "path": "Projects/AGENTS.md", "sha256": "…", "state": "unread" }
    ],
    "targets": [{ "path": "Projects/Client/Note.md", "rules": ["AGENTS.md", "Projects/AGENTS.md"] }],
    "nextActions": [{ "tool": "obsidian_read_note", "arguments": { "filePath": "Projects/AGENTS.md" } }]
  }
}
```

## Server instructions

When the mode is not `off` and the vault root has an instruction file, the MCP `instructions` returned at initialization tell the agent to read the root file and those of the parent folders of any path it writes, and, in `enforce`, that writes are refused until then. They point to the files and never include their content. The stdio proxy relays them to its client. The root check is cached for 60 seconds; instructions already received by a client are not updated. If the vault cannot be read when the client connects (Obsidian not started yet), that connection gets no instructions; its write results still carry `vaultInstructions`.

## Limits

- Only writes through this server are checked. An agent that writes the vault files directly, or another plugin, is not.
- The check runs just before the tool. A rule edited between the check and the write is caught by the next write, not by this one.
- `operon_recover_mutation` is not checked: it resumes a mutation that was already admitted, and its paths are not exposed.
- `obsidian_runtime_maintenance` and `obsidian_operation_close` do not write vault content and are not checked.
- A file read under another case or path form (`agents.md`) is not the listed file: read the exact path given.
