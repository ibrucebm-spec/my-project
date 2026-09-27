const test = require('node:test');
const assert = require('node:assert');
const { Strategy } = require('../server/ai/strategy');
const { parseBar } = require('../server/ai/lab');
const { computeFeatures, FEATURE_NAMES } = require('../server/ai/features');
const { Linear, MLP } = require('../server/ai/model');
const { GBDT } = require('../server/ai/gbdt');
const { normInv, normCdf, adjustedThreshold, tradeMetrics } = require('../server/ai/stats');
const { genBars } = require('./helpers');

const toObj = (b) => ({ ...parseBar(b), end: b[0] + 15 * 60_000 });

test('parseBar accepts arrays in seconds and rejects broken candles', () => {
  const b = parseBar([1700000000, 2000, 2005, 1995, 2001, 50]);
  assert.strictEqual(b.t, 1700000000000);
  assert.strictEqual(parseBar([1700000000, 2000, 1990, 1995, 2001]), null); // high below close
  assert.strictEqual(parseBar([1700000000, 'x', 2005, 1995, 2001]), null);
});

test('features never look into the future', () => {
  const bars = genBars(600).map(toObj);
  const aux = [genBars(600, { seed: 3 }).map(toObj), null, null];
  const ctx = { tfMs: 900_000, baseMs: 900_000, aux };
  const a = computeFeatures(bars.slice(0, 400), ctx);
  // Adding future bars of gold and of the related market changes nothing.
  const b = computeFeatures(bars.slice(0, 400), { ...ctx, aux: [aux[0].concat(genBars(50, { seed: 9, start: aux[0][599].t + 900_000 }).map(toObj)), null, null] });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.x.length, FEATURE_NAMES.length);
  assert.ok(a.x.every(Number.isFinite));
  assert.ok(a.x[FEATURE_NAMES.indexOf('aux0r1')] !== 0, 'related market feature present');
  assert.strictEqual(a.x[FEATURE_NAMES.indexOf('aux1r1')], 0, 'missing market gives 0');
  assert.strictEqual(computeFeatures(bars.slice(0, 100), ctx), null);
});

test('related market that stopped updating is ignored', () => {
  const bars = genBars(400).map(toObj);
  const stale = genBars(300, { seed: 3 }).map(toObj); // ends 100 bars before gold
  const f = computeFeatures(bars, { tfMs: 900_000, baseMs: 900_000, aux: [stale] });
  assert.strictEqual(f.x[FEATURE_NAMES.indexOf('aux0r1')], 0);
});

test('trade outcomes: TP, SL, both in one bar = loss, timeout at market, gap', () => {
  const st = new Strategy({ tf: 'M15', slAtr: 1, tpAtr: 1.5, horizon: 3 });
  const s = { entry: 100, slDist: 1, tpDist: 1.5, age: 1 };
  const bar = (o, h, l, c) => ({ t: 0, o, h, l, c });
  assert.strictEqual(st.outcome('long', s, bar(100, 101.6, 99.5, 101)).result, 'tp');
  assert.strictEqual(st.outcome('long', s, bar(100, 100.5, 98.9, 99)).result, 'sl');
  assert.strictEqual(st.outcome('long', s, bar(100, 102, 98, 100)).result, 'sl');
  assert.strictEqual(st.outcome('short', s, bar(100, 100.5, 98.4, 99)).result, 'tp');
  assert.strictEqual(st.outcome('long', s, bar(100, 100.5, 99.5, 100.2)), null);
  const timeout = st.outcome('long', { ...s, age: 3 }, bar(100, 100.5, 99.5, 100.2));
  assert.strictEqual(timeout.result, 'time');
  assert.ok(Math.abs(timeout.r - 0.2) < 1e-9);
  assert.strictEqual(st.outcome('long', s, bar(97, 97.5, 96, 97)).r, -3);
});

test('online learners learn a simple relation', () => {
  for (const M of [Linear, MLP]) {
    const m = new M(2, { lr: 0.05, avg: 0.9 });
    for (let i = 0; i < 4000; i++) {
      const x = [Math.sin(i * 1.7), Math.cos(i * 0.9)];
      m.learn(x, x[0] > 0 ? 1 : 0);
    }
    assert.ok(m.predict([1, 0]) > 0.8, M.name);
    assert.ok(m.predict([-1, 0]) < 0.2, M.name);
  }
});

test('gradient boosted trees learn a non-linear pattern a linear model cannot', () => {
  let s = 3;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const X = [];
  const y = [];
  for (let i = 0; i < 5000; i++) {
    const x = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
    X.push(x);
    y.push((x[0] > 0) !== (x[1] > 0) ? 1 : 0); // XOR
  }
  const g = new GBDT();
  assert.strictEqual(g.predict([0, 0, 0]), null, 'untrained');
  g.fit(X.slice(0, 4000), y.slice(0, 4000));
  let ok = 0;
  for (let i = 4000; i < 5000; i++) ok += (g.predict(X[i]) > 0.5) === (y[i] === 1);
  assert.ok(ok / 1000 > 0.9, `accuracy ${ok / 1000}`);
  const copy = new GBDT({}, JSON.parse(JSON.stringify(g)));
  assert.strictEqual(copy.predict(X[4500]), g.predict(X[4500]));
});

test('statistics helpers', () => {
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normInv(0.975) - 1.96) < 1e-3);
  assert.strictEqual(adjustedThreshold(1.5, 1), 1.5);
  assert.ok(Math.abs(adjustedThreshold(1.5, 6) - 2.29) < 0.01);
  const m = tradeMetrics([1.5, -1, -1, 1.5, -1]);
  assert.strictEqual(m.totalR, 0);
  assert.strictEqual(m.profitFactor, 1);
  assert.strictEqual(m.maxDrawdownR, 2);
});
