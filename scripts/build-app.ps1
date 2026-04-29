$ErrorActionPreference = "Stop"

# One-shot build: compiles the core DLL, publishes the sidecar EXE into
# app/vendor/win32-x64/, then runs `pnpm install` so the package tree is ready.
# `npm pack` is intentionally NOT run here; we don't publish the package yet.

$RepoRoot = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot "build-core.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& (Join-Path $PSScriptRoot "build-sidecar.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$AppDir = Join-Path $RepoRoot "app"
if (-not (Test-Path -LiteralPath $AppDir)) {
    Write-Error "app directory not found: $AppDir"
    exit 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Warning "pnpm not found on PATH; skipping pnpm install."
    Write-Host "Install pnpm with: npm i -g pnpm"
    exit 0
}

Push-Location $AppDir
try {
    pnpm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    pnpm rebuild electron
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "build-app: done."
Write-Host "  - core DLL  -> core/Pupil.Core/bin/Release/net8.0/Pupil.Core.dll"
Write-Host "  - sidecar   -> app/vendor/win32-x64/pupil-core.exe"
Write-Host "  - app deps  -> app/node_modules (pnpm)"
