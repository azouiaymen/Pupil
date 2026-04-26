$ErrorActionPreference = "Stop"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error "dotnet CLI not found. Install the .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0"
    exit 1
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Csproj = Join-Path $RepoRoot "core\Pupil.Core\Pupil.Core.csproj"

if (-not (Test-Path -LiteralPath $Csproj)) {
    Write-Error "Project not found: $Csproj"
    exit 1
}

dotnet build $Csproj -c Release --nologo
exit $LASTEXITCODE
