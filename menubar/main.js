const { app, BrowserWindow, Tray, nativeImage, ipcMain, shell, screen, Notification, Menu } = require('electron');
const path = require('path');
const zlib = require('zlib');
const fs   = require('fs');
const os   = require('os');

const DAEMON_API       = 'http://127.0.0.1:3457/api';
const POLL_INTERVAL_MS = 30_000;
const IS_MAC           = process.platform === 'darwin';
const IS_WIN           = process.platform === 'win32';

let tray, win;

// ── Reset notification state ───────────────────────────────────────────────
let resetTimer         = null;
let lastScheduledReset = null;
let lastNotifiedReset  = null;

// ── PNG generator (pure Node.js, no deps) ─────────────────────────────────

function crc32(buf) {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = t[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(d.length);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, d])));
  return Buffer.concat([len, t, d, crcBuf]);
}

function buildPNG(size, getPixel) {
  const sig  = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = ihdr[11] = ihdr[12] = 0;
  const raw = Buffer.allocUnsafe(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1); raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = getPixel(x, y);
      const i = row + 1 + x * 4;
      raw[i] = r; raw[i+1] = g; raw[i+2] = b; raw[i+3] = a;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// "C" arc icon — thick ring with ~55° gap on the right side
function makeIconPNG(size = 22) {
  const cx = (size - 1) / 2, cy = (size - 1) / 2;
  const outer = size / 2 - 1.5, inner = outer - 4.0, half = 55 / 2;
  return buildPNG(size, (x, y) => {
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const deg  = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    const inGap = deg > (360 - half) || deg < half;
    const outerA = Math.min(1, Math.max(0, outer + 0.5 - dist));
    const innerA = Math.min(1, Math.max(0, dist - inner + 0.5));
    const alpha  = Math.min(outerA, innerA);
    return (alpha > 0 && !inGap) ? [0, 0, 0, Math.round(alpha * 255)] : [0, 0, 0, 0];
  });
}

function writeTempIcon() {
  const p = path.join(os.tmpdir(), 'anthropic-tracker-icon.png');
  fs.writeFileSync(p, makeIconPNG(22));
  return p;
}

// ── Single-instance lock ───────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

if (app.dock) app.dock.hide();          // macOS: hide from Dock
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(() => {
  createTray();
  createWindow();
  pollAndUpdateTitle();
  setInterval(pollAndUpdateTitle, POLL_INTERVAL_MS);
});

// ── Tray ───────────────────────────────────────────────────────────────────

function createTray() {
  const icon = nativeImage.createFromPath(writeTempIcon());
  if (IS_MAC) icon.setTemplateImage(true); // macOS: auto-adapts for light/dark menu bar

  tray = new Tray(icon);
  tray.setToolTip('Anthropic Usage Tracker');

  if (IS_MAC) {
    tray.setTitle(' Claude');
    tray.on('click', toggleWindow);
  } else {
    // Windows/Linux: left-click opens popover, right-click shows menu
    tray.on('click', toggleWindow);
    tray.on('right-click', () => tray.popUpContextMenu(buildContextMenu()));
  }

  console.log('[tray] created, icon size:', icon.getSize());
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show Usage',      click: toggleWindow },
    { label: 'Open Dashboard',  click: () => shell.openExternal('http://127.0.0.1:3457') },
    { type: 'separator' },
    { label: 'Quit',            click: () => app.exit(0) },
  ]);
}

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 320,
    height: 360,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Level string ('pop-up-menu') is macOS-specific; plain true works everywhere
  if (IS_MAC) {
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    win.setAlwaysOnTop(true);
  }

  win.on('blur', () => win.hide());
}

function getWindowPosition() {
  const tb   = tray.getBounds();
  const wb   = win.getBounds();
  const work = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;

  let x = Math.round(tb.x + tb.width / 2 - wb.width / 2);
  // macOS: menu bar at top  → window appears below icon
  // Windows/Linux: taskbar at bottom → window appears above icon
  let y = IS_MAC
    ? Math.round(tb.y + tb.height + 4)
    : Math.round(tb.y - wb.height - 4);

  x = Math.max(work.x + 4, Math.min(x, work.x + work.width  - wb.width  - 4));
  y = Math.max(work.y + 4, Math.min(y, work.y + work.height - wb.height - 4));
  return { x, y };
}

function toggleWindow() {
  if (win.isVisible()) {
    win.hide();
  } else {
    const { x, y } = getWindowPosition();
    win.setPosition(x, y, false);
    win.show();
    win.focus(); // tray clicks don't transfer focus automatically — grab it explicitly
    win.webContents.send('refresh');
  }
}

// ── Tray title / tooltip update ────────────────────────────────────────────

async function pollAndUpdateTitle() {
  try {
    const snap    = await fetch(`${DAEMON_API}/snapshot`).then(r => r.json());
    const pct     = snap?.session_pct;

    if (pct == null) {
      if (IS_MAC) tray.setTitle(' —');
      tray.setToolTip('Claude Usage Tracker — no data yet');
      return;
    }

    const rounded = Math.round(pct);
    const alert   = rounded >= 90 ? ' !' : '';

    if (IS_MAC) {
      tray.setTitle(` ${rounded}%${alert}`);       // shown inline in menu bar
    }
    tray.setToolTip(`Claude  Session: ${rounded}%${alert} — click to view`);

    scheduleResetNotification(snap);
  } catch {
    if (IS_MAC) tray.setTitle(' Claude');
    tray.setToolTip('Claude Usage Tracker — daemon offline');
  }
}

// ── Session reset notifications ────────────────────────────────────────────

function scheduleResetNotification(snap) {
  const resetsAt = snap?.session_resets_at;
  if (!resetsAt) return;

  const now   = Date.now();
  const delay = resetsAt - now;

  // Polling fallback: reset already passed and not yet notified
  if (delay <= 0 && delay > -5 * 60_000 && lastNotifiedReset !== resetsAt) {
    fireResetNotification(resetsAt);
    return;
  }

  // Arm a precise timer once per unique resetsAt
  if (resetsAt !== lastScheduledReset && delay > 0 && delay < 6 * 60 * 60_000) {
    lastScheduledReset = resetsAt;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => fireResetNotification(resetsAt), delay + 2_000);
    console.log(`[notify] Reset timer armed — fires in ${Math.round(delay / 60_000)}m`);
  }
}

function fireResetNotification(resetsAt) {
  if (lastNotifiedReset === resetsAt) return;
  lastNotifiedReset = resetsAt;

  if (!Notification.isSupported()) {
    console.warn('[notify] Notifications not supported');
    return;
  }

  const n = new Notification({
    title: 'Claude session reset',
    body:  "Your 5-hour usage limit has reset — you're ready for a fresh session.",
    silent: false,
  });
  n.on('click', () => toggleWindow());
  n.show();

  console.log('[notify] Reset notification fired');
  setTimeout(pollAndUpdateTitle, 3_000);
}

// ── IPC ────────────────────────────────────────────────────────────────────

ipcMain.on('open-dashboard', () => { shell.openExternal('http://127.0.0.1:3457'); win.hide(); });
ipcMain.on('hide-window',    () => win.hide());

ipcMain.handle('fetch-stats',    () => fetch(`${DAEMON_API}/stats`).then(r => r.json()));
ipcMain.handle('fetch-snapshot', () => fetch(`${DAEMON_API}/snapshot`).then(r => r.json()));
ipcMain.handle('check-daemon',   () => fetch(`${DAEMON_API}/health`).then(r => r.json()).catch(() => null));
