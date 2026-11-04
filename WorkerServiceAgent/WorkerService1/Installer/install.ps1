<#
.SYNOPSIS
    Installs or upgrades the POS Monitoring Agent as a Windows service. Run as Administrator.

.EXAMPLE
    .\install.ps1 -StoreId STORE001 -ApiBaseUrl https://telemetry.example.com -ApiKey "..." `
        -SqlConnectionString "Server=localhost\SQLEXPRESS;Database=POS;Integrated Security=True;TrustServerCertificate=True"

.NOTES
    Store-specific settings are written to %ProgramData%\PosMonitoringAgent\agentsettings.json,
    which survives upgrades. Parameters you omit keep their existing values in that file.
    Every parameter is optional: anything not given and not saved before comes from appsettings.json
    (for example Agent:StoreId and TelemetryApi:BaseUrl), so .\install.ps1 alone is enough when that file is set up.
#>
param(
    # Defaults to the folder this script is in (the publish package).
    [string]$SourceDir = $PSScriptRoot,
    [string]$InstallDir = "$env:ProgramFiles\PosMonitoringAgent",
    [string]$StoreId,
    [string]$DeviceId,
    [string]$ApiBaseUrl,
    [string]$ApiKey,
    [string]$SqlConnectionString,
    [string]$PosLogDirectory
)

$ErrorActionPreference = "Stop"
$serviceName = "PosMonitoringAgent"
$exe = Join-Path $InstallDir "PosMonitoringAgent.exe"
$dataDir = Join-Path $env:ProgramData "PosMonitoringAgent"
$settingsPath = Join-Path $dataDir "agentsettings.json"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated (Administrator) PowerShell."
}
if (-not (Test-Path (Join-Path $SourceDir "PosMonitoringAgent.exe"))) {
    throw "PosMonitoringAgent.exe not found in $SourceDir. Run publish.ps1 first."
}

# 1. Stop an existing service so files can be replaced.
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne "Stopped") {
    Write-Host "Stopping existing service..."
    Stop-Service -Name $serviceName -Force
    $existing.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
}

# 2. Copy binaries.
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $SourceDir "*") -Destination $InstallDir -Recurse -Force

# 3. Data folder: SYSTEM and Administrators only, because it holds the API key and queued telemetry.
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
icacls $dataDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null

# 4. Merge store-specific settings into agentsettings.json.
$settings = @{}
if (Test-Path $settingsPath) {
    $json = Get-Content $settingsPath -Raw | ConvertFrom-Json
    foreach ($p in $json.PSObject.Properties) {
        $section = @{}
        foreach ($q in $p.Value.PSObject.Properties) { $section[$q.Name] = $q.Value }
        $settings[$p.Name] = $section
    }
}
function Set-Setting([string]$Section, [string]$Key, $Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return }
    if (-not $settings.ContainsKey($Section)) { $settings[$Section] = @{} }
    $settings[$Section][$Key] = $Value
}
Set-Setting "Agent" "StoreId" $StoreId
Set-Setting "Agent" "DeviceId" $DeviceId
Set-Setting "TelemetryApi" "BaseUrl" $ApiBaseUrl
Set-Setting "TelemetryApi" "ApiKey" $ApiKey
Set-Setting "SqlHealth" "ConnectionString" $SqlConnectionString
Set-Setting "PosApplication" "LogDirectory" $PosLogDirectory

if (-not $settings.ContainsKey("Agent") -or [string]::IsNullOrWhiteSpace($settings["Agent"]["StoreId"])) {
    # Not given and not saved before: the agent will use Agent:StoreId from appsettings.json.
    # That file allows // comments, which ConvertFrom-Json in Windows PowerShell does not.
    $appSettingsPath = Join-Path $InstallDir "appsettings.json"
    $json = (Get-Content $appSettingsPath) | Where-Object { $_ -notmatch '^\s*//' } | Out-String
    $packagedStoreId = ($json | ConvertFrom-Json).Agent.StoreId
    if ([string]::IsNullOrWhiteSpace($packagedStoreId)) {
        throw "No StoreId: set Agent:StoreId in appsettings.json or pass -StoreId STORE001."
    }
    Write-Host "Using StoreId '$packagedStoreId' from appsettings.json."
}
$settings | ConvertTo-Json -Depth 5 | Set-Content -Path $settingsPath -Encoding UTF8

# 5. Event log source for the agent's own logs.
if (-not [System.Diagnostics.EventLog]::SourceExists($serviceName)) {
    New-EventLog -LogName Application -Source $serviceName
}

# 6. Register the service (LocalSystem, delayed auto start) with automatic restart on failure.
if (-not $existing) {
    New-Service -Name $serviceName `
        -BinaryPathName "`"$exe`"" `
        -DisplayName "POS Monitoring Agent" `
        -Description "Collects OS metrics, POS application health, SQL connectivity and logs, and uploads them to the central monitoring API." `
        -StartupType Automatic | Out-Null
}
sc.exe config $serviceName start= delayed-auto | Out-Null
sc.exe failure $serviceName reset= 86400 actions= restart/60000/restart/60000/restart/300000 | Out-Null
sc.exe failureflag $serviceName 1 | Out-Null

Start-Service -Name $serviceName
Write-Host "PosMonitoringAgent installed and running. Settings: $settingsPath"
