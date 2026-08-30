# Runtime Capability Doctor

French version: [capability-doctor.fr.md](capability-doctor.fr.md)

`obsidian_runtime_status` is the single canonical diagnostic surface for the
active Optimike MCP process. It keeps the existing redacted runtime status and
adds `capabilityManifest`, a versioned JSON contract. No additional MCP tool is
introduced.

Use it when a tool is absent, a Bridge is cold, Operon appears read-only, or an
HTTP request was rejected by admission control. The doctor observes state only:
it never repairs a runtime, grants a capability, starts a plugin, or mutates the
vault.

## Contract

The first public contract is `capabilityManifest.contractVersion: 1`. Every
capability reports three independent facts:

- `discoverable`: at least one preferred tool for the capability is present in
  the active MCP profile and concrete server instance;
- `available`: the required backend contract is currently usable;
- `authorized`: the current credentials, Bridge switch, or Operon grant allows
  the capability.

These booleans must not be collapsed. For example, an Operon mutation can be
discoverable and technically available while `authorized: false` because its
Developer API grant is still pending. A healthy Canvas Bridge can also be
available and authorized while `discoverable: false` under the `standard`
profile.

Each entry also provides:

- `state`: `ready`, `degraded`, `blocked`, `unavailable`, or `hidden`;
- `reasonCode`: a closed, stable machine-readable cause;
- `nextAction`: one safe, closed action code;
- `preferredTools`: bounded canonical tool names, never caller or backend data.

The manifest covers Local REST, vault reads, semantic search, the governed
Note, Frontmatter, Canvas and Base lifecycles, and Operon reads and writes.
Operon cached reads are reported as `degraded` with
`operon_snapshot_fallback`; cached state is never presented as proof that a
mutation can run or was applied.

`operon-write.operations` projects every public mutation route separately.
`operon_mutations_disabled` means the Bridge write switch is off.
`mcp_operon_mutations_disabled` means the separate MCP apply opt-in remains
off, while `write_policy_blocked` and `operation_policy_blocked` preserve the
global or operation-specific `MCP_WRITE_MODE` boundary. Dry-runs can remain
available without claiming that apply is authorized.
`operon_capability_not_advertised` means the latest status snapshot does not
advertise that exact operation; the safe next step is to invoke its exact
dry-run/plan path so Operon can negotiate only that capability. The doctor does
not request the grant itself. A mix of advertised and cold operations is
`operon_partial_capabilities`, never a blanket write authorization.

## Profile, runtime, and authorization are separate

The doctor distinguishes three common absence causes:

| Cause                                                             | `reasonCode`               | Safe action           |
| ----------------------------------------------------------------- | -------------------------- | --------------------- |
| The selected profile intentionally hides the family               | `profile_hidden`           | `switch_tool_profile` |
| The runtime mode cannot host the family                           | `runtime_mode_unavailable` | `use_live_runtime`    |
| The mode and profile allow it, but its runtime did not initialize | `runtime_not_initialized`  | `restart_mcp_runtime` |

This prevents a static profile catalogue from claiming that a governed tool is
discoverable when the corresponding Bridge runtime was not actually mounted.

## Bounded live probes

One status call probes Local REST, Atomic Write, Bases Atomic and Operon in
parallel. Every probe has a 2.5-second request timeout. A failed probe is
projected to a closed state; raw HTTP errors, backend payloads and exception
messages never enter the manifest.

The HTTP admission projection contains aggregate counters only. `pressured`
means queueing, rejection, timeout, or cancellation has been observed by the
current process. If the doctor request itself cannot be admitted, the public
admission error is authoritative: retry after the advertised bounded delay.

## Privacy boundary

The doctor never returns:

- vault or journal paths;
- Local REST or Bridge URLs;
- API keys, authorization headers, binding fingerprints or configuration
  hashes;
- note, Frontmatter, Base, Canvas, task, or error content;
- raw Bridge diagnostics or raw exception messages.

The contract is tested through the pure projection, a real in-memory MCP call,
the immutable HTTP profile routes, and timeout fixtures. Run:

```bash
npm run test:capability-doctor
```

The release canary is read-only but must target the disposable Pilot 2 vault.
It starts the exact candidate, calls the doctor through `standard`, `authoring`,
`tasks`, and `full`, verifies all three Bridges plus Operon, writes one redacted
JSON proof in the OS temporary directory, and records `vaultMutations: 0`:

```bash
CAPABILITY_DOCTOR_CANARY_CONFIRM=I_UNDERSTAND_THIS_IS_A_READ_ONLY_PILOT_2_CANARY \
OBSIDIAN_API_KEY=... \
OBSIDIAN_BASE_URL=http://127.0.0.1:... \
OBSIDIAN_VAULT=/absolute/path/to/pilot-2 \
npm run smoke:capability-doctor-live
```

Related authorities: [Tool Surface Profiles](tool-surface-profiles.md),
[Runtime Capability Matrix](runtime-capability-matrix.md),
[Bridge Lifecycle Recovery](bridge-lifecycle.md), and
[Operations](../OPERATIONS.md).
