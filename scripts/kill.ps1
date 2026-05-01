$ErrorActionPreference = "Stop"

# Stop Pupil overlay daemon (Electron running app/src/daemon/main.cjs), then sidecar.
# Command-line match avoids killing unrelated Electron apps (e.g. Cursor).

function Stop-PupilDaemons {
  $list = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue
  if (-not $list) {
    return
  }
  foreach ($p in @($list)) {
    $cmd = [string]$p.CommandLine
    if (-not $cmd) {
      continue
    }
    $isPupilDaemon =
      ($cmd -like '*\daemon\main.cjs*') -or
      ($cmd -like '*/daemon/main.cjs*') -or
      ($cmd -like '*\src\daemon\main.cjs*')
    if (-not $isPupilDaemon) {
      continue
    }
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      Write-Host "stopped Pupil daemon (electron) pid=$($p.ProcessId)"
    } catch {
      Write-Warning "could not stop pid=$($p.ProcessId): $_"
    }
  }
}

function Stop-PupilSidecars {
  Get-Process -Name "pupil-core" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      Stop-Process -Id $_.Id -Force -ErrorAction Stop
      Write-Host "stopped pupil-core pid=$($_.Id)"
    } catch {
      Write-Warning "could not stop pupil-core pid=$($_.Id): $_"
    }
  }
}

Write-Host "kill: stopping Pupil daemon (Electron) then pupil-core..."
Stop-PupilDaemons
Stop-PupilSidecars
Write-Host "kill: done."
