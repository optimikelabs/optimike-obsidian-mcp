# Testing policy

This policy governs writing tests and requesting them in review. [AGENTS.md](../AGENTS.md)
routes agents here. Apply it to new and touched tests; do not rewrite the existing
suite en masse. Replace literal tool/capability count assertions when they break
or their file is touched, preserving the behavior they were meant to protect.

## Seven rules

1. **Name the behavior.** Test business rules, permissions and write policy,
   governed mutation contracts, Bridge/MCP adapter contracts, migrations, races
   and the logic a bug fix changed. State what observable failure the test catches.
2. **Do not mirror constants.** Leave out guarantees already enforced by types
   or the framework, labels, trivial wiring and mock-call mirrors. No literal
   tool, capability or surface totals: assert the specific required/forbidden
   member and its usable contract. Data counts can prove a behavior (one effect
   after replay, no writes after refusal); inventory size alone does not.
3. **Extend before adding.** Add to the existing behavior case or table first.
   Name a new file after the behavior, never an issue, PR, milestone or review.
   Use one table case per equivalence class plus boundaries with a demonstrated
   failure, rather than enumerating values that execute the same rule. When a
   compatibility window or backfill ends, remove its obsolete tests and tooling
   in that PR; retain tests for contracts still supported.
4. **One layer per property.** Choose the lowest layer that fails on `main` for
   that reason. Do not repeat a business rule in service, MCP and HTTP wrappers.
   Bridge HTTP mapping, native Developer API payloads, MCP schemas and public
   error envelopes are different properties and can each need coverage.
5. **Prove the fix.** Add the smallest regression test before the fix; show it
   failing on the base and passing on the candidate. For runtime-only behavior,
   prove the failing/passing scenario in an isolated live test vault instead of
   claiming that a mocked boundary demonstrates Desktop behavior (see below).
6. **Control event ordering.** No sleeps, polling loops or real-time deltas to
   order events. Inject/control time for expiry and deadlines, or await the
   specific event, request, promise or persisted receipt that marks completion.
   Do not increase timeouts or retry to obtain a pass. Fix a flaky test or delete
   the unreliable test, retaining necessary behavioral proof. A temporary skip
   needs a tracking issue and reason; skipped checks are not evidence. A bounded
   process/network watchdog may fail a hung fixture, but is not synchronization.
