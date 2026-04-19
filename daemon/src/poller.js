import { saveSnapshot } from './db.js';
import { readConfig, clearConfig } from './config.js';

const POLL_INTERVAL = 60_000; // every minute

let _timer = null;

function buildHeaders(sessionKey) {
  return {
    'Cookie':     `sessionKey=${sessionKey}`,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':     'application/json',
    'Referer':    'https://claude.ai/',
  };
}

// Auto-discover the primary org ID using the stored session key
export async function discoverOrgId(sessionKey) {
  const res = await fetch('https://claude.ai/api/organizations', {
    headers: buildHeaders(sessionKey),
  });
  if (!res.ok) throw new Error(`organizations API returned ${res.status}`);
  const orgs = await res.json();
  if (!Array.isArray(orgs) || !orgs.length) throw new Error('No organizations found');
  return orgs[0].id;
}

async function poll() {
  const { sessionKey, orgId } = readConfig();
  if (!sessionKey || !orgId) return;

  try {
    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      headers: buildHeaders(sessionKey),
    });

    if (res.status === 401 || res.status === 403) {
      // Session expired — clear stored key so the extension can re-seed it automatically
      console.warn('[poller] Session expired — clearing config so extension can re-seed');
      clearConfig();
      if (_timer) { clearInterval(_timer); _timer = null; }
      return;
    }
    if (!res.ok) {
      console.warn(`[poller] Usage API returned ${res.status}`);
      return;
    }

    const usage = await res.json();

    saveSnapshot({
      timestamp:         Date.now(),
      org_id:            orgId,
      session_pct:       usage.five_hour?.utilization        ?? null,
      weekly_pct:        usage.seven_day?.utilization        ?? null,
      sonnet_weekly_pct: usage.seven_day_sonnet?.utilization ?? null,
      opus_weekly_pct:   usage.seven_day_opus?.utilization   ?? null,
      session_resets_at: usage.five_hour?.resets_at   ? new Date(usage.five_hour.resets_at).getTime()   : null,
      weekly_resets_at:  usage.seven_day?.resets_at   ? new Date(usage.seven_day.resets_at).getTime()   : null,
      subscription_tier: null,
      source:            'daemon',
    });

    console.log(`[poller] Snapshot — session ${Math.round(usage.five_hour?.utilization ?? 0)}% weekly ${Math.round(usage.seven_day?.utilization ?? 0)}%`);
  } catch (err) {
    console.error('[poller] Poll failed:', err.message);
  }
}

export function startPoller() {
  const { sessionKey, orgId } = readConfig();
  if (!sessionKey || !orgId) {
    console.log('[poller] No session key configured — open the dashboard to set up');
    return;
  }
  console.log('[poller] Starting — polls claude.ai every minute');
  poll();
  _timer = setInterval(poll, POLL_INTERVAL);
}

export function restartPoller() {
  if (_timer) clearInterval(_timer);
  startPoller();
}
