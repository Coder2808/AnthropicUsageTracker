# uninstall.ps1 — removes Anthropic Usage Tracker scheduled tasks and stops all processes
#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$TaskDaemon  = 'AnthropicTrackerDaemon'
$TaskMenubar = 'AnthropicTrackerMenubar'

Write-Host ""
Write-Host "  Stopping processes..."
Get-Process -Name 'node','electron' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -match 'anthropic-tracker' } |
    Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "  Removing scheduled tasks..."
foreach ($t in $TaskDaemon, $TaskMenubar) {
    Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "    Removed: $t"
}

Write-Host ""
Write-Host "  Done. The SQLite database and logs at:"
Write-Host "    $ScriptDir\data\"
Write-Host "    $ScriptDir\logs\"
Write-Host "  were kept. Delete them manually if you want a clean slate."
Write-Host ""
Write-Host "  Note: ANTHROPIC_BASE_URL user environment variable was NOT removed."
Write-Host "  To remove it: [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', `$null, 'User')"
Write-Host ""