7. **Keep review independent and bounded.** The reviewer gets the diff and issue,
   not the author's summary as a briefing. One report, one fix round, then only a
   recheck of those fixes. The verdict names the exact head SHA; details follow
   in the [review contract](#review-contract).

## What deserves a test here

- Governed operations: no effect during planning, sealed target/content proof,
  stale CAS refusal, idempotent replay, durable journal transitions, effect
  fences, uncertain outcomes and same-plan status/recovery. Start with existing
  cases such as [note replacement](../scripts/test-obsidian-note-replace-operation.mjs)
  and [Operon service](../scripts/test-operon-service.mjs).
- Authorization: `MCP_WRITE_MODE`, protected frontmatter, path scope, Bridge
  consent/grants and the vault-instructions gate, including batch targets and
  denial without side effects. Existing homes include
  [vault instructions](../scripts/test-vault-instructions.mjs) and
  [Operon refusal codes](../scripts/test-operon-refusal-codes.mjs).
- External contracts: input validation, native request serialization, transport
  mapping and safe public errors. For example, [Operon pin/batch tests](../plugins/obsidian-operon-bridge/src/pin-batch.test.ts)
  protect the Developer API payload; a valid TypeScript object alone cannot prove
  that the native API accepts it.
- Runtime state: persistence/migrations, cache invalidation and concurrency,
  restart/recovery and supported protocol compatibility. Assert the resulting
  state or receipt, not incidental private helper calls.
- Surface membership: a named tool appears in its intended profile and is absent
  where forbidden; its capability and authorization agree with dispatch. Extend
  [profiles](../scripts/test-tool-profiles.mjs) and
  [input schemas](../scripts/test-tool-input-schemas.mjs) for distinct properties.

Do not add source-text/regex tests just to prove that an implementation contains
a chosen string or call. Existing doc-contract scripts check published claims and
links; run them for docs changes, but do not add a keyword assertion for every
policy sentence. Configuration-as-data checks are justified when they protect an
executable safety contract (for example a trusted checkout or mutation gate).
There is no coverage percentage or minimum test count.

## Test doubles stop at external boundaries

Use a few integration scenarios through real production components. Replace the
external dependency at its actual boundary, not the code that translates it.

| Boundary | Permitted substitute | What runs for real |
| --- | --- | --- |
| Obsidian Desktop/plugin API | Minimal synthetic vault/API fixture when Desktop is unavailable | Bridge route/adapter logic under test, validation and error projection |
| Local REST API network | Loopback HTTP fixture or deterministic request/response replay | MCP REST client, transport decoding, services and policies |
| Operon native Developer API, through its Bridge | Deterministic native session/grant/preview/apply responses | Developer API adapter, Bridge mapping and MCP Operon service |
| Clock, IDs, process and filesystem | Controlled clock/IDs, owned child process fixture, temporary directories | Business logic, concurrency rules and production journal/persistence semantics |

Replay realistic raw boundary responses and failures, with outbound request
assertions; do not feed pre-normalized successful domain receipts to an adapter
test. Never mock the MCP services, journal or write policies in an integration
scenario. Use the real journal implementation against private temporary storage.
Tests starting the real runtime should import
[`test-support/isolated-state.mjs`](../scripts/test-support/isolated-state.mjs)
first and pass its isolated state environment to explicitly configured children.
This prevents temporary profiles leaving journals in the operator's state area.

A boundary fixture cannot prove real Obsidian events, plugin lifecycle, grants or
native acceptance. Use a live smoke when those behaviors are the property at risk.

## Bug-fix evidence and live smoke

Record the base SHA, head SHA, focused command and its failing/passing outcome.
A compile/import/setup failure is not a reproduction of the bug. Reuse an
existing case where possible; keep tests for distinct adapter properties only.

For a runtime-only bug, reproduce one scenario against the base, then the fixed
build, in a dedicated disposable Desktop vault with synthetic data. Follow
[Operations](../OPERATIONS.md) and the relevant [Bridge lifecycle](bridge-lifecycle.md)
or [release qualification](bridge-packaging.md) runbook. Check the resolved vault,
endpoint, installed MCP/Bridge versions, exact canary target and opt-in flags
before mutation. Never use the real vault, ordinary user notes or copied private
content as fixtures, and never weaken a canary's safety checks to make it run.

Use the relevant existing command, such as `npm run smoke:atomic-note-mcp-live`,
`npm run smoke:governed-frontmatter-live`, `npm run smoke:governed-canvas-live` or
`npm run smoke:bridge-lifecycle-live`. These require the runbook's setup; they are
not interchangeable generic health checks. Keep redacted proof outside the repo,
verify restoration and report any pending/uncertain operation. If Desktop, native
API or consent is unavailable, state what remains unverified. Offline tests and
a skipped smoke do not establish live qualification.

## Local checks and heavy suites

Use Node as required by `package.json` (currently `>=22.12.0`). Install with
`npm ci` when the selected command needs dependencies; plugin checks need their
own locked install, e.g. `npm --prefix plugins/obsidian-operon-bridge ci`.

| Change | Existing local checks |
| --- | --- |
| Documentation | `npm run test:docs` and `git diff --check` |
| Server code | `npm run verify:code` and `npm run test:runtime` as documented in Operations, plus the focused behavior check |
| Operon | `npm run check:operon` |
| Atomic write / Bases Bridge | `npm run check:atomic-write` / `npm run check:bases-bridge` |
| Governed family | Relevant `npm run test:governed-frontmatter`, `npm run test:governed-base`, `npm run test:governed-canvas` or `npm run test:governed-text-patch` |
| Tool surface / model routing | `npm run test:profiles` and `npm run test:tool-routing` |

For a focused server script importing `dist/`, run `npm run build` first; use the
invocation in `package.json` or its workflow (some scripts need `node --test` or
`--experimental-strip-types`). There is no `npm test`, lint gate or automatic
changed-files selector to substitute for these checks. Run commands to completion
and report failures and omitted checks.

Broad/heavy gates include `test:mcp-2026:all` (dual-stack suites plus benchmarks),
`test:operation-runtime`, `test:external-roots`, `test:assets`, Bridge checks and
packaging, and `test:tool-routing` (the scorer's clean-checkout rebuild).
`.github/workflows/runtime.yml` runs broad cross-platform checks on PRs;
`mcp-2026-dual-stack.yml` adds its path-selected matrix and gateway gate, and
`p6-tool-routing-evaluation.yml` owns the authoritative routing scorer run.
Choose local checks by impact, then let the existing CI gates finish; broaden
only for an unresolved cross-component risk. Moving heavy suites to main-only
CI or changing branch protection requires a separate decision and is outside
this policy change.

Contributor documents such as this policy and `AGENTS.md` are English. Existing
doc contracts require named EN/FR user entrypoints and validate relative links;
they do not require a French twin or index entry for every contributor document.
Keep existing paired user contracts synchronized when behavior changes.

## Model-facing text and evaluations

Descriptions, schemas, tool results and instructions are behavioral inputs to
models. Read [evals/README.md](../evals/README.md) and the
[P6 evaluation contract](tool-routing-evaluation-p6.md). The existing corpus is
[`evals/tool-routing-corpus.json`](../evals/tool-routing-corpus.json); discovery
uses [`tool-catalog.v1.json`](../evals/tool-catalog.v1.json).

- Run `npm run test:tool-routing` for MCP routing changes. Its deterministic
  contracts do not measure real model selection. `test:tool-routing:fast` omits
  the expensive scorer; say so if that is all you ran.
- For a model behavior regression, add a case before the text fix, identify the
  source issue/experience and show failure against the old text. Include ordinary
  control cases to catch overcorrection. Never include user content or secrets.
- Use the [selection harness](../scripts/run-codex-routing-selection-eval.mjs)
  under the clean-candidate attestation in the eval README. It measures selection,
  not live vault-tool execution. Take several samples per case (the current P6
  contract requires two to five complete repetitions), compare with a baseline
  on the same model/configuration, and preserve exact SHA, corpus and surface
  hashes. Do not present synthetic traces as a real model run. Run artifacts stay
  outside the repository; do not add paid model calls to ordinary CI.

## Review contract

An agent does not review its own work. The pilot supplies an independent reviewer
on another model with the issue and base/head diff in fresh context, without an
author-summary briefing. The PR still records the author's commands and limits;
the reviewer verifies evidence against the source.

One report contains:

1. Base SHA, head SHA and scope reviewed.
2. BLOCKER, HIGH, MEDIUM and LOW findings, with `none` for empty buckets. Each
   finding names `file:line`, a concrete failure path and the smallest correction.
3. Commands run and outcomes.
4. What was not verified.
5. `Verdict: APPROVE <head SHA>` or `Verdict: REQUEST_CHANGES <head SHA>`.

Only demonstrated BLOCKER/HIGH defects block: a failing check, reproduced bug or
broken contract. MEDIUM/LOW findings and unexposed theoretical edges become
follow-ups. Ask for a test only when it catches a concrete regression allowed by
the seven rules; fold, remove or move low-signal/duplicated tests as appropriate.
One fix round is followed by a recheck of those fixes only, not a new full review;
switching reviewers does not restart the budget. Approval covers only its named
head. A remaining blocking defect goes back to the pilot for a decision; the
bounded loop never grants permission to merge it.

## Sources and credit

Adapted for this repository from [T3 Code](https://github.com/pingdotgg/t3code),
MIT, Copyright (c) 2026 T3 Tools Inc.:
[AGENTS.md at ae14293](https://github.com/pingdotgg/t3code/blob/ae142932d07c0596cf0497dd28cfee07ae7c0722/AGENTS.md)
and [testing policy at 68495b6](https://github.com/pingdotgg/t3code/blob/68495b641b3e5834421b6549751eb65ed66fc6f4/docs/internals/testing.md),
the source commits recorded in issue #164. Also consulted its
[review-bot configuration](https://github.com/pingdotgg/t3code/blob/ae142932d07c0596cf0497dd28cfee07ae7c0722/.coderabbit.config.ts),
[eval guidance](https://github.com/pingdotgg/t3code/blob/ae142932d07c0596cf0497dd28cfee07ae7c0722/evals/README.md)
and [integration strategy](https://github.com/pingdotgg/t3code/blob/ae142932d07c0596cf0497dd28cfee07ae7c0722/docs/orchestration-v2/testing-strategy.md).
An adaptation by another agent-written project, whose agent guidance derives
from T3 Code at `a9e709f15f825cacac1b6d665fa1920c328d68b7`, supplied the bounded
review contract, behavior-based filenames, equivalence classes and removal of
ended compatibility tests. Local commands, governance, Bridge boundaries and
routing evidence above replace source-specific tooling and runtime rules.

MIT notice for the adapted T3 Code material in this policy and `AGENTS.md`:

```text
Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
