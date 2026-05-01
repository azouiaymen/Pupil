param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

$ErrorActionPreference = "Stop"

Write-Host "[smoke] repo root: $RepoRoot"

Push-Location $RepoRoot
try {
  Write-Host "[smoke] syntax checks"
  python -m py_compile "mcp/main.py" "mcp/overlay_runtime.py"
  Push-Location "$RepoRoot\overlay"
  try {
    npm run check:bridge
  } finally {
    Pop-Location
  }

  Write-Host "[smoke] manual integration checklist"
  Write-Host "1) Start MCP and trigger indicate(await=true) twice in parallel; verify both resolve correctly."
  Write-Host "2) Kill Electron process during await; verify MCP restarts overlay and no orphan second overlay remains."
  Write-Host "3) Force renderer not-ready path; send >256 commands quickly; verify queue is bounded and overflow is logged."
  Write-Host "4) Restart host/reconnect MCP; verify stale session messages are rejected."
  Write-Host "5) Request shutdown; verify ack is received then process exits cleanly."
} finally {
  Pop-Location
}
