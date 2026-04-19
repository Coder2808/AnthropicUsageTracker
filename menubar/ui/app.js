function fmt$(v)    { return '$' + (v ?? 0).toFixed(3); }
function fmtTok(v)  { if (!v) return '0'; return v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(1)+'K' : String(Math.round(v)); }
function cls(pct)   { return pct >= 90 ? 'high' : pct >= 65 ? 'warn' : 'ok'; }

function fmtReset(ts) {
  if (!ts) return '';
  const d = ts - Date.now();
  if (d <= 0) return 'reset now';
  const h = Math.floor(d / 3_600_000);
  const m = Math.floor((d % 3_600_000) / 60_000);
  if (h >= 24) return `resets in ${Math.floor(h/24)}d ${h%24}h`;
  return `resets in ${h}h ${m}m`;
}

function renderOffline() {
  document.getElementById('daemon-dot').className = 'daemon-dot err';
  document.getElementById('last-update').textContent = 'Daemon offline';
  document.getElementById('main-content').innerHTML = `
    <div class="offline">
      <div class="icon">⚡</div>
      <div class="msg">
        The tracker daemon isn't running.<br>
        Start it with:<br>
        <code>cd anthropic-tracker/daemon && npm start</code>
      </div>
    </div>`;
}

function renderLimits(snap) {
  const limits = [
    { name: 'Session (5h)', pct: snap?.session_pct,      resetsAt: snap?.session_resets_at },
    { name: 'Weekly',       pct: snap?.weekly_pct,        resetsAt: snap?.weekly_resets_at  },
    { name: 'Sonnet wkly', pct: snap?.sonnet_weekly_pct, resetsAt: snap?.weekly_resets_at  },
    { name: 'Opus wkly',   pct: snap?.opus_weekly_pct,   resetsAt: snap?.weekly_resets_at  },
  ].filter(l => l.pct !== null && l.pct !== undefined);

  if (!limits.length) {
    return `<div class="no-limits">Open claude.ai to fetch limits</div>`;
  }

  return limits.map(l => {
    const pct = Math.round(l.pct ?? 0);
    const c   = cls(pct);
    return `
      <div class="limit-row">
        <div class="limit-top">
          <span class="limit-name">${l.name}</span>
          <span class="limit-pct ${c}">${pct}%</span>
        </div>
        <div class="bar"><div class="bar-fill ${c}" style="width:${Math.min(pct,100)}%"></div></div>
        <div class="limit-reset">${fmtReset(l.resetsAt)}</div>
      </div>`;
  }).join('');
}

function renderStats(stats) {
  const t = stats?.today?.totals ?? {};
  const w = stats?.week?.totals  ?? {};
  const m = stats?.month?.totals ?? {};
  return `
    <div class="stats-row">
      <div class="stat-cell">
        <div class="stat-label">Today</div>
        <div class="stat-value">${fmt$(t.cost_usd)}</div>
        <div class="stat-sub">${fmtTok(t.total_tokens)} tok</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">Week</div>
        <div class="stat-value">${fmt$(w.cost_usd)}</div>
        <div class="stat-sub">${fmtTok(w.total_tokens)} tok</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">Month</div>
        <div class="stat-value">${fmt$(m.cost_usd)}</div>
        <div class="stat-sub">${fmtTok(m.total_tokens)} tok</div>
      </div>
    </div>`;
}

async function load() {
  const daemonOk = await window.tracker.checkDaemon().catch(() => null);

  if (!daemonOk) {
    renderOffline();
    return;
  }

  document.getElementById('daemon-dot').className   = 'daemon-dot ok';
  document.getElementById('last-update').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const [snap, stats] = await Promise.all([
    window.tracker.fetchSnapshot().catch(() => null),
    window.tracker.fetchStats().catch(() => null),
  ]);

  document.getElementById('main-content').innerHTML = `
    <div class="section">
      <div class="section-label">Account limits · all surfaces</div>
      ${renderLimits(snap)}
    </div>
    ${stats ? renderStats(stats) : ''}`;
}

// Wire up buttons (no inline onclick — required by Content-Security-Policy)
document.getElementById('close-btn')?.addEventListener('click', () => window.tracker.hideWindow());
document.getElementById('refresh-btn')?.addEventListener('click', load);
document.getElementById('dashboard-btn')?.addEventListener('click', () => window.tracker.openDashboard());

// Refresh when the main process signals (tray click)
window.tracker.onRefresh(() => load());

load();
