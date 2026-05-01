param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$BuildScript = Join-Path $PSScriptRoot "build.ps1"
$SmokeScript = Join-Path $PSScriptRoot "smoke.ps1"
$AppDir = Join-Path $RepoRoot "app"
$DistDir = Join-Path $RepoRoot "dist"

Write-Host "[release] repo root: $RepoRoot"

if (-not $SkipBuild) {
  if (-not (Test-Path -LiteralPath $BuildScript)) {
    Write-Error "build.ps1 not found: $BuildScript"
    exit 1
  }
  Write-Host "[release] running build.ps1..."
  & $BuildScript
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  Write-Host "[release] skipping build (-SkipBuild)"
}

if (Test-Path -LiteralPath $SmokeScript) {
  Write-Host "[release] running smoke.ps1..."
  & $SmokeScript
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Path -LiteralPath $AppDir)) {
  Write-Error "app directory not found: $AppDir"
  exit 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Error "pnpm not found on PATH."
  exit 1
}

if (-not (Test-Path -LiteralPath $DistDir)) {
  New-Item -ItemType Directory -Path $DistDir | Out-Null
}

Push-Location $AppDir
try {
  Write-Host "[release] pnpm pack -> $DistDir"
  pnpm pack --pack-destination $DistDir
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

$tgzs = Get-ChildItem -Path $DistDir -Filter "*.tgz" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
if ($tgzs) {
  Write-Host ""
  Write-Host "[release] latest package:"
  Write-Host "  $($tgzs[0].FullName)"
}

Write-Host ""
Write-Host "[release] done."
