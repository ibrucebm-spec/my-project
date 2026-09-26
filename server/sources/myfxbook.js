// Myfxbook official API adapter.
// Reads the accounts in your Myfxbook portfolio and their open trades.
// Docs: https://www.myfxbook.com/api
//
// Endpoints used:
//   /api/login.json?email=&password=         -> { session }
//   /api/get-my-accounts.json?session=       -> { accounts: [...] }
//   /api/get-open-trades.json?session=&id=   -> { openTrades: [...] }

const BASE = 'https://www.myfxbook.com/api';
const TIMEOUT_MS = 15_000;

async function call(endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${endpoint}.json?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`${endpoint}: HTTP ${res.status}, odpowiedź nie jest JSON`);
  if (body.error) throw new Error(`${endpoint}: ${body.message || 'błąd API'}`);
  return body;
}

function weeksSince(dateStr) {
  // Myfxbook dates look like "08/15/2023 10:20"
  const d = new Date(dateStr);
  if (isNaN(d)) return 0;
  return Math.floor((Date.now() - d.getTime()) / (7 * 24 * 3600 * 1000));
}

const optNum = (v) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? undefined : Number(v));

function mapAccount(a) {
  return {
    growthPct: optNum(a.gain) ?? 0,
    maxDrawdownPct: optNum(a.drawdown),
    ageWeeks: weeksSince(a.creationDate || a.firstTradeDate),
    profitFactor: optNum(a.profitFactor),
    balance: optNum(a.balance),
    equity: optNum(a.equity),
  };
}

function mapTrade(t) {
  const lots = t.sizing?.value !== undefined ? Number(t.sizing.value) : Number(t.lots || 0);
  return {
    // The API has no ticket number, so the id is built from fields that never
    // change while the trade is open (not from its position in the list).
    id: t.ticket || t.id || ['mfb', t.openTime, t.symbol, t.action, t.openPrice, lots].join('|'),
    symbol: t.symbol,
    side: String(t.action || '').toLowerCase().includes('sell') ? 'sell' : 'buy',
    lots,
    openPrice: Number(t.openPrice),
    openTime: t.openTime,
    sl: Number(t.sl) || 0,
    tp: Number(t.tp) || 0,
    profit: optNum(t.profit),
  };
}

// Two identical trades (same time, price, size) would collide; suffix them.
function uniqueIds(trades) {
  const seen = new Map();
  return trades.map((t) => {
    const n = seen.get(t.id) || 0;
    seen.set(t.id, n + 1);
    return n ? { ...t, id: `${t.id}#${n}` } : t;
  });
}

function start(store, cfg) {
  if (!cfg.email || !cfg.password) {
    console.warn('[myfxbook] pominięto: brak MYFXBOOK_EMAIL / MYFXBOOK_PASSWORD w .env');
    return () => {};
  }
  let session = null;
  let stopped = false;
  let timer;

  async function poll() {
    try {
      if (!session) {
        session = (await call('login', { email: cfg.email, password: cfg.password })).session;
        console.log('[myfxbook] zalogowano');
      }
      const { accounts = [] } = await call('get-my-accounts', { session });
      for (const a of accounts) {
        const { openTrades = [] } = await call('get-open-trades', { session, id: a.id });
        store.upsertTrader({
          source: 'myfxbook',
          id: a.id,
          name: a.name,
          accountType: a.demo === true || a.demo === 'true' ? 'demo' : a.demo === false || a.demo === 'false' ? 'real' : null,
          statsSource: 'myfxbook',
          stats: mapAccount(a),
          positions: uniqueIds(openTrades.map(mapTrade)),
        });
      }
    } catch (err) {
      console.error('[myfxbook]', err.name === 'TimeoutError' ? 'brak odpowiedzi w 15 s' : err.message);
      if (/session/i.test(err.message)) session = null;
    } finally {
      if (!stopped) timer = setTimeout(poll, cfg.pollSeconds * 1000);
    }
  }

  timer = setTimeout(poll, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

module.exports = { start, call, mapAccount, mapTrade, uniqueIds };
