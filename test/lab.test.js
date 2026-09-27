const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Lab, Aggregator } = require('../server/ai/lab');
const { genBars } = require('./helpers');

const M15 = 15 * 60_000;
const feed = (lab, bars, extra = {}) => {
  for (let i = 0; i < bars.length; i += 1000) lab.ingest({ timeframe: 'M15', bars: bars.slice(i, i + 1000), ...extra });
};

test('aggregator builds UTC-aligned H1 candles and marks ones closed after a gap', () => {
  const agg = new Aggregator(60 * 60_000, M15);
  const t0 = Date.parse('2026-01-05T10:00:00Z');
  const bar = (t, o, h, l, c) => ({ t, o, h, l, c, v: 1 });
  assert.deepStrictEqual(agg.push(bar(t0, 10, 11, 9, 10.5)), []);
  agg.push(bar(t0 + M15, 10.5, 12, 10, 11));
  agg.push(bar(t0 + 2 * M15, 11, 11.5, 8, 9));
  const out = agg.push(bar(t0 + 3 * M15, 9, 10, 8.5, 9.5));
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], { bar: { t: t0, o: 10, h: 12, l: 8, c: 9.5, v: 4, end: t0 + 4 * M15 }, late: false });
  // Market stops mid-hour; the candle is closed by the next bar, marked late.
  agg.push(bar(t0 + 4 * M15, 9.5, 10, 9, 9.8));
  const later = agg.push(bar(t0 + 50 * 60 * 60_000, 9.8, 10, 9.7, 9.9));
  assert.strictEqual(later.length, 1);
  assert.strictEqual(later[0].late, true);
  assert.strictEqual(later[0].bar.c, 9.8);
});

test('on a random market the desk stays silent', () => {
  const lab = new Lab({ auxSymbols: [], strategies: 'M15:1:1.5:16,H1:1:1.5:12' });
  feed(lab, genBars(20000, { momentum: 0, seed: 7 }));
  const s = lab.snapshot();
  assert.ok(s.strategies[0].learned > 19000);
  assert.ok(s.strategies[1].learned > 4500);
  assert.strictEqual(s.ledger.n, 0, 'no trades without a real edge');
  assert.strictEqual(s.decision.action, 'wait');
});

test('on a market with a real pattern the desk proves it and profits out-of-sample', () => {
  const lab = new Lab({ auxSymbols: [], strategies: 'M15:1:1.5:16' });
  feed(lab, genBars(20000, { momentum: 0.3, seed: 11 }));
  const s = lab.snapshot();
  assert.ok(s.ledger.n > 300, `trades: ${s.ledger.n}`);
  assert.ok(s.ledger.avgR > 0.1, `avgR: ${s.ledger.avgR}`);
  assert.ok(s.ledger.profitFactor > 1.2);
  assert.ok(s.strategies[0].gbdt.fits > 0, 'trees were trained');
});

test('state is saved and learning continues exactly as without restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xau-lab-'));
  const bars = genBars(4000, { momentum: 0.3 });
  const aux = genBars(4000, { seed: 5 });
  const opts = { dir, auxSymbols: ['EURUSD'], strategies: 'M15:1:1.5:16,H1:1:1.5:12', minSamples: 500 };

  const a = new Lab(opts);
  feed(a, bars.slice(0, 2500), { aux: { EURUSD: aux.slice(0, 2500) } });
  a.flush();

  const b = new Lab(opts);
  assert.strictEqual(b.base.length, 2500);
  const r = b.ingest({ timeframe: 'M15', bars: bars.slice(0, 3000), aux: { EURUSD: aux.slice(0, 3000) } });
  assert.strictEqual(r.accepted, 500, 'known bars are skipped');
  assert.strictEqual(r.last.XAUUSD, bars[2999][0]);
  assert.strictEqual(r.last.EURUSD, aux[2999][0]);

  const ref = new Lab({ ...opts, dir: null });
  feed(ref, bars.slice(0, 2500), { aux: { EURUSD: aux.slice(0, 2500) } });
  ref.ingest({ timeframe: 'M15', bars: bars.slice(2500, 3000), aux: { EURUSD: aux.slice(2500, 3000) } });
  const strip = (s) => s.strategies.map(({ hint, ...rest }) => rest);
  assert.deepStrictEqual(strip(b.snapshot()), strip(ref.snapshot()));

  // A newly added strategy learns from the stored history.
  const c = new Lab({ ...opts, strategies: 'M15:1:1.5:16,H1:1:1.5:12,M15:2:2:20' });
  assert.ok(c.strategies[2].stats.learned > 2000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrong timeframe is rejected, unknown related markets are ignored', () => {
  const lab = new Lab({ strategies: 'M15:1:1.5:16' });
  assert.throws(() => lab.ingest({ timeframe: 'H1', bars: [] }), /interwał/);
  const r = lab.ingest({ timeframe: 'M15', bars: [], aux: { BTCUSD: genBars(10) } });
  assert.strictEqual(r.auxAccepted, 0);
  assert.strictEqual(lab.ingest({ bars: [], aux: { 'XAGUSD.r': genBars(10) } }).auxAccepted, 10, 'broker suffix accepted');
});

test('position size follows balance, risk % and stop distance', () => {
  const lab = new Lab({ strategies: 'M15:1:1.5:16', riskPct: 1 });
  lab.ingest({ bars: [], account: { balance: 10000, currency: 'USD', lotSize: 100, valuePerUnit: 1, minUnits: 1, stepUnits: 1 } });
  // Risk 100 USD, stop 5 USD/oz -> 20 oz = 0.2 lot.
  assert.deepStrictEqual(lab.sizing(5), { ok: true, lots: 0.2, units: 20, riskMoney: 100, riskPct: 1, currency: 'USD' });
  lab.ingest({ bars: [], account: { balance: 100, currency: 'USD', lotSize: 100, valuePerUnit: 1, minUnits: 1, stepUnits: 1 } });
  assert.strictEqual(lab.sizing(5).ok, false, 'account too small for the minimum size');
});

test('risk guards block signals on wide spread and after the daily loss limit', () => {
  const lab = new Lab({ strategies: 'M15:1:1.5:16', costUsd: 0.3, maxSpreadMult: 2, dailyLossR: 3 });
  const now = Date.now();
  const bar = { t: now - M15, end: now };
  lab.ingest({ bars: [], spread: 1.0 });
  assert.match(lab.guards(bar).join(), /spread/);
  lab.ingest({ bars: [], spread: 0.3 });
  assert.deepStrictEqual(lab.guards(bar), []);
  lab.desk.ledger.push({ t: now - M15, r: -1 }, { t: now - M15, r: -1 }, { t: now - M15, r: -1.1 });
  assert.match(lab.guards(bar).join(), /dzienny limit/);
});
