# Tool-routing evaluations

`tool-routing-corpus.json` is a versioned, harness-neutral corpus for measuring
whether a reduced MCP tool surface improves routing without reducing successful
coverage. Corpus v1 preserves the original 31 discriminating cases and adds:

- `expectedToolFamily`, reported separately from an exact first-tool match.
- `clarificationExpectation` (`none`, `required`, or `before_mutation`), so unnecessary
  clarification is observable rather than silently counted as success.

The corpus hash is the SHA-256 of the exact corpus file bytes. Do not rewrite or
pretty-print a corpus between a run and scoring: the trace retains that hash.

## Reproducible JSONL traces

Each line is one independent run. New runs must use the strict
`tool-routing-trace/v1` contract. Legacy lines with `id` and `toolsCalled` are
accepted only for historical comparison; they cannot establish a reproducible v1
result.

```json
{
  "schemaVersion": "tool-routing-trace/v1",
  "caseId": "semantic-canonical",
  "corpusId": "optimike-tool-routing-v1",
  "corpusHash": "sha256 of evals/tool-routing-corpus.json bytes",
  "gitSha": "full-40-character-commit-sha",
  "harness": { "name": "codex", "version": "observed-harness-version" },
  "model": {
    "provider": "openai",
    "name": "model-name",
    "version": "observed-model-version"
  },
  "modelConfig": { "temperature": 0 },
  "runtimeMode": "live",
  "surface": "standard",
  "runIndex": 0,
  "fixtureHash": "sha256 of the fixture or deterministic setup",
  "caseContextHash": "sha256 of the ordered comparison cases",
  "events": [
    { "sequence": 0, "type": "tool_call", "toolName": "smart_semantic_search" },
    { "sequence": 1, "type": "assistant_final" }
  ],
  "success": true,
  "successEvidence": [
    {
      "kind": "fixture_assertion",
      "detail": "Expected fixture match was returned."
    }
  ],
  "toolCount": 22,
  "schemaBytes": 2048,
  "toolsListSha256": "sha256 of the canonical measured tools/list surface",
  "latencyMs": 842,
  "inputTokens": 2100,
  "outputTokens": 320,
  "costUsd": 0.0042
}
```

Required v1 anchors are corpus ID/hash, Git SHA, harness/version, model/config,
runtime mode, surface, run index, fixture hash, ordered events, success evidence,
case-context hash, tool count, schema bytes, and the measured `tools/list` hash. Strict scoring also
requires the harness-produced run manifest. The scorer independently rebuilds
each canonical live `tools/list` surface from the exact checkout against a
local authenticated status fixture, compares its full schema hash to the
manifest, verifies the trace-file hash and exact checkout SHA, and
recalculates success from deterministic evidence. A strict P6 manifest must
contain exactly `standard`, `authoring`, `tasks`, and `full`; each focused
surface covers every case assigned to it, `full` covers all 31 cases, and every
surface has two to five complete repetitions. Latency, token counts and cost are
optional. When an optional measure is absent, the scorer emits literal `"N/A"`,
never synthetic zero.

`events` are deliberately minimal: no prompts, private arguments, model reasoning,
vault content, or credentials. A `clarification` event records a user-facing
clarification request. `toolCount` is the actual number of tools exposed by
`tools/list`; the scorer derives the number of calls from the events.

## Optional live selection harness

The Codex CLI selection harness runs only on an explicitly attested, clean
candidate and writes an atomically published, unique trace file plus manifest
outside the repository:

```text
node scripts/run-codex-routing-selection-eval.mjs --runs=2 --model=gpt-5.6-luna --reasoning=high
```

It closes the readonly MCP discovery sessions before model selection and never
asks the model to execute a vault tool. CI exercises only its offline contract.
Focused and `full` measurements receive identical ordered case batches, and the
Codex subprocess inherits only an explicit non-secret environment allowlist.
Use the CLI's stored login rather than an environment API key.
Before discovery, the harness rebuilds `dist/` from the exact clean checkout
and rechecks the commit and tracked tree, so ignored stale artifacts cannot be
mistaken for evidence from the attested SHA.

## Offline scorer

```text
$env:EXPECTED_CANDIDATE_COMMIT = "<manifest.sourceCommit>"
$env:P6_COMPARE_COMMIT = (git rev-parse HEAD) # optional release-surface parity gate
node scripts/score-tool-routing-evals.mjs traces.jsonl evals/tool-routing-corpus.json manifest.json
```

The scorer is deterministic and provider-free. From a clean verifier checkout
it creates a detached worktree for the historical candidate, installs from its
lockfile, rebuilds it, and binds the supplied corpus semantically to the exact
candidate Git blob. It preserves the byte hash sealed by the campaign and
reports both the supplied and candidate-blob hashes before validating every v1
trace. Dependency acquisition may use the configured npm registry or cache;
after that installation step, scoring invokes no model or external service. The
report
keeps `verifierSha` and `candidateSha` distinct and binds the corpus, traces,
manifest, rebuilt artifacts and surface hashes. It reports first-tool and
first-family accuracy, safety/forbidden-tool rate, clarification adherence,
success, calls above the declared minimum, schema bytes, latency, tokens and
cost. Candidate and comparison `publicTools` are rehashed with the verifier's
own versioned measurement function before parity is accepted. A minimum is not
interpreted as proof that additional calls were
unnecessary. Summaries are partitioned by harness, harness version, model,
runtime mode and surface.

Candidate installation explicitly includes the locked development dependencies
needed for the build, regardless of inherited `NODE_ENV` or npm omit settings.
Legacy scoring without a manifest remains catalogue-only and does not require a
Git checkout; it produces no authority block.

