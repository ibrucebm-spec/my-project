const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/index');
const { genBars } = require('./helpers');

const cfg = { port: 0, ingestToken: 'secret-token', lab: { baseTf: 'M15', strategies: 'M15:1:1.5:16', dir: null } };

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

test('bars endpoint feeds the lab and reports what it has stored', () => withServer(async (base) => {
  const secs = (bars) => bars.map(([t, ...rest]) => [t / 1000, ...rest]); // feeders send seconds
  const bars = secs(genBars(300));
  const aux = secs(genBars(300, { seed: 5 }));
  let r = await post(base, {
    symbol: 'XAUUSD', timeframe: 'M15', price: 2010.5, spread: 0.3,
    account: { balance: 5000, currency: 'EUR', lotSize: 100, valuePerUnit: 0.9, minUnits: 1, stepUnits: 1 },
    aux: { EURUSD: aux }, bars,
  });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.accepted, 300);
  assert.strictEqual(body.auxAccepted, 300);
  assert.strictEqual(body.last.XAUUSD, bars[299][0] * 1000);
  assert.strictEqual(body.last.EURUSD, aux[299][0] * 1000);

  r = await post(base, { symbol: 'XAUUSD', timeframe: 'M15', bars: bars.slice(-5) });
  assert.strictEqual((await r.json()).accepted, 0, 'resent bars are ignored');

  r = await post(base, { timeframe: 'H1', bars });
  assert.strictEqual(r.status, 400);

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.strictEqual(state.price, 2010.5);
  assert.strictEqual(state.lab.bars, 300);
  assert.strictEqual(state.lab.live.account.currency, 'EUR');
  assert.strictEqual(state.lab.decision.action, 'wait'); // still learning
  assert.match(state.lab.decision.why, /uczy się/);
}));

test('static files cannot escape public dir', () => withServer(async (base) => {
  const r = await fetch(`${base}/..%2fpackage.json`);
  assert.notStrictEqual(r.status, 200);
}));

test('analyst answers only when configured and only to this page', () => withServer(async (base) => {
  const ask = (headers) => fetch(`${base}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ question: 'Co teraz?' }) });
  let r = await ask({ 'Content-Type': 'application/json' });
  assert.strictEqual(r.status, 503);
  assert.match((await r.json()).error, /ANTHROPIC_API_KEY/);
  r = await ask({ 'Content-Type': 'text/plain' }); // cross-site form/fetch without preflight
  assert.strictEqual(r.status, 403);
  r = await ask({ 'Content-Type': 'application/json', Origin: 'https://evil.example' });
  assert.strictEqual(r.status, 403);
}));
