// Teaches the AI from a candle history CSV (e.g. exported from MT5) and prints an
// honest report (every result is out-of-sample: the model is scored on each
// candle before it learns from it).
//
//   npm run train -- XAUUSD_M15.csv           learn and save into the live model
//   npm run train -- XAUUSD_M15.csv --dry     test only, do not touch the model
//
// Accepted formats: MT5 export (<DATE> <TIME> <OPEN> <HIGH> <LOW> <CLOSE> <TICKVOL> ...,
// tab or comma separated) and "YYYY-MM-DD HH:MM,open,high,low,close[,volume]".
// Times are taken as UTC; set --utc-offset=3 when the file is in broker time UTC+3.

const fs = require('fs');
const config = require('../server/config');
const { Lab } = require('../server/ai/lab');

const ACTION = { long: 'KUPNO', short: 'SPRZEDAŻ', wait: 'CZEKAJ' };

function parseCsv(text, offsetHours) {
  const bars = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/[\t,;]/).map((c) => c.trim());
    if (cols.length < 5 || !/^\d{4}[.\-/]\d{2}[.\-/]\d{2}/.test(cols[0])) continue;
    let when = cols[0];
    let rest = cols.slice(1);
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(cols[1])) {
      when = `${cols[0]} ${cols[1]}`;
      rest = cols.slice(2);
    }
    const m = when.match(/^(\d{4})[.\-/](\d{2})[.\-/](\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) continue;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - offsetHours * 3600_000;
    const [o, h, l, c, v] = rest.map(Number);
    bars.push([t, o, h, l, c, v || 0]);
  }
  return bars;
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Użycie: npm run train -- plik.csv [--dry] [--utc-offset=2]');
    process.exit(1);
  }
  const dry = args.includes('--dry');
  const offset = Number((args.find((a) => a.startsWith('--utc-offset=')) || '=0').split('=')[1]) || 0;
  const bars = parseCsv(fs.readFileSync(file, 'utf8'), offset);
  if (!bars.length) {
    console.error('Nie znalazłem świec w pliku. Sprawdź format (README).');
    process.exit(1);
  }
  console.log(`Wczytano ${bars.length} świec: ${new Date(bars[0][0]).toISOString()} – ${new Date(bars[bars.length - 1][0]).toISOString()}`);
  console.log('Plik CSV zawiera tylko złoto, więc cechy rynków powiązanych (EURUSD, srebro, USDJPY) będą puste.\n');

  const lab = new Lab({ ...config.lab, dir: dry ? null : config.lab.dir });
  const t0 = Date.now();
  let accepted = 0;
  for (let i = 0; i < bars.length; i += 1000) {
    accepted += lab.ingest({ timeframe: config.lab.baseTf, bars: bars.slice(i, i + 1000) }).accepted;
    process.stdout.write(`\rNauka: ${Math.min(bars.length, i + 1000)} / ${bars.length} świec`);
  }
  lab.flush();
  const s = lab.snapshot();
  const pct = (v) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(1)}%`);
  const n2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(2));

  console.log(`\n\nNowe świece: ${accepted}, czas ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`Próg dowodu przewagi: t-stat ≥ ${n2(s.threshold.tstat)} (poprawka na ${s.threshold.strategies} strategii)\n`);
  console.log('Laboratorium strategii (wyniki tylko na danych, których model wcześniej nie widział):');
  for (const st of s.strategies) {
    const status = { learning: 'UCZY SIĘ', proven: 'PRZEWAGA', 'no-edge': 'brak przewagi' }[st.status];
    const skill = (dir) => pct(st.models[dir].skill[st.models[dir].best]);
    console.log(`  ${st.label.padEnd(42)} ${status.padEnd(14)} wyniki ${String(st.learned).padStart(6)} | skill K ${skill('long')} S ${skill('short')} | papier ${st.paper.n} trans., ${n2(st.paper.avgR)} R, t ${n2(st.paper.tstat)}`);
  }
  const l = s.ledger;
  console.log(`\nDesk (podpowiedzi, które zostałyby pokazane): ${l.n} transakcji, TP ${l.wins}, SL ${l.losses}, czas ${l.timeouts}`);
  console.log(`  średnio ${n2(l.avgR)} R, razem ${n2(l.totalR)} R, profit factor ${n2(l.profitFactor)}, max obsunięcie ${n2(l.maxDrawdownR)} R`);
  console.log(`\nTeraz: ${ACTION[s.decision?.action] || 'CZEKAJ'} – ${s.decision?.why || 'za mało danych'}`);
  if (!dry) console.log(`\nZapisano stan AI w: ${config.lab.dir}`);
}

main();
