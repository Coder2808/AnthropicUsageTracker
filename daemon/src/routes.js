import { Router } from 'express';
import {
  saveEvent, saveSnapshot,
  getLatestSnapshot, getRecentEvents,
  getTotals, getBreakdown, getDailyTotals, getSnapshotHistory,
} from './db.js';
import { calculateCost, normalizeModel } from './pricing.js';
import { readConfig, writeConfig, clearConfig } from './config.js';
import { discoverOrgId, restartPoller } from './poller.js';

const router = Router();

// Allowed surface values — reject anything else to prevent DB/UI pollution
const ALLOWED_SURFACES = new Set(['api', 'web', 'cli']);

// Integer clamp: ensure a value is a safe non-negative integer within a sane ceiling
function safeInt(v, max = 10_000_000) {
  const n = Math.trunc(Number(v));
  return (Number.isFinite(n) && n >= 0) ? Math.min(n, max) : 0;
}

// ── Extension: report a claude.ai web interaction ──────────────────────────
router.post('/events', (req, res) => {
  try {
    const b = req.body ?? {};

    const surface    = ALLOWED_SURFACES.has(b.surface) ? b.surface : 'web';
    const model      = typeof b.model === 'string' ? b.model.slice(0, 120) : 'unknown';
    const inputTok   = safeInt(b.inputTokens);
    const outputTok  = safeInt(b.outputTokens);
    const cacheRead  = safeInt(b.cacheReadTokens);
    const cacheWrite = safeInt(b.cacheWriteTokens);
    const convId     = typeof b.conversationId === 'string' ? b.conversationId.slice(0, 120) : null;

    saveEvent({
      timestamp:          Date.now(),
      surface,
      model,
      model_display:      normalizeModel(model),
      input_tokens:       inputTok,
      output_tokens:      outputTok,
      cache_read_tokens:  cacheRead,
      cache_write_tokens: cacheWrite,
      cost_usd:           calculateCost(model, inputTok, outputTok, cacheRead, cacheWrite),
      conversation_id:    convId,
      request_path:       '/claude.ai',
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[routes] POST /events:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── Extension: push an account usage snapshot ──────────────────────────────
router.post('/account-snapshot', (req, res) => {
  try {
    const b = req.body ?? {};

    // Clamp percentages to [0, 100]; timestamps to plausible epoch range
    const clampPct = v => {
      const n = Number(v);
      return (Number.isFinite(n) && n >= 0 && n <= 100) ? n : null;
    };
    const clampTs = v => {
      const n = Math.trunc(Number(v));
      return (Number.isFinite(n) && n > 0 && n < 4_102_444_800_000) ? n : null;
    };

    saveSnapshot({
      timestamp:          Date.now(),
      org_id:             typeof b.orgId === 'string'            ? b.orgId.slice(0, 80) : null,
      session_pct:        clampPct(b.sessionPct),
      weekly_pct:         clampPct(b.weeklyPct),
      sonnet_weekly_pct:  clampPct(b.sonnetWeeklyPct),
      opus_weekly_pct:    clampPct(b.opusWeeklyPct),
      session_resets_at:  clampTs(b.sessionResetsAt),
      weekly_resets_at:   clampTs(b.weeklyResetsAt),
      subscription_tier:  typeof b.subscriptionTier === 'string' ? b.subscriptionTier.slice(0, 80) : null,
      source:             'extension',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[routes] POST /account-snapshot:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── Dashboard: aggregated statistics ───────────────────────────────────────
router.get('/stats', (req, res) => {
  const now          = Date.now();
  const startOfDay   = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek  = new Date(); startOfWeek.setDate(startOfWeek.getDate() - 6); startOfWeek.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  res.json({
    today:   { totals: getTotals(startOfDay.getTime()),   breakdown: getBreakdown(startOfDay.getTime()) },
    week:    { totals: getTotals(startOfWeek.getTime()),  breakdown: getBreakdown(startOfWeek.getTime()) },
    month:   { totals: getTotals(startOfMonth.getTime()), breakdown: getBreakdown(startOfMonth.getTime()) },
    chart:   getDailyTotals(thirtyDaysAgo),
    snapshot: getLatestSnapshot(),
    snapshots_24h: getSnapshotHistory(now - 24 * 60 * 60 * 1000),
  });
});

router.get('/events', (req, res) => {
  const limit = Math.min(Math.max(1, safeInt(req.query.limit) || 100), 1000);
  res.json(getRecentEvents(limit));
});
router.get('/snapshot', (req, res) => res.json(getLatestSnapshot() ?? {}));
router.get('/health',   (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Setup: store session key and start daemon-side polling ─────────────────

router.get('/setup', (_req, res) => {
  const { orgId, sessionKey } = readConfig();
  res.json({ configured: !!(sessionKey && orgId), orgId: orgId ?? null });
});

router.post('/setup', async (req, res) => {
  const sk = req.body?.sessionKey;
  if (typeof sk !== 'string' || sk.trim().length < 10) {
    return res.status(400).json({ error: 'Invalid session key' });
  }
  const sessionKey = sk.trim();

  try {
    // Validate the key and discover org ID in one step
    const orgId = await discoverOrgId(sessionKey);
    writeConfig({ sessionKey, orgId });
    restartPoller();
    res.json({ ok: true, orgId });
  } catch (err) {
    console.error('[setup] Failed:', err.message);
    res.status(401).json({ error: 'Could not authenticate with claude.ai — check your session key' });
  }
});

router.delete('/setup', (_req, res) => {
  clearConfig();
  res.json({ ok: true });
});

export default router;
