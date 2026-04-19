# install.ps1 — sets up Anthropic Usage Tracker as Windows Scheduled Tasks
# Run from an elevated PowerShell prompt: .\install.ps1
#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$DaemonDir   = Join-Path $ScriptDir 'daemon'
$MenubarDir  = Join-Path $ScriptDir 'menubar'
$LogsDir     = Join-Path $ScriptDir 'logs'
$TaskDaemon  = 'AnthropicTrackerDaemon'
$TaskMenubar = 'AnthropicTrackerMenubar'

Write-Host ""
Write-Host "  Anthropic Usage Tracker — Installing (Windows)"
Write-Host ""

# ── Find Node.js ────────────────────────────────────────────────────────────

$NodeBin = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $NodeBin) {
    # Common nvm-windows and direct install paths
    $candidates = @(
        "$env:APPDATA\nvm\current\node.exe",
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $NodeBin = $c; break }
    }
}
if (-not $NodeBin) {
    Write-Error "Node.js not found. Install from https://nodejs.org and re-run."
}
$NodeDir  = Split-Path -Parent $NodeBin
$NpmBin   = Join-Path $NodeDir 'npm.cmd'
$NodeVer  = & $NodeBin --version
Write-Host "  Node:     $NodeBin  ($NodeVer)"

# ── Install dependencies ─────────────────────────────────────────────────────

if (-not (Test-Path (Join-Path $DaemonDir 'node_modules'))) {
    Write-Host "  Installing daemon dependencies..."
    Push-Location $DaemonDir
    & $NpmBin install --silent
    Pop-Location
}

$ElectronBin = Join-Path $MenubarDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $ElectronBin)) {
    Write-Host "  Installing menubar dependencies..."
    Push-Location $MenubarDir
    & $NpmBin install --silent
    Pop-Location
}
if (-not (Test-Path $ElectronBin)) {
    Write-Error "Electron binary not found at: $ElectronBin"
}
Write-Host "  Electron: $ElectronBin"

# ── Stop any running instances ───────────────────────────────────────────────

Get-Process -Name 'node','electron' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -match 'anthropic-tracker' } |
    Stop-Process -Force -ErrorAction SilentlyContinue

# Remove old tasks silently
foreach ($t in $TaskDaemon, $TaskMenubar) {
    Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

# ── Daemon scheduled task ────────────────────────────────────────────────────
# Trigger: at logon. Restart on failure up to 10 times with 1-minute delay.

$DaemonAction  = New-ScheduledTaskAction `
    -Execute    $NodeBin `
    -Argument   "`"$(Join-Path $DaemonDir 'src\index.js')`"" `
    -WorkingDirectory $DaemonDir

$DaemonTrigger = New-ScheduledTaskTrigger -AtLogOn

$DaemonSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit      ([TimeSpan]::Zero) `
    -RestartCount            10 `
    -RestartInterval         ([TimeSpan]::FromMinutes(1)) `
    -MultipleInstances       IgnoreNew

$DaemonPrincipal = New-ScheduledTaskPrincipal `
    -UserId    "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel  Highest

Register-ScheduledTask `
    -TaskName   $TaskDaemon `
    -Action     $DaemonAction `
    -Trigger    $DaemonTrigger `
    -Settings   $DaemonSettings `
    -Principal  $DaemonPrincipal `
    -Description 'Anthropic Usage Tracker — proxy + API daemon' | Out-Null

Write-Host "  Daemon task registered: $TaskDaemon"

# ── Menubar scheduled task ───────────────────────────────────────────────────
# RestartOnFailure but NOT on clean exit (Electron exits 0 on quit).

$MenubarAction  = New-ScheduledTaskAction `
    -Execute    $ElectronBin `
    -Argument   "`"$MenubarDir`"" `
    -WorkingDirectory $MenubarDir

$MenubarTrigger = New-ScheduledTaskTrigger -AtLogOn

$MenubarSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit      ([TimeSpan]::Zero) `
    -RestartCount            5 `
    -RestartInterval         ([TimeSpan]::FromMinutes(1)) `
    -MultipleInstances       IgnoreNew

Register-ScheduledTask `
    -TaskName   $TaskMenubar `
    -Action     $MenubarAction `
    -Trigger    $MenubarTrigger `
    -Settings   $MenubarSettings `
    -Principal  $DaemonPrincipal `
    -Description 'Anthropic Usage Tracker — system tray app' | Out-Null

Write-Host "  Menubar task registered: $TaskMenubar"

# ── ANTHROPIC_BASE_URL as a persistent user environment variable ─────────────

$existing = [Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL', 'User')
if (-not $existing) {
    [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', 'http://127.0.0.1:3456', 'User')
    Write-Host "  Set ANTHROPIC_BASE_URL=http://127.0.0.1:3456 (user environment)"
} else {
    Write-Host "  ANTHROPIC_BASE_URL already set: $existing"
}

# ── Start tasks now (no need to log out) ────────────────────────────────────

Start-ScheduledTask -TaskName $TaskDaemon
Start-Sleep -Seconds 1     # let daemon bind its ports
Start-ScheduledTask -TaskName $TaskMenubar

Write-Host ""
Write-Host "  Dashboard  ->  http://127.0.0.1:3457"
Write-Host "  Tray icon  ->  appears in system tray now"
Write-Host ""
Write-Host "  Useful commands:"
Write-Host "    Status:    Get-ScheduledTask -TaskName 'AnthropicTracker*'"
Write-Host "    Logs:      Get-Content '$LogsDir\daemon.log' -Wait"
Write-Host "    Uninstall: .\uninstall.ps1"
Write-Host ""
Write-Host "  Open a new terminal for ANTHROPIC_BASE_URL to take effect."
Write-Host ""
