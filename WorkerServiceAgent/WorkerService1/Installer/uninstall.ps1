# Removes the POS Monitoring Agent service. Run as Administrator.
# Queued telemetry and settings in %ProgramData%\PosMonitoringAgent are kept unless -RemoveData is given.
param(
    [string]$InstallDir = "$env:ProgramFiles\PosMonitoringAgent",
    [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
$serviceName = "PosMonitoringAgent"

$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service) {
    if ($service.Status -ne "Stopped") {
        Stop-Service -Name $serviceName -Force
        $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
    }
    sc.exe delete $serviceName | Out-Null
    Write-Host "Service removed."
}

if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
}

if ($RemoveData) {
    Remove-Item -Recurse -Force (Join-Path $env:ProgramData "PosMonitoringAgent") -ErrorAction SilentlyContinue
    Write-Host "Data and settings removed."
}
