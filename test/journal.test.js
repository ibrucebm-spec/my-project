const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Lab } = require('../server/ai/lab');
const { genBars } = require('./helpers');

const M15 = 15 * 60_000;

// A trader who does well when trading with the last hour's move and badly against it.
function traderTrades(bars, n, seed = 3) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = [];
  for (let k = 0; k < n; k++) {
    const i = 400 + Math.floor(rnd() * (bars.length - 450));
    const side = rnd() < 0.5 ? 1 : -1;
    const withMove = side * (bars[i][4] - bars[i - 4][4]) > 0;
    const win = rnd() < (withMove ? 0.75 : 0.25);
    const entryT = bars[i][0] + M15; // opened right after bar i closed
    out.push([`${k}:${k}`, side, entryT / 1000, bars[i][4], (entryT + 3 * M15) / 1000, bars[i][4] + side * (win ? 3 : -3), 10, win ? 30 : -30]);
  }
  return out.sort((a, b) => a[4] - b[4]);
}

test('the coach learns when the trader wins and tests itself honestly', () => {
  const lab = new Lab({ auxSymbols: [], strategies: 'M15:1:1.5:16' });
  const bars = genBars(4000, { momentum: 0.2 });
  lab.ingest({ bars: bars.slice(0, 2000) });
  // Trades arrive before part of their candles: they are completed later.
  lab.ingest({ bars: [], trades: traderTrades(bars, 200) });
  lab.ingest({ bars: bars.slice(2000) });
  const j = lab.snapshot().journal;
  assert.strictEqual(j.n, 200);
  assert.strictEqual(j.learnable, 200, 'market conditions filled in once candles arrived');
  assert.ok(j.evaluation.tested >= 150);
  assert.ok(j.evaluation.skill > 0.03, `skill ${j.evaluation.skill}`);
  assert.ok(j.evaluation.skippedProfit < 0, 'skipping low-rated trades would have avoided losses');
  assert.ok(j.insights.segments.some((g) => g.dim === 'Sesja'));
  assert.strictEqual(lab.ingest({ bars: [], trades: traderTrades(bars, 200) }).tradesAccepted, 0, 'duplicates ignored');
});

test('the coach does not invent patterns for a trader without any', () => {
  const lab = new Lab({ auxSymbols: [], strategies: 'M15:1:1.5:16' });
  const bars = genBars(4000, { momentum: 0.2 });
  let s = 9;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const coinFlips = traderTrades(bars, 200, 4).map((r) => { const win = rnd() < 0.5; return [...r.slice(0, 7), win ? 30 : -30]; });
  lab.ingest({ bars, trades: coinFlips });
  assert.ok(lab.snapshot().journal.evaluation.skill < 0.02);
});

test('open positions get live feedback and the desk opinion is remembered', () => {
  const lab = new Lab({ auxSymbols: [], strategies: 'M15:1:1.5:16' });
  const now = Math.floor(Date.now() / M15) * M15;
  const bars = genBars(3000, { momentum: 0.2, start: now - 3000 * M15 });
  lab.ingest({ bars, trades: traderTrades(bars, 80), account: { balance: 1000, currency: 'USD', lotSize: 100, valuePerUnit: 1 } });
  lab.ingest({ bars: [], positions: [['77', 1, Date.now() / 1000 - 60, bars[2999][4], 10, 0, 0, -1.5]] });
  const j = lab.snapshot().journal;
  assert.strictEqual(j.open.length, 1);
  const p = j.open[0];
  assert.strictEqual(p.lots, 0.1);
  assert.ok(p.pWin > 0 && p.pWin < 1);
  assert.strictEqual(p.noStop, true);
  assert.ok(lab.journal.aiAtOpen['77'], 'desk opinion at open recorded');
  // When it closes, the trade is linked to that opinion.
  lab.ingest({ bars: [], trades: [['77:900', 1, Date.now() / 1000 - 60, bars[2999][4], Date.now() / 1000, bars[2999][4] + 1, 10, 10]] });
  assert.ok(lab.journal.trades.get('77:900').ai);
});

test('journal survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xau-journal-'));
  const bars = genBars(1500);
  const a = new Lab({ dir, auxSymbols: [], strategies: 'M15:1:1.5:16' });
  const r = a.ingest({ bars, trades: traderTrades(bars, 20) });
  assert.strictEqual(r.last.trades, Math.max(...traderTrades(bars, 20).map((t) => t[4])) * 1000);
  a.flush();
  const b = new Lab({ dir, auxSymbols: [], strategies: 'M15:1:1.5:16' });
  assert.strictEqual(b.journal.trades.size, 20);
  assert.ok([...b.journal.trades.values()].every((t) => t.x));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('walk-forward test never uses trades that were still open', () => {
  const lab = new Lab({ auxSymbols: [], strategies: 'M15:1:1.5:16' });
  const bars = genBars(4000, { momentum: 0.2 });
  lab.ingest({ bars });
  const endT = bars[3999][0] / 1000;
  // Every trade stays open until the very end: no result is known when any other is opened.
  const trades = traderTrades(bars, 100).map((r) => [...r.slice(0, 4), endT, ...r.slice(5)]);
  lab.ingest({ bars: [], trades });
  assert.strictEqual(lab.snapshot().journal.evaluation, null);
});

test('trades near the start of the stored history do not break learning', () => {
  const lab = new Lab({ auxSymbols: [], strategies: 'M15:1:1.5:16' });
  const bars = genBars(1000);
  const early = [['1:1', 1, (bars[255][0] + M15) / 1000, bars[255][4], (bars[260][0]) / 1000, bars[260][4], 10, 5]];
  assert.doesNotThrow(() => lab.ingest({ bars, trades: early }));
  assert.strictEqual(lab.journal.trades.get('1:1').x, undefined, 'not enough candles before it');
});
