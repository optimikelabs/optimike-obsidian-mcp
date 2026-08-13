# Governed atomic note replacement

French version: [governed-note-replacement.fr.md](governed-note-replacement.fr.md)

The 2.6 candidate exposes four domain-specific MCP tools for one existing
Markdown note: `obsidian_note_replace_plan`, `obsidian_note_replace_apply`,
`obsidian_note_replace_status`, and `obsidian_note_replace_recover`.

They are available only with a live Obsidian REST service and the bundled
Atomic Write Bridge. Planning and every possible effect remain subject to the
current MCP write policy, protected-frontmatter rules, backend binding, and the
Bridge write gate.

`planRef` is opaque. Apply accepts only the sealed plan and matching
idempotency key. After an uncertain response, clients read status before using
exact-plan recovery. Recovery reconciles or safely resumes that same plan; it
is not undo and accepts no replacement payload.

The durable journal remains the sole authority for this operation. Non-terminal
sealed content stays machine-local and is redacted when a stable terminal state
is recorded.

The atomic guarantee covers the target-note transition enforced by Obsidian
`Vault.process` compare-and-replace. Sync, watchers, plugins, indexers, and
external automations are outside that recovery boundary.

The deterministic test uses the compiled MCP server and a real stdio client,
mocking only the Obsidian HTTP boundary. A separate fail-closed operator canary
validates the same surface against a disposable live Obsidian vault before
merge or release.

No generic public `operation_*` surface is introduced.
