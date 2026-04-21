# Anthropic Usage Tracker

Track every Claude API call across all surfaces — CLI, SDK, browser, desktop app — from a single dashboard on your machine. Includes session-reset notifications, cost breakdowns by model and surface, and a 30-day usage chart.

---

## Features

- **Universal capture** — intercepts CLI/SDK calls via a local HTTP proxy (`ANTHROPIC_BASE_URL`), browser usage via a Chrome extension, and pulls server-side account-level data (reflects mobile and other devices too)
- **macOS menu bar / Windows system tray** — always-visible usage % with popover details
- **Session reset notifications** — desktop alert the moment your 5-hour limit resets
- **Cost tracking** — per-call cost calculated from current model pricing (Opus, Sonnet, Haiku)
- **Web dashboard** — live stats, model/surface breakdown, 30-day cost chart, recent events
- **Auto-start** — survives reboots and sleep/wake cycles via LaunchAgents (macOS) or Task Scheduler (Windows)
- **Fully local** — no data leaves your machine; SQLite database in `./data/`
- **Open source** — MIT licensed

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Your Machine                           │
│                                                                 │
│  Claude CLI / SDK ──► localhost:3456 (proxy) ──► api.anthropic.com
│                              │                                  │
│  Chrome extension ───────────┤                                  │
│   (claude.ai usage)          │                                  │
│                              ▼                                  │
│                       SQLite database                           │
│                              │                                  │
│                       localhost:3457                            │
│                       ┌──────┴──────┐                           │
│                       │  REST API   │                           │
│                       │  Dashboard  │                           │
│                       └──────┬──────┘                           │
│                              │                                  │
│                    Menu bar / Tray app                          │
└─────────────────────────────────────────────────────────────────┘
```

| Component | Port | Purpose |
|-----------|------|---------|
| Proxy daemon | 3456 | Transparent HTTP proxy — intercepts all Anthropic API calls from CLI/SDK |
| API + Dashboard | 3457 | REST API consumed by the tray app; web dashboard at `http://127.0.0.1:3457` |
| Chrome extension | — | Intercepts `claude.ai` completion requests; polls account-level usage |
| Menu bar / Tray | — | Electron app showing usage % inline; session reset notifications |

---

## Prerequisites

