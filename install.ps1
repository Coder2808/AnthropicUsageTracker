# install.ps1 -- sets up Anthropic Usage Tracker as Windows Scheduled Tasks
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
Write-Host "  Anthropic Usage Tracker -- Installing (Windows)"
Write-Host ""

# -- Find Node.js ------------------------------------------------------------

$_cmd = Get-Command node -ErrorAction SilentlyContinue
$NodeBin = if ($_cmd) { $_cmd.Source } else { $null }
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

# -- Install dependencies -----------------------------------------------------

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

# -- Stop any running instances -----------------------------------------------

Get-Process -Name 'node','electron' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -match 'anthropic-tracker' } |
    Stop-Process -Force -ErrorAction SilentlyContinue

# Remove old tasks silently
foreach ($t in $TaskDaemon, $TaskMenubar) {
    Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

# -- Daemon scheduled task ----------------------------------------------------
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
    -Description 'Anthropic Usage Tracker -- proxy + API daemon' | Out-Null

Write-Host "  Daemon task registered: $TaskDaemon"

# -- Menubar scheduled task ---------------------------------------------------
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
    -Description 'Anthropic Usage Tracker -- system tray app' | Out-Null

Write-Host "  Menubar task registered: $TaskMenubar"

# -- ANTHROPIC_BASE_URL as a persistent user environment variable -------------

$existing = [Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL', 'User')
if (-not $existing) {
    [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', 'http://127.0.0.1:3456', 'User')
    Write-Host "  Set ANTHROPIC_BASE_URL=http://127.0.0.1:3456 (user environment)"
} else {
    Write-Host "  ANTHROPIC_BASE_URL already set: $existing"
}

# -- Start tasks now (no need to log out) ------------------------------------

Start-ScheduledTask -TaskName $TaskDaemon
Start-Sleep -Seconds 2     # let daemon bind its ports
Start-ScheduledTask -TaskName $TaskMenubar

# -- Auto-configure session key -----------------------------------------------
# Reads the claude.ai sessionKey from Chrome/Edge/Brave and sends it to the
# daemon so it can poll usage data independently -- no browser extension needed.
#
# Security model:
#   * Cookies are decrypted using DPAPI (Windows Data Protection API) -- this
#     is the same mechanism Chrome uses and requires no extra privileges.
#   * The session key is transmitted only to localhost:3457, never externally.
#   * Python (already required) handles SQLite reads and AES-256-GCM decryption.

function Invoke-AutoConfigureSession {
    # Locate Python (required for SQLite access and AES-GCM decryption)
    $_py = Get-Command python -ErrorAction SilentlyContinue
    $python = if ($_py) { $_py.Source } else { $null }
    if (-not $python) {
        $_py3 = Get-Command python3 -ErrorAction SilentlyContinue
        $python = if ($_py3) { $_py3.Source } else { $null }
    }
    if (-not $python) { return $false }

    # Build Python script as a string array and join with newlines.
    # Avoids here-strings whose embedded try/except blocks can confuse
    # the PowerShell 5.1 parser even though the content is never executed.
    $pyLines = @(
        'import sys, sqlite3, shutil, tempfile, os',
        'db_path, key_hex = sys.argv[1], sys.argv[2]',
        'aes_key = bytes.fromhex(key_hex)',
        'tmp = tempfile.mktemp(suffix=''.db'')',
        'shutil.copy2(db_path, tmp)',
        'row = None',
        'con = sqlite3.connect(tmp)',
        'row = con.execute("SELECT encrypted_value FROM cookies WHERE host_key LIKE ' + "'%claude.ai%'" + ' AND name=' + "'sessionKey'" + ' LIMIT 1").fetchone()',
        'con.close()',
        'os.unlink(tmp)',
        'if not row or not row[0]: sys.exit(1)',
        'enc = bytes(row[0])',
        'if enc[:3] != b"v10": print(enc.decode("utf-8", errors="replace")); sys.exit(0)',
        'nonce = enc[3:15]',
        'payload = enc[15:]',
        'plain = None',
        'try:',
        '    from cryptography.hazmat.primitives.ciphers.aead import AESGCM',
        '    plain = AESGCM(aes_key).decrypt(nonce, payload, None)',
        'except Exception:',
        '    pass',
        'if plain is None:',
        '    from Crypto.Cipher import AES',
        '    plain = AES.new(aes_key, AES.MODE_GCM, nonce=nonce).decrypt(payload[:-16])',
        'print(plain.decode("utf-8"))'
    )
    $pyScript = $pyLines -join "`n"

    # Chromium-family browser profiles on Windows
    $browsers = @(
        [PSCustomObject]@{
            Name       = 'Google Chrome'
            LocalState = "$env:LOCALAPPDATA\Google\Chrome\User Data\Local State"
            Cookies    = @(
                "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Network\Cookies",
                "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Cookies"
            )
        }
        [PSCustomObject]@{
            Name       = 'Microsoft Edge'
            LocalState = "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Local State"
            Cookies    = @(
                "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Network\Cookies",
                "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Cookies"
            )
        }
        [PSCustomObject]@{
            Name       = 'Brave Browser'
            LocalState = "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data\Local State"
            Cookies    = @(
                "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data\Default\Network\Cookies",
                "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data\Default\Cookies"
            )
        }
    )

    Add-Type -AssemblyName System.Security

    $result = $false
    $browserIndex = 0

    while (-not $result -and $browserIndex -lt $browsers.Count) {
        $browser = $browsers[$browserIndex]
        $browserIndex++

        if (-not (Test-Path $browser.LocalState)) { continue }

        $cookiesDb = $null
        foreach ($p in $browser.Cookies) {
            if (Test-Path $p) { $cookiesDb = $p; break }
        }
        if (-not $cookiesDb) { continue }

        $sessionKey = $null
        $aesKeyHex  = $null

        # Step 1 -- read DPAPI-encrypted AES key from Local State
        $state = $null
        try {
            $state = Get-Content $browser.LocalState -Raw | ConvertFrom-Json
        } catch {
            continue
        }

        $encB64 = $null
        try { $encB64 = $state.os_crypt.encrypted_key } catch { }
        if (-not $encB64) { continue }

        # Step 2 -- decrypt AES key with Windows DPAPI
        try {
            $encBytes    = [Convert]::FromBase64String($encB64)
            $cipherBytes = $encBytes[5..($encBytes.Length - 1)]
            $aesKeyBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
                $cipherBytes, $null,
                [System.Security.Cryptography.DataProtectionScope]::CurrentUser
            )
            $aesKeyHex = [BitConverter]::ToString($aesKeyBytes).Replace('-', '').ToLower()
        } catch {
            continue
        }

        # Step 3 -- write Python script to temp file, decrypt cookie
        $tmpPy = [IO.Path]::GetTempFileName() + '.py'
        try {
            $pyScript | Set-Content $tmpPy -Encoding UTF8
            $sessionKey = & $python $tmpPy $cookiesDb $aesKeyHex 2>$null
        } catch {
            $sessionKey = $null
        }
        Remove-Item $tmpPy -Force -ErrorAction SilentlyContinue

        if (-not $sessionKey -or $sessionKey.Length -lt 10) { continue }

        # Step 4 -- POST to daemon (localhost only -- never transmitted externally)
        $body = "{`"sessionKey`":`"$($sessionKey.Trim())`"}"
        $resp = $null
        try {
            $resp = Invoke-RestMethod `
                -Uri         'http://127.0.0.1:3457/api/setup' `
                -Method      POST `
                -Body        $body `
                -ContentType 'application/json' `
                -ErrorAction SilentlyContinue
        } catch {
            $resp = $null
        }

        if ($resp -and $resp.ok) {
            Write-Host "  Found session key in $($browser.Name)"
            Write-Host "  Daemon configured -- will poll claude.ai every minute"
            $result = $true
        }
    }

    return $result
}

Write-Host ""
Write-Host "  Configuring session key..."
$configured = Invoke-AutoConfigureSession
if (-not $configured) {
    Write-Host "  Could not auto-detect session key (browser not found or not logged in)."
    Write-Host "  Open http://127.0.0.1:3457 and paste your claude.ai sessionKey cookie,"
    Write-Host "  or install the Chrome extension and it will configure automatically."
}

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
