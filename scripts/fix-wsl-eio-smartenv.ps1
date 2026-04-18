param(
  [string]$VaultRoot = "F:\OBSIDIAN\ÉLYSIA",
  [string]$WslDistro = "Ubuntu-24.04",
  [string]$WslMultiPath = "/mnt/f/OBSIDIAN/ÉLYSIA/.smart-env/multi",
  [int]$NameByteLimit = 255,
  [int]$MaxRenames = 400,
  [switch]$Aggressive,
  [switch]$WhatIf,
  [string]$RollbackMap = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-Utf8Bytes {
  param([Parameter(Mandatory = $true)][string]$Text)
  return [System.Text.Encoding]::UTF8.GetByteCount($Text)
}

function Get-Sha1Hex {
  param([Parameter(Mandatory = $true)][string]$Text)
  $sha1 = [System.Security.Cryptography.SHA1]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $hash = $sha1.ComputeHash($bytes)
    return ($hash | ForEach-Object { $_.ToString("x2") }) -join ""
  } finally {
    $sha1.Dispose()
  }
}

function Convert-ToLongPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ($Path.StartsWith("\\?\")) { return $Path }
  return "\\?\" + $Path
}

function Get-WslScan {
  param(
    [Parameter(Mandatory = $true)][string]$Distro,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $escapedPath = $Path.Replace("\", "\\").Replace("'", "\\'")
  $pythonScript = @"
import os
p = r'''$escapedPath'''
c = 0
code = "OK"
try:
    with os.scandir(p) as it:
        for _ in it:
            c += 1
except OSError as e:
    code = getattr(e, "errno", None)
    if code is None:
        code = getattr(e, "strerror", str(e))
print(f"{c}|{code}")
"@
  $pyBytes = [System.Text.Encoding]::UTF8.GetBytes($pythonScript)
  $pyB64 = [Convert]::ToBase64String($pyBytes)
  $pythonCode = "import base64; exec(base64.b64decode('$pyB64').decode('utf-8'))"

  $raw = & wsl.exe -d $Distro -- python3 -c $pythonCode 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Échec appel WSL scan: $raw"
  }

  $line = (($raw -split "`r?`n") | Where-Object { $_ -match "^\d+\|" } | Select-Object -Last 1)
  if (-not $line) {
    throw "Sortie scan WSL inattendue: $raw"
  }

  $parts = $line.Split("|", 2)
  return [pscustomobject]@{
    Count = [int]$parts[0]
    Code = $parts[1]
  }
}

function Get-AjsonFiles {
  param([Parameter(Mandatory = $true)][string]$DirPath)

  $longDir = Convert-ToLongPath -Path $DirPath
  $files = [System.IO.Directory]::EnumerateFiles(
    $longDir,
    "*.ajson",
    [System.IO.SearchOption]::TopDirectoryOnly
  )

  $result = New-Object System.Collections.Generic.List[object]
  foreach ($fullPath in $files) {
    $name = [System.IO.Path]::GetFileName($fullPath)
    $bytes = Get-Utf8Bytes -Text $name
    $nonAscii = @($name.ToCharArray() | Where-Object { [int]$_ -gt 127 }).Count -gt 0
    $result.Add([pscustomobject]@{
      FullPath = $fullPath
      Name = $name
      Bytes = $bytes
      NonAscii = $nonAscii
    })
  }
  return $result
}

function New-ShortName {
  param(
    [Parameter(Mandatory = $true)][string]$OriginalName,
    [Parameter(Mandatory = $true)][string]$Prefix,
    [Parameter(Mandatory = $true)][string]$DirectoryPath
  )

  $hex = Get-Sha1Hex -Text $OriginalName
  $size = 16
  while ($true) {
    $candidate = "{0}_{1}.ajson" -f $Prefix, $hex.Substring(0, [Math]::Min($size, $hex.Length))
    $dest = [System.IO.Path]::Combine($DirectoryPath, $candidate)
    if (-not [System.IO.File]::Exists($dest)) { return $candidate }

    $size += 2
    if ($size -gt $hex.Length) {
      $salt = Get-Sha1Hex -Text ($OriginalName + [Guid]::NewGuid().ToString("N"))
      $candidate = "{0}_{1}.ajson" -f $Prefix, $salt.Substring(0, 20)
      $dest = [System.IO.Path]::Combine($DirectoryPath, $candidate)
      if (-not [System.IO.File]::Exists($dest)) { return $candidate }
    }
  }
}

function Invoke-Rollback {
  param([Parameter(Mandatory = $true)][string]$MapCsvPath)

  if (-not (Test-Path -LiteralPath $MapCsvPath)) {
    throw "Fichier rollback introuvable: $MapCsvPath"
  }

  $rows = Import-Csv -LiteralPath $MapCsvPath
  [array]::Reverse($rows)
  $done = 0

  foreach ($row in $rows) {
    $oldPath = $row.OldPath
    $newPath = $row.NewPath
    if ([string]::IsNullOrWhiteSpace($oldPath) -or [string]::IsNullOrWhiteSpace($newPath)) {
      continue
    }
    if ((Test-Path -LiteralPath $newPath) -and -not (Test-Path -LiteralPath $oldPath)) {
      Move-Item -LiteralPath $newPath -Destination $oldPath
      $done++
    }
  }

  Write-Host "Rollback terminé. Renames annulés: $done"
}

if (-not [string]::IsNullOrWhiteSpace($RollbackMap)) {
  Invoke-Rollback -MapCsvPath $RollbackMap
  exit 0
}

$multiPath = Join-Path $VaultRoot ".smart-env\multi"
if (-not (Test-Path -LiteralPath $multiPath)) {
  throw "Dossier introuvable: $multiPath"
}

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$logDir = Join-Path $env:TEMP "smart-env-eio-fix-$ts"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$mapCsv = Join-Path $logDir "rename-map.csv"
$summaryPath = Join-Path $logDir "summary.txt"

$files = Get-AjsonFiles -DirPath $multiPath
$total = $files.Count
if ($total -eq 0) {
  throw "Aucun .ajson trouvé dans $multiPath"
}

$baseScan = Get-WslScan -Distro $WslDistro -Path $WslMultiPath
Write-Host ("WSL scan initial: {0}/{1} (code={2})" -f $baseScan.Count, $total, $baseScan.Code)

if ($baseScan.Code -eq "OK" -and $baseScan.Count -ge $total) {
  $longNow = @((Get-AjsonFiles -DirPath $multiPath | Where-Object { $_.Bytes -ge $NameByteLimit })).Count
  $summary = @(
    "VaultRoot=$VaultRoot"
    "MultiPath=$multiPath"
    "WslDistro=$WslDistro"
    "WslMultiPath=$WslMultiPath"
    "TotalAjson=$total"
    "QueueCount=0"
    "Renamed=0"
    "LongNamesRemaining(>=$NameByteLimit)=$longNow"
    "ScanInitial=$($baseScan.Count)|$($baseScan.Code)"
    "ScanFinal=$($baseScan.Count)|$($baseScan.Code)"
    "MapCsv="
  )
  $summary | Set-Content -LiteralPath $summaryPath -Encoding UTF8
  Write-Host "Scan déjà sain, aucun renommage nécessaire."
  Write-Host ("Summary: {0}" -f $summaryPath)
  exit 0
}

$queue = New-Object System.Collections.Generic.List[object]
$seen = New-Object 'System.Collections.Generic.HashSet[string]'

function Add-Group {
  param([Parameter(Mandatory = $true)][object[]]$Group, [Parameter(Mandatory = $true)][string]$Reason)
  foreach ($item in $Group) {
    if ($seen.Add($item.FullPath)) {
      $queue.Add([pscustomobject]@{
        File = $item
        Reason = $Reason
      })
    }
  }
}

$g1 = $files | Where-Object { $_.Bytes -ge $NameByteLimit } | Sort-Object Bytes -Descending
$g2 = $files | Where-Object { $_.Bytes -ge 240 } | Sort-Object Bytes -Descending
$g3 = $files | Where-Object { $_.NonAscii -and $_.Bytes -ge 180 } | Sort-Object Bytes -Descending

Add-Group -Group $g1 -Reason "bytes>=limit"
Add-Group -Group $g2 -Reason "bytes>=240"
Add-Group -Group $g3 -Reason "non-ascii+bytes>=180"

if ($Aggressive) {
  $g4 = $files | Where-Object { $_.NonAscii } | Sort-Object Bytes -Descending
  Add-Group -Group $g4 -Reason "aggressive-non-ascii"
}

$queueCount = $queue.Count
Write-Host ("Candidats: {0}" -f $queueCount)

$records = New-Object System.Collections.Generic.List[object]
$scan = $baseScan
$renamed = 0

foreach ($entry in $queue) {
  if ($renamed -ge $MaxRenames) { break }

  $item = $entry.File
  if (-not (Test-Path -LiteralPath $item.FullPath)) { continue }

  $newName = New-ShortName -OriginalName $item.Name -Prefix "eio" -DirectoryPath $multiPath
  $newPath = Join-Path $multiPath $newName

  if ($WhatIf) {
    Write-Host ("WHATIF {0} -> {1}" -f $item.Name, $newName)
    continue
  }

  Move-Item -LiteralPath $item.FullPath -Destination $newPath
  $renamed++

  $after = Get-WslScan -Distro $WslDistro -Path $WslMultiPath
  $improved = $after.Count -gt $scan.Count

  $records.Add([pscustomobject]@{
    Timestamp = (Get-Date).ToString("s")
    OldPath = $item.FullPath
    NewPath = $newPath
    OldName = $item.Name
    NewName = $newName
    OldBytes = $item.Bytes
    NewBytes = (Get-Utf8Bytes -Text $newName)
    Reason = $entry.Reason
    ScanBefore = $scan.Count
    ScanAfter = $after.Count
    ScanCode = $after.Code
    Improved = $improved
  })

  $scan = $after
  Write-Host ("#{0} scan={1}/{2} code={3} ({4} -> {5})" -f $renamed, $scan.Count, $total, $scan.Code, $item.Name, $newName)

  if ($scan.Code -eq "OK" -and $scan.Count -ge $total) {
    break
  }
}

if (-not $WhatIf) {
  $records | Export-Csv -LiteralPath $mapCsv -NoTypeInformation -Encoding UTF8
}

$longNow = @((Get-AjsonFiles -DirPath $multiPath | Where-Object { $_.Bytes -ge $NameByteLimit })).Count
$finalScan = Get-WslScan -Distro $WslDistro -Path $WslMultiPath

$summary = @(
  "VaultRoot=$VaultRoot"
  "MultiPath=$multiPath"
  "WslDistro=$WslDistro"
  "WslMultiPath=$WslMultiPath"
  "TotalAjson=$total"
  "QueueCount=$queueCount"
  "Renamed=$renamed"
  "LongNamesRemaining(>=$NameByteLimit)=$longNow"
  "ScanInitial=$($baseScan.Count)|$($baseScan.Code)"
  "ScanFinal=$($finalScan.Count)|$($finalScan.Code)"
  "MapCsv=$mapCsv"
)

$summary | Set-Content -LiteralPath $summaryPath -Encoding UTF8

Write-Host "-------------------------------"
Write-Host ("Scan final: {0}/{1} (code={2})" -f $finalScan.Count, $total, $finalScan.Code)
Write-Host ("Noms >= {0} octets restants: {1}" -f $NameByteLimit, $longNow)
Write-Host ("Log dir: {0}" -f $logDir)
Write-Host ("Map CSV: {0}" -f $mapCsv)
Write-Host ("Summary: {0}" -f $summaryPath)
Write-Host "Rollback:"
Write-Host ("  .\fix-wsl-eio-smartenv.ps1 -RollbackMap `"{0}`"" -f $mapCsv)
