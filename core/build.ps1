$ErrorActionPreference = "Stop"

# Build core artifacts locally:
# 1) Pupil.Core.dll (Release)
# 2) pupil-core.exe sidecar (Release, win-x64, self-contained, single-file)

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error "dotnet CLI not found. Install the .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0"
    exit 1
}

$CoreRoot = $PSScriptRoot
$CoreCsproj = Join-Path $CoreRoot "Pupil.Core\Pupil.Core.csproj"
$SidecarCsproj = Join-Path $CoreRoot "Pupil.Core.Sidecar\Pupil.Core.Sidecar.csproj"
$SidecarPublishDir = Join-Path $CoreRoot "Pupil.Core.Sidecar\bin\Release\net8.0\win-x64\publish"
$SidecarExe = Join-Path $SidecarPublishDir "pupil-core.exe"

if (-not (Test-Path -LiteralPath $CoreCsproj)) {
    Write-Error "Core project not found: $CoreCsproj"
    exit 1
}

if (-not (Test-Path -LiteralPath $SidecarCsproj)) {
    Write-Error "Sidecar project not found: $SidecarCsproj"
    exit 1
}

dotnet build $CoreCsproj -c Release --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

dotnet publish $SidecarCsproj `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path -LiteralPath $SidecarExe)) {
    Write-Error "Expected sidecar EXE not found: $SidecarExe"
    exit 1
}

Write-Host ""
Write-Host "core build: done."
Write-Host "  - dll     -> $CoreRoot\Pupil.Core\bin\Release\net8.0\Pupil.Core.dll"
Write-Host "  - sidecar -> $SidecarExe"
