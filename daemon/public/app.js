const API = 'http://127.0.0.1:3457/api';

// Escape HTML entities before inserting any external data into innerHTML
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt$  (v) { return '$' + (v ?? 0).toFixed(4); }
function fmtTok(v) { if (!v) return '0'; if (v >= 1e6) return (v/1e6).toFixed(2)+'M'; if (v >= 1e3) return (v/1e3).toFixed(1)+'K'; return String(v); }
function fmtTs (ts) { if (!ts) return '—'; return new Date(ts).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
function fmtReset(ts) {
  if (!ts) return '';
  const diff = ts - Date.now();
  if (diff <= 0) return 'reset past';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `resets in ${Math.floor(h/24)}d ${h%24}h`;
  return `resets in ${h}h ${m}m`;
}

function limitClass(pct) {
  if (!pct && pct !== 0) return '';
  if (pct >= 90) return 'high';
  if (pct >= 70) return 'warn';
  return 'ok';
}

function renderLimits(snapshot) {
  const grid = document.getElementById('limits-grid');
  if (!snapshot || !snapshot.id) {
    grid.innerHTML = `<div class="limit-card" style="grid-column:1/-1"><div class="limit-na">—</div><div class="limit-reset">No snapshot yet — open claude.ai with the extension installed</div></div>`;
    return;
  }

  const limits = [
    { label: 'Session (5-hour)',  pct: snapshot.session_pct,       resetsAt: snapshot.session_resets_at },
    { label: 'Weekly',            pct: snapshot.weekly_pct,         resetsAt: snapshot.weekly_resets_at },
    { label: 'Sonnet weekly',     pct: snapshot.sonnet_weekly_pct,  resetsAt: snapshot.weekly_resets_at },
    { label: 'Opus weekly',       pct: snapshot.opus_weekly_pct,    resetsAt: snapshot.weekly_resets_at },
  ].filter(l => l.pct !== null && l.pct !== undefined);

  if (!limits.length) {
    grid.innerHTML = `<div class="limit-card" style="grid-column:1/-1"><div class="limit-na">—</div><div class="limit-reset">No limit data</div></div>`;
    return;
  }

  grid.innerHTML = limits.map(l => {
    const pct  = Math.round(l.pct ?? 0);
    const cls  = limitClass(pct);
    const tier = snapshot.subscription_tier ? esc(snapshot.subscription_tier.replace('claude_', '')) : '';
    const sub  = tier ? `· ${tier}` : '';
    return `
      <div class="limit-card">
        <div class="limit-label">${esc(l.label)} ${sub}</div>
        <div class="limit-pct ${cls}">${pct}%</div>
        <div class="bar-track"><div class="bar-fill ${cls}" style="width:${Math.min(pct,100)}%"></div></div>
        <div class="limit-reset">${fmtReset(l.resetsAt)}</div>
      </div>`;
  }).join('');
}

function renderStats(data) {
  const row = document.getElementById('stats-row');
  const periods = [
    { label: 'Today',      d: data.today },
    { label: 'This week',  d: data.week  },
    { label: 'This month', d: data.month },
  ];
  row.innerHTML = periods.map(p => `
    <div class="stat-card">
      <div class="stat-period">${p.label}</div>
      <div class="stat-cost">${fmt$(p.d.totals?.cost_usd)}</div>
      <div class="stat-tokens">${fmtTok(p.d.totals?.total_tokens)} tokens</div>
      <div class="stat-count">${p.d.totals?.event_count ?? 0} requests</div>
    </div>`).join('');
}

function renderBreakdown(weekBreakdown) {
  const byModel   = {};
  const bySurface = {};
  let totalCost   = 0;

  for (const row of weekBreakdown) {
    totalCost += row.cost_usd || 0;
    const m = row.model_display || 'unknown';
    byModel[m] = byModel[m] || { cost: 0, count: 0 };
    byModel[m].cost  += row.cost_usd  || 0;
    byModel[m].count += row.event_count || 0;

    const s = row.surface || 'api';
    bySurface[s] = bySurface[s] || { cost: 0, count: 0 };
    bySurface[s].cost  += row.cost_usd    || 0;
    bySurface[s].count += row.event_count || 0;
  }

  function rows(map) {
    return Object.entries(map)
      .sort((a, b) => b[1].cost - a[1].cost)
      .map(([key, v]) => {
        const pct     = totalCost > 0 ? (v.cost / totalCost * 100) : 0;
        const safeKey = esc(key);
        // CSS class for the dot uses a fixed allowlist; fall back to 'unknown'
        const dotCls  = ['Opus','Sonnet','Haiku','api','web','cli'].includes(key) ? key : 'unknown';
        return `
          <div class="breakdown-row">
            <div class="breakdown-label">
              <span class="dot ${dotCls}"></span>
              <div>
                <div>${safeKey}</div>
                <div class="breakdown-sub">${v.count} requests</div>
              </div>
            </div>
            <div>
              <div class="breakdown-cost">${fmt$(v.cost)}</div>
              <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${pct.toFixed(1)}%;background:var(--accent)"></div></div>
            </div>
          </div>`;
      }).join('') || '<div style="color:var(--muted);font-size:13px">No data</div>';
  }

  document.getElementById('model-breakdown').innerHTML   = rows(byModel);
  document.getElementById('surface-breakdown').innerHTML = rows(bySurface);
}

function renderChart(chartData) {
  const el = document.getElementById('chart');
  if (!chartData || !chartData.length) { el.innerHTML = '<div style="color:var(--muted);font-size:12px;align-self:center">No data yet</div>'; return; }

  const max = Math.max(...chartData.map(d => d.cost_usd || 0), 0.000001);
  // Fill in missing days for last 30 days
  const days = {};
  chartData.forEach(d => days[d.day] = d);

  const result = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push(days[key] || { day: key, cost_usd: 0, tokens: 0 });
  }

  el.innerHTML = result.map(d => {
    const h = Math.max((d.cost_usd / max) * 80, d.cost_usd > 0 ? 2 : 0);
    const label = d.day.slice(5); // MM-DD
    return `
      <div class="chart-bar-wrap">
        <div class="chart-bar" style="height:${h}px" title="${d.day}: ${fmt$(d.cost_usd)} · ${fmtTok(d.tokens)} tokens"></div>
        <div class="chart-label">${label.endsWith('-01') || label.endsWith('-15') ? label : ''}</div>
      </div>`;
  }).join('');
}