| Requirement | macOS | Windows |
|-------------|-------|---------|
| Node.js 18+ | [nodejs.org](https://nodejs.org) or `brew install node` | [nodejs.org](https://nodejs.org) or nvm-windows |
| npm | Bundled with Node.js | Bundled with Node.js |
| Chrome/Chromium | For browser extension (optional) | For browser extension (optional) |

---

## Installation

### macOS

```bash
# 1. Clone the repository
git clone https://github.com/Coder2808/AnthropicUsageTracker.git
cd AnthropicUsageTracker

# 2. Run the installer (handles Node deps, LaunchAgents, env var)
bash install.sh
```

The installer:
- Detects your Node.js installation (nvm, Homebrew, system)
- Installs npm dependencies for the daemon and menubar
- Creates two macOS LaunchAgents that auto-start at login and restart after crashes/sleep
- Appends `export ANTHROPIC_BASE_URL=http://127.0.0.1:3456` to `~/.zshrc` and `~/.bash_profile`

Open a **new terminal tab** after installation for `ANTHROPIC_BASE_URL` to take effect.

**Uninstall:**
```bash
bash uninstall.sh
```

---

### Windows

> **Important:** `.ps1` scripts must be run from inside PowerShell — not by double-clicking or from Command Prompt. Double-clicking will open the file in a text editor.

1. Press `Win + X` → **Windows PowerShell (Admin)** — or search "PowerShell", right-click → **Run as administrator**
2. In that PowerShell window, run:

```powershell
# 1. Clone the repository
git clone https://github.com/Coder2808/AnthropicUsageTracker.git
cd AnthropicUsageTracker

# 2. Allow script execution (if not already set)
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

# 3. Run the installer
.\install.ps1
```

If Windows still blocks execution, use this one-time bypass:
```powershell
powershell.exe -ExecutionPolicy Bypass -File .\install.ps1
```

The installer:
- Detects your Node.js installation
- Installs npm dependencies for the daemon and menubar
- Registers two Task Scheduler tasks that run at logon and restart on failure
- Sets `ANTHROPIC_BASE_URL=http://127.0.0.1:3456` as a persistent user environment variable

Open a **new terminal** after installation for `ANTHROPIC_BASE_URL` to take effect.

**Uninstall:**
```powershell
.\uninstall.ps1
```

---

### Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked** and select the `extension/` folder
4. The extension icon appears in your toolbar — it will begin tracking `claude.ai` sessions immediately

> The extension requires the daemon to be running at `localhost:3457` to POST events.

---

## Usage

### Dashboard

Open `http://127.0.0.1:3457` in your browser for the full web dashboard:
- **Account limits** — session and weekly usage from the Anthropic API (reflects all your devices)
- **Stats** — today / this week / this month token counts and costs
- **Breakdown** — usage split by model and surface (CLI, SDK, web)
- **Cost chart** — 30-day daily cost history
- **Recent events** — last 50 API calls with timestamps, models, and token counts

### Menu bar (macOS)

The menu bar shows your current session usage percentage inline (e.g. `84%`). Click the icon to open the popover with full details.

### System tray (Windows)

The tray icon tooltip shows `Claude  Session: 84% — click to view`. Left-click opens the popover; right-click shows a context menu with **Show Usage**, **Open Dashboard**, and **Quit**.

### Session reset notifications

When your 5-hour session window resets, you receive a desktop notification. Click the notification to open the usage popover.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:3456` | Set by the installer. Routes CLI/SDK calls through the local proxy. |
| `DAEMON_API` (menubar) | `http://127.0.0.1:3457/api` | Internal — change in `menubar/main.js` if you remap the port. |
| `POLL_INTERVAL_MS` (menubar) | `30000` | How often the tray app polls the daemon (ms). |

To change ports, update `daemon/src/index.js` (the two `listen()` calls) and the matching constants in `menubar/main.js` and `extension/background.js`.

---

## Development

```bash
# Start the daemon (restarts automatically with nodemon)
cd daemon && npm run dev

# Start the menubar app (kills previous instance first)
cd menubar && npm start

# Load the extension in Chrome via chrome://extensions/ → Load unpacked → extension/
```

**Project layout:**
```
anthropic-tracker/
├── daemon/
│   ├── src/
│   │   ├── index.js       # entry point — starts proxy (3456) and API server (3457)
│   │   ├── proxy.js       # HTTP proxy with SSE stream parsing
│   │   ├── routes.js      # REST API routes
│   │   ├── db.js          # SQLite schema and query helpers
│   │   └── pricing.js     # model pricing table and cost calculator
│   └── public/
│       ├── index.html     # web dashboard
│       └── app.js         # dashboard frontend logic
├── menubar/
│   ├── main.js            # Electron main process (cross-platform)
│   ├── preload.js         # context-bridge IPC
│   └── ui/
│       ├── index.html     # popover UI
│       └── app.js         # popover frontend logic
├── extension/
│   ├── manifest.json      # Chrome MV3 manifest
│   ├── background.js      # service worker — intercepts requests, polls usage
│   ├── popup.html         # extension popup
│   └── popup.js           # popup logic
├── install.sh             # macOS installer
├── uninstall.sh           # macOS uninstaller
├── install.ps1            # Windows installer
└── uninstall.ps1          # Windows uninstaller
```

---

## How it works

### Proxy (CLI / SDK)

Setting `ANTHROPIC_BASE_URL=http://127.0.0.1:3456` causes the Claude CLI and any code using the Anthropic SDK to route requests through the local proxy. The proxy:

1. Forwards the request to `api.anthropic.com` with the original headers and body
2. Streams the response back to the caller without buffering (zero added latency)
3. Parses Server-Sent Events in the background to extract token counts from `message_start` and `message_delta` events
4. Saves the event to SQLite with model, surface, input/output tokens, and calculated cost

### Browser extension (claude.ai)

The Chrome extension uses `chrome.webRequest` to observe completion requests on `claude.ai`. It also polls the Anthropic account usage endpoint every 2 minutes to capture session percentage and weekly limits — these numbers reflect usage from *all* your devices, not just the current machine.

### Tray app

The Electron tray app polls the local daemon every 30 seconds and updates the menu bar title / tooltip. It arms a precise `setTimeout` to fire a desktop notification exactly when the session window resets.

---

## Supported models and pricing

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|------------------------|
| Claude Opus 4 / 3 | $15.00 | $75.00 |
| Claude Sonnet 4 / 3.7 / 3.5 / 3 | $3.00 | $15.00 |
| Claude Haiku 3.5 / 3 | $0.80 | $4.00 |

Prices are updated in `daemon/src/pricing.js`.

---

## Privacy

- All data is stored locally in `./data/usage.db` (SQLite)
- The proxy never logs request or response bodies — only token counts and model names
- The Chrome extension only reads `claude.ai` pages and communicates exclusively with `localhost:3457`
- No telemetry, no external services

---

## Troubleshooting

**Daemon not running**
```bash
# macOS
launchctl list | grep anthropic-tracker
tail -f logs/daemon.error.log

# Windows
Get-ScheduledTask -TaskName 'AnthropicTrackerDaemon'
Get-Content logs\daemon.error.log -Wait
```

**Menu bar / tray icon missing**
```bash
# macOS — restart both agents
launchctl unload ~/Library/LaunchAgents/com.anthropic-tracker.menubar.plist
launchctl load  ~/Library/LaunchAgents/com.anthropic-tracker.menubar.plist

# Windows
Stop-ScheduledTask  -TaskName AnthropicTrackerMenubar
Start-ScheduledTask -TaskName AnthropicTrackerMenubar
```

**CLI calls not tracked**

Check that `ANTHROPIC_BASE_URL` is set in your current shell:
```bash
echo $ANTHROPIC_BASE_URL   # should print http://127.0.0.1:3456
```
If empty, open a new terminal or source your shell config (`source ~/.zshrc`).

**Extension shows "daemon offline"**

Ensure the daemon is running at `http://127.0.0.1:3457`. Open the URL in your browser — you should see the dashboard.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit your changes: `git commit -m 'feat: add my feature'`
4. Push and open a pull request

Please open an issue first for significant changes so we can discuss the approach.

---

## License

MIT — see [LICENSE](LICENSE) for details.
