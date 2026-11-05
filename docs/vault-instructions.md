# Vault agent instructions (AGENTS.md)

French version: [vault-instructions.fr.md](vault-instructions.fr.md)

Many vaults keep rules for agents in `AGENTS.md`, at the root and in folders that need local rules. An agent started at the vault root (Codex, Claude Code) reads the root file itself. An agent that sees the vault only through this server (ChatGPT, Claude Desktop, an agent started elsewhere) never receives these files: nothing tells it they exist before it writes.

The server closes that gap without assuming anything about the vault:

- its MCP instructions tell the agent to read the instruction files before writing;
- every write plan and direct write lists the instruction files that apply to the paths it writes, and says which ones the agent has not read in their current version;
- optionally (`enforce`), the write is refused until the agent has been served each of them.

What the server proves is that the agent received the applicable instructions, in their current version, before it wrote. It does not prove that the model follows them, nor that a person agreed to the write.

## Settings

| Variable | Values | Default | Role |
| --- | --- | --- | --- |
| `MCP_VAULT_INSTRUCTIONS` | `off`, `advise`, `enforce` | `advise` | Mode of this server, or of this client when set on a stdio proxy. |
| `MCP_VAULT_INSTRUCTIONS_MIN` | `off`, `advise`, `enforce` | `off` | Administrative minimum. No client can choose a lower mode. |
| `MCP_VAULT_INSTRUCTIONS_FILES` | 1 to 8 file names, comma-separated | `AGENTS.md` | Instruction file names, for example `AGENTS.md,CLAUDE.md`. Plain names only, no folder. |
| `MCP_VAULT_INSTRUCTIONS_JOURNAL_PATH` | absolute path | machine-local state folder | SQLite journal of plan seals. Give an absolute path outside any synchronized vault: the server does not check this for you. |

An invalid value stops the server at startup without echoing the value.

### Modes

- `off`: the server behaves exactly as before this feature.
- `advise` (default): server instructions plus a `vaultInstructions` field in the result of every write plan and direct write whose targets have instruction files. Nothing is refused because of instructions.
- `enforce`: the same, and a write plan or direct write is refused before the tool runs while an applicable file is unread or changed since it was read. The apply or recover of a plan is refused if the rules changed after the plan was made. `enforce` also refuses, cautiously, writes whose target it cannot determine, even in a vault without instruction files (see below).

### Choosing the mode per client

The right mode depends on where the agent runs:

| Client | Suggested mode | Why |
| --- | --- | --- |
| Codex or Claude Code started at the vault root | `advise` or `off` | They read the root `AGENTS.md` themselves; `advise` still points to the local files of the target folders. |
| Claude Desktop, ChatGPT, any agent that sees the vault only through MCP | `enforce` | Nothing else makes it read the rules. |

With the usual local setup, each client starts its own stdio proxy and all proxies share one HTTP backend. Set `MCP_VAULT_INSTRUCTIONS` in the environment of each client's proxy: the proxy sends it to the backend on every request (`X-Optimike-Vault-Instructions` header) and never passes it to a backend it starts, so one client in `enforce` does not change the others. A direct HTTP client that sends no header gets the backend's own `MCP_VAULT_INSTRUCTIONS`. `MCP_VAULT_INSTRUCTIONS_MIN=enforce` applies to every client of that backend, local proxies included: to keep `advise` or `off` for local clients while a remote tunnel is in `enforce`, give the tunnel its own backend.

## What changes in a vault without instruction files

- `off`: nothing.
- `advise`: results are unchanged, but each gated write now probes the folders of its target chain (and, for Operon mutations, resolves the task note or the file-task folder first). When a probe fails, the result carries `vaultInstructions` with `verified: false`. Plans are sealed in the journal, so they remain applicable if the client later moves to `enforce`.
- `enforce`: results of writes with a known target are unchanged. These are refused even without any instruction file:
  - a write whose target cannot be determined (`vault_instructions_target_unresolved`, see the next section);
  - any plan or apply while the seal journal cannot be opened (`vault_instructions_unavailable`, `unavailableReason: "seal_journal"`);
  - the apply of a plan made while the client was `off` (`vault_instructions_plan_unsealed`);
  - a write whose instruction files cannot be read right now (`vault_instructions_unavailable`).

