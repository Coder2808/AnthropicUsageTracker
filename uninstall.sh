#!/bin/bash
# uninstall.sh — removes Anthropic Usage Tracker LaunchAgents and stops all processes
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
DAEMON_LABEL="com.anthropic-tracker.daemon"
MENUBAR_LABEL="com.anthropic-tracker.menubar"

echo ""
echo "  Stopping processes…"
pkill -9 -f "anthropic-tracker" 2>/dev/null || true

echo "  Unloading LaunchAgents…"
launchctl unload "$AGENTS_DIR/$DAEMON_LABEL.plist"  2>/dev/null || true
launchctl unload "$AGENTS_DIR/$MENUBAR_LABEL.plist" 2>/dev/null || true

echo "  Removing plist files…"
rm -f "$AGENTS_DIR/$DAEMON_LABEL.plist"
rm -f "$AGENTS_DIR/$MENUBAR_LABEL.plist"

echo ""
echo "  ✓ Uninstalled. The SQLite database and logs at:"
echo "    $SCRIPT_DIR/data/"
echo "    $SCRIPT_DIR/logs/"
echo "  were kept. Delete them manually if you want a clean slate."
echo ""
echo "  Note: ANTHROPIC_BASE_URL in ~/.zshrc was NOT removed."
echo "  Remove it manually if you no longer need the proxy."
echo ""
