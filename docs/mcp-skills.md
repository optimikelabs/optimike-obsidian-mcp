# Skills over MCP — publication contract

This opt-in read-only extension is included in Optimike MCP 3.10.0. Dual-stack and Skills were developed separately in PR #103 and PR #104. A deployed server does not prove that a connected host supports native Skills; observe the host's negotiated protocol and extension calls.

## Authority

- Extension: `io.modelcontextprotocol/skills`.
- Normative revision: [stable Skills specification](https://github.com/modelcontextprotocol/ext-skills/blob/0e85d4db8860a305c857f26fdede64f416675b92/specification/stable/skills.mdx), base MCP `2026-07-28`.
- Format: [Agent Skills](https://agentskills.io/specification), consulted 2026-09-22.
- Binding: [SDK v2 public custom methods](https://ts.sdk.modelcontextprotocol.io/v2/advanced/custom-methods.html).

The format defines the skill. This server only publishes its files. It does not execute scripts, activate skills in a host, grant tool permissions, or decide user consent. A host must support the extension; server support alone does not prove ChatGPT/Secure or another host exposes it.

## Explicit activation

Keep `MCP_PROTOCOL_MODE=legacy` for existing behavior. To serve Skills, set all three values in the selected process:

```text
MCP_PROTOCOL_MODE=dual
MCP_EXTERNAL_ROOTS_FILE=<absolute private roots JSON path>
MCP_SKILLS_CONFIG_FILE=<absolute private publication JSON path>
```

Example external-root configuration (replace the absolute path locally; do not commit private paths):

```json
{"version":1,"roots":[{"id":"local.skills","path":"/absolute/operator-approved/skills","capabilities":["visible","readable"]}]}
```

Independent publication configuration:

```json
{
  "version": 1,
  "pageSize": 5,
  "skills": [
    {"rootId":"local.skills","path":"elysia-consultation-ia","profiles":["full"]},
    {"rootId":"local.skills","path":"elysia-organisation-notes","profiles":["full"],"listed":false}
  ]
}
```

These are examples, not a claim that those local sources have been qualified. Paths are relative to the authorized external root. Every publication is explicit; no disk/vault scan or source copy takes place. `listed:false` suppresses enumeration but permits an exact get/read under the same profile policy; it is not a secrecy boundary.

Existing profiles are unchanged. Publications default to `full`; they can select existing profiles. Profiles control exposure, not a new user-role ACL. HTTP authentication and any existing authorization policies still apply. MCP `clientInfo`, capabilities, `allowed-tools` and skill metadata never grant access. Separate trust domains require appropriate server/auth isolation, not merely a different skill name.

For the stdio proxy, the configured local sources belong to that proxy. Backend Skills are not blindly forwarded. A direct HTTP server uses its own configured sources. Legacy serving never reads the Skills configuration or advertises this extension.

## Wire contract

Modern discovery advertises `resources: {}` and `extensions: {"io.modelcontextprotocol/skills": {}}`. The server implements official `skills/list`, `skills/get` and `resources/read`, not tools with those names. DirectoryRead is not implemented or advertised.

A skill URI is `skill://<root-id>/<relative-directory>/SKILL.md`. Supporting files are individually readable sibling resources. The final directory segment must match frontmatter `name`. A URI is meaningful within its originating server; hosts must not merge same-URI skills from different servers.

Entries contain verbatim JSON-compatible authored frontmatter and the complete file manifest. Each manifest entry includes raw-byte `sha256:<64 lowercase hex>` and byte size. Original BOM/CRLF are retained. Text and binary reads preserve bytes; binary uses base64. No rewritten frontmatter, generated copies or packed skill archive is substituted.

Results use `resultType: complete`, `ttlMs: 0` and `cacheScope: private` on the modern wire. The SDK client view may remove wire discriminator fields, so raw-wire tests and client tests are separate.

## Consistency and publication policy

Each load reads a complete bounded directory with before/after membership and opened-file identity checks. A hidden/sensitive-name, excluded, unreadable, linked or over-limit member invalidates the entire skill. The sole dotfile exception is an exact, case-sensitive `.gitattributes` regular file. It is passive content: never interpreted by Git or executed. Root read capabilities and include/exclude policy still apply; directories or links named `.gitattributes` remain denied. Invalid sources are omitted from listing and refused on direct access; the internal operator audit returns logical URIs and closed reasons. The server never publishes a truncated manifest.

Limits are publication policy, not additional Agent Skills format rules: at most 64 publications, page size 1–10 (default 5), at most 512 files and 16 MiB per skill, and at most 1024 scanned entries. Existing external-root limits can be stricter. Markdown/frontmatter parsing is additionally bounded. Explicit local Markdown links must resolve within the complete skill snapshot. References mentioned as external prerequisites are not fetched or given filesystem authority.

This is a point-in-time manifest, not snapshot-pinned storage. If a file changes between get and read, read returns current verified bytes. The host must compare bytes with the approved digest/size and re-fetch/re-approve a changed manifest. The server never labels new bytes with the old digest. The local canary fails on drift instead of retrying it into a PASS.

All file members are read to establish complete manifests, including when serving one resource. This is intentionally conservative and can be costly for large publications; select small explicit skill directories and keep root limits bounded. No whole-vault performance gain is claimed.

Nested files are supporting content. Publishing or reading an enclosing skill does not approve activation of nested skills. Skill instructions and scripts remain untrusted content until the host applies its approval policy.

## Repository pilot: elysia-task-gouverneur

`profiles/elysia-tasks/skills/elysia-task-gouverneur` contains `SKILL.md` and seven reference modules. Metadata values are strings, including `profile_schema_version: "1"` and `reference_gate: "true"`.

`profiles/elysia-tasks/v1/profile.json` remains the one external machine-readable `elysia.tasks` contract. It is not copied into the skill or included in its manifest. Runtime configuration/status remain separately consulted before task decisions. Expected revision, idempotency, human approval and reference gates are unchanged.

## Repository acceptance

After `npm ci` and `npm run build`, the permanent Windows/Linux gate runs:

```text
node scripts/test-skills-source-snapshot.mjs
node scripts/test-skills-validation.mjs
node scripts/test-skills-registry.mjs
node scripts/test-skills-protocol.mjs
node scripts/test-skills-runtime.mjs
node scripts/test-skills-repo.mjs
node scripts/test-skills-smoke.mjs
```

The child also requires its exact-candidate MCP 2026, Runtime, P0, P6, M4/M5, profile/privacy and packaging regressions. `npm run test:mcp-2026:all` retains both P0 benchmark eras and mutation/no-replay tests. A prior parent PASS is not a child PASS.

Actual ELYSIA sources and Desktop/Pilot2/Secure remain separate local gates. See [the local handoff](mcp-skills-local.md) and [checkpoint](mcp-skills-CHECKPOINT.md).

## Rollback

Unset `MCP_SKILLS_CONFIG_FILE` and restart the selected process to disable Skills without changing source files. Set `MCP_PROTOCOL_MODE=legacy` to also disable modern protocol serving. A full package rollback restores a previously qualified release, not a vault rewind. Drain active work and consult status before any uncertain mutation. Do not delete journals or replay apply as part of rollback.

## Rich skills and narrow root authorization

A skill containing Python/JSON support files can be published as passive resources when the original root explicitly permits every member. Skills never overrides root authorization and never executes support files. Keep the existing Markdown rule and add only reviewed exact paths for the selected skill, for example `selected-skill/.gitattributes`, `selected-skill/tests/validate.py` and `selected-skill/tests/fixtures.json`. Do not open Python/JSON or dotfiles across the whole root. Existing denials for secrets, credentials, keys, `.git`, excluded dependencies, links and incomplete snapshots remain in force. A new or renamed unapproved member causes refusal until explicitly reviewed.
