const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { isGoldSymbol, scoreTrader } = require('./scoring');
const { isGoldMarketOpen } = require('./market');

// How long a source may stay silent before its data is marked as outdated.
const DEFAULT_STALE_MS = { mt5: 30_000, myfxbook: 180_000 };
const PRICE_STALE_MS = 60_000;

// In-memory state of traders and their open XAUUSD positions.
// Sources push full snapshots per trader; the store diffs them and emits
// 'position_opened' / 'position_closed' events for the live feed.
// Martingale/grid flags are persisted to disk so a restart does not forget them.
class Store extends EventEmitter {
  constructor(filters, { staleMs = {}, memoryFile = null } = {}) {
    super();
    this.filters = filters;
    this.staleMs = { ...DEFAULT_STALE_MS, ...staleMs };
    this.memoryFile = memoryFile;
    this.traders = new Map();
    this.goldPrice = null;
    this.goldPriceAt = 0;
    this.version = 0;
    this.riskMemory = this.loadMemory();
  }

  loadMemory() {
    if (!this.memoryFile) return {};
    try {
      return JSON.parse(fs.readFileSync(this.memoryFile, 'utf8'));
    } catch {
      return {};
    }
  }

  saveMemory() {
    if (!this.memoryFile) return;
    try {
      fs.mkdirSync(path.dirname(this.memoryFile), { recursive: true });
      fs.writeFileSync(this.memoryFile, JSON.stringify(this.riskMemory, null, 2));
    } catch (err) {
      console.error('[store] nie udało się zapisać pamięci ryzyka:', err.message);
    }
  }

  upsertTrader(snapshot) {
    const key = `${snapshot.source}:${snapshot.id}`;
    const prev = this.traders.get(key);
    const positions = (snapshot.positions || prev?.positions || [])
      .filter((p) => isGoldSymbol(p.symbol))
      .map((p) => normalizePosition(p, key));

    const trader = {
      key,
      id: String(snapshot.id),
      source: snapshot.source,
      name: snapshot.name || prev?.name || String(snapshot.id),
      url: snapshot.url || prev?.url || null,
      accountType: snapshot.accountType || prev?.accountType || null,
      statsSource: snapshot.statsSource || prev?.statsSource || null,
      stats: { ...(prev?.stats || {}), ...(snapshot.stats || {}) },
      positions,
      riskMemory: { ...(this.riskMemory[key] || {}) },
      lastSeenAt: Date.now(),
    };
    trader.rating = scoreTrader(trader, this.filters);

    const mem = this.riskMemory[key] || {};
    if ((trader.rating.risk.martingale && !mem.martingale) || (trader.rating.risk.grid && !mem.grid)) {
      this.riskMemory[key] = {
        martingale: mem.martingale || trader.rating.risk.martingale,
        grid: mem.grid || trader.rating.risk.grid,
        name: trader.name,
        detectedAt: new Date().toISOString(),
      };
      this.saveMemory();
    }

    this.traders.set(key, trader);
    this.version++;

    if (snapshot.positions) this.diffPositions(trader, prev?.positions || []);
    return trader;
  }

  diffPositions(trader, before) {
    const oldIds = new Map(before.map((p) => [p.id, p]));
    const newIds = new Set(trader.positions.map((p) => p.id));
    const brief = { key: trader.key, name: trader.name, source: trader.source, rating: trader.rating };

    for (const p of trader.positions) {
      if (!oldIds.has(p.id)) this.emit('position_opened', { trader: brief, position: p });
    }
    for (const [id, p] of oldIds) {
      if (!newIds.has(id)) this.emit('position_closed', { trader: brief, position: p });
    }
  }

  setGoldPrice(price) {
    this.goldPrice = price;
    this.goldPriceAt = Date.now();
    this.version++;
  }

  isStale(trader, now = Date.now()) {
    return now - trader.lastSeenAt > (this.staleMs[trader.source] ?? 60_000);
  }

  snapshot() {
    const now = Date.now();
    const traders = [...this.traders.values()]
      .map((t) => ({ ...t, stale: this.isStale(t, now), lastSeenAt: new Date(t.lastSeenAt).toISOString() }))
      .sort((a, b) => b.rating.qualifies - a.rating.qualifies || a.stale - b.stale || b.rating.score - a.rating.score);
    return {
      goldPrice: this.goldPrice,
      goldPriceAt: this.goldPriceAt ? new Date(this.goldPriceAt).toISOString() : null,
      goldPriceStale: !this.goldPriceAt || now - this.goldPriceAt > PRICE_STALE_MS,
      marketOpen: isGoldMarketOpen(),
      filters: this.filters,
      traders,
      at: new Date(now).toISOString(),
    };
  }
}

function normalizePosition(p, traderKey) {
  const side = String(p.side || p.type || '').toLowerCase().startsWith('s') ? 'sell' : 'buy';
  return {
    id: String(p.id ?? `${p.openTime}-${p.openPrice}-${p.lots}`),
    traderKey,
    symbol: String(p.symbol),
    side,
    lots: Number(p.lots) || 0,
    openPrice: Number(p.openPrice) || 0,
    openTime: p.openTime ? new Date(p.openTime).toISOString() : new Date().toISOString(),
    sl: Number(p.sl) || 0,
    tp: Number(p.tp) || 0,
    currentPrice: p.currentPrice !== undefined ? Number(p.currentPrice) : null,
    profit: p.profit !== undefined && p.profit !== null ? Number(p.profit) : null,
  };
}

module.exports = { Store, normalizePosition };
