// Prices in USD per million tokens
const PRICING = {
  'claude-opus-4-7':           { input: 15.00, output: 75.00, cache_read: 1.500, cache_write: 18.75 },
  'claude-opus-4-5':           { input: 15.00, output: 75.00, cache_read: 1.500, cache_write: 18.75 },
  'claude-3-opus':             { input: 15.00, output: 75.00, cache_read: 1.500, cache_write: 18.75 },
  'claude-sonnet-4-6':         { input:  3.00, output: 15.00, cache_read: 0.300, cache_write:  3.75 },
  'claude-sonnet-4-5':         { input:  3.00, output: 15.00, cache_read: 0.300, cache_write:  3.75 },
  'claude-3-7-sonnet':         { input:  3.00, output: 15.00, cache_read: 0.300, cache_write:  3.75 },
  'claude-3-5-sonnet':         { input:  3.00, output: 15.00, cache_read: 0.300, cache_write:  3.75 },
  'claude-haiku-4-5':          { input:  0.80, output:  4.00, cache_read: 0.080, cache_write:  1.00 },
  'claude-3-5-haiku':          { input:  0.80, output:  4.00, cache_read: 0.080, cache_write:  1.00 },
  'claude-3-haiku':            { input:  0.25, output:  1.25, cache_read: 0.025, cache_write:  0.30 },
};

const DEFAULT = PRICING['claude-sonnet-4-6'];

export function getPricing(model) {
  if (!model) return DEFAULT;
  const m = model.toLowerCase();
  // Exact match first
  for (const [key, price] of Object.entries(PRICING)) {
    if (m === key) return price;
  }
  // Partial match (e.g. "claude-sonnet-4-6-20250514" → sonnet-4-6)
  for (const [key, price] of Object.entries(PRICING)) {
    if (m.startsWith(key)) return price;
  }
  // Broad match by family
  if (m.includes('opus'))   return PRICING['claude-opus-4-5'];
  if (m.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
  if (m.includes('haiku'))  return PRICING['claude-haiku-4-5'];
  return DEFAULT;
}

export function calculateCost(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  const p = getPricing(model);
  return (
    (inputTokens    * p.input)       +
    (outputTokens   * p.output)      +
    (cacheReadTokens  * p.cache_read)  +
    (cacheWriteTokens * p.cache_write)
  ) / 1_000_000;
}

export function normalizeModel(model) {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('opus'))   return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku'))  return 'Haiku';
  return model;
}
