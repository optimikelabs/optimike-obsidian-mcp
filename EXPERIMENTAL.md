# Experimental headless integration

`exp/headless-autonomy` integrates headless changes for evaluation on a local
copy of a vault. Its base is `2636214bf976e492a9e545a4705d9f2a09b4ae1d`.
This branch leaves `main` and the individual pull requests unaffected.

| Pull request | Integrated head | Behavior |
| --- | --- | --- |
| [#202](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/202) | `3dd977a7d5d1c3b12a1efc7a52228dc290848c7e` | Filesystem write serialization and conflict checks |
| [#204](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/204) | `a100abad7b77354dc0527f8de00cf0634968ee8b` | Explicit refusal and labeled Markdown property scans with supported filter trees |
| [#205](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/205) | `12890e70897675a2becad16210d98e8559fd1132` | Read provenance, successful scan start time, and index freshness reporting |
| [#209](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/209) | `f628b91a56c46a8ad5d5b98ff98fe73f4cc5dac0` | Bases Bridge tests replay a capture from Obsidian 1.15.1 |
| [#210](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/210) | `b715fe2b8e7cc0af222e9cdf263146cb8b5cf958` | Semantic search reads complete external generations selected by `CURRENT` |
| [#212](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/212) | `12a35db5b6781b86303c3fa2f0ed543801d30252` | Standalone BitNet producer publishes note and section vectors outside the vault |
| [#217](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/217) | `9710f22b365ebc773ddbfb5e7fc899bb2edb3fb7` | Formula diagnostics recognize registered function names regardless of case |

Run the read-only profile first. Test filesystem writes on a separate,
disposable copy using synthetic notes. Write serialization is process-local.
The runtime cannot attest to upstream sync. Headless property scans do not run
the Bases engine. The captured #204 head predates its follow-up for date-valued
frontmatter comparisons. Semantic search requires a complete generation and a
compatible encoder. See the [producer](docs/semantic-index-producer.md) and
[reader](docs/semantic-vector-cache-encoding.md#external-smart-env-v3-generations)
contracts. The Windows HTTP startup issue [#214](https://github.com/optimikelabs/optimike-obsidian-mcp/issues/214)
is outside this integration.

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
