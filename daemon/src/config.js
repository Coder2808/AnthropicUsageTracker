import { readFileSync, writeFileSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, '../../data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

mkdirSync(DATA_DIR, { recursive: true });

export function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(updates) {
  const current = readConfig();
  const next    = { ...current, ...updates };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  try { chmodSync(CONFIG_PATH, 0o600); } catch {}  // owner-read-only
  return next;
}

export function clearConfig() {
  writeFileSync(CONFIG_PATH, '{}', 'utf8');
  try { chmodSync(CONFIG_PATH, 0o600); } catch {}
}
