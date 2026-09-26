const test = require('node:test');
const assert = require('node:assert');
const { isGoldSymbol, detectRiskPatterns, scoreTrader } = require('../server/scoring');

const filters = { minAgeWeeks: 26, maxDrawdownPct: 30, minScore: 40 };
const t0 = Date.parse('2026-09-01T00:00:00Z');
const pos = (i, side, lots, openPrice, extra = {}) => ({
  id: String(i), symbol: 'XAUUSD', side, lots, openPrice,
  openTime: new Date(t0 + i * 60000).toISOString(), sl: 0, tp: 0, ...extra,
});

test('recognises gold symbols with broker suffixes', () => {
  for (const s of ['XAUUSD', 'XAUUSD.m', 'xauusdm', 'GOLD', 'XAUUSD+']) assert.ok(isGoldSymbol(s), s);
  for (const s of ['EURUSD', 'XAGUSD', '', undefined]) assert.ok(!isGoldSymbol(s), String(s));
});

test('flags martingale: buys added lower with growing lots', () => {
  const r = detectRiskPatterns([pos(1, 'buy', 0.1, 5100), pos(2, 'buy', 0.2, 5095), pos(3, 'buy', 0.4, 5090)]);
  assert.ok(r.martingale);
});

test('does not flag pyramiding into a winning trade', () => {
  const r = detectRiskPatterns([pos(1, 'buy', 0.1, 5100), pos(2, 'buy', 0.2, 5105), pos(3, 'buy', 0.4, 5110)]);
  assert.ok(!r.martingale);
});

test('flags grid: five losing positions on one side', () => {
  const ps = [1, 2, 3, 4, 5].map((i) => pos(i, 'sell', 0.2, 5100 + i, { profit: -10 }));
  assert.ok(detectRiskPatterns(ps).grid);
});

test('solid long-running trader qualifies', () => {
  const r = scoreTrader({
    stats: { growthPct: 180, maxDrawdownPct: 12, ageWeeks: 140, profitFactor: 1.9 },
    positions: [pos(1, 'buy', 0.5, 5100, { sl: 5088, tp: 5124 })],
  }, filters);
  assert.ok(r.qualifies, r.reasons.join(','));
  assert.ok(r.score >= 60, `score ${r.score}`);
});

test('huge-return young martingale account is rejected and scored low', () => {
  const r = scoreTrader({
    stats: { growthPct: 1000, maxDrawdownPct: 18, ageWeeks: 20, profitFactor: 3 },
    positions: [pos(1, 'buy', 0.1, 5100), pos(2, 'buy', 0.2, 5095), pos(3, 'buy', 0.4, 5090)],
  }, filters);
  assert.ok(!r.qualifies);
  assert.ok(r.reasons.some((x) => /martingale/.test(x)));
  assert.ok(r.reasons.some((x) => /młode/.test(x)));
  assert.ok(r.score < 40, `score ${r.score}`);
});

test('high drawdown is rejected', () => {
  const r = scoreTrader({ stats: { growthPct: 500, maxDrawdownPct: 58, ageWeeks: 60 }, positions: [] }, filters);
  assert.ok(!r.qualifies);
});

test('martingale stays flagged after the basket closes', () => {
  const { Store } = require('../server/store');
  const store = new Store(filters);
  const stats = { growthPct: 200, maxDrawdownPct: 10, ageWeeks: 100 };
  store.upsertTrader({ source: 'x', id: 1, stats, positions: [pos(1, 'buy', 0.1, 5100), pos(2, 'buy', 0.2, 5095), pos(3, 'buy', 0.4, 5090)] });
  const t = store.upsertTrader({ source: 'x', id: 1, stats, positions: [] });
  assert.ok(!t.rating.qualifies);
  assert.ok(t.rating.risk.martingale);
});

test('qualified traders are listed before rejected ones', () => {
  const { Store } = require('../server/store');
  const store = new Store(filters);
  store.upsertTrader({ source: 'x', id: 'bad', stats: { growthPct: 900, maxDrawdownPct: 50, ageWeeks: 100, profitFactor: 3 }, positions: [] });
  store.upsertTrader({ source: 'x', id: 'good', stats: { growthPct: 80, maxDrawdownPct: 8, ageWeeks: 100, profitFactor: 1.6 }, positions: [] });
  assert.strictEqual(store.snapshot().traders[0].id, 'good');
});

