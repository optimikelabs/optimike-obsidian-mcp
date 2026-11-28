# Experimental headless integration

`exp/headless-autonomy` integrates headless changes for evaluation on a local
copy of a vault. Its base is `2636214bf976e492a9e545a4705d9f2a09b4ae1d`.
This branch leaves `main` and the individual pull requests unaffected.

| Pull request | Integrated head | Behavior |
| --- | --- | --- |
| [#202](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/202) | `3dd977a7d5d1c3b12a1efc7a52228dc290848c7e` | Filesystem write serialization and conflict checks |
| [#204](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/204) | `c1749c4f2b091186b02ed084a5fa1681f58a90b9` | Explicit refusal and labeled Markdown property scans for headless Bases |
| [#205](https://github.com/optimikelabs/optimike-obsidian-mcp/pull/205) | `8110555c582b1b714f62fa10ee01e3762133232a` | Read provenance and index freshness reporting |

Run the read-only profile first. Test filesystem writes on a separate,
disposable copy using synthetic notes. Write serialization is process-local.
The runtime cannot attest to upstream sync. External semantic generations,
their index producer, and the Bases Bridge test realignment are pending.

## Add another change

1. Check out `exp/headless-autonomy` in its integration worktree with a clean
   working tree. If the remote branch advanced, fast-forward to it first.
2. Fetch the intended head with `git fetch --no-tags origin refs/pull/<number>/head`.
   Record `git rev-parse FETCH_HEAD` and merge that SHA using `git merge --no-ff`.
   Keep one merge commit per PR, including the tests from both sides of conflicts.
3. Build and run each affected PR's focused checks, `npm run smoke:headless-server-profile`
   against a synthetic fixture, `npm run test:http-headless-multiclient`,
   `npm run test:docs`, and `git diff --check`.
4. Record the newly integrated heads here and push `exp/headless-autonomy`.
   Keep private pilot files, vault copies, credentials, and transcripts outside Git.
