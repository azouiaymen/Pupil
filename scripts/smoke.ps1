param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

$ErrorActionPreference = "Stop"

Write-Host "[smoke] repo root: $RepoRoot"

function Assert-Exists {
  param(
    [string]$Path,
    [string]$Name
  )

  if (-not (Test-Path $Path)) {
    throw "[smoke] missing $Name at: $Path"
  }

  Write-Host "[smoke] ok: $Name"
}

Push-Location $RepoRoot
try {
  Write-Host "[smoke] checking expected files"

  Assert-Exists "$RepoRoot\app\package.json" "app/package.json"
  Assert-Exists "$RepoRoot\app\src\shim\index.js" "Node MCP shim"
  Assert-Exists "$RepoRoot\app\src\daemon\main.cjs" "Electron daemon"
  Assert-Exists "$RepoRoot\core\Pupil.Core\Pupil.Core.csproj" ".NET core project"
  Assert-Exists "$RepoRoot\core\Pupil.Core.Sidecar\Pupil.Core.Sidecar.csproj" ".NET sidecar project"

  Write-Host "[smoke] checking generated build artifacts"

  Assert-Exists "$RepoRoot\core\Pupil.Core\bin\Release\net8.0\Pupil.Core.dll" "Pupil.Core.dll"
  Assert-Exists "$RepoRoot\app\vendor\win32-x64\pupil-core.exe" "pupil-core.exe"

  Write-Host "[smoke] checking Node syntax"

  Push-Location "$RepoRoot\app"
  try {
    node --check .\src\shim\index.js
    node --check .\src\daemon\main.cjs
    pnpm run check
  }
  finally {
    Pop-Location
  }

  Write-Host "[smoke] checking MCP entrypoint"

  if (Test-Path "$RepoRoot\app\bin\pupil-mcp.js") {
    Write-Host "[smoke] ok: app/bin/pupil-mcp.js"
  } else {
    Write-Host "[smoke] warning: app/bin/pupil-mcp.js is missing"
    Write-Host "[smoke] Cursor should use: $RepoRoot\app\src\shim\index.js"
  }

  Write-Host "[smoke] manual integration checklist"
  Write-Host "1) Start MCP in Cursor and verify tools: perceive, indicate."
  Write-Host "2) Run perceive and verify visible UI is returned."
  Write-Host "3) Run indicate with type=info and verify overlay appears."
  Write-Host "4) Run indicate with type=click and coords; press Tab; verify click executes."
  Write-Host "5) Kill Electron/Pupil process and verify reconnect works after Cursor reload."

  Write-Host "[smoke] done"
}
finally {
  Pop-Location
}