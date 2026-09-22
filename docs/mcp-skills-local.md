# Local handoff — MCP 2026 and Skills

Repository work is reviewed in PR #103 (dual-stack) and stacked PR #104 (Skills). This document contains only environment-dependent acceptance. It does not authorize production deployment or changes to canonical local skills.

LOCAL_GATE: NOT_RUN until a new receipt is produced against the exact approved candidate. Historical P0 Pilot2 12/12 is not migration certification. A synthetic `test-skills-smoke` PASS is not Desktop proof.

## 1. Select an approved candidate

Read the current PR #104 body, exact head, CI and review. The parent must include PR #103 candidate `832bc9ed040389075d9367111d4087ae295baca9`, or its explicitly requalified replacement. Do not substitute a later unreviewed branch head.

In an isolated clean checkout/worktree:

```powershell
git fetch origin
$candidate = '<full 40-character SHA approved in PR #104>'
git checkout --detach $candidate
if ((git rev-parse HEAD).Trim() -ne $candidate) { throw 'Wrong candidate' }
if (git status --porcelain) { throw 'Dirty worktree' }
npm ci
if ($LASTEXITCODE) { throw 'npm ci failed' }
npm run build
if ($LASTEXITCODE) { throw 'Build failed' }
```

Use a full development install: the operator canary deliberately includes a genuine SDK v1 client. It is not a production CLI requiring a new runtime dependency. No Bridge binary needs to be rebuilt or replaced for these protocol/Skills changes.

## 2. Read-only Skills/roots canary

Open the disposable Pilot2 vault in Obsidian with the existing compatible Bridges. Prepare private JSON configuration outside the repository and vault. Reuse the original authorized root paths; do not copy the ELYSIA skill corpus or modify it to force the test green. Publish only the few intended directories, using the contract in `mcp-skills.md`.

Run in a dedicated PowerShell process so environment changes disappear when it exits. Set the Pilot2 path/name and private config paths yourself; never paste tokens into a PR, command output or receipt.

```powershell
$env:MCP_SMOKE_EXPECTED_SHA = $candidate
$env:MCP_SMOKE_REQUIRE_LIVE = 'true'
$env:MCP_SMOKE_TRANSPORT = 'stdio'
$env:MCP_TOOL_PROFILE = 'full'
$env:MCP_PROTOCOL_MODE = 'dual'
$env:OBSIDIAN_RUNTIME_MODE = 'live'
$env:OBSIDIAN_VAULT = '<absolute Pilot2 vault path>'
$env:MCP_SMOKE_VAULT = $env:OBSIDIAN_VAULT
$env:MCP_EXTERNAL_ROOTS_FILE = '<absolute private external-roots.json>'
$env:MCP_SKILLS_CONFIG_FILE = '<absolute private skills-publications.json>'
$env:MCP_SMOKE_EXPECT_SKILLS = 'skill://local.skills/elysia-consultation-ia/SKILL.md'
$proof = '<absolute private proof directory outside repo and vault>'
# Configure OBSIDIAN_BASE_URL and OBSIDIAN_API_KEY for Pilot2 only,
# using the existing private Local REST settings. Never print the key.
$env:OBSIDIAN_SHARED_CACHE_DB_PATH = Join-Path $proof 'skills-cache.sqlite'
$env:MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH = Join-Path $proof 'skills-notes.sqlite'
$env:MCP_OBSIDIAN_BASE_FORMULA_JOURNAL_PATH = Join-Path $proof 'skills-bases.sqlite'
$env:MCP_OBSIDIAN_CANVAS_JOURNAL_PATH = Join-Path $proof 'skills-canvas.sqlite'
$env:MCP_EXTERNAL_MOVE_JOURNAL_PATH = Join-Path $proof 'skills-external.sqlite'
$env:MCP_SMOKE_OUTPUT = Join-Path $proof ('skills-stdio-' + [guid]::NewGuid() + '.json')
node scripts/smoke-mcp-skills-local.mjs
if ($LASTEXITCODE) { throw 'Skills local canary failed; keep receipt, do not promote' }
```

The canary requires a clean exact-SHA checkout, independently reads configured local sources, then checks real modern/legacy clients, runtime revision/live mode, extension capability, catalog parity, full get/list manifests and every raw file digest/size. It rejects an empty eligible publication set and any explicitly required URI that was refused. Other refused configured skills are recorded as logical URI/reason pairs, not silently repaired.

