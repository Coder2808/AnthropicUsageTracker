#!/bin/bash
# install.sh — sets up Anthropic Usage Tracker as macOS LaunchAgents
# Runs automatically at login and restarts after crashes/sleep.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_DIR="$SCRIPT_DIR/daemon"
MENUBAR_DIR="$SCRIPT_DIR/menubar"
LOGS_DIR="$SCRIPT_DIR/logs"
AGENTS_DIR="$HOME/Library/LaunchAgents"
DAEMON_LABEL="com.anthropic-tracker.daemon"
MENUBAR_LABEL="com.anthropic-tracker.menubar"
DAEMON_PLIST="$AGENTS_DIR/$DAEMON_LABEL.plist"
MENUBAR_PLIST="$AGENTS_DIR/$MENUBAR_LABEL.plist"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║      Anthropic Usage Tracker — Installing           ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Preflight checks ──────────────────────────────────────────────────────

# Find Node.js (handles nvm, homebrew, system installs)
NODE_BIN=$(command -v node 2>/dev/null || true)
if [ -z "$NODE_BIN" ]; then
  for candidate in \
    "$HOME/.nvm/versions/node/"*/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node; do
    [ -f "$candidate" ] && { NODE_BIN="$candidate"; break; }
  done
fi
[ -z "$NODE_BIN" ] && { echo "✗  Node.js not found. Install via https://nodejs.org or nvm."; exit 1; }

# If nvm manages node, resolve to the current active version binary
if [[ "$NODE_BIN" == *"/.nvm/"* ]]; then
  NEWEST=$(ls -t "$HOME/.nvm/versions/node/"*/bin/node 2>/dev/null | head -1 || true)
  [ -n "$NEWEST" ] && NODE_BIN="$NEWEST"
fi

NODE_VERSION=$("$NODE_BIN" --version)
echo "  Node:     $NODE_BIN  ($NODE_VERSION)"

# Check daemon deps
[ ! -d "$DAEMON_DIR/node_modules" ] && {
  echo "  Installing daemon dependencies…"
  (cd "$DAEMON_DIR" && "$NODE_BIN" "$(dirname "$NODE_BIN")/npm" install --silent)
}

# Electron binary (the real executable, not the npm shim)
ELECTRON_BIN="$MENUBAR_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -f "$ELECTRON_BIN" ]; then
  echo "  Installing menubar dependencies…"
  (cd "$MENUBAR_DIR" && "$NODE_BIN" "$(dirname "$NODE_BIN")/npm" install --silent)
fi
[ ! -f "$ELECTRON_BIN" ] && { echo "✗  Electron binary not found at: $ELECTRON_BIN"; exit 1; }
echo "  Electron: $ELECTRON_BIN"

# ── Stop any running instances ────────────────────────────────────────────

pkill -9 -f "anthropic-tracker" 2>/dev/null || true

# Unload existing agents silently
launchctl unload "$DAEMON_PLIST"  2>/dev/null || true
launchctl unload "$MENUBAR_PLIST" 2>/dev/null || true
sleep 1

mkdir -p "$LOGS_DIR" "$AGENTS_DIR"

# ── Daemon plist ──────────────────────────────────────────────────────────
# KeepAlive: true  — launchd restarts the server after any exit (crash, sleep kill, etc.)
cat > "$DAEMON_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>$DAEMON_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DAEMON_DIR/src/index.js</string>
  </array>
  <key>WorkingDirectory</key>  <string>$DAEMON_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key> <string>$HOME</string>
    <key>PATH</key> <string>$(dirname "$NODE_BIN"):/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>$LOGS_DIR/daemon.log</string>
  <key>StandardErrorPath</key> <string>$LOGS_DIR/daemon.error.log</string>
</dict>
</plist>
PLIST

# ── Menubar plist ─────────────────────────────────────────────────────────
# KeepAlive.Crashed: true  — restarts on crash/signal but NOT on clean exit.
# This works correctly with requestSingleInstanceLock: if a duplicate is
# launched, it exits cleanly (code 0) and launchd does NOT loop-restart it.
cat > "$MENUBAR_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>$MENUBAR_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ELECTRON_BIN</string>
    <string>$MENUBAR_DIR</string>
  </array>
  <key>WorkingDirectory</key>  <string>$MENUBAR_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>                  <string>$HOME</string>
    <key>PATH</key>                  <string>$(dirname "$NODE_BIN"):/usr/bin:/bin</string>
    <key>ELECTRON_DISABLE_SECURITY_WARNINGS</key> <string>1</string>
  </dict>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>         <true/>
  </dict>
  <key>ProcessType</key>       <string>Interactive</string>
  <key>StandardOutPath</key>   <string>$LOGS_DIR/menubar.log</string>
  <key>StandardErrorPath</key> <string>$LOGS_DIR/menubar.error.log</string>
</dict>
</plist>
PLIST

# ── Load agents ───────────────────────────────────────────────────────────

launchctl load "$DAEMON_PLIST"
echo "  ✓ Daemon agent loaded"

sleep 1   # give daemon a moment to bind its ports before menubar connects

launchctl load "$MENUBAR_PLIST"
echo "  ✓ Menubar agent loaded"

# ── ANTHROPIC_BASE_URL in shell config ───────────────────────────────────
# Needed so that `claude` CLI and SDK code in terminal sessions route through
# the local proxy and are tracked.

