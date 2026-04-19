import { calculateCost, normalizeModel } from './pricing.js';
import { saveEvent } from './db.js';

const UPSTREAM = 'https://api.anthropic.com';

// Headers that must not be forwarded upstream or downstream
const DROP_REQ_HEADERS  = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'expect']);
const DROP_RES_HEADERS  = new Set(['content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

function buildUpstreamHeaders(incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!DROP_REQ_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  out['host'] = 'api.anthropic.com';
  return out;
}

async function persistUsage(path, requestBody, usage) {
  try {
    const model = requestBody?.model ?? 'unknown';
    saveEvent({
      timestamp:          Date.now(),
      surface:            'api',           // CLI, SDK, or any direct API caller
      model,
      model_display:      normalizeModel(model),
      input_tokens:       usage.input       ?? 0,
      output_tokens:      usage.output      ?? 0,
      cache_read_tokens:  usage.cache_read  ?? 0,
      cache_write_tokens: usage.cache_write ?? 0,
      cost_usd:           calculateCost(model, usage.input ?? 0, usage.output ?? 0, usage.cache_read ?? 0, usage.cache_write ?? 0),
      conversation_id:    null,
      request_path:       path,
    });
  } catch (err) {
    console.error('[proxy] persist failed:', err.message);
  }
}

function extractUsageFromResponse(responseJson) {
  const u = responseJson?.usage;
  if (!u) return null;
  return {
    input:       u.input_tokens                  ?? 0,
    output:      u.output_tokens                 ?? 0,
    cache_read:  u.cache_read_input_tokens        ?? 0,
    cache_write: u.cache_creation_input_tokens    ?? 0,
  };
}

export async function handleProxyRequest(req, res) {
  // Reconstruct full upstream URL including query string
  const upstreamUrl = `${UPSTREAM}${req.path}${req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : ''}`;

  // Buffer raw request body (Express has no body parser on this app)
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyBuf = Buffer.concat(chunks);

  let parsedBody = null;
  try { parsedBody = JSON.parse(bodyBuf.toString('utf8')); } catch {}

  const isStreaming  = parsedBody?.stream === true;
  const isMessages   = req.path.startsWith('/v1/messages');
  const isCountTokens = req.path.includes('/count_tokens');

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method:  req.method,
      headers: buildUpstreamHeaders(req.headers),
      body:    (req.method !== 'GET' && req.method !== 'HEAD' && bodyBuf.length > 0) ? bodyBuf : undefined,
      duplex:  'half',
    });
  } catch (err) {
    console.error('[proxy] upstream error:', err.message);
    console.error('[proxy] upstream connect error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'upstream_unavailable' });
    return;
  }

  // Forward status
  res.status(upstreamRes.status);

  // Forward response headers
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (!DROP_RES_HEADERS.has(k.toLowerCase())) {
      try { res.setHeader(k, v); } catch {}
    }
  }

  if (isStreaming && isMessages) {
    // --- SSE streaming path ---
    const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    const reader = upstreamRes.body.getReader();
    const dec    = new TextDecoder();
    let sseBuffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const rawBytes = Buffer.from(value);
        res.write(rawBytes);

        sseBuffer += dec.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() ?? '';        // keep incomplete last line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const evt = JSON.parse(data);
            if (evt.type === 'message_start' && evt.message?.usage) {
              const u = evt.message.usage;
              usage.input       = u.input_tokens                 ?? 0;
              usage.cache_read  = u.cache_read_input_tokens       ?? 0;
              usage.cache_write = u.cache_creation_input_tokens   ?? 0;
            } else if (evt.type === 'message_delta' && evt.usage) {
              usage.output = evt.usage.output_tokens ?? 0;
            }
          } catch {}
        }
      }
    } finally {
      res.end();
    }

    if (usage.input > 0 || usage.output > 0) {
      await persistUsage(req.path, parsedBody, usage);
      console.log(`[proxy] stream  ${normalizeModel(parsedBody?.model)} in=${usage.input} out=${usage.output}`);
    }

  } else {
    // --- Non-streaming path ---
    const responseBuf = Buffer.from(await upstreamRes.arrayBuffer());
    res.end(responseBuf);

    if ((isMessages || isCountTokens) && upstreamRes.status === 200) {
      try {
        const responseJson = JSON.parse(responseBuf.toString('utf8'));
        const usage = extractUsageFromResponse(responseJson);
        if (usage && (usage.input > 0 || usage.output > 0)) {
          await persistUsage(req.path, parsedBody, usage);
          console.log(`[proxy] sync    ${normalizeModel(parsedBody?.model)} in=${usage.input} out=${usage.output}`);
        }
      } catch {}
    }
  }
}
