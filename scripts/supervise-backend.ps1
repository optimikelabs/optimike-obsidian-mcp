<#
.SYNOPSIS
  Keeps the shared HTTP backend running, independently of any MCP client or tunnel.

.DESCRIPTION
  Probes the unauthenticated /healthz endpoint of the backend. After
  -FailureThreshold consecutive failures it starts the backend through the
  launcher you give it (-LaunchArguments, run from -WorkingDirectory), then waits
  for /healthz. Clients that start with automatic backend startup (the stdio
  proxy) attach to a healthy backend instead of spawning their own, so the
  backend stops being a child of a tunnel or of a client session.

  Safety rules:
    - it never touches a process that holds the port while /healthz fails,
      unless -ReplaceUnhealthy is set and that process is a Node process whose
      command line contains the expected entry point (Windows only);
    - at most -MaxRestartsPerHour starts per hour, then it stops restarting and
      says so (a crash loop needs a human);
    - it reads, prints and writes no secret: the launcher owns the environment;
    - one supervisor per port (exclusive lock in -StateDirectory).

  Exit codes with -Once: 0 healthy, or started and healthy; 1 start failed;
  2 port held by an unhealthy process; 3 restart budget exhausted.

  Nothing here registers a scheduled task. See docs/backend-supervision.md.

.EXAMPLE
  pwsh -NoProfile -File scripts/supervise-backend.ps1 -WorkingDirectory <runtime-root> -Port 3010

.EXAMPLE
  pwsh -NoProfile -File scripts/supervise-backend.ps1 -WorkingDirectory <runtime-root> -Port 3010 -Once -DryRun
