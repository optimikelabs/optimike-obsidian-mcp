# Bridge bundle, upgrade and rollback

Optimike MCP releases ship one verified bundle for the three Obsidian Bridges:

- `optimike-operon-bridge`;
- `obsidian-atomic-write-bridge`;
- `obsidian-bases-bridge`.

This bundle changes delivery only. It does not add an MCP tool, grant a
capability, enable a write gate or modify a note.

## Release assets

Each release publishes three matching assets:

```text
optimike-bridge-bundle-v<version>.zip
optimike-bridge-bundle-v<version>.manifest.json
SHA256SUMS
```

The manifest is generated from a fully clean worktree, including the absence
of non-ignored untracked source inputs. It binds the bundle
to the full 40-character Git commit, the MCP version, every Bridge ID/version
and the SHA-256 plus byte size of every file. The installer accepts only
`main.js`, `manifest.json` and an optional `styles.css` for each Bridge.
`data.json`, unknown files, links, junctions and hard-linked bundle entries are
rejected before staging.

Every non-watch Bridge build removes its previous ignored `build/` directory
before compilation. An optional artifact can therefore enter an attested
bundle only when the current source build emitted it; an obsolete
`styles.css` from an earlier checkout cannot survive into a release.

## Upgrade on Windows

1. Download the zip and `SHA256SUMS` from the same GitHub release.
2. Verify the zip checksum, then extract it outside the vault.
3. Close Obsidian completely.
4. Run the included PowerShell wrapper with the release commit shown on
   GitHub:

```powershell
pwsh -NoProfile -File .\install-bridge-bundle.ps1 `
  -Mode install `
  -VaultPath "C:\path\to\vault" `
  -BundlePath "$PWD" `
  -ExpectedCommit "<40-character release commit>" `
  -ConfirmObsidianClosed
```

The installer validates the complete bundle before acquiring its vault-local
transaction lock. It stages the candidate below `.obsidian/plugins`, writes a
private backup below the operating-system state directory, then replaces only
the three managed code filenames. Existing `data.json`, grants, write gates
and unknown plugin files are neither copied into the release bundle nor
overwritten during install.

After restarting Obsidian, call `obsidian_runtime_status`. The capability
doctor must report the three Bridges as available with the expected versions;
authorization and write readiness remain separate decisions.

## Rollback

The successful install receipt prints its private `backupPath`. Close Obsidian
again and run:

```powershell
pwsh -NoProfile -File .\install-bridge-bundle.ps1 `
  -Mode rollback `
  -VaultPath "C:\path\to\vault" `
  -BackupPath "<private backupPath from the install receipt>" `
  -ConfirmObsidianClosed
```

Rollback is fenced. It proceeds only if the currently installed managed files
still match the bundle recorded by that receipt. A later manual or third-party
change is not overwritten. Previous code bytes and prior file absence are
restored exactly; `data.json` remains untouched.

If installation fails after the first replacement, the same backup is used
for automatic rollback. A second failure leaves the backup in
`manual_recovery_required` and prints its only recovery path. Do not retry an
install until that receipt has been inspected.

An abrupt installer exit leaves an `applying` receipt and its transaction
lock. Rollback with that exact backup may reclaim the lock only after its
recorded process is no longer alive; mixed installed/previous bytes are then
restored resumably. A rollback interrupted in turn resumes from
`rollback_in_progress` without weakening the third-party-change fence.

## Release gate

`npm run package:bridge-bundle` builds the three Bridges, creates the
exact-commit manifest and emits the release assets under `out/bridge-release`.
It refuses any tracked or untracked non-ignored worktree change. CI runs the transaction tests on Windows
and Linux. Select the qualification scope below before running live recipes.
A changed or previously unqualified installation/rollback path requires an
exact-SHA Pilot 2 cycle:

```text
attest closed Pilot 2 → upgrade → restart
                      → wait for lifecycle/doctor convergence
                      → close → rollback → verify hashes
                      → reinstall candidate → restart → doctor → clean private test backup
```

The readiness wait is bounded and fails closed if the doctor never converges.
The canary owns no note mutation. Its restoration authority is the recorded
pre-install managed-file hashes plus unchanged hashes for every Bridge
`data.json` that existed at the start. On failure it restores those bytes and
leaves Pilot 2 closed, so an intentionally rolled-back Bridge version is never
observed by Operon's Developer API grant policy.

## Proportionate release qualification

This policy governs release-recipe selection throughout the repository, including
feature-specific guides. Their live gates apply to initial admission or changed
or unqualified paths; they do not independently require replay for metadata-only
changes with applicable successful evidence. First qualification is never waived.

| Change | Required qualification |
| --- | --- |
| Version metadata, changelog or documentation only | Check version consistency, documentation contracts and package contents. For a publication, rebuild the assets from the clean published commit and verify the manifest and SHA256SUMS. Reuse applicable live evidence; no automatic vault restart or mutation recipe. |
| Functional MCP or Operon change | Run the affected contract/service tests and the relevant live path when its observable behavior changes. Preserve unrelated valid evidence. |
| Bridge code, grants, installation, rollback or recovery change | Run the affected safety contracts and the real Pilot 2 cycle for those changed paths, including restoration. |

Before qualification, record the changed paths, observable behavior affected,
selected checks and the reason for each live recipe. A candidate followed by a
merge commit does not itself require repeating a recipe: compare functional
inputs and reuse evidence when they are identical.

Evidence reuse requires a successful, scoped proof with its original commit,
runtime versions, configuration and artifact hashes. Record the current commit
and the reviewed diff establishing unchanged relevant code, dependency
resolution, build inputs, grants, schemas and settings. Exclude only explicitly
reviewed documentation and version metadata differences; a version change that
alters consumer identity, grant binding or migration behavior is functional.
Bridge artifact bytes must match the qualified bytes. A new manifest still
binds the assets to the actual published commit. This establishes evidence reuse,
not a newly executed exact-SHA canary.

Reuse is invalid when relevant inputs or artifact bytes change, the proof is
missing/incomplete, or a relevant failure remains unresolved. Run the affected
recipe instead. Unknown impact requires inspection first; it does not justify
blindly replaying every suite. A deferred or untested path remains explicitly
unqualified. These rules do not disable CI, change branch protection or weaken
runtime authorization, confirmations, restoration or rollback fences.
