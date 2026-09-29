# Four-lot assembly and local qualification handoff

This is an integration candidate, not a release or permission to deploy.
PR #113 assembles the independently owned lots without changing `main`.
Read live refs, CI and exact-head reviews before using any checkpoint below.

## Sources

Baseline: `34d7a75bfbed48f75607aa2a3caf01292af16403`.

- L0, PR #109: `f062fe462ed077e40fdbb3fcc45a0bf488cd7838`.
- L1, PR #110: `0e92bae86f8c0d3fc7252f703bfeb7967eeef063`.
- L3, PR #111: `d770a41599e72a00cfec620e716c3cc67a13d294`.
- L2, PR #112: `4465a3bf83e80dceed3d9aebc2830febec399fc2`.

Assembly checkpoint: `575214f6e32c6187c31c589bd5136042c0330a57`.
Package/README merge conflicts were resolved additively: retain each lot's
scripts, packaged contracts and optional dependencies. No #107/#108 changes
are included. The source branches retain ownership of functional corrections;
fix there first and merge the resulting commit here, not only in this branch.

## Default behavior and image boundary

SSE and asset import stay disabled by default. Periodic scans remain ten minutes.
A missing optional event endpoint must not invalidate verified periodic data.
An event counter jump is not loss evidence. Cache completeness and stream
coverage have separate diagnostics; uncertain content needs actual reproof.

Reference/display/read is not consent to import. Reuse local assets without
copying/recompression. Import accepts one already-present server-local file in
an authorized readable+handoff ExternalRoot, with the expected source hash.
The configured format/folder policy remains separate from the generic MCP.
The native mutation supports Windows x64, a fixed local NTFS volume and held
ordinary parent handles. No UNC/reparse/path-writer fallback is admitted.
A proven pre-spawn refusal preserves the exact frozen plan for retry. After
possible effect, use status; never retry the mutation or delete an uncertain
asset automatically. Note insertion is a separate existing governed operation.

No URL-download, raw client upload, model-carried base64, or automatic crawling
is implemented. This V1 is not ChatGPT-attachment-to-PC transfer. A signed URL
is not proof of reachability or exclusive creation. No alternate MCP authority.

## Repository gate commands

Use a clean isolated checkout and the committed lockfiles, not production paths.

```sh
npm ci
npm run build
npm --prefix plugins/obsidian-atomic-write-bridge ci
npm --prefix plugins/obsidian-operon-bridge ci
npm --prefix plugins/obsidian-bases-bridge ci
npm run test:local-rest-531
npm run test:cache-events
npm run test:assets
npm run test:bridge-openapi
```
Then run shared regressions and packaging:

```sh
npm run test:operation-runtime
npm run test:operation-cockpit
npm run test:profiles
npm run test:log-privacy
npm run test:docs
npm run build:bridges
npm run test:package
npm audit --omit=dev
```

CI must run the four dedicated lot workflows and existing affected workflows
at the final exact head. A review completion badge alone is not a no-findings
verdict. Cancelled superseded runs and older green heads are not evidence.
The PR body records current evidence without a self-referential commit field.

## Audit observation

At the assembly checkpoint, production audit reported zero vulnerabilities.
The full dependency audit reported a moderate development-only `ip-address`
advisory (GHSA-rpw4-54j3-4h4q and GHSA-2vr4-cq9g-pvrc). It was not silently
waived or fixed through a broad dependency update. Recheck at qualification;
this observation does not certify all development dependencies as vulnerability-free.

## Separate local gates and promotion

Do not install into or reload the production vault. Follow L0.md's disposable
Desktop gate only after the pilot vault and endpoint have been independently
identified, authorized and attested. Keep real credentials and content private.

- Desktop 5.3.1 and three candidate Bridge reload/late-startup behavior: NOT_RUN.
- Actual merged OpenAPI inventory and preserved grants in Desktop: NOT_RUN.
- SSE reconnect, hidden-window behavior and representative freshness: NOT_RUN.
- Desktop indexing/embed resolution of an imported synthetic asset: NOT_RUN.
- TLS trust and real remote byte ingress: NOT_RUN; new ingress is not implemented.

An earlier attempted full L2 HTTP control was blocked by a tool safety check;
no equivalent end-to-end execution is claimed here. The successful SDK/HTTP/SQLite
fixtures have their own bounded scope and must not substitute for that gate.

For permitted pilot execution, retain the previous installed artifact hashes,
record the exact admitted source SHAs, exercise only synthetic files, and verify
restoration and pending receipts before qualification. Do not clear unknown
receipts or replay mutations to manufacture a clean outcome.

Promotion is a separate human decision. Independent PRs or this assembled branch
must be revalidated against the eventual merge base; neither automatically
includes unrelated #107/#108 work. No release version bump or production toggle
change belongs to this assembly. Final states remain CANDIDATE_READY_REPO,
QUALIFIED_LOCAL and PROMOTED, never an undifferentiated DONE.

## Final assembly proof contract

PR #113 is the assembled candidate. All pull-request checkout steps now explicitly
select the PR head, including the older packaging/runtime gates; no synthetic
merge commit is silently reported as the tested candidate. The M6 workflow runs
`test-assembly-contract.mjs` to check every PR checkout, combined root dependency
lockfile coherence and French cache/asset documentation. Existing dedicated
qualification workflows remain unchanged. Exact CI/review verdict belongs in
the current PR body and checkpoint comment, not in a self-referential source SHA.

Desktop 5.3.1, TLS and remote binary ingress remain separate NOT_RUN gates; no
release/deployment or production configuration was authorized or performed.
