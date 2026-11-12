# Optimike Obsidian MCP

TypeScript MCP server for Obsidian, with stdio/HTTP transports, shared runtime
state and Obsidian plugins under `plugins/`. Read [README](README.md) for the
product, [Operations](OPERATIONS.md) for runtime setup, [Security](SECURITY.md)
for trust boundaries and the [documentation hub](docs/README.md) for contracts.

## Invariants never traded

- No new vault write path without a sealed plan. Preserve governed
  `plan → apply → status → recover`, CAS, idempotency and effect fences; never
  bypass them through a direct/legacy tool or raw Markdown fallback.
- Never report a silent, failed or uncertain write as success. Reconcile the
  same plan through its journal and public status/recovery contract.
- Keep the public tool contract stable: names, schemas, annotations, errors,
  profiles and capability claims must agree with what the runtime can execute.
- The real vault is never test data. Use synthetic fixtures in an isolated test
  vault, with private temporary cache and journal state.

## The three ways to hurt yourself

1. **Killing by name or path.** Several agents and the shared backend use this
   machine. Stop only a process whose PID you recorded when you started it;
   never kill by a process name, path or worktree pattern.
2. **Leaking a secret.** Never print or commit credentials, private vault
   content or local runtime configuration, including in PRs and review reports.
3. **Writing to a real vault.** Check the resolved vault, REST endpoint and
   canary target before a live smoke. Follow the relevant Operations runbook;
   a canary confirmation does not authorize using an ordinary user note.

## Hit every surface

For a tool change, trace the applicable entries below and state in the PR which
apply. The Operon paths are a concrete example, not a requirement to edit every
file for every change.

- MCP registration/schema: `src/mcp-server/tools/`, including
  `operonTools/registration.ts`; service/input/refusal contracts in
  `src/services/operon/`.
- Bridge HTTP route and contract: the relevant `plugins/*/src/main.ts` and
  `contract.ts`; Operon Developer API sessions, exact grants and native payloads
  in `plugins/obsidian-operon-bridge/src/developer-api-adapter.ts`.
- Profiles and tool visibility: `src/mcp-server/toolSurfaceRegistry.ts`,
  `src/mcp-server/toolProfiles.ts`, `evals/tool-catalog.v1.json`.
- Capability claims: `src/services/capabilityManifest.ts`; authorization:
  `src/services/writePolicy.ts` and `src/mcp-server/vaultInstructionsGate.ts`,
  including every exact target of a batch.
- User contracts: `README.md` / `README.fr.md`, `OPERATIONS.md` /
  `OPERATIONS.fr.md`, relevant EN/FR pages under `docs/` and plugin READMEs.
- Surface evidence: relevant `scripts/test-tool-*.mjs`,
  `scripts/test-http-tool-profiles.mjs`, `scripts/test-capability-*.mjs`,
  `scripts/test-vault-instructions*.mjs` and the affected Bridge tests. Protect
  membership and refusals rather than copying total tool counts.

## Model-facing text

Tool descriptions, schemas, results and agent instructions guide model choices.
Read [tool-routing evals](evals/README.md) and [Testing](docs/testing.md) before
changing them. Run `npm run test:tool-routing` for MCP routing changes; it checks
deterministic contracts, not real model behavior. Use the existing corpus and
selection harness for model evidence as described in those pages.

## Verify

[Testing](docs/testing.md) owns the writing and review policy. Extend existing
behavior tests before adding files. For docs, run `npm run test:docs` and
`git diff --check`; code and Bridge checks depend on the changed behavior. There
is no repository-wide `npm test` or changed-files check. The real commands and
heavy suites are listed in the testing policy and `package.json`.

## Roles

- **Orchestrator / pilot:** frames the issue, assigns scope and accepts evidence.
- **Executor:** implements one issue in its own worktree and branch; completes
  commands before handing back and reports limitations honestly.
- **Reviewer:** independent of the author, on another model and in fresh context;
  follows the bounded [review contract](docs/testing.md#review-contract).

## Pull requests

One idea per PR. Use English and a plain conventional title. Explain the problem,
result, applicable surfaces, commands/results and unverified behavior. Keep plans,
progress notes and scratch files outside commits: issues track work; the merged
PR is the implementation record. Preserve paired user docs when their contract
changes; contributor policy does not need a French twin. Do not push to `main`
or merge unless the task explicitly assigns that authority.

## Review guidelines

Hold new and changed tests to [docs/testing.md](docs/testing.md).
Request tests only as that policy allows: name a concrete regression they catch.
Flag low-signal or duplicate tests with the smallest correction; do not demand
tests for constants, labels or literal tool/capability totals.
