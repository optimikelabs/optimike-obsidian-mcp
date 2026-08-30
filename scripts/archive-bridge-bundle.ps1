param(
  [string] $RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$repository = [System.IO.Path]::GetFullPath($RepositoryRoot)
$outRoot = [System.IO.Path]::GetFullPath((Join-Path $repository "out"))
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $outRoot "bridge-release"))

function Assert-StrictChildPath {
  param([string] $Parent, [string] $Candidate, [string] $Label)
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
  if (-not $candidateFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escapes its expected parent."
  }
}

Assert-StrictChildPath -Parent $repository -Candidate $outRoot -Label "Output root"
Assert-StrictChildPath -Parent $outRoot -Candidate $releaseRoot -Label "Release root"

$package = Get-Content -LiteralPath (Join-Path $repository "package.json") -Raw -Encoding utf8 | ConvertFrom-Json
$bundleName = "optimike-bridge-bundle-v$($package.version)"
$bundleRoot = [System.IO.Path]::GetFullPath((Join-Path $outRoot "bridge-bundle\$bundleName"))
Assert-StrictChildPath -Parent $outRoot -Candidate $bundleRoot -Label "Bundle root"
if (-not (Test-Path -LiteralPath (Join-Path $bundleRoot "bridge-bundle.json") -PathType Leaf)) {
  throw "The verified Bridge bundle directory does not exist. Run build-bridge-bundle.mjs first."
}

if (Test-Path -LiteralPath $releaseRoot) {
  Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $releaseRoot | Out-Null

$zipPath = Join-Path $releaseRoot "$bundleName.zip"
Compress-Archive -LiteralPath $bundleRoot -DestinationPath $zipPath -CompressionLevel Optimal
$publicManifest = Join-Path $releaseRoot "$bundleName.manifest.json"
Copy-Item -LiteralPath (Join-Path $bundleRoot "bridge-bundle.json") -Destination $publicManifest

$checksumPath = Join-Path $releaseRoot "SHA256SUMS"
$checksumLines = @($zipPath, $publicManifest) | ForEach-Object {
  $hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $([System.IO.Path]::GetFileName($_))"
}
[System.IO.File]::WriteAllLines($checksumPath, $checksumLines, [System.Text.UTF8Encoding]::new($false))

[pscustomobject]@{
  ok = $true
  bundleVersion = [string] $package.version
  zipPath = $zipPath
  manifestPath = $publicManifest
  checksumsPath = $checksumPath
} | ConvertTo-Json -Compress
