import express from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { handleProxyRequest } from './proxy.js';
import apiRouter from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROXY_PORT = Number(process.env.PROXY_PORT) || 3456;
const API_PORT   = Number(process.env.API_PORT)   || 3457;

// ── Proxy server ─────────────────────────────────────────────────────────
// No body-parser — we read the raw stream in the handler
const proxyApp = express();
proxyApp.all('*', handleProxyRequest);

proxyApp.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║        Anthropic Usage Tracker  v1.0.0           ║
╚═══════════════════════════════════════════════════╝

  Proxy     → http://127.0.0.1:${PROXY_PORT}
  Dashboard → http://127.0.0.1:${API_PORT}

  ► To capture CLI / SDK traffic add this to ~/.zshrc:
    export ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}

  ► Then reload: source ~/.zshrc
`);
});

// ── API + Dashboard server ────────────────────────────────────────────────
const apiApp = express();

// Only allow localhost and Chrome extension origins; block all other cross-origin callers.
// A malicious webpage cannot read usage data even if the user visits it while the daemon runs.
apiApp.use(cors({
  origin(origin, cb) {
    const ok = !origin                              // Electron / Node server-side fetch
      || origin.startsWith('chrome-extension://')   // Chrome extension
      || origin === 'http://127.0.0.1:3457'
      || origin === 'http://localhost:3457';
    cb(ok ? null : new Error('Forbidden'), ok);
  },
  methods: ['GET', 'POST'],
}));

// Security headers for every response
apiApp.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

apiApp.use(express.json({ limit: '50kb' }));
apiApp.use('/api', apiRouter);
apiApp.use(express.static(join(__dirname, '../public')));
apiApp.get('*', (_req, res) => res.sendFile(join(__dirname, '../public/index.html')));

apiApp.listen(API_PORT, '127.0.0.1', () => {
  console.log(`  Dashboard is ready at http://127.0.0.1:${API_PORT}\n`);
});
