$ErrorActionPreference = "Stop"

# One-shot app prep:
# - run core/build.ps1 to produce DLL + sidecar publish output
# - copy sidecar EXE into app/vendor/win32-x64/
# - run `pnpm install` and `pnpm rebuild electron` so package tree is ready
# `npm pack` is intentionally NOT run here; we don't publish the package yet.

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CoreBuildScript = Join-Path $RepoRoot "core\build.ps1"
$CoreSidecarExe = Join-Path $RepoRoot "core\Pupil.Core.Sidecar\bin\Release\net8.0\win-x64\publish\pupil-core.exe"
$AppSidecarDir = Join-Path $RepoRoot "app\vendor\win32-x64"
$AppSidecarExe = Join-Path $AppSidecarDir "pupil-core.exe"

if (-not (Test-Path -LiteralPath $CoreBuildScript)) {
    Write-Error "Core build script not found: $CoreBuildScript"
    exit 1
}

& $CoreBuildScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path -LiteralPath $CoreSidecarExe)) {
    Write-Error "Published sidecar EXE not found: $CoreSidecarExe"
    exit 1
}

if (-not (Test-Path -LiteralPath $AppSidecarDir)) {
    New-Item -ItemType Directory -Path $AppSidecarDir | Out-Null
}

$copySucceeded = $false
for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
        Copy-Item -LiteralPath $CoreSidecarExe -Destination $AppSidecarExe -Force
        $copySucceeded = $true
        break
    } catch {
        if ($attempt -eq 5) {
            break
        }
        Start-Sleep -Milliseconds 400
    }
}

if (-not $copySucceeded) {
    Write-Error "Failed to copy sidecar EXE to app vendor path. Target is likely locked by a running process: $AppSidecarExe"
    Write-Host "Close running pupil-core/electron processes and retry."
    exit 1
}

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
Write-Host "build: done."
Write-Host "  - core DLL  -> core/Pupil.Core/bin/Release/net8.0/Pupil.Core.dll"
Write-Host "  - sidecar   -> app/vendor/win32-x64/pupil-core.exe"
Write-Host "  - app deps  -> app/node_modules (pnpm)"
