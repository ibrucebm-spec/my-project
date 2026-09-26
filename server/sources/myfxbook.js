// Myfxbook official API adapter.
// Reads the accounts in your Myfxbook portfolio (your own, and systems you have
// added) and their open trades. Docs: https://www.myfxbook.com/api
//
// Endpoints used:
//   /api/login.json?email=&password=         -> { session }
//   /api/get-my-accounts.json?session=       -> { accounts: [...] }
//   /api/get-open-trades.json?session=&id=   -> { openTrades: [...] }

const BASE = 'https://www.myfxbook.com/api';

async function call(endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${endpoint}.json?${qs}`);
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${endpoint}: ${body.message || 'błąd API'}`);
  return body;
}

function weeksSince(dateStr) {
  // Myfxbook dates look like "08/15/2023 10:20"
  const d = new Date(dateStr);
  if (isNaN(d)) return 0;
  return Math.floor((Date.now() - d.getTime()) / (7 * 24 * 3600 * 1000));
}

function mapAccount(a) {
  return {
    growthPct: Number(a.gain) || 0,
    maxDrawdownPct: Number(a.drawdown) || 0,
    ageWeeks: weeksSince(a.creationDate || a.firstTradeDate),
    profitFactor: a.profitFactor !== undefined ? Number(a.profitFactor) : undefined,
    balance: Number(a.balance) || undefined,
    equity: Number(a.equity) || undefined,
  };
}

function mapTrade(t, i) {
  const lots = t.sizing?.value !== undefined ? Number(t.sizing.value) : Number(t.lots || 0);
  return {
    id: t.ticket || t.id || `${t.openTime}-${t.openPrice}-${i}`,
    symbol: t.symbol,
    side: String(t.action || '').toLowerCase().includes('sell') ? 'sell' : 'buy',
    lots,
    openPrice: Number(t.openPrice),
    openTime: t.openTime,
    sl: Number(t.sl) || 0,
    tp: Number(t.tp) || 0,
    profit: t.profit !== undefined ? Number(t.profit) : undefined,
  };
}

function start(store, cfg) {
  if (!cfg.email || !cfg.password) {
    console.warn('[myfxbook] pominięto: brak MYFXBOOK_EMAIL / MYFXBOOK_PASSWORD');
    return () => {};
  }
  let session = null;
  let stopped = false;

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
          stats: mapAccount(a),
          positions: openTrades.map(mapTrade),
        });
      }
    } catch (err) {
      console.error('[myfxbook]', err.message);
      if (/session/i.test(err.message)) session = null;
    } finally {
      if (!stopped) timer = setTimeout(poll, cfg.pollSeconds * 1000);
    }
  }

  let timer = setTimeout(poll, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

module.exports = { start, mapAccount, mapTrade };
