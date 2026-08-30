# Bridge bundle, upgrade and rollback

Optimike MCP `3.5.0` ships one release bundle for the three Obsidian Bridges:

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
and Linux. Release admission additionally requires an exact-SHA Pilot 2 cycle:

```text
attest closed Pilot 2 → upgrade → restart → doctor
                      → close → rollback → verify hashes
                      → reinstall candidate → restart → doctor → clean private test backup
```

The canary owns no note mutation. Its restoration authority is the recorded
pre-install managed-file hashes plus unchanged hashes for every Bridge
`data.json` that existed at the start. On failure it restores those bytes and
leaves Pilot 2 closed, so an intentionally rolled-back Bridge version is never
observed by Operon's Developer API grant policy.
