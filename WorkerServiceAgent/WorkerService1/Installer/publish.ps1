# Builds a self-contained, single-file agent (no .NET runtime needed on the POS) into <solution>\publish.
# The output folder, including install.ps1 / uninstall.ps1, is the complete deployment package.
param(
    [string]$Configuration = "Release",
    [string]$Runtime = "win-x64",
    [string]$Output = (Join-Path $PSScriptRoot "..\..\publish")
)

$ErrorActionPreference = "Stop"
$project = Join-Path $PSScriptRoot "..\WorkerService1.csproj"

dotnet publish $project `
    -c $Configuration `
    -r $Runtime `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $Output

if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

# Development settings must never ship to stores.
Remove-Item (Join-Path $Output "appsettings.Development.json") -ErrorAction SilentlyContinue
Copy-Item (Join-Path $PSScriptRoot "install.ps1"), (Join-Path $PSScriptRoot "uninstall.ps1"), (Join-Path $PSScriptRoot "pos-agent.sh") -Destination $Output -Force
Write-Host "Published to $((Resolve-Path $Output).Path)"
