param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("install", "rollback")]
  [string] $Mode,

  [Parameter(Mandatory = $true)]
  [string] $VaultPath,

  [string] $BundlePath = "",
  [string] $ExpectedCommit = "",
  [string] $BackupPath = "",
  [string] $BackupRoot = "",
  [switch] $ConfirmObsidianClosed
)

$ErrorActionPreference = "Stop"
$installer = Join-Path $PSScriptRoot "install-bridge-bundle.mjs"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Missing installer runtime: $installer"
}

$arguments = @($installer, $Mode, "--vault", $VaultPath)
if ($BundlePath) { $arguments += @("--bundle", $BundlePath) }
if ($ExpectedCommit) { $arguments += @("--expected-commit", $ExpectedCommit) }
if ($BackupPath) { $arguments += @("--backup", $BackupPath) }
if ($BackupRoot) { $arguments += @("--backup-root", $BackupRoot) }
if ($ConfirmObsidianClosed) { $arguments += "--confirm-obsidian-closed" }

& node @arguments
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
