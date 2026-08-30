# Bridge lifecycle recovery

French version: [bridge-lifecycle.fr.md](bridge-lifecycle.fr.md)

Optimike MCP `3.3.0` bundles a shared lifecycle supervisor for the Operon,
Atomic Write and Bases Bridges. It removes the former 30-second registration
window: a Bridge can load before Local REST API, and a running MCP client can
survive an Obsidian or Local REST API reload without being restarted.

## Contract

- Each Bridge waits for Obsidian layout readiness, then probes Local REST API
  indefinitely.
- An unavailable or failed provider is retried with bounded exponential
  backoff from 250 ms to 5 seconds. A ready provider is checked every second.
- Exactly one recursive timer and one mounted provider generation exist per
  lifecycle. The same provider is never registered twice.
- When the provider disappears or its object identity changes, the old
  extension is unregistered before the replacement is mounted.
- Mount and cleanup failures are contained. A failed cleanup keeps the old
  generation fenced in `degraded`, does not advance `unloadGeneration`, and
  blocks replacement mounting until that same cleanup succeeds. Failures
  during a partial route mount retain the same fence if rollback fails, so a
  retry cannot register over surviving routes. Failures never enable writes or
  change an Operon grant.
- Stopping or disabling a Bridge cancels its timer and unregisters its current
  extension.

The Bases Bridge applies the same contract independently to its Local REST
routes and to the optional headless Bases view. Disabling the Bases engine
stops only that headless lifecycle.

## Status semantics

Bridge status responses may include:

```json
{
  "lifecycle": {
    "state": "ready",
    "running": true,
    "mountGeneration": 2,
    "unloadGeneration": 1,
    "consecutiveFailures": 0,
    "nextProbeDelayMs": 1000
  }
}
```

`state: ready` means only that the Bridge route is mounted on the current Local
REST provider. It does not mean that Operon is indexed, that a grant is
approved, or that writes are enabled. `operon_status` therefore preserves the
live lifecycle projection even while the Operon runtime is still initializing;
all read and mutation operations keep their stricter readiness gates.

The field is additive and optional so an MCP upgrade can still diagnose an
older installed Bridge. Existing write settings remain authoritative:

- Operon Bridge: its mutation setting plus `OPERON_MUTATIONS_ENABLED=true`;
- Atomic Write Bridge: its Note/Frontmatter and Canvas write settings;
- Bases Bridge: its atomic Base and legacy configuration write settings.

## Live acceptance

The exact-SHA gate uses the disposable Pilot 2 vault. It starts one stdio MCP
client, records the three Bridge status envelopes, disables Local REST API
inside the same Obsidian process, proves the MCP connection remains alive,
re-enables Local REST API, and waits for all three routes to return. The gate
passes only when every mount and unload generation advances, the Operon index
becomes live again, and every write projection is byte-for-byte equivalent to
its pre-reload value. The canary MCP itself runs read-only and dispatches no
mutation.

```powershell
$env:OBSIDIAN_VAULT = '<exact Pilot 2 path>'
$env:OBSIDIAN_BASE_URL = 'http://127.0.0.1:27233'
$env:OBSIDIAN_API_KEY = '<Local REST API key>'
$env:BRIDGE_LIFECYCLE_CANARY_CONFIRM = 'I_CONFIRM_PILOT_2_LOCAL_REST_RELOAD'
npm run smoke:bridge-lifecycle-live
```

The script requires a clean worktree and verifies that all three installed
Bridge bundles and manifests equal the exact local candidate. It writes a
redacted JSON receipt to the operating-system temporary directory and prints
the exact path. Every spawned build, Git, or Obsidian CLI process is terminated
and awaited if its timeout expires; the Local REST restoration fence is armed
before the disable command. If cleanup is needed after an interruption,
re-enable Local REST API in the Pilot 2 Community Plugins settings before any
other test.