test('suspiciously high win rate is rejected', () => {
  const r = scoreTrader({ stats: { growthPct: 300, maxDrawdownPct: 10, ageWeeks: 60, winRatePct: 99 }, positions: [] }, filters);
  assert.ok(!r.qualifies);
});

test('gold market hours', () => {
  const { isGoldMarketOpen } = require('../server/market');
  assert.ok(!isGoldMarketOpen(new Date('2026-09-26T12:00:00Z')), 'saturday');
  assert.ok(!isGoldMarketOpen(new Date('2026-09-25T21:30:00Z')), 'friday evening');
  assert.ok(!isGoldMarketOpen(new Date('2026-09-27T20:00:00Z')), 'sunday before open');
  assert.ok(isGoldMarketOpen(new Date('2026-09-27T22:30:00Z')), 'sunday after open');
  assert.ok(isGoldMarketOpen(new Date('2026-09-29T10:00:00Z')), 'tuesday');
  assert.ok(!isGoldMarketOpen(new Date('2026-09-29T21:15:00Z')), 'daily break');
});

test('growth is not extrapolated to a year for young accounts', () => {
  const young = scoreTrader({ stats: { growthPct: 100, maxDrawdownPct: 10, ageWeeks: 30 }, positions: [] }, filters);
  assert.strictEqual(young.annualizedPct, null);
  const old = scoreTrader({ stats: { growthPct: 100, maxDrawdownPct: 10, ageWeeks: 104 }, positions: [] }, filters);
  assert.ok(Math.abs(old.annualizedPct - 41.4) < 0.1, String(old.annualizedPct));
});

test('traders go stale when their source stops sending', () => {
  const { Store } = require('../server/store');
  const store = new Store(filters, { staleMs: { mt5: 1000 } });
  const t = store.upsertTrader({ source: 'mt5', id: 1, stats: {}, positions: [] });
  assert.strictEqual(store.snapshot().traders[0].stale, false);
  t.lastSeenAt -= 2000;
  assert.strictEqual(store.snapshot().traders[0].stale, true);
  assert.strictEqual(store.snapshot().goldPriceStale, true);
});

test('risk flags survive a restart via the memory file', () => {
  const os = require('os');
  const path = require('path');
  const { Store } = require('../server/store');
  const file = path.join(os.tmpdir(), `gcr-mem-${process.pid}.json`);
  const stats = { growthPct: 200, maxDrawdownPct: 10, ageWeeks: 100 };
  new Store(filters, { memoryFile: file }).upsertTrader({
    source: 'x', id: 1, stats, positions: [pos(1, 'buy', 0.1, 5100), pos(2, 'buy', 0.2, 5095), pos(3, 'buy', 0.4, 5090)],
  });
  const t = new Store(filters, { memoryFile: file }).upsertTrader({ source: 'x', id: 1, stats, positions: [] });
  require('fs').unlinkSync(file);
  assert.ok(t.rating.risk.martingale);
  assert.ok(!t.rating.qualifies);
});

test('myfxbook trade ids do not depend on list order', () => {
  const { mapTrade, uniqueIds } = require('../server/sources/myfxbook');
  const a = { openTime: '09/25/2026 10:00', symbol: 'XAUUSD', action: 'Buy', openPrice: 5100, sizing: { value: '0.5' } };
  const b = { openTime: '09/25/2026 11:00', symbol: 'XAUUSD', action: 'Sell', openPrice: 5110, sizing: { value: '0.2' } };
  const first = uniqueIds([a, b].map(mapTrade));
  const afterAClosed = uniqueIds([b].map(mapTrade));
  assert.strictEqual(first[1].id, afterAClosed[0].id);
  const dup = uniqueIds([a, a].map(mapTrade));
  assert.notStrictEqual(dup[0].id, dup[1].id);
});
