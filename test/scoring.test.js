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
