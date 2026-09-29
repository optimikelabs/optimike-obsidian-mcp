# Local REST compatibility, cache freshness and voluntary assets

This is a repository preparation cycle, not a release or deployment record.
Read the current branch and PR head before resuming. Historical evidence never
certifies a later candidate implicitly.

## Baseline and ownership

- Optimike baseline: `34d7a75bfbed48f75607aa2a3caf01292af16403` (3.10.0).
- Local REST API target: tag `5.3.1`, commit
  `17a9cfd9ff5dd0156b694bf9b13ab36c786b29da`.
- PRs #107 and #108 remain separate. This cycle does not merge or silently
  include their changes.
- Existing mutation authorities, grants, CAS, journals and no-blind-replay
  contracts remain in force. No production installation is changed.

## Lots

- **L0:** pin specification provenance; exercise consumed REST contracts and
  error boundaries; prepare an attested disposable Desktop qualification.
- **L1:** bounded event-assisted cache freshness with honest failures,
  exclusions, concurrency and reconciliation. The periodic interval remains
  unchanged in the first candidate.
- **L2:** voluntary image import, distinct from remote reference and reuse of
  an existing local file. Prove byte transport and exclusive creation before
  exposing a mutation. A failed note insertion is a partial result, not an
  excuse for automatic deletion.
- **L3:** public extension typing and optional OpenAPI descriptions without
  replacing authenticated routes or the Bridge lifecycle supervisor.

Each admitted lot has its own branch and PR. A technical dependency may use a
stacked PR with an explicit parent; unrelated lots need not wait for a merge.

## Facts constraining implementation

Local REST's SSE counter is global and allocated before filtering. Numeric gaps
are not evidence of loss. Reconnection or interrupted processing does require
reconciliation; Last-Event-ID is not replay. Payloads without file.content still
contain metadata. Never log raw event payloads or signed URLs.

Cache inventory scans compare mtime/size and selectively reread files. They are
not exhaustive byte verification. A resolved void cache update is not proof of
freshness. Coordinate scans and single-file updates and retain failed work.

Binary REST writes predate 5.2. Signed upload URLs delegate a whole-file PUT that
can overwrite and create parents. They neither provide exclusive creation nor
make a loopback address reachable from a remote client.

Observing, displaying, referencing or reading an image does not authorize its
persistent import. Remote references stay remote unless import was explicitly
requested or covered by an explicit bounded workflow policy. Existing images
are not silently copied, recompressed, renamed or migrated. No publication,
clipping-plugin change, general deletion or upstream modification is included.

## Evidence states and release boundary

- `IMPLEMENTING`: work exists, mandatory gates incomplete.
- `REVIEW_REQUIRED`: repository tests may pass, but distinct review is missing.
- `CANDIDATE_READY_REPO`: exact candidate, repository gates and distinct review
  are recorded, findings resolved, package/docs complete and restart possible
  from GitHub without the originating chat.
- `QUALIFIED_LOCAL`: the exact artifact also passed the declared real-runtime
  gates on an attested disposable vault.
- `PROMOTED`: separately authorized merge/release/deployment, never inferred.

Initial state: L0-L3 `NOT_RUN`; no candidate qualification is claimed. Source
changes, test results and the first incomplete gate belong in each lot's PR.
No merge, release or production deployment is authorized by this document.
