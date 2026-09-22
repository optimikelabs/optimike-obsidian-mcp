# Skills over MCP — implementation checkpoint

## Authority
- Branch: `codex/mcp-skills-over-mcp-764a4174`.
- Parent candidate: `764a417421760570887c502825f3862c9b56901a`, dual-stack PR #103.
- Parent exact-HEAD global CI/review remains a dependency; do not promote this child independently or reuse historical P0 Desktop evidence.
- Read current branch refs and PRs before resuming. Never treat this historical parent value as the current candidate.

## Normative qualification
Skills extension `io.modelcontextprotocol/skills`, stable specification at upstream `modelcontextprotocol/ext-skills` commit `0e85d4db8860a305c857f26fdede64f416675b92`, `specification/stable/skills.mdx`; base protocol `2026-07-28`.
Agent Skills format: https://agentskills.io/specification (consulted 2026-09-22).
SDK v2 custom methods/capabilities: https://ts.sdk.modelcontextprotocol.io/v2/advanced/custom-methods.html.

Required wire surface: extension capability plus resources; skills/list and skills/get return complete entries, resultType=complete, ttlMs and cacheScope; resources/read serves individual raw files. Static manifests enumerate every file exactly once, including SKILL.md, with raw-byte SHA-256 and size. Reference limits are 512 files and 16 MiB per skill. DirectoryRead remains unadvertised/unimplemented. Same names in different namespaces are not identity collisions; identical resource URIs are.

## Source and safety decisions
- Explicit publication allowlist tied to existing external-root IDs and relative skill directories, not a disk/vault scan.
- Original files remain authoritative. No corpus copy, hidden rewriting, script execution or local-skill mutation.
- Reuse ExternalRootsService path/capability and opened-file identity checks. A complete skill snapshot must reject an excluded, unreadable, linked or over-limit member rather than silently publish an incomplete manifest.
- Publication is independently opt-in, modern only. Existing tool profiles and tool registry remain unchanged. Publications may select existing profiles, default full; MCP clientInfo never grants access.
- Per-request point-in-time manifests, private cacheScope and ttlMs=0. Later resource reads return current verified bytes, never claim an old digest covers changed bytes. Hosts must verify against their approved manifest and re-fetch/re-approve on change as the extension requires.
- The public task skill currently has numeric/boolean metadata and an out-of-directory profile prerequisite. Only minimal source-format/explicit dependency corrections inside this repo are authorized; local canonical ELYSIA sources remain untouched.

## Cause / impact
1. ExternalRootsService: narrow internal bounded complete-directory snapshot; no new public tools.
2. Skill registry: validate exact frontmatter, canonical URIs, raw manifests, pagination, current resource reads and safe diagnostics.
3. MCP factory / proxy: official public custom-method registration and resource delegation on modern era only; no business mutation adapter changes.
4. Tests/CI: real SDK HTTP/stdio/proxy clients, invalid sources/URIs/races, profile isolation, unchanged legacy catalog and P0 benchmark.

## Resume / gates
Implement and checkpoint one coherent unit at a time: snapshot + tests; registry + tests; protocol serving + tests; CI/docs/canary and review fixes. Start Draft PR immediately. Propagate any late parent fix explicitly.

Current status: QUALIFICATION_RECORDED, implementation NOT_DONE.
Local ELYSIA roots / Desktop / Secure / Pilot2: NOT_RUN (Optimike is unavailable in this resumed surface).
No merge, release or production deployment.
