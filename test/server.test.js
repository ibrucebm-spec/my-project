const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/index');

const cfg = {
  port: 0, sources: ['mt5'], ingestToken: 'secret-token',
  myfxbook: {}, filters: { minAgeWeeks: 26, maxDrawdownPct: 30, minScore: 40 },
};

async function withServer(fn) {
  const app = createApp(cfg);
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try { await fn(base, app); } finally { app.close(); }
}

const payload = (positions) => ({
  account: { id: '123', name: 'Signal <b>X</b>', stats: { growthPct: 150, maxDrawdownPct: 10, ageWeeks: 100 } },
  price: 5111.5,
  positions,
});

test('ingest rejects a wrong token', () => withServer(async (base) => {
  const r = await fetch(`${base}/api/ingest`, { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' });
  assert.strictEqual(r.status, 401);
}));

test('ingest stores only gold positions and emits open/close events', () => withServer(async (base, app) => {
  const events = [];
  app.store.on('position_opened', (e) => events.push(['open', e.position.id]));
  app.store.on('position_closed', (e) => events.push(['close', e.position.id]));
  const post = (body) => fetch(`${base}/api/ingest`, {
    method: 'POST', headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body) + '\0',
  });

  let r = await post(payload([
    { id: 1, symbol: 'XAUUSD.m', side: 'buy', lots: 0.5, openPrice: 5100, openTime: Date.now(), sl: 5090, tp: 5130 },
    { id: 2, symbol: 'EURUSD', side: 'sell', lots: 1, openPrice: 1.1, openTime: Date.now() },
  ]));
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).positions, 1);

  r = await post(payload([]));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(events, [['open', '1'], ['close', '1']]);

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.strictEqual(state.goldPrice, 5111.5);
  assert.strictEqual(state.traders[0].source, 'mt5');
}));

test('static files cannot escape public dir', () => withServer(async (base) => {
  const r = await fetch(`${base}/..%2fpackage.json`);
  assert.notStrictEqual(r.status, 200);
}));
