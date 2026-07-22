[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $VaultPath,

  [Parameter(Mandatory = $true)]
  [string] $KairelysBuildPath,

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
$build = Resolve-ExistingDirectory $KairelysBuildPath "KairelysBuildPath"
$pluginsRoot = Join-Path $vault ".obsidian\plugins"
$sourceRoot = Join-Path $pluginsRoot "operon"
$targetRoot = Join-Path $pluginsRoot "kairelys"
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
  throw "Operon source plugin folder not found: $sourceRoot"
}

$requiredBuildFiles = @("main.js", "manifest.json", "styles.css")
foreach ($name in $requiredBuildFiles) {
  $candidate = Join-Path $build $name
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Kairélys build file missing: $candidate"
  }
}

$manifest = Get-Content -Raw -LiteralPath (Join-Path $build "manifest.json") | ConvertFrom-Json
if ($manifest.id -ne "kairelys" -or $manifest.name -ne "Kairélys") {
  throw "Build manifest must identify Kairélys (id=kairelys, name=Kairélys)."
}

$sourceDataPath = Join-Path $sourceRoot "data.json"
if (-not (Test-Path -LiteralPath $sourceDataPath -PathType Leaf)) {
  throw "Operon data.json not found: $sourceDataPath"
}
$null = Get-Content -Raw -LiteralPath $sourceDataPath | ConvertFrom-Json
$sourceDataHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceDataPath).Hash
if ($ExpectedSourceDataSha256 -and $sourceDataHash -ne $ExpectedSourceDataSha256.ToUpperInvariant()) {
  throw "Operon data.json changed: expected $ExpectedSourceDataSha256, found $sourceDataHash."
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
  throw "Disable Operon and Kairélys before applying migration. Active: $($activeEngines -join ', ')"
}
if (-not $buildPathSafeForApply) {
  throw "KairelysBuildPath must be outside the target plugin folder before applying: $targetRoot"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $pluginsRoot ".optimike-backups\kairelys-cutover-$timestamp"
Assert-ChildPath $pluginsRoot $backupRoot "backupRoot"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

if (Test-Path -LiteralPath $targetRoot) {
  $targetBackup = Join-Path $backupRoot "previous-kairelys"
  Move-Item -LiteralPath $targetRoot -Destination $targetBackup
}

New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
foreach ($name in $requiredBuildFiles) {
  Copy-Item -LiteralPath (Join-Path $build $name) -Destination (Join-Path $targetRoot $name)
}
foreach ($name in $durableEntries) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $targetRoot $name) -Recurse
}

# Non-English packs are intentionally downloaded at runtime by Operon/Kairélys.
# During a local cutover the future public release URL may not exist yet, so seed
# the pack generated by the exact build when it is available. Index/cache data
# remains excluded and is rebuilt by the plugin.
$seededLocale = $null
$targetData = Get-Content -Raw -LiteralPath (Join-Path $targetRoot "data.json") | ConvertFrom-Json
$configuredLanguage = [string] $targetData.settings.language
$localeCatalogPath = Join-Path $build "src\generated\locale-pack-catalog.json"
if ($configuredLanguage -and $configuredLanguage -notin @("auto", "en") -and (Test-Path -LiteralPath $localeCatalogPath -PathType Leaf)) {
  $localeCatalog = Get-Content -Raw -LiteralPath $localeCatalogPath | ConvertFrom-Json
  $catalogEntry = $localeCatalog.locales.PSObject.Properties[$configuredLanguage].Value
  if ($catalogEntry) {
    $localeAssetPath = Join-Path $build ("release-assets\locales\" + [string] $catalogEntry.assetName)
    if (-not (Test-Path -LiteralPath $localeAssetPath -PathType Leaf)) {
      throw "Generated locale asset is missing: $localeAssetPath"
    }
    $actualLocaleHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localeAssetPath).Hash.ToLowerInvariant()
    if ($actualLocaleHash -ne ([string] $catalogEntry.sha256).ToLowerInvariant()) {
      throw "Generated locale asset hash mismatch for $configuredLanguage."
    }
    $localePack = Get-Content -Raw -LiteralPath $localeAssetPath | ConvertFrom-Json
    $localeRoot = Join-Path $targetRoot "runtime\locales"
    $localePacksRoot = Join-Path $localeRoot "packs"
    New-Item -ItemType Directory -Path $localePacksRoot -Force | Out-Null
    Copy-Item -LiteralPath $localeAssetPath -Destination (Join-Path $localePacksRoot ([string] $catalogEntry.assetName))
    $localeManifest = [ordered]@{
      version = 1
      locales = [ordered]@{
        $configuredLanguage = [ordered]@{
          fileName = [string] $catalogEntry.assetName
          sha256 = [string] $catalogEntry.sha256
          sizeBytes = [int64] $catalogEntry.sizeBytes
          schemaVersion = [int] $localePack.schemaVersion
          sourceVersion = [string] $localePack.sourceVersion
          keyCount = [int] $localePack.keyCount
          keyFingerprint = [string] $localePack.keyFingerprint
          installedAt = (Get-Date).ToUniversalTime().ToString("o")
        }
      }
    }
    $localeManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $localeRoot "manifest.json") -Encoding utf8
    $seededLocale = $configuredLanguage
  }
}

$targetManifest = Get-Content -Raw -LiteralPath (Join-Path $targetRoot "manifest.json") | ConvertFrom-Json
$targetDataPath = Join-Path $targetRoot "data.json"
$null = Get-Content -Raw -LiteralPath $targetDataPath | ConvertFrom-Json
$targetDataHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $targetDataPath).Hash
if ($targetManifest.id -ne "kairelys" -or $targetDataHash -ne $sourceDataHash) {
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
  seededLocale = $seededLocale
  nextAction = "Enable kairelys, reload optimike-operon-bridge, then validate through operon_status and operon_get_configuration."
} | ConvertTo-Json -Depth 5
