[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$forwardScript = Join-Path $PSScriptRoot "migrate-operon-to-kairelys.ps1"
$reverseScript = Join-Path $PSScriptRoot "migrate-kairelys-to-operon.ps1"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
  "optimike-task-engine-migrations-" + [guid]::NewGuid().ToString("N")
)
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Assert-True([bool] $Condition, [string] $Message) {
  if (-not $Condition) { throw $Message }
}

function Write-Utf8([string] $Path, [string] $Content) {
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

function New-PluginBuild(
  [string] $Path,
  [string] $Id,
  [string] $Name,
  [string] $Version
) {
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
  Write-Utf8 (Join-Path $Path "manifest.json") (
    [ordered]@{ id = $Id; name = $Name; version = $Version; minAppVersion = "1.6.0" } |
      ConvertTo-Json -Compress
  )
  Write-Utf8 (Join-Path $Path "main.js") "module.exports = {};"
  Write-Utf8 (Join-Path $Path "styles.css") "/* fixture */"
}

function New-DurablePlugin(
  [string] $Path,
  [string] $Id,
  [string] $Name,
  [string] $Version,
  [string] $Marker
) {
  New-PluginBuild $Path $Id $Name $Version
  Write-Utf8 (Join-Path $Path "data.json") (
    [ordered]@{ settings = [ordered]@{ language = "fr" }; marker = $Marker } |
      ConvertTo-Json -Compress
  )
  Write-Utf8 (Join-Path $Path "data\fixture.json") "{`"marker`":`"$Marker-data`"}"
  Write-Utf8 (Join-Path $Path "state\fixture.json") "{`"marker`":`"$Marker-state`"}"
  Write-Utf8 (Join-Path $Path "runtime\ignored.json") "{`"ignored`":true}"
  Write-Utf8 (Join-Path $Path "cache\ignored.json") "{`"ignored`":true}"
}

function Invoke-MigrationJson([string] $Script, [hashtable] $Arguments) {
  $lines = & $Script @Arguments
  return (($lines -join [Environment]::NewLine) | ConvertFrom-Json)
}

function Test-ReverseMigration([string] $Root) {
  $vault = Join-Path $Root "vault"
  $plugins = Join-Path $vault ".obsidian\plugins"
  $source = Join-Path $plugins "kairelys"
  $target = Join-Path $plugins "operon"
  $build = Join-Path $Root "official-operon-build"

  New-DurablePlugin $source "kairelys" "Kairélys" "2.5.3" "reverse-source"
  New-DurablePlugin $target "operon" "Operon" "2.5.0" "previous-operon"
  New-PluginBuild $build "operon" "Operon" "2.6.0"

  $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $source "data.json")).Hash
  $result = Invoke-MigrationJson $reverseScript @{
    VaultPath = $vault
    OperonBuildPath = $build
    ExpectedSourceDataSha256 = $sourceHash
    Apply = $true
  }

  $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target "data.json")).Hash
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $target "manifest.json") | ConvertFrom-Json
  Assert-True ($result.status -eq "applied") "Reverse migration did not report applied."
  Assert-True ($manifest.id -eq "operon") "Reverse migration installed the wrong plugin ID."
  Assert-True ($targetHash -eq $sourceHash) "Reverse migration changed data.json."
  Assert-True (Test-Path -LiteralPath (Join-Path $result.backup "previous-operon")) "Reverse migration backup is missing."
  Assert-True (Test-Path -LiteralPath (Join-Path $target "data\fixture.json")) "Reverse migration omitted durable data/."
  Assert-True (Test-Path -LiteralPath (Join-Path $target "state\fixture.json")) "Reverse migration omitted durable state/."
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $target "runtime\ignored.json"))) "Reverse migration copied runtime/."
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $target "cache\ignored.json"))) "Reverse migration copied cache/."

  Write-Utf8 (Join-Path $vault ".obsidian\community-plugins.json") '["operon"]'
  $hashBeforeActiveRefusal = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target "data.json")).Hash
  $activeBlocked = $false
  try {
    Invoke-MigrationJson $reverseScript @{
      VaultPath = $vault
      OperonBuildPath = $build
      ExpectedSourceDataSha256 = $sourceHash
      Apply = $true
    } | Out-Null
  } catch {
    $activeBlocked = $_.Exception.Message -like "*Disable Kairélys and Operon*"
  }
  $hashAfterActiveRefusal = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target "data.json")).Hash
  Assert-True $activeBlocked "Reverse migration did not reject an active engine."
  Assert-True ($hashBeforeActiveRefusal -eq $hashAfterActiveRefusal) "Active-engine refusal changed the target."

  Write-Utf8 (Join-Path $vault ".obsidian\community-plugins.json") '[]'
  $unsafeBlocked = $false
  try {
    Invoke-MigrationJson $reverseScript @{
      VaultPath = $vault
      OperonBuildPath = $target
      ExpectedSourceDataSha256 = $sourceHash
      Apply = $true
    } | Out-Null
  } catch {
    $unsafeBlocked = $_.Exception.Message -like "*must be outside the target plugin folder*"
  }
  Assert-True $unsafeBlocked "Reverse migration did not reject an in-target build."
}

function Test-ForwardMigration([string] $Root) {
  $vault = Join-Path $Root "vault"
  $plugins = Join-Path $vault ".obsidian\plugins"
  $source = Join-Path $plugins "operon"
  $target = Join-Path $plugins "kairelys"
  $build = Join-Path $Root "kairelys-build"

  New-DurablePlugin $source "operon" "Operon" "2.5.0" "forward-source"
  New-DurablePlugin $target "kairelys" "Kairélys" "2.5.2" "previous-kairelys"
  New-PluginBuild $build "kairelys" "Kairélys" "2.5.3"

  $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $source "data.json")).Hash
  $result = Invoke-MigrationJson $forwardScript @{
    VaultPath = $vault
    KairelysBuildPath = $build
    ExpectedSourceDataSha256 = $sourceHash
    Apply = $true
  }

  $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target "data.json")).Hash
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $target "manifest.json") | ConvertFrom-Json
  Assert-True ($result.status -eq "applied") "Forward migration did not report applied."
  Assert-True ($manifest.id -eq "kairelys") "Forward migration installed the wrong plugin ID."
  Assert-True ($targetHash -eq $sourceHash) "Forward migration changed data.json."
  Assert-True (Test-Path -LiteralPath (Join-Path $result.backup "previous-kairelys")) "Forward migration backup is missing."
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $target "runtime\ignored.json"))) "Forward migration copied runtime/."
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $target "cache\ignored.json"))) "Forward migration copied cache/."
}

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  Test-ReverseMigration (Join-Path $tempRoot "reverse")
  Test-ForwardMigration (Join-Path $tempRoot "forward")
  Write-Output "PASS: bidirectional task-engine migrations, backups, durable state, active-engine refusal, and build-path safety"
} finally {
  $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
  $tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $leaf = [System.IO.Path]::GetFileName($resolvedTemp)
  if (
    $resolvedTemp.StartsWith($tempParent, [System.StringComparison]::OrdinalIgnoreCase) -and
    $leaf.StartsWith("optimike-task-engine-migrations-")
  ) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
