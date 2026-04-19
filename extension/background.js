const DAEMON = 'http://127.0.0.1:3457';

// ── Utilities ──────────────────────────────────────────────────────────────

async function post(path, data) {
  try {
    await fetch(`${DAEMON}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
  } catch {
    // Daemon not running — fail silently, don't disrupt the user
  }
}

async function getActiveOrgId() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://claude.ai/*' });
    if (!tabs.length) return null;
    const cookie = await chrome.cookies.get({ name: 'lastActiveOrg', url: tabs[0].url });
    return cookie?.value ?? null;
  } catch {
    return null;
  }
}

// ── Account snapshot: polls claude.ai and sends usage % to daemon ──────────
// This is the key data that shows ALL usage (mobile, other machines, etc.)

async function pollAndPushSnapshot(orgIdHint = null) {
  try {
    const orgId = orgIdHint ?? await getActiveOrgId();
    if (!orgId) return;

    const usageRes = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`);
    if (!usageRes.ok) return;
    const usage = await usageRes.json();

    // Also fetch subscription tier from bootstrap
    let tier = null;
    try {
      const tabs = await chrome.tabs.query({ url: '*://claude.ai/*' });
      if (tabs.length) {
        const bsRes = await fetch(`https://claude.ai/api/organizations/${orgId}/bootstrap/${orgId}/app_start`);
        if (bsRes.ok) {
          const bs = await bsRes.json();
          tier = bs?.account?.memberships?.[0]?.organization?.settings?.claude_subscription_tier ?? null;
        }
      }
    } catch {}

    await post('/api/account-snapshot', {
      orgId,
      sessionPct:       usage.five_hour?.utilization        ?? null,
      weeklyPct:        usage.seven_day?.utilization         ?? null,
      sonnetWeeklyPct:  usage.seven_day_sonnet?.utilization  ?? null,
      opusWeeklyPct:    usage.seven_day_opus?.utilization    ?? null,
      sessionResetsAt:  usage.five_hour?.resets_at   ? new Date(usage.five_hour.resets_at).getTime()   : null,
      weeklyResetsAt:   usage.seven_day?.resets_at   ? new Date(usage.seven_day.resets_at).getTime()   : null,
      subscriptionTier: tier,
    });
  } catch (err) {
    console.warn('[tracker] snapshot poll failed:', err.message);
  }
}

// ── Intercept completions on claude.ai ────────────────────────────────────

function parseRequestBody(details) {
  try {
    if (!details.requestBody?.raw?.[0]?.bytes) return null;
    const text = new TextDecoder().decode(details.requestBody.raw[0].bytes);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeModel(model) {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('opus'))   return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku'))  return 'Haiku';
  return model;
}

// Track pending completions: key = orgId:conversationId
const pending = new Map();

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== 'POST') return;
    const body = parseRequestBody(details);
    if (!body) return;

    const parts = details.url.split('/');
    const orgIdx  = parts.indexOf('organizations');
    const convIdx = parts.indexOf('chat_conversations');
    if (orgIdx === -1) return;

    const orgId         = parts[orgIdx + 1];
    const conversationId = convIdx !== -1 ? parts[convIdx + 1] : null;
    const model         = body.model ?? null;

    if (conversationId) {
      pending.set(`${orgId}:${conversationId}`, { orgId, conversationId, model });
    }

    // Fire a snapshot poll to capture the state before this message
    pollAndPushSnapshot(orgId);

    // Post a lightweight web event (no token counts — those come from the snapshot %)
    post('/api/events', {
      surface:        'web',
      model:          model,
      inputTokens:    0,
      outputTokens:   0,
      conversationId: conversationId,
    });
  },
  {
    urls: [
      '*://claude.ai/api/organizations/*/completion',
      '*://claude.ai/api/organizations/*/retry_completion',
      '*://claude.ai/api/organizations/*/chat_conversations/*/completion',
      '*://claude.ai/api/organizations/*/chat_conversations/*/retry_completion',
    ]
  },
  ['requestBody']
);

// After a completion finishes, fire another snapshot to capture the updated %
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!details.url.includes('/chat_conversations/')) return;
    const parts  = details.url.split('/');
    const orgIdx = parts.indexOf('organizations');
    if (orgIdx === -1) return;
    const orgId = parts[orgIdx + 1];
    // Small delay so Anthropic's server has updated the usage counter
    setTimeout(() => pollAndPushSnapshot(orgId), 3000);
  },
  {
    urls: [
      '*://claude.ai/api/organizations/*/chat_conversations/*',
      '*://claude.ai/v1/sessions/*/events',
    ]
  }
);

// ── Periodic polling (every 2 minutes) ────────────────────────────────────

chrome.alarms.create('pollUsage', { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollUsage') pollAndPushSnapshot();
});

// ── Popup: status check ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'getStatus') {
    fetch(`${DAEMON}/api/health`)
      .then(r => r.json())
      .then(d => respond({ daemon: true, ts: d.ts }))
      .catch(() => respond({ daemon: false }));
    return true; // async
  }
  if (msg.type === 'pollNow') {
    pollAndPushSnapshot().then(() => respond({ ok: true }));
    return true;
  }
});

// ── Startup: poll immediately ──────────────────────────────────────────────
pollAndPushSnapshot();
