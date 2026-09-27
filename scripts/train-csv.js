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
const { Advisor } = require('../server/ai/advisor');

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

  const advisor = new Advisor({ ...config.ai, file: dry ? null : config.ai.file });
  const before = advisor.stats.learned;
  const t0 = Date.now();
  const r = advisor.addBars(config.ai.timeframe, bars);
  const s = advisor.snapshot();
  const pct = (v) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(1)}%`);
  const n2 = (v) => (v === null || v === undefined ? '–' : v.toFixed(2));

  console.log(`\nNowe świece: ${r.accepted} (pominięte jako już znane: ${r.ignored}, błędne: ${r.invalid}), czas ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`Model nauczony na ${s.learned} wynikach (+${s.learned - before})\n`);
  console.log('Przewaga modeli nad zgadywaniem (skill > 0 = lepiej niż przypadek, liczone na danych, których model nie widział):');
  for (const dir of ['long', 'short']) {
    const m = s.models[dir];
    const skills = Object.entries(m.skill).map(([k, v]) => `${s.modelLabels[k]} ${pct(v)}`).join(', ');
    console.log(`  ${dir === 'long' ? 'KUPNO   ' : 'SPRZEDAŻ'}  ${skills}  | najlepszy: ${s.modelLabels[m.best]} | TP trafiane bazowo: ${pct(m.baseRate)}`);
  }
  console.log(`\nHandel na papierze (ostatnie ${s.paper.n}): średnio ${n2(s.paper.avgR)} R na transakcję, t-stat ${n2(s.paper.tstat)} (wymagane ≥ ${config.ai.minTstat})`);
  const t = s.trades;
  console.log(`Podpowiedzi, które zostałyby pokazane: ${t.n} (TP ${t.wins}, SL ${t.losses}, czas ${t.timeouts}), średnio ${n2(t.avgR)} R, razem ${n2(t.totalR)} R`);
  console.log(`\nTeraz: ${s.hint ? `${ACTION[s.hint.action]} – ${s.hint.why}` : 'za mało danych'}`);
  if (!dry) console.log(`\nZapisano model: ${config.ai.file}`);
}

main();