It compares manifests before/after, verifies the private configuration hashes stayed unchanged, and snapshots Markdown/.base/.canvas source content before/after. That bounded projection excludes `.obsidian`, `.smart-env`, `.trash`, `.git` and `node_modules`; it does not certify plugin caches, binary attachments or concurrent external edits. Limits are 40,000 scanned entries, 20,000 document files, 16 MiB per file and 512 MiB total. A concurrent source edit fails the canary. The script calls no mutation tool and writes only a new, explicitly selected JSON receipt. Candidate startup can create isolated caches/journals in the proof directory.

No persistent settings are changed by this readonly canary, so restoration consists of closing its private process and stopping any separately launched candidate backend. Receipts are created exclusively; choose a new filename for every run.

### HTTP and stdio proxy

Start the same candidate HTTP backend separately, on a dedicated loopback port and Pilot2 configuration. Keep authentication enabled; provision a private test bearer credential. Do not repoint the production backend or tunnel.

For HTTP, select `MCP_SMOKE_TRANSPORT=http`, set `MCP_SMOKE_HTTP_URL` to the existing candidate `/mcp/full` endpoint and `MCP_SMOKE_BEARER_TOKEN` privately; choose a new receipt. Only HTTPS or loopback HTTP is accepted by the canary.

For proxy, select `MCP_SMOKE_TRANSPORT=proxy`, use the same host/port as the candidate backend, set `MCP_PROXY_REQUIRE_EXISTING_BACKEND=true` and `MCP_BACKEND_BEARER_TOKEN` privately; choose a new receipt. The proxy publishes its own configured sources and must not leak unrelated backend sources.

For each real ELYSIA skill to qualify, explicitly include its URI in `MCP_SMOKE_EXPECT_SKILLS`. Test `elysia-humanisation-texte`, `elysia-organisation-notes` and `elysia-consultation-ia` only when actually configured. A rejected original stays unchanged and is reported for a separate authorized source correction. The repository pilot `elysia-task-gouverneur` can instead be published from a root pointing at `profiles/elysia-tasks/skills`.

## 3. Desktop governed mutation/no-replay gate

This is distinct from the read-only Skills canary. Run the existing disposable-vault script for each era, with explicit approval for its bounded Pilot2 mutations. It exercises original graph/Bases/Operon/receipt/loss assertions and restoration. Never run it against production ELYSIA.

```powershell
$env:VNEXT_PILOT_CONFIRM = 'DISPOSABLE_VAULT_ONLY'
$env:VNEXT_PILOT_VAULT = '<absolute disposable Pilot2 vault path>'
$env:VNEXT_PILOT_NAME = '<actual Obsidian vault name containing pilot>'
$env:VNEXT_PROOF_DIR = '<absolute private proof directory>'
$env:MCP_CANARY_PROTOCOL_ERA = 'legacy'
node scripts/smoke-vnext-pilot2.mjs
if ($LASTEXITCODE) { throw 'Legacy Pilot2 failed' }
$env:MCP_CANARY_PROTOCOL_ERA = 'modern'
node scripts/smoke-vnext-pilot2.mjs
if ($LASTEXITCODE) { throw 'Modern Pilot2 failed' }
```

Prerequisites already used by that script: Windows Obsidian CLI, compatible running Bridges/Operon, explicitly enabled insecure Local REST on loopback in the disposable vault, and local Ollama `qwen3-embedding:0.6b`. The canary itself reads the disposable Local REST configuration; do not expose it in the handoff. Verify its final receipts, exactly one create dispatch after loss, settings restoration and fixture cleanup. Preserve a failed receipt and use status; do not replay an uncertain apply.

## 4. Real Secure host

Create/use a separate candidate tunnel profile; preserve the production profile. Run a real host session against the candidate and record the negotiated era and exposed methods. Server-side Skills success is not host support. If the host cannot issue the official extension methods, record `NOT_EXERCISED` for host Skills and retain legacy serving; do not emulate Skills as new tools or weaken the server contract. No automatic tunnel refresh or host reconnection is claimed by this repository smoke.

## Acceptance and promotion

PASS requires new exact-candidate receipts, live Desktop where required, unchanged observed source/config hashes, verified manifests, catalog parity and no replay. Any wrong SHA, denied required skill, digest mismatch, changed projection, missing capability, mutation regression or failed restoration blocks local qualification. A zero process exit alone is insufficient; inspect the JSON fields.

Record `QUALIFIED_LOCAL` only for scopes actually exercised. `CANDIDATE_READY_REPO` is separate. Keep `PROMOTED` unavailable until explicit merge/release/deployment authorization. Promotion order is parent PR #103, then child PR #104 with base/ancestry rechecked and fresh relevant gates; no automatic merge is performed here.
