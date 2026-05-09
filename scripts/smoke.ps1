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
    Write-Host "[smoke] checking overlay bridge (npm run check:bridge)"
    pnpm run check:bridge
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

  Write-Host "[smoke] manual integration checklist (Cursor)"
  Write-Host "1) Start MCP in Cursor and verify tools: perceive, indicate."
  Write-Host "2) Run perceive and verify visible UI is returned."
  Write-Host "3) Run indicate with type=info and verify overlay appears."
  Write-Host "4) Run indicate with type=click and coords; press Tab; verify click executes."
  Write-Host "5) Kill Electron/Pupil process and verify reconnect works after Cursor reload."

  Write-Host "[smoke] manual integration checklist (MCP protocol / stress)"
  Write-Host "6) Start MCP and trigger indicate(await=true) twice in parallel; verify both resolve correctly."
  Write-Host "7) Kill Electron process during await; verify MCP restarts overlay and no orphan second overlay remains."
  Write-Host "8) Force renderer not-ready path; send >256 commands quickly; verify queue is bounded and overflow is logged."
  Write-Host "9) Restart host/reconnect MCP; verify stale session messages are rejected."
  Write-Host "10) Request shutdown; verify ack is received then process exits cleanly."

  Write-Host "[smoke] done"
}
finally {
  Pop-Location
}