## Which files apply to a write

For a target `Projects/Client/Note.md`, the server looks for each configured name in the vault root, `Projects/` and `Projects/Client/`, in that order (folder depth, then the order of `MCP_VAULT_INSTRUCTIONS_FILES`). Every file that exists applies; more local files refine the root rules.

The targets are the paths the backend really writes:

- A path is kept exactly as written; no Unicode normalisation. When its composed (NFC) and decomposed (NFD) spellings differ, the chains of every spelling are checked, because a backend or a file system may resolve either one. On a file system that keeps both as distinct folders, both sets of files apply.
- A move applies the chains of the source and of the destination. A native move plan (`obsidian_note_move_plan`) also applies the chains of every note whose links it rewrites (`affectedPaths` of its sealed neighbourhood); they are part of the plan seal. If those notes cannot be determined, `enforce` refuses the plan.
- Batch tools apply the union of the chains of all their target notes.
- `asset_import_plan` uses the configured asset folder (`MCP_ASSET_FOLDER`).
- Operon mutations use the note that holds the task (resolved from `operonId`) and their destination: `targetPath` for inline tasks, conversions to inline and relocations; for a file-task creation or an inline-to-file conversion, `targetFolder` on a legacy engine, otherwise the file-task folder of the live Operon configuration (`creation.fileTasksFolder`, read by a preflight that writes nothing), plus the folder of the parent task note when a `parentTask` is given. Without a configured folder, Operon routes the file by its parent: the parent's folder alone is checked.
- Read-only operations of mixed tools are never checked: `get`, `list`, `index`, `audit`, `validate`, `validateOnly`, and a tag `rename` preview (`dryRun` true, the default). A real tag `rename` writes notes known only when it runs, so `enforce` refuses it as unresolved.

When the target path cannot be known (`targetType: "activeFile"`, periodic Operon task creation, an inline Operon task without `targetPath`, a file task when Operon has neither a configured file-task folder nor a parent task, an unknown `operonId`, a vault-wide tag rename), `advise` lists the root files with `targetResolved: false`, and `enforce` refuses with `vault_instructions_target_unresolved` and a message that says what to do instead.

### Bounds

The server never scans the vault: each check probes only the folders on the chains of its targets. Every probe is bounded, and the bounds are enforced, not only advertised:

| Bound | Value |
| --- | --- |
| One instruction file | 256 KiB; never read beyond that |
| All files of one check | 1 MiB |
| One probe | 2.5 s |
| One check, queueing included | 5 s |
| Probes in flight for one check | 4 |
| Probes in flight for the whole backend process | 8 |
| Operon resolutions before the probes | 5 s each |

At a deadline, the probes still running are cancelled (the Local REST request is aborted, the disk read stops); the server stops waiting for an Operon resolution after 5 s, while the Operon request itself ends on its own timeout. A file over a byte bound makes the check unavailable with `unavailableReason: "too_large"` (`enforce` refuses, not retryable as is: shorten the file or split it between folders).

## Read proof

The agent reads an instruction file with `obsidian_read_note`, using the exact path listed. The server then records, for this reader, the SHA-256 of the content it served (line endings normalized), after checking it against the authoritative copy (Local REST API in live mode, read as raw text whatever its content type; the file on disk in headless mode). Search results and semantic snippets never count.

A file edited after the read is reported `changed` and must be read again. The proof only shows that the content was served to this reader.

The reader is:

- the MCP session on legacy Streamable HTTP (a stdio proxy has one session per process);
- the process for a direct stdio server;
- on session-less (2026-07-28) HTTP, the verified identity plus the proxy's per-process reader context (`X-Optimike-Reader-Context`); without that header, the identity alone, reported as `readerScope: "identity"`: agents sharing one credential then share their reads.

