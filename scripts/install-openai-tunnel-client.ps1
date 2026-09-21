[CmdletBinding()]
param(
  [string]$Version = "latest",
  [ValidateSet("", "amd64", "arm64")]
  [string]$Architecture = "",
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Optimike\tunnel-client")
)

$ErrorActionPreference = "Stop"
$headers = @{ "User-Agent" = "optimike-obsidian-mcp-tunnel-installer" }

if (-not $Architecture) {
  $Architecture = switch ($env:PROCESSOR_ARCHITECTURE.ToUpperInvariant()) {
    "AMD64" { "amd64" }
    "ARM64" { "arm64" }
    default { throw "Unsupported Windows architecture: $env:PROCESSOR_ARCHITECTURE" }
  }
}

$releaseUri = if ($Version -eq "latest") {
  "https://api.github.com/repos/openai/tunnel-client/releases/latest"
} else {
  $normalized = $Version.TrimStart("v")
  "https://api.github.com/repos/openai/tunnel-client/releases/tags/v$normalized"
}

$release = Invoke-RestMethod -Uri $releaseUri -Headers $headers
$tag = [string]$release.tag_name
if ($tag -notmatch '^v\d+\.\d+\.\d+$') {
  throw "Unexpected tunnel-client release tag: $tag"
}

$assetName = "tunnel-client-$tag-windows-$Architecture.zip"
$zipAsset = $release.assets | Where-Object name -eq $assetName | Select-Object -First 1
$checksumsAsset = $release.assets | Where-Object name -eq "SHA256SUMS.txt" | Select-Object -First 1
if (-not $zipAsset -or -not $checksumsAsset) {
  throw "Release $tag does not publish $assetName and SHA256SUMS.txt."
}

$target = Join-Path $InstallRoot (Join-Path $tag "windows-$Architecture")
$targetExe = Join-Path $target "tunnel-client.exe"
$launcherPath = Join-Path $InstallRoot "tunnel-client.cmd"
$manifestPath = Join-Path $target "optimike-install-manifest.json"

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("optimike-tunnel-client-" + [guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $tempRoot $assetName
$checksumsPath = Join-Path $tempRoot "SHA256SUMS.txt"
$stage = Join-Path $tempRoot "stage"

try {
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri $zipAsset.browser_download_url -Headers $headers -OutFile $zipPath
  Invoke-WebRequest -UseBasicParsing -Uri $checksumsAsset.browser_download_url -Headers $headers -OutFile $checksumsPath

  $escapedName = [regex]::Escape($assetName)
  $checksumLine = Select-String -LiteralPath $checksumsPath -Pattern "^([a-fA-F0-9]{64})\s+$escapedName$" | Select-Object -First 1
  if (-not $checksumLine) {
    throw "No checksum found for $assetName."
  }
  $expected = $checksumLine.Matches[0].Groups[1].Value.ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "Checksum mismatch for $assetName."
  }

  New-Item -ItemType Directory -Path $stage | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $stage
  $stageExe = Join-Path $stage "tunnel-client.exe"
  if (-not (Test-Path -LiteralPath $stageExe)) {
    throw "The verified archive does not contain tunnel-client.exe."
  }
  $reportedVersion = (& $stageExe --version | Out-String).Trim()
  if ($reportedVersion -notmatch [regex]::Escape($tag.TrimStart("v"))) {
    throw "Downloaded binary reports an unexpected version: $reportedVersion"
  }
  $verifiedExeHash = (Get-FileHash -LiteralPath $stageExe -Algorithm SHA256).Hash.ToLowerInvariant()

  if (Test-Path -LiteralPath $target) {
    if (-not (Test-Path -LiteralPath $targetExe)) {
      throw "Install target exists but is incomplete: $target"
    }
    $existingExeHash = (Get-FileHash -LiteralPath $targetExe -Algorithm SHA256).Hash.ToLowerInvariant()
    $existingVersion = (& $targetExe --version | Out-String).Trim()
    if ($existingExeHash -ne $verifiedExeHash -or
        $existingVersion -notmatch [regex]::Escape($tag.TrimStart("v"))) {
      throw "Existing tunnel-client does not match the verified $tag release: $targetExe"
    }
    Write-Output "Verified existing OpenAI tunnel-client ${tag}: $targetExe"
  } else {
    $targetParent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    Move-Item -LiteralPath $stage -Destination $target
    Write-Output "Installed verified OpenAI tunnel-client ${tag}: $targetExe"
  }

  $manifest = [ordered]@{
    schemaVersion = 1
    tag = $tag
    architecture = $Architecture
    asset = $assetName
    archiveSha256 = $actual
    executableSha256 = $verifiedExeHash
    reportedVersion = $reportedVersion
    source = [string]$zipAsset.browser_download_url
  }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
  @(
    "@echo off"
    ('"' + $targetExe + '" %*')
  ) | Set-Content -LiteralPath $launcherPath -Encoding ascii
  Write-Output "SHA256($assetName)=$actual"
  Write-Output "Stable launcher: $launcherPath"
} finally {
  $resolvedTempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot)
  if ($resolvedTempRoot.StartsWith($resolvedTempBase, [StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $resolvedTempRoot)) {
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
  }
}
