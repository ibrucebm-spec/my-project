const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { Advisor } = require('./ai/advisor');
const { isGoldMarketOpen } = require('./market');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const MAX_BODY = 2 * 1024 * 1024; // history arrives in chunks of ~1000 bars
const PRICE_STALE_MS = 60_000;
const DEFAULT_TOKEN = 'zmien-mnie-na-dlugi-losowy-token';

function createApp(cfg = config) {
  const advisor = new Advisor(cfg.ai);
  const clients = new Set();
  let price = null;
  let priceAt = 0;
  let priceVersion = 0;

  const state = () => {
    const now = Date.now();
    return {
      price,
      priceAt: priceAt ? new Date(priceAt).toISOString() : null,
      priceStale: !priceAt || now - priceAt > PRICE_STALE_MS,
      marketOpen: isGoldMarketOpen(),
      ai: advisor.snapshot(),
      at: new Date(now).toISOString(),
    };
  };

  const broadcast = (event, data) => {
    if (clients.size === 0) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  advisor.on('signal', (hint) => broadcast('signal', hint));

  // Push state when something changed, and every 5 s regardless so the
  // "outdated data" markers stay current.
  let sent = '';
  let lastSent = 0;
  const tick = setInterval(() => {
    const now = Date.now();
    const v = `${advisor.version}:${priceVersion}`;
    if (v === sent && now - lastSent < 5000) return;
    sent = v;
    lastSent = now;
    broadcast('state', state());
  }, 500);

  const tokenOk = (req) => {
    if (!cfg.ingestToken) return false;
    const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(cfg.ingestToken);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, state());

    // cTrader cBot / MT5 EA feeder: closed candles (history first, then each new bar) + live price.
    if (url.pathname === '/api/bars' && req.method === 'POST') {
      if (!tokenOk(req)) return json(res, 401, { error: 'invalid token' });
      try {
        // MQL5 WebRequest may append a trailing NUL byte.
        const body = JSON.parse((await readBody(req)).replace(/\0+$/, ''));
        if (typeof body.price === 'number' && body.price > 0) {
          price = body.price;
          priceAt = Date.now();
          priceVersion++;
        }
        const r = advisor.addBars(body.timeframe, body.bars || []);
        return json(res, 200, { ok: true, ...r, learned: advisor.stats.learned });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // Static files
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  function close() {
    clearInterval(tick);
    for (const c of clients) c.end();
    server.close();
  }

  return { server, advisor, close };
}

if (require.main === module) {
  if (!config.ingestToken) console.warn('[feeder] INGEST_TOKEN nie ustawiony: serwer odrzuci dane z cTradera/MT5');
  else if (config.ingestToken === DEFAULT_TOKEN || config.ingestToken.length < 16) {
    console.warn('[feeder] UWAGA: INGEST_TOKEN jest domyślny albo krótszy niż 16 znaków. Ustaw długi losowy ciąg w .env');
  }
  const app = createApp();
  const a = app.advisor.snapshot();
  console.log(`[ai] XAUUSD ${a.timeframe}: ${a.bars} świec w pamięci, model nauczony na ${a.learned} wynikach`);
  app.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} jest zajęty: aplikacja już działa w innym oknie albo zmień PORT w .env`);
    else console.error(err);
    process.exit(1);
  });
  app.server.listen(config.port, config.host, () => {
    console.log(`XAU AI Advisor: http://localhost:${config.port}`);
    if (config.host !== '127.0.0.1') console.warn(`[config] serwer nasłuchuje na ${config.host}: dostępny dla innych urządzeń w sieci`);
  });
}

module.exports = { createApp };
