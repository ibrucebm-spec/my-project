const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { Store } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const MAX_BODY = 256 * 1024;

const KNOWN_SOURCES = ['mt5', 'myfxbook'];
const DEFAULT_TOKEN = 'zmien-mnie-na-dlugi-losowy-token';

function createApp(cfg = config) {
  const store = new Store(cfg.filters, {
    staleMs: { myfxbook: (cfg.myfxbook?.pollSeconds || 60) * 3 * 1000 },
    memoryFile: cfg.memoryFile || null,
  });
  const clients = new Set();

  const broadcast = (event, data) => {
    if (clients.size === 0) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  store.on('position_opened', (e) => broadcast('opened', e));
  store.on('position_closed', (e) => broadcast('closed', e));

  // Push state only when something changed; every 5 s regardless, so that
  // "outdated" markers and the market-hours banner stay current.
  let sentVersion = -1;
  let lastSent = 0;
  const tick = setInterval(() => {
    const now = Date.now();
    if (store.version === sentVersion && now - lastSent < 5000) return;
    sentVersion = store.version;
    lastSent = now;
    broadcast('state', store.snapshot());
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
      res.write(`event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, store.snapshot());

    // MT5 bridge: full snapshot of one account's open positions.
    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      if (!cfg.sources.includes('mt5')) return json(res, 404, { error: 'mt5 source disabled' });
      if (!tokenOk(req)) return json(res, 401, { error: 'invalid token' });
      try {
        // MQL5 WebRequest may append a trailing NUL byte.
        const body = JSON.parse((await readBody(req)).replace(/\0+$/, ''));
        if (!body.account || !body.account.id) return json(res, 400, { error: 'account.id required' });
        const t = store.upsertTrader({
          source: 'mt5',
          id: body.account.id,
          name: body.account.name,
          stats: body.account.stats,
          accountType: ['demo', 'real'].includes(body.account.type) ? body.account.type : null,
          statsSource: 'manual',
          positions: Array.isArray(body.positions) ? body.positions : [],
        });
        if (typeof body.price === 'number' && body.price > 0) store.setGoldPrice(body.price);
        return json(res, 200, { ok: true, positions: t.positions.length, score: t.rating.score });
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

  const stops = [];
  function startSources() {
    for (const s of cfg.sources) {
      if (!KNOWN_SOURCES.includes(s)) console.warn(`[config] nieznane źródło "${s}" w DATA_SOURCES zostało pominięte (dostępne: ${KNOWN_SOURCES.join(', ')})`);
    }
    if (cfg.sources.includes('myfxbook')) stops.push(require('./sources/myfxbook').start(store, cfg.myfxbook));
    if (cfg.sources.includes('mt5')) {
      if (!cfg.ingestToken) console.warn('[mt5] INGEST_TOKEN nie ustawiony: most MT5 odrzuci wszystkie dane');
      else if (cfg.ingestToken === DEFAULT_TOKEN || cfg.ingestToken.length < 16) {
        console.warn('[mt5] UWAGA: INGEST_TOKEN jest domyślny albo krótszy niż 16 znaków. Ustaw długi losowy ciąg w .env');
        console.log('[mt5] endpoint POST /api/ingest aktywny');
      } else console.log('[mt5] endpoint POST /api/ingest aktywny');
    }
  }

  function close() {
    clearInterval(tick);
    stops.forEach((s) => s());
    for (const c of clients) c.end();
    server.close();
  }

  return { server, store, startSources, close };
}

if (require.main === module) {
  const app = createApp();
  app.startSources();
  app.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} jest zajęty: aplikacja już działa w innym oknie albo zmień PORT w .env`);
    else console.error(err);
    process.exit(1);
  });
  app.server.listen(config.port, config.host, () => {
    console.log(`Gold Copy Radar: http://localhost:${config.port}  (źródła: ${config.sources.join(', ')})`);
    if (config.host !== '127.0.0.1') console.warn(`[config] serwer nasłuchuje na ${config.host}: dostępny dla innych urządzeń w sieci`);
  });
}

module.exports = { createApp };