#>
[CmdletBinding()]
param(
  # Directory the launcher runs from (the runtime root that holds the launcher).
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [string]$NodePath = 'node',
  # Command-line arguments of the backend launch command, passed verbatim to
  # the process (quote any argument that contains a space yourself).
  [string]$LaunchArguments = 'launch.mjs --backend',
  # Text expected in the command line of the process that owns the port.
  [string]$ExpectedEntryPoint = 'index.js',
  [string]$HostName = $(if ($env:MCP_HTTP_HOST) { $env:MCP_HTTP_HOST } else { '127.0.0.1' }),
  [int]$Port = $(if ($env:MCP_HTTP_PORT) { [int]$env:MCP_HTTP_PORT } else { 3010 }),
  [string]$StateDirectory = (Join-Path $WorkingDirectory 'backend-supervisor'),
  [int]$IntervalSeconds = 30,
  [int]$FailureThreshold = 2,
  [int]$StartupGraceSeconds = 90,
  [int]$HealthTimeoutSeconds = 3,
  [int]$MaxRestartsPerHour = 6,
  [int]$KeepProcessLogs = 10,
  [switch]$Once,
  [switch]$ReplaceUnhealthy,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$IsWindowsHost = ($PSVersionTable.PSEdition -eq 'Desktop') -or ($IsWindows -eq $true)
$null = New-Item -ItemType Directory -Force -Path $StateDirectory
$logPath = Join-Path $StateDirectory 'supervisor.log'
$statePath = Join-Path $StateDirectory 'state.json'
$healthUri = "http://${HostName}:${Port}/healthz"

function Write-SupervisorLog([string]$Message) {
  if ((Test-Path -LiteralPath $logPath) -and ((Get-Item -LiteralPath $logPath).Length -gt 1MB)) {
    Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
  }
  $line = (Get-Date).ToUniversalTime().ToString('o') + ' ' + $Message
  Add-Content -LiteralPath $logPath -Encoding utf8 -Value $line
  Write-Verbose $line
}

# Times are stored as Unix seconds: ConvertFrom-Json would turn ISO strings into
# culture-dependent DateTime values.
function Get-UnixNow { return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

function Read-State {
  if (Test-Path -LiteralPath $statePath) {
    try {
      $raw = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
      return @{
        failures = [int]$raw.failures
        restarts = @($raw.restarts | Where-Object { $_ } | ForEach-Object { [long]$_ })
        lastStart = if ($raw.lastStart) { [long]$raw.lastStart } else { $null }
        down = [bool]$raw.down
      }
    } catch { }
  }
  return @{ failures = 0; restarts = @(); lastStart = $null; down = $false }
}

function Write-State($State) {
  [pscustomobject]@{
    failures = $State.failures
    restarts = @($State.restarts)
    lastStart = $State.lastStart
    down = $State.down
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding utf8
}

function Test-BackendHealthy {
  try {
    $response = Invoke-WebRequest -Uri $healthUri -UseBasicParsing -TimeoutSec $HealthTimeoutSeconds
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Test-PortOpen {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect($HostName, $Port, $null, $null)
    if ($pending.AsyncWaitHandle.WaitOne([TimeSpan]::FromSeconds($HealthTimeoutSeconds)) -and $client.Connected) {
      return $true
    }
    return $false
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

# Only a verified Node process running the expected entry point may be replaced.
function Get-ReplaceableOwner {
  if (-not $IsWindowsHost) { return $null }
  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return $null }
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $connection) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
  if ($process -and $process.Name -like 'node*' -and $process.CommandLine -and $process.CommandLine.Contains($ExpectedEntryPoint)) {
    return [int]$connection.OwningProcess
  }
  return $null
}

# Remove empty process logs of dead launches and keep only the most recent ones.
function Remove-StaleProcessLogs {
  $files = @(Get-ChildItem -LiteralPath $StateDirectory -Filter 'backend-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending)
  $index = 0
  foreach ($file in $files) {
    $index++
    $stale = $file.Length -eq 0 -and $file.LastWriteTimeUtc -lt (Get-Date).ToUniversalTime().AddMinutes(-5)
    if ($stale -or $index -gt ($KeepProcessLogs * 2)) {
      Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-Backend($State) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
  $stdout = Join-Path $StateDirectory "backend-$stamp.stdout.log"
  $stderr = Join-Path $StateDirectory "backend-$stamp.stderr.log"
  Write-SupervisorLog "starting backend: $NodePath $LaunchArguments"
  if ($DryRun) {
    Write-SupervisorLog 'dry run: backend not started'
    return $true
  }
  $arguments = @{
    FilePath = $NodePath
    ArgumentList = $LaunchArguments
    WorkingDirectory = $WorkingDirectory
    RedirectStandardOutput = $stdout
    RedirectStandardError = $stderr
    PassThru = $true
  }
  if ($IsWindowsHost) { $arguments.WindowStyle = 'Hidden' }
  $process = Start-Process @arguments
  $State.lastStart = Get-UnixNow
  $State.restarts = @($State.restarts) + @($State.lastStart)
  Write-State $State
  $deadline = (Get-Date).AddSeconds($StartupGraceSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-BackendHealthy) {
      Write-SupervisorLog "backend healthy after start (pid=$($process.Id))"
      return $true
    }
    if ($process.HasExited) {
      Write-SupervisorLog "backend exited during startup (exit=$($process.ExitCode)); see $([IO.Path]::GetFileName($stderr))"
      return $false
    }
  }
  Write-SupervisorLog "backend did not answer /healthz within $StartupGraceSeconds s (pid=$($process.Id))"
  return $false
}

# Returns the exit code of one cycle.
function Invoke-SupervisorCycle {
  $state = Read-State
  Remove-StaleProcessLogs
  if (Test-BackendHealthy) {
    if ($state.down) { Write-SupervisorLog 'backend recovered' }
    $state.failures = 0
    $state.down = $false
    Write-State $state
    return 0
  }

  $state.failures++
  $state.down = $true
  Write-State $state
  Write-SupervisorLog "healthz failed ($($state.failures)/$FailureThreshold)"
  if ($state.failures -lt $FailureThreshold) { return 0 }

  if ($state.lastStart) {
    $sinceStart = (Get-UnixNow) - $state.lastStart
    if ($sinceStart -lt $StartupGraceSeconds) {
      Write-SupervisorLog 'a start is still in its grace period; waiting'
      return 0
    }
  }

  if (Test-PortOpen) {
    $owner = $null
    if ($ReplaceUnhealthy) { $owner = Get-ReplaceableOwner }
    if ($owner) {
      Write-SupervisorLog "replacing unhealthy backend (pid=$owner)"
      if (-not $DryRun) {
        Stop-Process -Id $owner -Force
        Start-Sleep -Seconds 2
      }
    } else {
      Write-SupervisorLog "port $Port is held by a process that fails /healthz; not touching it (use -ReplaceUnhealthy to replace a verified backend)"
      return 2
    }
  }

  $cutoff = (Get-UnixNow) - 3600
  $recent = @($state.restarts | Where-Object { $_ -gt $cutoff })
  $state.restarts = $recent
  if ($recent.Count -ge $MaxRestartsPerHour) {
    Write-SupervisorLog "restart budget exhausted ($MaxRestartsPerHour per hour); not restarting"
    Write-State $state
    return 3
  }

  if (Start-Backend $state) {
    $state = Read-State
    $state.failures = 0
    $state.down = $false
    Write-State $state
    return 0
  }
  return 1
}

# One supervisor per port: an exclusive lock that the OS releases with the process.
$lockPath = Join-Path $StateDirectory "supervisor-$Port.lock"
try {
  $lock = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  Write-SupervisorLog 'another supervisor already runs for this port; exiting'
  exit 0
}

try {
  if ($Once) {
    exit (Invoke-SupervisorCycle)
  }
  Write-SupervisorLog "supervising $healthUri every $IntervalSeconds s"
  while ($true) {
    try {
      $null = Invoke-SupervisorCycle
    } catch {
      Write-SupervisorLog "cycle failed: $($_.Exception.GetType().Name)"
    }
    Start-Sleep -Seconds $IntervalSeconds
  }
} finally {
  $lock.Close()
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
