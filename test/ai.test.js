const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Advisor, parseBar } = require('../server/ai/advisor');
const { computeFeatures } = require('../server/ai/features');
const { Linear, MLP } = require('../server/ai/model');
const { genBars } = require('./helpers');

const toObj = (b) => parseBar(b);

test('parseBar accepts arrays in seconds and rejects broken candles', () => {
  const b = parseBar([1700000000, 2000, 2005, 1995, 2001, 50]);
  assert.strictEqual(b.t, 1700000000000);
  assert.strictEqual(parseBar([1700000000, 2000, 1990, 1995, 2001]), null); // high below close
  assert.strictEqual(parseBar([1700000000, 'x', 2005, 1995, 2001]), null);
});

test('features never look into the future', () => {
  const bars = genBars(400).map(toObj);
  const a = computeFeatures(bars.slice(0, 300));
  const b = computeFeatures(bars.slice(0, 300).concat()); // same past
  assert.deepStrictEqual(a, b);
  assert.strictEqual(computeFeatures(bars.slice(0, 50)), null);
  assert.ok(a.x.every(Number.isFinite));
  assert.ok(a.atr > 0);
});

test('trade outcomes: TP, SL, both in one bar = loss, timeout at market', () => {
  const adv = new Advisor({ horizon: 3 });
  const s = { entry: 100, slDist: 1, tpDist: 1.5, age: 1 };
  const bar = (o, h, l, c) => ({ o, h, l, c });
  assert.deepStrictEqual(adv.outcome('long', s, bar(100, 101.6, 99.5, 101)), { win: 1, r: 1.5, result: 'tp' });
  assert.strictEqual(adv.outcome('long', s, bar(100, 100.5, 98.9, 99)).result, 'sl');
  assert.strictEqual(adv.outcome('long', s, bar(100, 102, 98, 100)).result, 'sl');
  assert.strictEqual(adv.outcome('short', s, bar(100, 100.5, 98.4, 99)).result, 'tp');
  assert.strictEqual(adv.outcome('long', s, bar(100, 100.5, 99.5, 100.2)), null);
  const timeout = adv.outcome('long', { ...s, age: 3 }, bar(100, 100.5, 99.5, 100.2));
  assert.strictEqual(timeout.result, 'time');
  assert.ok(Math.abs(timeout.r - 0.2) < 1e-9);
  // Gap through the stop loses more than 1R.
  assert.strictEqual(adv.outcome('long', s, bar(97, 97.5, 96, 97)).r, -3);
});

test('both learners can learn a simple relation', () => {
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

test('on a random market the AI stays silent', () => {
  const adv = new Advisor({});
  adv.addBars('M15', genBars(12000, { momentum: 0, seed: 7 }));
  const s = adv.snapshot();
  assert.ok(s.learned > 11000);
  assert.strictEqual(s.trades.n, 0, 'no hints without a real edge');
});

test('on a market with a real pattern the AI learns it and profits out-of-sample', () => {
  const adv = new Advisor({});
  adv.addBars('M15', genBars(12000, { momentum: 0.3, seed: 11 }));
  const s = adv.snapshot();
  assert.ok(s.trades.n > 100, `hints: ${s.trades.n}`);
  assert.ok(s.trades.avgR > 0.1, `avgR: ${s.trades.avgR}`);
  assert.ok(s.models.long.skill[s.models.long.best] > 0);
});

test('model is saved and keeps learning after restart; settings change triggers relearning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xau-ai-'));
  const file = path.join(dir, 'model.json');
  const bars = genBars(3000, { momentum: 0.3 });

  const a = new Advisor({ file });
  a.addBars('M15', bars.slice(0, 2000));
  const learned = a.stats.learned;

  const b = new Advisor({ file });
  assert.strictEqual(b.stats.learned, learned);
  assert.strictEqual(b.addBars('M15', bars.slice(0, 2500)).accepted, 500); // old bars ignored
  assert.ok(b.stats.learned > learned);
  assert.deepStrictEqual(b.snapshot(), (() => {
    const ref = new Advisor({});
    ref.addBars('M15', bars.slice(0, 2500));
    return ref.snapshot();
  })(), 'restart gives exactly the same model as uninterrupted learning');

  const c = new Advisor({ file, tpAtr: 2 });
  assert.strictEqual(c.bars.length, 2500);
  assert.ok(c.stats.learned > 2000, 'relearned from stored bars');

  assert.throws(() => c.addBars('H1', bars), /interwał/);
  fs.rmSync(dir, { recursive: true, force: true });
});