Use the same corpus hash, case-context hash, Git SHA, model configuration and run
index when comparing two surfaces. Compare at minimum `full` to the smallest
intended surface (`standard`, `authoring`, or `tasks`) for the same cases and
setup; the surface-specific fixture hash is expected to differ with its tools.

## Judge rubric

`tool-routing-judge-rubric.json` is a data-only review contract. It has no
provider configuration and cannot call a provider. A human or separately
authorized judge may review only supplied cases, v1 traces and scorer output; it
must return `pass`, `fail`, or `inconclusive` with evidence references. It must not
infer unrecorded runtime facts or request hidden reasoning.

## Tool discovery (deferred tool search)

Some clients do not put MCP tool definitions in the model context. Claude Code
gives the model the deferred tool names and a keyword `ToolSearch`; Codex 0.160
runs in code mode, where the model filters `ALL_TOOLS` (name and description)
in its own JavaScript. `tool-discovery-corpus.json` measures whether the right
tool is found that way. Each of its 26 intents has an English and a French user
request, one keyword `query` issued verbatim, and three `holdoutQueries` written
by a separate agent from the intent text alone, without tool names,
descriptions or search hints. An intent passes when an expected tool is in the
top 3 search results; `riskyTools` must not outrank it.

```text
npm run build
node scripts/run-tool-discovery-eval.mjs --client=claude-sim
node scripts/run-tool-discovery-eval.mjs --client=claude --runs=2 --out=<dir outside the repo>
node scripts/run-tool-discovery-eval.mjs --client=codex --runs=3 --out=<dir outside the repo>
```

- `claude-sim` is model-free. `scripts/tool-discovery-index.mjs` reproduces the
  Claude Code 2.1.331 keyword ranking: per query word, a name part match scores
  12 (6 if contained), the server or tool name 12 (4 if contained), a whole
  word of `_meta["anthropic/searchHint"]` 4 and of the description 2; ties are
  in name order. Stop words are not dropped. `claude` replays every real
  keyword search through this reproduction and reports the agreements; a
  disagreement means the client changed and the reproduction must follow.
- The harness captures the catalogue (`tools/list`, instructions, server info)
  once from the built server, against an empty synthetic vault, a loopback Local
  REST status fixture, `MCP_WRITE_MODE=readonly` and private state, then stops
  it. `claude` and `codex` run the real CLI on its stored login against
  `scripts/tool-discovery-replay-server.mjs`, which serves that exact catalogue
  and refuses and logs every `tools/call` before dispatch; a model-free
  preflight checks both before any paid run. `--server=<dist/index.js>`
  measures another build, such as a baseline worktree; the report keeps the
  harness and measured-build commits apart and refuses a `dist/` older than its
  `src/`.
- Runs that exit nonzero, miss their evidence (Claude `init`, Codex session
  record) or never connect to the fixture are reported apart (`failedRuns`,
  `fixtureUnavailableRuns`), not as misses. A keyword case counts only when the
  model sent its query once and verbatim (`queryDeviations` otherwise).
- `codex` refuses to measure unless an isolation check proves, from the
  session's own code-cell output, that `ALL_TOOLS` holds only Codex built-ins
  and the fixture's tools (no ChatGPT app, plugin or user configuration). It
  records the model's code cells, the fixture tools they printed and the tool
  it names, then deletes its session record. Code mode has no ranking to score:
  report its variability across runs, not a top-3 rate.
- `--decoys=<dir>` measures discovery next to competing servers. Each
  `<server>.json` there (`{serverName, tools, instructions?}`, for example a
  captured `tools/list` of another MCP server the user runs) is served by its
  own replay server, which refuses and logs every call like the fixture; the
  reproduction ranks all servers together, with ties in full
  `mcp__<server>__<tool>` order. Decoy tools are reported by that full name.
  The report adds `foreignFirst`, `foreignWriteFirst` (a decoy tool that
  writes, by its annotations or else its name, ranks first),
  `foreignWriteAboveExpected` (one ranks in the top 3 above the expected tool)
  and, for real clients, `finalForeign` / `finalForeignWrite`. With decoys the
  request prompt says the client is connected to several servers, one of them
  the user's Obsidian vault; `--context=none` drops the vault from the prompt,
  like a client without instructions about where the user's notes and tasks
  live. A decoy without annotations is classed as writing by its name parts, a
  presumption the report labels (`writeBasis`). Server names must be bare keys
  (`A-Z a-z 0-9 _ -`) that stay distinct once a client namespaces them.
  Catalogues and their `instructions` reach the measured model verbatim and
  reports keep its raw reply: review and redact a capture before a paid run,
  and keep captures and reports outside the repository.
  The harness refuses `--decoys` with `--client=codex`: Codex code mode keeps
  its own `exec_command`, its read-only sandbox still reads host files outside
  the work directory, and decoy catalogues are untrusted text that reaches the
  model verbatim. Claude Code runs get `ToolSearch` as their only built-in
  tool. Competing-server numbers are Claude Code only.
- No client can execute a server tool: the replay refuses the call. Every
  attempt, in any run including failed ones, is counted: `refusedCalls` is the
  number of calls the replay servers refused (from their logs), and
  `otherToolCalls` the number of runs with any attempt, refused or seen in the
  client's own record. Run artifacts stay outside the
  repository and paid model calls stay out of CI.

## Focused checks

```text
npm run build
node scripts/test-tool-routing-eval-corpus.mjs
node scripts/test-tool-routing-scorer.mjs
node scripts/test-tool-routing-judge-rubric.mjs
```
