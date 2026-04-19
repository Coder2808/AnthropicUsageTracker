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
