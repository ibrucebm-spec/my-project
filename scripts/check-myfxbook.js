// Diagnostic: logs in to the Myfxbook API with the credentials from .env / env
// vars and prints your accounts plus their open gold positions. Never prints
// the password or session id.
require('../server/config');
const { call, mapAccount, mapTrade } = require('../server/sources/myfxbook');
const { isGoldSymbol } = require('../server/scoring');

(async () => {
  const email = process.env.MYFXBOOK_EMAIL;
  const password = process.env.MYFXBOOK_PASSWORD;
  if (!email || !password) {
    console.error('Brak MYFXBOOK_EMAIL lub MYFXBOOK_PASSWORD (w .env albo w zmiennych środowiskowych).');
    process.exit(1);
  }
  console.log(`1/3 Logowanie jako ${email.replace(/(.).*(@.*)/, '$1***$2')} ...`);
  const { session } = await call('login', { email, password });
  console.log('    OK, zalogowano');

  try {
    console.log('2/3 Pobieranie kont ...');
    const { accounts = [] } = await call('get-my-accounts', { session });
    console.log(`    Kont: ${accounts.length}`);
    if (accounts.length === 0) console.log('    (Twoje portfolio Myfxbook jest puste: podłącz konto na myfxbook.com)');

    console.log('3/3 Otwarte pozycje na złocie ...');
    for (const a of accounts) {
      const s = mapAccount(a);
      const { openTrades = [] } = await call('get-open-trades', { session, id: a.id });
      const gold = openTrades.map(mapTrade).filter((t) => isGoldSymbol(t.symbol));
      const type = a.demo === true || a.demo === 'true' ? 'DEMO' : 'REAL';
      console.log(`  - ${a.name} (id ${a.id}, ${type}): zysk ${s.growthPct}%, max DD ${s.maxDrawdownPct}%, wiek ${s.ageWeeks} tyg., ` +
        `otwartych ${openTrades.length}, w tym złoto ${gold.length}`);
      for (const t of gold) console.log(`      ${t.side.toUpperCase()} ${t.lots} ${t.symbol} @ ${t.openPrice} SL ${t.sl || 'brak'} TP ${t.tp || '-'}`);
    }
    console.log('\nWynik: połączenie z Myfxbook działa.');
  } finally {
    await call('logout', { session }).catch(() => {});
  }
})().catch((err) => {
  console.error(`\nBŁĄD: ${err.message}`);
  if (/fetch failed|ENOTFOUND|ECONN|nie jest JSON|timeout|aborted/i.test(err.message)) {
    console.error('Brak połączenia z myfxbook.com: blokuje je sieć, firewall albo proxy.');
  }
  process.exit(1);
});
