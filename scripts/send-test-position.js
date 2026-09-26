// Sends one fake XAUUSD position to a running Gold Copy Radar, exactly like the
// MT5 bridge EA does, then closes it after 15 s. Verifies the whole pipeline
// (token, /api/ingest, live table, notifications) without MetaTrader.
require('../server/config');

const url = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 3000}/api/ingest`;
const token = process.env.INGEST_TOKEN;
if (!token) {
  console.error('Brak INGEST_TOKEN w .env');
  process.exit(1);
}

const account = {
  id: 'test-bridge',
  name: 'TEST mostu MT5',
  stats: { growthPct: 120, maxDrawdownPct: 10, ageWeeks: 80, profitFactor: 1.8 },
};

async function send(positions) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ account, positions }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
  return body;
}

(async () => {
  console.log(`Wysyłam testową pozycję do ${url} ...`);
  console.log('  odpowiedź:', await send([{
    id: `test-${Date.now()}`, symbol: 'XAUUSD', side: 'buy', lots: 0.1,
    openPrice: 5100, openTime: Date.now(), sl: 5090, tp: 5120, profit: 0,
  }]));
  console.log('Sprawdź przeglądarkę: w tabeli powinien być trader "TEST mostu MT5". Zamknę pozycję za 15 s ...');
  await new Promise((r) => setTimeout(r, 15000));
  console.log('  odpowiedź:', await send([]));
  console.log('Wynik: most MT5 działa.');
})().catch((err) => {
  console.error(`BŁĄD: ${err.message}`);
  if (/fetch failed|ECONNREFUSED/i.test(err.message)) console.error('Serwer nie działa. Uruchom najpierw "npm start" w innym oknie.');
  if (/401/.test(err.message)) console.error('Token się nie zgadza. Po zmianie INGEST_TOKEN w .env zrestartuj "npm start".');
  process.exit(1);
});
