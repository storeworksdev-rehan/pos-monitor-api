#!/usr/bin/env bash
# Install, upgrade, remove or check the POS Monitoring Agent Windows service from Git Bash.
# Run it from the publish folder (next to PosMonitoringAgent.exe, install.ps1 and uninstall.ps1).
#
#   ./pos-agent.sh install [--store-id STORE001] [--api-url https://<app>.azurewebsites.net] [--api-key KEY]
#                          [--device-id ID] [--sql "Server=...;Database=StellaNovaMRF;..."] [--log-dir DIR]
#   ./pos-agent.sh uninstall [--remove-data]
#   ./pos-agent.sh status
#
# Every install option is optional: values not given come from appsettings.json (e.g. Agent:StoreId).
# On an upgrade, options left out keep the values saved in %ProgramData%\PosMonitoringAgent\agentsettings.json.
# install and uninstall need Administrator rights. When this shell is not elevated, a UAC prompt opens and
# the work runs in an elevated PowerShell window, which stays open until Enter is pressed.
set -euo pipefail

SERVICE=PosMonitoringAgent
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

is_admin() { net session >/dev/null 2>&1; }

# Quotes a value as a PowerShell single-quoted string.
psq() { printf "'%s'" "${1//\'/\'\'}"; }

# Runs a PowerShell script elevated. Output shows here when already elevated, else in the UAC window.
run_elevated() {
  local body="$1" script
  script="$(mktemp --suffix=.ps1)"
  {
    echo '$ErrorActionPreference = "Stop"'
    echo 'try {'
    echo "$body"
    echo '  $code = 0'
    echo '} catch {'
    echo '  Write-Host $_ -ForegroundColor Red'
    echo '  $code = 1'
    echo '}'
    # Keep a UAC-launched window open so the result can be read.
    echo 'if ($env:POS_AGENT_PAUSE -eq "1") { Read-Host "Press Enter to close" | Out-Null }'
    echo 'exit $code'
  } >"$script"
  local win
  win="$(cygpath -w "$script")"

  local status=0
  if is_admin; then
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$win" || status=$?
  else
    echo "Administrator rights needed: approve the Windows prompt (UAC)."
    powershell.exe -NoProfile -Command "
      \$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        '\$env:POS_AGENT_PAUSE = ''1''; & ''$win''; exit \$LASTEXITCODE')
      exit \$p.ExitCode" || status=$?
  fi
  rm -f "$script"
  return "$status"
}

cmd_install() {
  local args=()
  while [[ $# -gt 0 ]]; do
    [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; usage 2; }
    case "$1" in
      --store-id)  args+=("-StoreId" "$(psq "$2")") ;;
      --device-id) args+=("-DeviceId" "$(psq "$2")") ;;
      --api-url)   args+=("-ApiBaseUrl" "$(psq "$2")") ;;
      --api-key)   args+=("-ApiKey" "$(psq "$2")") ;;
      --sql)       args+=("-SqlConnectionString" "$(psq "$2")") ;;
      --log-dir)   args+=("-PosLogDirectory" "$(psq "$2")") ;;
      *) echo "Unknown option: $1" >&2; usage 2 ;;
    esac
    shift 2
  done

  [[ -f "$HERE/PosMonitoringAgent.exe" ]] || {
    echo "PosMonitoringAgent.exe is not next to this script. Run it from the publish folder (Installer/publish.ps1 creates it)." >&2
    exit 1
  }

  run_elevated "  & $(psq "$(cygpath -w "$HERE/install.ps1")") -SourceDir $(psq "$(cygpath -w "$HERE")") ${args[*]}"
  cmd_status
}

cmd_uninstall() {
  local remove=""
  case "${1:-}" in
    "") ;;
    --remove-data) remove="-RemoveData" ;;
    *) echo "Unknown option: $1" >&2; usage 2 ;;
  esac
  run_elevated "  & $(psq "$(cygpath -w "$HERE/uninstall.ps1")") $remove"
  cmd_status
}

cmd_status() {
  if sc.exe query "$SERVICE" >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Get-Service $SERVICE | Format-Table Name, Status, StartType -AutoSize | Out-String" | sed '/^\s*$/d'
  else
    echo "$SERVICE is not installed."
  fi
}

case "${1:-}" in
  install)   shift; cmd_install "$@" ;;
  uninstall) shift; cmd_uninstall "$@" ;;
  status)    cmd_status ;;
  -h|--help|help) usage 0 ;;
  *) usage 2 ;;
esac
