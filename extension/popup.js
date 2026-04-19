function limitClass(pct) {
  if (pct >= 90) return 'high';
  if (pct >= 70) return 'warn';
  return 'ok';
}
function fmtReset(ts) {
  if (!ts) return '';
  const d = ts - Date.now();
  if (d <= 0) return 'reset past';
  const h = Math.floor(d / 3600000), m = Math.floor((d % 3600000) / 60000);
  return h >= 24 ? `${Math.floor(h/24)}d ${h%24}h` : `${h}h ${m}m`;
}

async function init() {
  // Check daemon health
  const statusRes = await chrome.runtime.sendMessage({ type: 'getStatus' });

  const dot  = document.getElementById('dot');
  const txt  = document.getElementById('status-text');

  if (statusRes?.daemon) {
    dot.className  = 'dot ok';
    txt.className  = 'status-text ok';
    txt.textContent = 'Daemon running';
  } else {
    dot.className  = 'dot err';
    txt.className  = 'status-text err';
    txt.textContent = 'Daemon offline — run npm start';
  }

  // Fetch latest snapshot from daemon
  try {
    const snap = await fetch('http://127.0.0.1:3457/api/snapshot').then(r => r.json());
    renderLimits(snap);
  } catch {
    document.getElementById('no-data').textContent = 'Daemon offline';
  }

  document.getElementById('poll-btn').addEventListener('click', async () => {
    document.getElementById('poll-btn').textContent = 'Polling…';
    await chrome.runtime.sendMessage({ type: 'pollNow' });
    document.getElementById('poll-btn').textContent = 'Done ✓';
    setTimeout(() => init(), 1500);
  });
}

function renderLimits(snap) {
  const noData = document.getElementById('no-data');
  const rows   = document.getElementById('limit-rows');

  const limits = [
    { label: 'Session (5h)', pct: snap?.session_pct,      resetsAt: snap?.session_resets_at },
    { label: 'Weekly',       pct: snap?.weekly_pct,        resetsAt: snap?.weekly_resets_at  },
    { label: 'Sonnet wkly', pct: snap?.sonnet_weekly_pct, resetsAt: snap?.weekly_resets_at  },
    { label: 'Opus wkly',   pct: snap?.opus_weekly_pct,   resetsAt: snap?.weekly_resets_at  },
  ].filter(l => l.pct !== null && l.pct !== undefined);

  if (!limits.length) {
    noData.textContent = 'Open claude.ai to fetch limits';
    return;
  }

  noData.style.display = 'none';
  rows.style.display   = 'block';
  rows.innerHTML = limits.map(l => {
    const pct = Math.round(l.pct ?? 0);
    const cls = limitClass(pct);
    return `
      <div class="limit-row">
        <div class="limit-label">
          <span>${l.label}</span>
          <span class="limit-pct">${pct}% · ${fmtReset(l.resetsAt)}</span>
        </div>
        <div class="bar"><div class="bar-fill ${cls}" style="width:${Math.min(pct,100)}%"></div></div>
      </div>`;
  }).join('');
}

init();
