[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $VaultPath,

  [Parameter(Mandatory = $true)]
  [string] $OperonBuildPath,

  [string] $ExpectedSourceDataSha256 = "",

  [switch] $Apply
)

$ErrorActionPreference = "Stop"

function Resolve-ExistingDirectory([string] $Path, [string] $Label) {
  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
  $item = Get-Item -LiteralPath $resolved.Path
  if (-not $item.PSIsContainer) {
    throw "$Label is not a directory: $($resolved.Path)"
  }
  return $resolved.Path
}

function Assert-ChildPath([string] $Parent, [string] $Child, [string] $Label) {
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $childFull = [System.IO.Path]::GetFullPath($Child)
  if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escapes the intended parent directory: $childFull"
  }
}

$vault = Resolve-ExistingDirectory $VaultPath "VaultPath"
$build = Resolve-ExistingDirectory $OperonBuildPath "OperonBuildPath"
$pluginsRoot = Join-Path $vault ".obsidian\plugins"
$sourceRoot = Join-Path $pluginsRoot "kairelys"
$targetRoot = Join-Path $pluginsRoot "operon"
$enabledPath = Join-Path $vault ".obsidian\community-plugins.json"

Assert-ChildPath $vault $pluginsRoot "pluginsRoot"
Assert-ChildPath $pluginsRoot $sourceRoot "sourceRoot"
Assert-ChildPath $pluginsRoot $targetRoot "targetRoot"

$buildFull = [System.IO.Path]::GetFullPath($build).TrimEnd('\')
$targetFull = [System.IO.Path]::GetFullPath($targetRoot).TrimEnd('\')
$buildPathSafeForApply =
  $buildFull -ne $targetFull -and
  -not $buildFull.StartsWith($targetFull + '\', [System.StringComparison]::OrdinalIgnoreCase)

if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
  throw "Kairélys source plugin folder not found: $sourceRoot"
}

$requiredBuildFiles = @("main.js", "manifest.json", "styles.css")
foreach ($name in $requiredBuildFiles) {
  $candidate = Join-Path $build $name
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Operon build file missing: $candidate"
  }
}

$manifest = Get-Content -Raw -LiteralPath (Join-Path $build "manifest.json") | ConvertFrom-Json
if ($manifest.id -ne "operon" -or $manifest.name -ne "Operon") {
  throw "Build manifest must identify Operon (id=operon, name=Operon)."
}

$sourceDataPath = Join-Path $sourceRoot "data.json"
if (-not (Test-Path -LiteralPath $sourceDataPath -PathType Leaf)) {
  throw "Kairélys data.json not found: $sourceDataPath"
}
$null = Get-Content -Raw -LiteralPath $sourceDataPath | ConvertFrom-Json
$sourceDataHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceDataPath).Hash
if ($ExpectedSourceDataSha256 -and $sourceDataHash -ne $ExpectedSourceDataSha256.ToUpperInvariant()) {
  throw "Kairélys data.json changed: expected $ExpectedSourceDataSha256, found $sourceDataHash."
}

$enabled = @()
if (Test-Path -LiteralPath $enabledPath -PathType Leaf) {
  $enabled = @(Get-Content -Raw -LiteralPath $enabledPath | ConvertFrom-Json)
}
$activeEngines = @($enabled | Where-Object { $_ -in @("operon", "kairelys") })

$durableEntries = @("data.json", "data", "state") | Where-Object {
  Test-Path -LiteralPath (Join-Path $sourceRoot $_)
}
$excludedEntries = @("runtime", "cache")

$plan = [ordered]@{
  mode = if ($Apply) { "apply" } else { "dry-run" }
  vault = $vault
  source = $sourceRoot
  target = $targetRoot
  build = $build
  sourceDataSha256 = $sourceDataHash
  buildVersion = [string] $manifest.version
  durableEntries = $durableEntries
  excludedRebuildableEntries = $excludedEntries
  activeTaskEngines = $activeEngines
  targetExists = Test-Path -LiteralPath $targetRoot
  buildPathSafeForApply = $buildPathSafeForApply
}

if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 5
  exit 0
}

if ($activeEngines.Count -gt 0) {
  throw "Disable Kairélys and Operon before applying migration. Active: $($activeEngines -join ', ')"
}
if (-not $buildPathSafeForApply) {
  throw "OperonBuildPath must be outside the target plugin folder before applying: $targetRoot"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $pluginsRoot ".optimike-backups\operon-return-$timestamp"
Assert-ChildPath $pluginsRoot $backupRoot "backupRoot"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

if (Test-Path -LiteralPath $targetRoot) {
  $targetBackup = Join-Path $backupRoot "previous-operon"
  Move-Item -LiteralPath $targetRoot -Destination $targetBackup
}

New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
foreach ($name in $requiredBuildFiles) {
  Copy-Item -LiteralPath (Join-Path $build $name) -Destination (Join-Path $targetRoot $name)
}
foreach ($name in $durableEntries) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $targetRoot $name) -Recurse
}

$targetManifest = Get-Content -Raw -LiteralPath (Join-Path $targetRoot "manifest.json") | ConvertFrom-Json
$targetDataPath = Join-Path $targetRoot "data.json"
$null = Get-Content -Raw -LiteralPath $targetDataPath | ConvertFrom-Json
$targetDataHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $targetDataPath).Hash
if ($targetManifest.id -ne "operon" -or $targetDataHash -ne $sourceDataHash) {
  throw "Post-copy validation failed. The recoverable backup is at $backupRoot"
}

[ordered]@{
  status = "applied"
  target = $targetRoot
  backup = $backupRoot
  sourceDataSha256 = $sourceDataHash
  targetDataSha256 = $targetDataHash
  copiedDurableEntries = $durableEntries
  excludedRebuildableEntries = $excludedEntries
  nextAction = "Enable operon, reload optimike-operon-bridge, then validate through operon_status and operon_get_configuration."
} | ConvertTo-Json -Depth 5
