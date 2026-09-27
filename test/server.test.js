const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/index');
const { genBars } = require('./helpers');

const cfg = { port: 0, ingestToken: 'secret-token', ai: { timeframe: 'M15', file: null } };

async function withServer(fn) {
  const app = createApp(cfg);
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try { await fn(base, app); } finally { app.close(); }
}

const post = (base, body, token = 'secret-token') => fetch(`${base}/api/bars`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body) + '\0', // MQL5 may append a NUL byte
});

test('bars endpoint rejects a wrong token', () => withServer(async (base) => {
  const r = await post(base, { timeframe: 'M15', bars: [] }, 'nope');
  assert.strictEqual(r.status, 401);
}));

test('bars endpoint feeds the AI and exposes its state', () => withServer(async (base) => {
  const bars = genBars(300).map(([t, ...rest]) => [t / 1000, ...rest]); // EA sends seconds
  let r = await post(base, { symbol: 'XAUUSD', timeframe: 'M15', price: 2010.5, bars });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.accepted, 300);

  r = await post(base, { timeframe: 'M15', bars: bars.slice(-5) });
  assert.strictEqual((await r.json()).accepted, 0, 'resent bars are ignored');

  r = await post(base, { timeframe: 'H1', bars });
  assert.strictEqual(r.status, 400);

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.strictEqual(state.price, 2010.5);
  assert.strictEqual(state.ai.bars, 300);
  assert.strictEqual(state.ai.hint.action, 'wait'); // still in the learning period
  assert.match(state.ai.hint.why, /uczy się/);
}));

test('static files cannot escape public dir', () => withServer(async (base) => {
  const r = await fetch(`${base}/..%2fpackage.json`);
  assert.notStrictEqual(r.status, 200);
}));
