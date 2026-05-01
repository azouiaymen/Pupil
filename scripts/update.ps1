param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$KillFirst,
  # When set, runs `pnpm update` (within semver ranges). Omit for install-only.
  [switch]$BumpDeps
)

$ErrorActionPreference = "Stop"

$KillScript = Join-Path $PSScriptRoot "kill.ps1"
$AppDir = Join-Path $RepoRoot "app"

Write-Host "[update] repo root: $RepoRoot"

if ($KillFirst) {
  if (Test-Path -LiteralPath $KillScript) {
    Write-Host "[update] running kill.ps1 (unlock sidecar / daemon)..."
    & $KillScript
  } else {
    Write-Warning "[update] kill.ps1 not found; skipping."
  }
}

if (-not (Test-Path -LiteralPath $AppDir)) {
  Write-Error "app directory not found: $AppDir"
  exit 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Error "pnpm not found on PATH. Install with: npm i -g pnpm"
  exit 1
}

Push-Location $AppDir
try {
  Write-Host "[update] pnpm install"
  pnpm install
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  if ($BumpDeps) {
    Write-Host "[update] pnpm update (semver ranges in package.json)"
    pnpm update
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  Write-Host "[update] pnpm rebuild electron"
  pnpm rebuild electron
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

Write-Host "[update] done."