Proofs live in memory (bounded, 24 hours of inactivity) and are lost on restart; the agent then reads the files again.

## Trust boundary

An instruction file is vault content served to the agent as is. The server neither runs nor interprets it, and a local rule gains no authority over the instructions of the user or of the host. Whoever can write an `AGENTS.md` in the vault can put text in front of every agent that writes under it, as with any note: treat instruction files like the rest of the vault content.

In headless mode, an instruction file that is a symbolic link, or that resolves outside the vault (through a junction, for instance), counts as absent: rules centralized through a symlink are not served. Copy the file instead. In live mode, Local REST API decides how links are resolved; that behaviour has not been qualified.

## Plan seals

When a governed plan with a known target is made in `advise` or `enforce`, the server seals the plan's targets and rules (`rulesDigest`) in its own SQLite journal, apart from the operation journals, and reports `sealed: true` only once the seal is written. Its apply or recover recomputes the rules of the sealed targets:

- same rules and current proofs: the tool runs;
- rules changed (`changed`, `added` or `removed` files): `enforce` refuses with `vault_instructions_changed_since_plan`, `advise` runs and reports `changedSincePlan: true`;
- no seal (plan made before this feature, with the mode off, whose seal could not be written, or older than 90 days): `enforce` refuses with `vault_instructions_plan_unsealed`.

When the journal cannot be opened, `enforce` refuses the plan itself before it runs (a plan it could never apply); when a seal write fails after the plan, the result says `sealed: false` and that its apply will be refused. `advise` reports `sealed: false` and refuses nothing.

A refusal of an apply happens before the tool runs, so it never changes the operation state. `status` tools are never checked. Planning again with the same idempotency key and intent returns the same plan and seals it again under the new rules. The seal is not a signature: a local administrator who can edit the journal is outside this model.

## Refusals (`enforce`)

Every refusal is a tool error with `error.details.reasonCode`, a message that says what to do, and a `vaultInstructions` object.

| `reasonCode` | Meaning | What the agent does |
| --- | --- | --- |
| `vault_instructions_unread` | An applicable file is `unread` or `changed`. | Read each listed file with `obsidian_read_note` (see `nextActions`), then call the same tool again with the same arguments. For a native move whose rewritten notes have unread rules, the plan was recorded but not sealed: read, then plan again with the same idempotency key. |
| `vault_instructions_changed_since_plan` | The rules changed after the plan. | Call the family's `status` first. Only if the plan is still `planned`: read the `changed` or `added` files, then plan again, reusing the arguments only if the new rules do not change the intent. |
| `vault_instructions_plan_unsealed` | The plan has no seal. | Call `status` first. Only if the plan is still `planned`: read the instruction files, then plan again. |
| `vault_instructions_target_unresolved` | The written path cannot be known. | Follow the message (explicit-path form, configuration to set). Not retryable as is. |
| `vault_instructions_unavailable` | The instruction files, the Operon destination or the seal journal could not be read (`unavailableReason`: `timeout`, `source_error`, `invalid_response`, `too_large`, `seal_journal`). | Nothing was planned or written. Retry later, except `too_large` and `seal_journal`, which need the vault owner. |

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
- Notes that Operon writes on its own after a mutation (automatic archiving, cascades to parent or child tasks, recurrence copies) are not checked.
- For a file task with a parent, the configured folder (when there is one) and the parent's folder are checked; a deeper layout Operon may choose for child tasks is not known to the server.
- Under `enforce`, periodic Operon task creation is refused: Operon does not expose the periodic note path before creating the task. Lower the mode for that client to create periodic tasks.
- `obsidian_runtime_maintenance` and `obsidian_operation_close` do not write vault content and are not checked.
- A file read under another case (`agents.md`) is not the listed file: read the exact path given.
