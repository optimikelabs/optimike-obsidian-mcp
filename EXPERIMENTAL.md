# Experimental headless integration

`exp/headless-autonomy` integrates headless changes for evaluation on a local
copy of a vault. Its base is `2636214bf976e492a9e545a4705d9f2a09b4ae1d`.
This branch leaves `main` and the individual pull requests unaffected.

| Pull request | Integrated head | Behavior |
| --- | --- | --- |
| [#202](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/202) | `3dd977a7d5d1c3b12a1efc7a52228dc290848c7e` | Filesystem write serialization and conflict checks |
| [#204](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/204) | `3dcc86ca556a9b7213459711ad4f517678041516` | Labeled Markdown property scans, filter trees, and YAML dates preserved as strings |
| [#205](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/205) | `12890e70897675a2becad16210d98e8559fd1132` | Read provenance, successful scan start time, and index freshness reporting |
| [#209](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/209) | `f628b91a56c46a8ad5d5b98ff98fe73f4cc5dac0` | Bases Bridge tests replay a capture from Obsidian 1.15.1 |
| [#210](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/210) | `de81ed30427fd7a33158ef4d8de2bbd6504ee269` | Semantic search reads external generations selected by a strict `CURRENT` pointer |
| [#212](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/212) | `12a1489b590aa63107b294c5800e3f688a61f896` | BitNet producer with Smart Connections block selection, configurable minimum sizes, and deletion guards before encoding and publication |
| [#217](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/217) | `9710f22b365ebc773ddbfb5e7fc899bb2edb3fb7` | Formula diagnostics recognize registered function names regardless of case |
| [#218](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/218) | `488cb4fcef6f9e8f8a34d0ee4c68b8a96220ee25` | Exact Markdown reads can succeed during the cold cache build |
| [#219](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/219) | `da7ef45f3c74f2b10cc053406ea609ceace398dd` | Shared HTTP startup test helper waits for the listener before probing it |
| [#220](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/220) | `2fd17ad831bd97b0bc2c413321ac0b1d167f80e2` | Import a text patch proposal into a sealed plan and recover its receipt after a lost response |
| [#223](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/223) | `1ac99ddd625a734c36855ff6e879917cb61354ff` | Notes expose the read SHA-256 for optional strict-base replacement planning |

Run the read-only profile first. Test filesystem writes on a separate,
disposable copy using synthetic notes. Write serialization is process-local.
The runtime cannot attest to upstream sync. Headless property scans do not run
the Bases engine. Semantic search requires a complete generation and a
compatible encoder. The producer's v3 input profile requires an explicit
rebuild of generations made with the older block selection. See the [producer](docs/semantic-index-producer.md) and
[reader](docs/semantic-vector-cache-encoding.md#external-smart-env-v3-generations)
contracts. Proposal planning needs the live Atomic Write authority. Apply
retains the sealed plan and its compare-and-swap check.

On this branch the proposal HTTP test from #220 uses #219's shared startup
helper. Its lost-response, redaction, and shutdown assertions still run.

With #205 and #218 combined, direct exact reads include
`readPath: "direct-filesystem"`, their own `observedAt`, and `partial: false`
in the provenance. The full inventory may still be refreshing. Cached reads
keep the successful scan's start and refresh timestamps. The regression test
exercises both responses on the same note.

## Add another change

1. Check out `exp/headless-autonomy` in its integration worktree with a clean
   working tree. If the remote branch advanced, fast-forward to it first.
2. Fetch the intended head with `git fetch --no-tags origin refs/pull/<number>/head`.
   Record `git rev-parse FETCH_HEAD` and merge that SHA using `git merge --no-ff`.
   Skip heads already in the branch. Merge advanced heads separately and keep
   the behavior and tests from both sides of conflicts.
3. Build and run each affected PR's focused checks, `npm run smoke:headless-server-profile`
   against a synthetic fixture, `npm run test:http-headless-multiclient`,
   `npm run test:docs`, and `git diff --check`.
4. Record the newly integrated heads here and push `exp/headless-autonomy`.
   Keep private pilot files, vault copies, credentials, and transcripts outside Git.