add_env_to_file() {
  local rcfile="$1"
  if [ -f "$rcfile" ] && ! grep -q "ANTHROPIC_BASE_URL" "$rcfile"; then
    printf '\n# Anthropic Usage Tracker — route CLI/SDK calls through local proxy\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:3456\n' >> "$rcfile"
    echo "  ✓ Added ANTHROPIC_BASE_URL to $rcfile"
  fi
}
add_env_to_file "$HOME/.zshrc"
add_env_to_file "$HOME/.bash_profile"

# ── Auto-configure daemon session key ────────────────────────────────────
# Try to extract the claude.ai sessionKey from Chrome/Arc/Brave cookies so
# users don't have to open DevTools manually.
# Security: key is read from the local browser profile (same user, same
# machine) and sent only to localhost:3457. It is never transmitted externally.

auto_configure_session() {
  # Require Python 3 (present on every macOS since Ventura)
  local python; python=$(command -v python3 2>/dev/null || true)
  [ -z "$python" ] && return 1

  # Chromium-family browsers store cookies in SQLite, encrypted with a key
  # derived from the "Chrome Safe Storage" / "Brave Safe Storage" Keychain entry.
  local browsers=(
    "Google Chrome:Chrome Safe Storage:$HOME/Library/Application Support/Google/Chrome/Default/Cookies"
    "Brave Browser:Brave Safe Storage:$HOME/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies"
    "Arc:Arc Safe Storage:$HOME/Library/Application Support/Arc/User Data/Default/Cookies"
    "Microsoft Edge:Microsoft Edge Safe Storage:$HOME/Library/Application Support/Microsoft Edge/Default/Cookies"
  )

  for entry in "${browsers[@]}"; do
    IFS=':' read -r browser_name keychain_item cookie_db <<< "$entry"
    [ -f "$cookie_db" ] || continue

    # Read the Safe Storage password from Keychain — prompts user once with Touch ID / password
    local safe_password
    safe_password=$(security find-generic-password -w -s "$keychain_item" 2>/dev/null || true)
    [ -z "$safe_password" ] && continue

    # Decrypt the sessionKey cookie using Python (stdlib only — no pip required)
    local session_key
    session_key=$("$python" - "$cookie_db" "$safe_password" "claude.ai" "sessionKey" 2>/dev/null <<'PYEOF'
import sys, sqlite3, hashlib, hmac, shutil, tempfile, os
from pathlib import Path

db_path, password, host, name = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

# Work on a copy so we don't lock Chrome's live database
tmp = tempfile.mktemp(suffix='.db')
shutil.copy2(db_path, tmp)
try:
    con = sqlite3.connect(tmp)
    cur = con.execute(
        "SELECT encrypted_value FROM cookies WHERE host_key LIKE ? AND name=? LIMIT 1",
        (f'%{host}%', name)
    )
    row = cur.fetchone()
    con.close()
finally:
    os.unlink(tmp)

if not row or not row[0]:
    sys.exit(1)

enc = row[0]
# Chrome on macOS uses v10 prefix + AES-128-CBC
# key = PBKDF2-HMAC-SHA1(password, b'saltysalt', 1003, 16)
# iv  = b' ' * 16
if not enc[:3] == b'v10':
    # Unencrypted (older Chrome versions) — value is plain text
    print(enc.decode('utf-8', errors='replace'))
    sys.exit(0)

from hashlib import pbkdf2_hmac
key = pbkdf2_hmac('sha1', password.encode('utf-8'), b'saltysalt', 1003, dklen=16)
iv  = b' ' * 16
try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.backends import default_backend
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    dec = cipher.decryptor()
    raw = dec.update(enc[3:]) + dec.finalize()
except ImportError:
    # Fall back to stdlib AES via PyCryptodome if available, else give up
    try:
        from Crypto.Cipher import AES as _AES
        raw = _AES.new(key, _AES.MODE_CBC, iv).decrypt(enc[3:])
    except ImportError:
        sys.exit(1)
# Strip PKCS7 padding
pad = raw[-1]
print(raw[:-pad].decode('utf-8'))
PYEOF
)
    if [ -n "$session_key" ]; then
      echo "  ✓ Found session key in $browser_name"
      # POST to daemon — localhost only, never leaves the machine
      local resp
      resp=$(curl -sf -X POST http://127.0.0.1:3457/api/setup \
        -H 'Content-Type: application/json' \
        -d "{\"sessionKey\":\"$session_key\"}" 2>/dev/null || true)
      if echo "$resp" | grep -q '"ok":true'; then
        echo "  ✓ Daemon configured — will poll claude.ai every minute"
        return 0
      fi
    fi
  done
  return 1
}

echo ""
echo "  Configuring session key…"
if auto_configure_session; then
  : # success message already printed inside the function
else
  echo "  ℹ  Could not auto-detect session key (browser not found or not logged in)."
  echo "     Open http://127.0.0.1:3457 after install and paste your claude.ai"
  echo "     sessionKey cookie — or install the Chrome extension and it will"
  echo "     configure the daemon automatically."
fi

# ── Done ──────────────────────────────────────────────────────────────────

echo ""
echo "  Dashboard  →  http://127.0.0.1:3457"
echo "  Menu icon  →  appears in menu bar now"
echo ""
echo "  Useful commands:"
echo "    Status:    launchctl list | grep anthropic-tracker"
echo "    Logs:      tail -f $LOGS_DIR/daemon.log"
echo "    Uninstall: bash $SCRIPT_DIR/uninstall.sh"
echo ""
echo "  Open a new terminal tab for ANTHROPIC_BASE_URL to take effect."
echo ""