function renderEvents(events) {
  const body  = document.getElementById('events-body');
  const count = document.getElementById('events-count');
  count.textContent = `${events.length} recent`;

  if (!events.length) {
    body.innerHTML = '<div class="empty">No events yet. Start using Claude CLI or claude.ai with the extension installed.</div>';
    return;
  }

  body.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Surface</th>
          <th>Model</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cache read</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        ${events.map(e => {
          const sfBadge  = ['api','web','cli'].includes(e.surface) ? e.surface : 'unknown';
          const mdBadge  = ['Opus','Sonnet','Haiku'].includes(e.model_display) ? e.model_display : 'unknown';
          const mdLabel  = e.model_display ? esc(e.model_display) : '—';
          return `
          <tr>
            <td class="mono" style="color:var(--muted);font-size:11px">${fmtTs(e.timestamp)}</td>
            <td><span class="badge ${sfBadge}">${esc(e.surface)}</span></td>
            <td><span class="badge ${mdBadge}">${mdLabel}</span></td>
            <td class="mono">${fmtTok(e.input_tokens)}</td>
            <td class="mono">${fmtTok(e.output_tokens)}</td>
            <td class="mono" style="color:var(--muted)">${fmtTok(e.cache_read_tokens)}</td>
            <td class="mono" style="color:var(--green)">${fmt$(e.cost_usd)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

async function loadAll() {
  try {
    const [stats, events] = await Promise.all([
      fetch(`${API}/stats`).then(r => r.json()),
      fetch(`${API}/events?limit=100`).then(r => r.json()),
    ]);

    renderLimits(stats.snapshot);
    renderStats(stats);
    renderBreakdown(stats.week.breakdown);
    renderChart(stats.chart);
    renderEvents(events);

    document.getElementById('status-dot').className  = 'ok';
    document.getElementById('status-text').textContent = 'Daemon connected';
    document.getElementById('last-sync').textContent  = 'Updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    document.getElementById('status-dot').className   = '';
    document.getElementById('status-text').textContent = 'Daemon offline';
    document.getElementById('last-sync').textContent   = '';
    console.error('Load failed:', err);
  }
}

// Auto-refresh every 30s
document.getElementById('refresh-btn')?.addEventListener('click', loadAll);
loadAll();
setInterval(loadAll, 30_000);
