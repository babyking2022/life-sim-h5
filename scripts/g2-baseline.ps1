<#
.SYNOPSIS
  Build and verify a G2 synthetic engineering baseline archive (ASCII-only script).

.DESCRIPTION
  - Collect source, config, lockfile, docs, fixtures, reports, UI baseline.
  - Exclude node_modules, coverage, dist, .artifacts, baseline, SHA lists, *.bak-*.
  - Put a per-file SHA-256 list in the archive (BASELINE-FILES.sha256).
  - Record the archive's own SHA-256 in <archive>.sha256.
  - Extract to a temp directory and verify every entry.
  - Write baseline/G2-baseline-verification.json.

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/g2-baseline.ps1
#>
param(
  [string]$Root = (Get-Location).Path,
  [string]$BaselineId = "g2-synthetic-engineering-baseline-20261027"
)

$ErrorActionPreference = "Stop"

$baselineDir = Join-Path $Root "baseline"
$archive = Join-Path $baselineDir "$BaselineId.tar.gz"
$hashFile = "$archive.sha256"
$jsonFile = Join-Path $baselineDir "G2-baseline-verification.json"

New-Item -ItemType Directory -Force -Path $baselineDir | Out-Null

function Invoke-Tar {
  param([string[]]$ArgumentList)
  $process = Start-Process -FilePath "tar.exe" -ArgumentList $ArgumentList -Wait -PassThru -NoNewWindow
  if ($process.ExitCode -ne 0) { throw ("tar failed with exit code " + $process.ExitCode + ": " + ($ArgumentList -join " ")) }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("g2-baseline-build-" + [Guid]::NewGuid().ToString("N"))
$stage = Join-Path $tempRoot $BaselineId
$rawTar = Join-Path $tempRoot "raw.tar"
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# 1) Create a raw tar of the working tree with exclusions.
Invoke-Tar @("-cf", $rawTar, "-C", $Root, "--exclude", "node_modules", "--exclude", ".artifacts", "--exclude", "baseline", "--exclude", "dist", "--exclude", "coverage", "--exclude", ".git", "--exclude", "SHA256SUMS-*", "--exclude", "*.bak-*", ".")

# 2) Extract into the staged baseline directory.
Invoke-Tar @("-xf", $rawTar, "-C", $stage)

# 3) Drop any leftover excluded names and write the per-file SHA-256 list.
Get-ChildItem -LiteralPath $stage -Recurse -Directory -Force -ErrorAction SilentlyContinue |
  Where-Object { @("node_modules", ".artifacts", "dist", "coverage", "baseline", ".git") -contains $_.Name } |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath $stage -Recurse -File -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "*.bak-*" -or $_.Name -like "SHA256SUMS-*" } |
  Remove-Item -Force

$files = Get-ChildItem -LiteralPath $stage -Recurse -File -Force | Sort-Object FullName
$listLines = @(
  "# $BaselineId per-file SHA-256",
  "# Paths are relative to the archive root ($BaselineId/).",
  "# Generated: 2026-10-27"
)
foreach ($file in $files) {
  $relative = $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
  $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLower()
  $listLines += "$hash  $relative"
}
[IO.File]::WriteAllLines((Join-Path $stage "BASELINE-FILES.sha256"), $listLines, [Text.UTF8Encoding]::new($false))

# 4) Create the final archive and record its SHA-256.
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
Invoke-Tar @("-czf", $archive, "-C", $tempRoot, $BaselineId)

$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower()
$archiveSize = (Get-Item -LiteralPath $archive).Length
[IO.File]::WriteAllText($hashFile, "$archiveHash  $([IO.Path]::GetFileName($archive))`n", [Text.UTF8Encoding]::new($false))

# 5) Extract to a fresh temp dir and verify every entry.
$verifyRoot = Join-Path ([IO.Path]::GetTempPath()) ("g2-baseline-verify-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $verifyRoot | Out-Null
Invoke-Tar @("-xzf", $archive, "-C", $verifyRoot)

$extracted = Join-Path $verifyRoot $BaselineId
$entries = Get-Content -LiteralPath (Join-Path $extracted "BASELINE-FILES.sha256") -Encoding UTF8 | Where-Object { $_ -match '^[0-9a-f]{64}  ' }
$missing = 0
$mismatch = 0
foreach ($line in $entries) {
  $hash, $relative = $line -split '  ', 2
  $target = Join-Path $extracted ($relative -replace '/', '\')
  if (-not (Test-Path -LiteralPath $target)) { $missing += 1; continue }
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower() -ne $hash) { $mismatch += 1 }
}
$extractedCount = (Get-ChildItem -LiteralPath $extracted -Recurse -File -Force).Count
$verified = ($missing -eq 0) -and ($mismatch -eq 0) -and ($entries.Count -eq ($extractedCount - 1))

$summary = [ordered]@{
  baselineId = $BaselineId
  generatedAt = "2026-10-27"
  archive = "baseline/$BaselineId.tar.gz"
  archiveSha256 = $archiveHash
  archiveBytes = $archiveSize
  entries = $entries.Count
  extractedFiles = $extractedCount
  missing = $missing
  mismatch = $mismatch
  verified = $verified
  exclusions = @("node_modules", ".artifacts", "baseline", "dist", "coverage", ".git", "SHA256SUMS-*", "*.bak-*")
}
[IO.File]::WriteAllText($jsonFile, (($summary | ConvertTo-Json -Depth 4) + "`n"), [Text.UTF8Encoding]::new($false))

Remove-Item -LiteralPath $verifyRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue

if (-not $verified) { throw "baseline verification failed: missing=$missing mismatch=$mismatch" }
Write-Output ("BASELINE-OK archive=" + [IO.Path]::GetFileName($archive) + " entries=" + $entries.Count + " extracted=" + $extractedCount + " sha256=" + $archiveHash.Substring(0, 12) + "...")
