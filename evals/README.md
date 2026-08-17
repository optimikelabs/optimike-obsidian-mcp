# Tool-routing evaluations

`tool-routing-corpus.json` is the initial discriminating corpus for measuring the
impact of tool-surface profiles. It is intentionally harness-neutral: the same
cases can be executed through Codex, Gemini CLI, Claude Code, Hermes Agent,
OpenClaw or another MCP client.

The corpus does **not** contain fabricated model scores. CI validates the cases,
tool names and profile contracts only. Real model runs are recorded separately
as JSONL traces and scored with `scripts/score-tool-routing-evals.mjs`.

## Initial experiment

Start with the 31 cases in the corpus. For stochastic harnesses, use three runs
per case when practical.

Compare at minimum:

```text
full vs recommended profile
```

For general authoring cases that means `full` vs `standard` or `authoring`; for
Operon cases it means `full` vs `tasks`.

Only expand toward 50-100 prompts if the initial sample shows a material signal
or an uncovered ambiguity.

## Result format

Write one JSON object per run:

```json
{"id":"semantic-canonical","harness":"codex","surface":"standard","toolsCalled":["smart_semantic_search"],"success":true,"latencyMs":842,"inputTokens":2100}
```

Required fields:

- `id`: case ID from the corpus;
- `toolsCalled`: ordered MCP tool names used during the run;
- `success`: whether the requested task completed successfully.

Recommended fields:

- `harness`: client/harness name and optionally model/version;
- `surface`: `full`, `standard`, `authoring`, or `tasks`;
- `latencyMs`;
- `inputTokens`.

Then run:

```bash
node scripts/score-tool-routing-evals.mjs results.jsonl
```

The scorer reports:

- first-tool accuracy;
- success rate;
- forbidden-tool rate;
- mean tool-call count;
- mean unnecessary calls;
- p50/p95 latency when supplied;
- mean input tokens when supplied.

`forbiddenTools` encode routing mistakes relevant to each case, such as choosing
a semantic-search compatibility alias, calling apply before status after an
uncertain outcome, or using a direct path when the case explicitly asks for the
governed guarantee.

## Interpretation

The 15-25 tool target for a normal surface is a hypothesis, not a pass/fail
criterion. Evaluate the tradeoff against routing accuracy, coverage, latency and
token cost. A smaller surface that hides a required capability is a regression.

Do not compare clients only by raw latency: clients differ in tool discovery,
deferred loading, model choice and transport behavior. The load-bearing signal
is whether the profile improves tool choice without reducing successful task
coverage.
