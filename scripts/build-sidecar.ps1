$ErrorActionPreference = "Stop"

# Publishes Pupil.Core.Sidecar as a self-contained single-file Windows x64 EXE
# and copies the result into app/vendor/win32-x64/pupil-core.exe so the Electron
# daemon can spawn it without requiring the .NET runtime to be installed.

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error "dotnet CLI not found. Install the .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0"
    exit 1
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Csproj   = Join-Path $RepoRoot "core\Pupil.Core.Sidecar\Pupil.Core.Sidecar.csproj"
$OutDir   = Join-Path $RepoRoot "app\vendor\win32-x64"
$PublishDir = Join-Path $RepoRoot "core\Pupil.Core.Sidecar\bin\Release\net8.0\win-x64\publish"

if (-not (Test-Path -LiteralPath $Csproj)) {
    Write-Error "Sidecar project not found: $Csproj"
    exit 1
}

dotnet publish $Csproj `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    --nologo

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$ExePath = Join-Path $PublishDir "pupil-core.exe"
if (-not (Test-Path -LiteralPath $ExePath)) {
    Write-Error "Expected published EXE not found at $ExePath"
    exit 1
}

if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

Copy-Item -LiteralPath $ExePath -Destination (Join-Path $OutDir "pupil-core.exe") -Force
Write-Host "pupil-core.exe -> $OutDir"
