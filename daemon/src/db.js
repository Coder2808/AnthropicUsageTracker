import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'usage.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS api_events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp          INTEGER NOT NULL,
    surface            TEXT    NOT NULL DEFAULT 'api',
    model              TEXT,
    model_display      TEXT,
    input_tokens       INTEGER DEFAULT 0,
    output_tokens      INTEGER DEFAULT 0,
    cache_read_tokens  INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    cost_usd           REAL    DEFAULT 0,
    conversation_id    TEXT,
    request_path       TEXT
  );

  CREATE TABLE IF NOT EXISTS account_snapshots (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp          INTEGER NOT NULL,
    org_id             TEXT,
    session_pct        REAL,
    weekly_pct         REAL,
    sonnet_weekly_pct  REAL,
    opus_weekly_pct    REAL,
    session_resets_at  INTEGER,
    weekly_resets_at   INTEGER,
    subscription_tier  TEXT,
    source             TEXT DEFAULT 'extension'
  );

  CREATE INDEX IF NOT EXISTS idx_events_ts      ON api_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_surface ON api_events(surface);
  CREATE INDEX IF NOT EXISTS idx_snapshots_ts   ON account_snapshots(timestamp);
`);

// --- Write ---

const insertEvent = db.prepare(`
  INSERT INTO api_events
    (timestamp, surface, model, model_display, input_tokens, output_tokens,
     cache_read_tokens, cache_write_tokens, cost_usd, conversation_id, request_path)
  VALUES
    (@timestamp, @surface, @model, @model_display, @input_tokens, @output_tokens,
     @cache_read_tokens, @cache_write_tokens, @cost_usd, @conversation_id, @request_path)
`);

const insertSnapshot = db.prepare(`
  INSERT INTO account_snapshots
    (timestamp, org_id, session_pct, weekly_pct, sonnet_weekly_pct, opus_weekly_pct,
     session_resets_at, weekly_resets_at, subscription_tier, source)
  VALUES
    (@timestamp, @org_id, @session_pct, @weekly_pct, @sonnet_weekly_pct, @opus_weekly_pct,
     @session_resets_at, @weekly_resets_at, @subscription_tier, @source)
`);

export function saveEvent(event)    { return insertEvent.run(event); }
export function saveSnapshot(snap)  { return insertSnapshot.run(snap); }

// --- Read ---

export function getLatestSnapshot() {
  return db.prepare('SELECT * FROM account_snapshots ORDER BY timestamp DESC LIMIT 1').get() ?? null;
}

export function getRecentEvents(limit = 100) {
  return db.prepare('SELECT * FROM api_events ORDER BY timestamp DESC LIMIT ?').all(limit);
}

export function getTotals(since) {
  return db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0)                                             AS input_tokens,
      COALESCE(SUM(output_tokens), 0)                                            AS output_tokens,
      COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0)                   AS cache_tokens,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost_usd), 0)                                                 AS cost_usd,
      COUNT(*)                                                                   AS event_count
    FROM api_events WHERE timestamp >= ?
  `).get(since);
}

export function getBreakdown(since) {
  return db.prepare(`
    SELECT
      surface,
      model_display,
      COALESCE(SUM(input_tokens), 0)  AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cost_usd), 0)      AS cost_usd,
      COUNT(*)                        AS event_count
    FROM api_events
    WHERE timestamp >= ?
    GROUP BY surface, model_display
    ORDER BY cost_usd DESC
  `).all(since);
}

export function getDailyTotals(since) {
  return db.prepare(`
    SELECT
      date(timestamp / 1000, 'unixepoch', 'localtime') AS day,
      COALESCE(SUM(cost_usd), 0)      AS cost_usd,
      COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
    FROM api_events
    WHERE timestamp >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(since);
}

export function getSnapshotHistory(since) {
  return db.prepare(`
    SELECT * FROM account_snapshots
    WHERE timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT 200
  `).all(since);
}
