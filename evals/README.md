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
cost. A minimum is not interpreted as proof that additional calls were
unnecessary. Summaries are partitioned by harness, harness version, model,
runtime mode and surface.

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

## Focused checks

```text
npm run build
node scripts/test-tool-routing-eval-corpus.mjs
node scripts/test-tool-routing-scorer.mjs
node scripts/test-tool-routing-judge-rubric.mjs
```
