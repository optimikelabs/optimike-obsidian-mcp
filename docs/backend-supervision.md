# Backend supervision

The shared HTTP backend (`dist/index.js` with `MCP_TRANSPORT_TYPE=http`) serves every client of a workstation. Nothing in the repository restarts it, and a backend started by a client's stdio proxy is a descendant of that client or of the tunnel that launched the proxy. On one production runtime the backend was a child of a tunnel's stdio launcher, the tunnel had asked to stop 22 times in a month, and no component restarted the backend afterwards.

[`scripts/supervise-backend.ps1`](../scripts/supervise-backend.ps1) closes that gap. It is a small PowerShell script (PowerShell 7 or Windows PowerShell 5.1) that watches `GET /healthz` and starts the backend through the launcher you give it, from outside any client or tunnel. The repository installs and schedules nothing: you decide where and how it runs.

## What it does

- Probes the unauthenticated `/healthz` endpoint. After `-FailureThreshold` consecutive failures (default 2) it starts the backend with `-NodePath` and `-LaunchArguments` from `-WorkingDirectory`, then waits up to `-StartupGraceSeconds` (default 90) for `/healthz`.
- A client that starts with automatic backend startup (the stdio proxy) first checks `/healthz` and attaches to a healthy backend instead of spawning one, so once the supervisor owns the backend the clients attach to it. Nothing changes in how clients are configured.
- Never touches a process that holds the port while `/healthz` fails: it logs that and exits with code 2. `-ReplaceUnhealthy` allows replacing it only on Windows and only when it is a Node process whose command line contains `-ExpectedEntryPoint` (default `index.js`).
- Starts at most `-MaxRestartsPerHour` times per hour (default 6), then stops restarting, logs it and exits with code 3: a crash loop needs a person.
- Keeps one supervisor per port with an exclusive lock, and deletes empty process logs of old launches.
- Reads, prints and writes no secret. The launcher owns the environment: the supervisor only runs the command you give it.

## Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `-WorkingDirectory` | required | directory the launch command runs from |
| `-NodePath` | `node` | executable that starts the backend |
| `-LaunchArguments` | `launch.mjs --backend` | arguments passed verbatim; quote any argument that contains a space |
| `-HostName`, `-Port` | `MCP_HTTP_HOST` or `127.0.0.1`, `MCP_HTTP_PORT` or `3010` | backend address to probe |
| `-StateDirectory` | `<WorkingDirectory>/backend-supervisor` | `supervisor.log` (rotates at 1 MiB), `state.json`, lock and process logs |
| `-IntervalSeconds` | `30` | pause between probes in loop mode |
| `-FailureThreshold` | `2` | consecutive failures before a restart |
| `-StartupGraceSeconds` | `90` | time given to a starting backend |
| `-HealthTimeoutSeconds` | `3` | timeout of one probe |
| `-MaxRestartsPerHour` | `6` | restart budget |
| `-KeepProcessLogs` | `10` | process logs kept per stream |
| `-Once` | off | one cycle, then exit with the code below (for an external scheduler) |
| `-ReplaceUnhealthy` | off | replace a verified unhealthy backend |
| `-DryRun` | off | log what would be done and start nothing |

Exit codes with `-Once`: `0` healthy, or started and healthy; `1` the start failed; `2` the port is held by an unhealthy process; `3` the restart budget is exhausted.

## Procedure

1. Dry run, with the backend stopped:

   ```powershell
   pwsh -NoProfile -File scripts/supervise-backend.ps1 -WorkingDirectory <runtime-root> -Port <port> -FailureThreshold 1 -Once -DryRun -Verbose
   ```

   The log must say `starting backend` and `dry run: backend not started`.
2. Real run, still with the backend stopped: remove `-DryRun`. Expect `backend healthy after start`, then confirm `/healthz` and `/readyz` and that a client reaches the backend.
3. Register the supervisor, as the user who owns the launcher environment (the launcher may read per-user variables), once the dry run and the real run behave:

   ```powershell
   $action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument '-NoProfile -WindowStyle Hidden -File "<path-to>\supervise-backend.ps1" -WorkingDirectory "<runtime-root>" -Port <port>'
   $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
   $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
   Register-ScheduledTask -TaskName 'Backend Supervisor' -Action $action -Trigger $trigger -Settings $settings
   ```

   The task runs the loop mode: one long-lived process that is also the parent of the backend it starts. Leave any existing tunnel or client startup task unchanged.
4. Check the restart path: stop the backend process, then read `supervisor.log`. Within about `FailureThreshold × IntervalSeconds` plus the startup time it shows `healthz failed (1/2)`, `healthz failed (2/2)`, `starting backend`, `backend healthy after start`.

## Operating it

- Shipping a new release: switch the active release, then stop the backend process. The supervisor starts it again from the new release through the launcher. Check the runtime fingerprint with `obsidian_runtime_status`.
- Stopping the supervisor's task may also stop a backend it started (the scheduler can end the whole process tree). A client's stdio proxy then starts a backend again when it next needs one.
- Rollback: `Unregister-ScheduledTask -TaskName 'Backend Supervisor' -Confirm:$false`, stop the supervisor process, and delete `-StateDirectory` if you no longer need its log.
- Read `supervisor.log` first. `restart budget exhausted` and `port ... is held by a process that fails /healthz` are the two states that need a person.

## Limits

- `/healthz` proves the process and the HTTP listener answer. It does not prove that Obsidian, the shared cache, a Bridge or a semantic provider is ready: use `/readyz` and the authenticated runtime tools.
- The supervisor itself is not supervised beyond the scheduler's restart settings.
- The contract test drives the script against a fake backend. It does not prove the behaviour of a given Windows scheduler configuration, fast startup or sleep; verify those on the target workstation with step 4.
