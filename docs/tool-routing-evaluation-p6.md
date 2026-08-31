# Tool routing evaluation and profile decision (P6)

French version: [tool-routing-evaluation-p6.fr.md](tool-routing-evaluation-p6.fr.md)

P6 makes tool-surface decisions reproducible. It does not claim that fewer
tools are automatically better, and it does not turn model preference into a
safety authority.

## Outcome for 3.8

- The public profiles remain `standard`, `authoring`, `tasks` and `full`.
- No tool is removed or moved to another public profile in 3.8.
- No combined authoring-and-tasks profile is added. Its live union would expose
  60 tools, while the current corpus contains no repeated workflow proving that
  a profile switch loses necessary context or a durable receipt.
- The 81-name cross-runtime registry is now classified and exported as a
  versioned inventory. There are no registered compatibility aliases.

This is an evidence-based rejection for this release, not a permanent ban. A
new workflow profile may be reconsidered when a measured, same-session journey
needs both authoring mutation and Operon mutation or recovery.

## Two independent evidence layers

### Deterministic CI authority

The versioned corpus, trace contract and offline scorer decide facts that do not
need an LLM judge:

- exact first-tool and first-family correctness;
- forbidden calls and mutation before a required clarification;
- success established by a harness post-condition;
- tool calls above the corpus-declared minimum, without claiming that the
  excess is necessarily useless;
- actual `tools/list` tool count and canonical UTF-8 schema bytes;
- trace reproducibility and binding to corpus, commit, model configuration,
  runtime, profile, fixture and run index.

Safety violations cannot be waived by a high qualitative score.

### Optional probabilistic judgment

The data-only judge rubric is provider-neutral and makes no network call. It may
score only residual qualities such as whether the final explanation matches the
supplied evidence and whether a clarification was materially useful. A judgment
is bound to an immutable trace hash. Pairwise comparisons must swap candidate
positions; disagreement is a tie or low-confidence result, not a hidden winner.

No live model run blocks CI. Raw traces must be preserved; a report must not
select only the best stochastic run.

## Corpus and trace contract

`evals/tool-routing-corpus.json` preserves the original 31 cases as the P6
baseline inside a versioned envelope. Each case declares its expected registry
family and clarification rule in addition to its exact acceptable first tools
and forbidden choices.

A reproducible JSONL trace records:

- corpus ID and SHA-256;
- Git SHA, harness and harness version;
- model plus explicit model configuration;
- runtime mode, exposed surface, fixture SHA-256 and run index;
- ordered `tool`, `clarification` and `final` events;
- harness-derived success evidence;
- actual `tools/list` count, schema bytes and canonical surface hash.

The accompanying run manifest contains the measured public schemas. Strict
scoring requires `EXPECTED_COMMIT`, verifies the current checkout, recomputes
every surface measurement and fixture hash, validates the trace-file hash, and
recalculates success from the deterministic routing and safety evidence. It
also requires the four canonical profiles, every case assigned to each focused
profile, all 31 cases on `full`, and two to five complete repetitions.

Missing data is reported as `N/A`; an absent clarification case is never
reported as 100% clarification accuracy.

## Measuring schema exposure

The live measurement is read-only. It isolates caches and journals in an
OS-temporary directory; the runtime's redacted transient logs stay under the
gitignored project `logs/` boundary. Each run directory is removed after the
run, and the empty parent is removed when no concurrent measurement owns it. It cannot
sweep or reconcile a user's durable operations:

```powershell
$env:OBSIDIAN_RUNTIME_MODE = "live"
$env:OBSIDIAN_VAULT = "C:\path\to\disposable-vault"
$env:OBSIDIAN_API_KEY = "<local-rest-api-key>"
$env:EXPECTED_COMMIT = (git rev-parse HEAD)
npm run build
node scripts/measure-tool-profile-schemas.mjs --require-live
```

The output contains public tool names, counts, canonical schema bytes and a
SHA-256 per profile. It never prints the API key, vault path, payloads or journal
contents.

## Catalogue rules

Every registered name is classified as one of:

- canonical unique;
- redundant alias;
- historical compatibility path;
- governed operation;
- diagnostic;
- administration.

Equal schemas do not prove equal contracts. In particular,
`operon_list_tasks` and `operon_query_tasks`, lifecycle `apply` and `recover`,
and the fail-closed external move endpoints keep distinct intentions. Direct
headless fallbacks remain available when the governed Desktop family is absent.

Any future physical removal or loss from an existing public profile is a major
version change. It requires a documented migration and a replacement proven in
every runtime where the old tool remains necessary.

## Verification

```bash
npm run build
npm run test:tool-routing
npm run test:profiles
npm run test:docs
```
