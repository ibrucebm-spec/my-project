const { EventEmitter } = require('events');
const { isGoldSymbol, scoreTrader } = require('./scoring');
const { isGoldMarketOpen } = require('./market');

// In-memory state of traders and their open XAUUSD positions.
// Sources push full snapshots per trader; the store diffs them and emits
// 'position_opened' / 'position_closed' events for the live feed.
class Store extends EventEmitter {
  constructor(filters) {
    super();
    this.filters = filters;
    this.traders = new Map();
    this.goldPrice = null;
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
      stats: { ...(prev?.stats || {}), ...(snapshot.stats || {}) },
      positions,
      riskMemory: { ...(prev?.riskMemory || {}) },
      updatedAt: new Date().toISOString(),
    };
    trader.rating = scoreTrader(trader, this.filters);
    if (trader.rating.risk.martingale) trader.riskMemory.martingale = true;
    if (trader.rating.risk.grid) trader.riskMemory.grid = true;
    this.traders.set(key, trader);

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
  }

  snapshot() {
    const traders = [...this.traders.values()].sort(
      (a, b) => b.rating.qualifies - a.rating.qualifies || b.rating.score - a.rating.score,
    );
    return {
      goldPrice: this.goldPrice,
      marketOpen: isGoldMarketOpen(),
      filters: this.filters,
      traders,
      at: new Date().toISOString(),
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
    profit: p.profit !== undefined ? Number(p.profit) : null,
  };
}

module.exports = { Store, normalizePosition };
