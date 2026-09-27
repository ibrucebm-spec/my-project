// Feature extraction for one strategy bar (M15, H1, H4, ...).
//
// Every feature uses only the current bar and the bars before it, never the
// future, so the models can be evaluated honestly on data they have not seen.
// Price distances are expressed in ATR units, which keeps them comparable
// between a calm market at 1800 $ and a wild one at 5000 $.
//
// Besides gold's own price action the models see related markets (by default
// EURUSD as a proxy for the dollar, XAGUSD silver and USDJPY), because gold
// is priced in dollars and often reacts to them first.

const WINDOW = 260; // bars used to compute one feature vector
const MIN_BARS = 210; // fewer bars than this = not enough history yet
const AUX_SLOTS = 3;
const AUX_VOL_BARS = 200; // base bars used to measure a related market's volatility

// Name and Polish description of each feature ({0}, {1}, {2} = related markets).
const FEATURES = [
  ['ret1', 'zmiana ceny na ostatniej świecy'],
  ['ret4', 'ruch z ostatnich 4 świec'],
  ['ret16', 'ruch z ostatnich 16 świec'],
  ['ret64', 'trend z ostatnich 64 świec'],
  ['rsi', 'RSI(14)'],
  ['distEma20', 'odległość od EMA20'],
  ['distEma50', 'odległość od EMA50'],
  ['ema20Slope', 'nachylenie EMA20'],
  ['emaSpread', 'EMA20 względem EMA50'],
  ['distSma200', 'odległość od SMA200 (długi trend)'],
  ['volRegime', 'zmienność teraz vs średnio'],
  ['range', 'wielkość ostatniej świecy'],
  ['closeLoc', 'zamknięcie w świecy (góra/dół)'],
  ['donchian', 'pozycja w zakresie 50 świec'],
  ['bbZ', 'odchylenie od średniej (Bollinger)'],
  ['tickVol', 'wolumen tickowy vs średni'],
  ['dayLoc', 'pozycja w dzisiejszym zakresie dnia'],
  ['prevDayLoc', 'cena względem wczorajszego high/low'],
  ['hourSin', 'pora dnia (sesja)'],
  ['hourCos', 'pora dnia (sesja)'],
  ['aux0r1', '{0}: ruch na ostatniej świecy'],
  ['aux0r4', '{0}: ruch z ostatnich 4 świec'],
  ['aux1r1', '{1}: ruch na ostatniej świecy'],
  ['aux1r4', '{1}: ruch z ostatnich 4 świec'],
  ['aux2r1', '{2}: ruch na ostatniej świecy'],
  ['aux2r4', '{2}: ruch z ostatnich 4 świec'],
];
const FEATURE_NAMES = FEATURES.map((f) => f[0]);
const DAY_MS = 86_400_000;

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / Math.min(period, values.length);
  for (let i = 0; i < values.length; i++) {
    e = i < period ? e : values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function trueRanges(bars) {
  return bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const clip = (v, m) => Math.max(-m, Math.min(m, v));

function rsi(closes, period = 14) {
  let up = 0;
  let down = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) up += d;
    else down -= d;
  }
  if (up + down === 0) return 50;
  return (100 * up) / (up + down);
}

// Last index whose bar had closed by time T (bar end = t + baseMs), or -1.
function lastClosedIndex(series, T, baseMs) {
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t + baseMs <= T) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// Moves of a related market over the last 1 and 4 strategy bars, measured in
// its own typical volatility (z-score). Missing or outdated data gives 0.
function auxFeatures(series, T, tfMs, baseMs) {
  if (!series || series.length < 50) return [0, 0];
  const i0 = lastClosedIndex(series, T, baseMs);
  if (i0 < 30 || series[i0].t + baseMs < T - 2 * baseMs) return [0, 0];
  let ss = 0;
  let n = 0;
  for (let i = Math.max(1, i0 - AUX_VOL_BARS + 1); i <= i0; i++) {
    const r = Math.log(series[i].c / series[i - 1].c);
    ss += r * r;
    n++;
  }
  const sigma = Math.sqrt(ss / n);
  if (!(sigma > 0)) return [0, 0];
  const c0 = series[i0].c;
  const move = (k) => {
    const i = lastClosedIndex(series, T - k * tfMs, baseMs);
    if (i < 0) return 0;
    return clip(Math.log(c0 / series[i].c) / (sigma * Math.sqrt(Math.max(1, (k * tfMs) / baseMs))), 6);
  };
  return [move(1), move(4)];
}

// Returns { x: number[], atr } for the last bar in `allBars`, or null when
// there is not enough history.
//   ctx.tfMs   – length of one strategy bar
//   ctx.baseMs – length of one base (input) bar, e.g. M15
//   ctx.aux    – up to 3 arrays of related-market base bars (or null)
function computeFeatures(allBars, ctx = {}) {
  if (allBars.length < MIN_BARS) return null;
  const bars = allBars.slice(-WINDOW);
  const n = bars.length;
  const last = bars[n - 1];
  const closes = bars.map((b) => b.c);
  const tr = trueRanges(bars);
  const atr14 = mean(tr.slice(-14));
  const atr100 = mean(tr.slice(-100));
  if (!(atr14 > 0) || !(atr100 > 0)) return null;

  const ret = (k) => (last.c - closes[n - 1 - k]) / atr14;
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const sma200 = mean(closes.slice(-200));
  const last20 = closes.slice(-20);
  const sma20 = mean(last20);
  const sd20 = Math.sqrt(mean(last20.map((v) => (v - sma20) ** 2))) || atr14;
  const hi50 = Math.max(...bars.slice(-50).map((b) => b.h));
  const lo50 = Math.min(...bars.slice(-50).map((b) => b.l));
  const vols = bars.slice(-50).map((b) => b.v || 0);
  const avgVol = mean(vols);
  const hour = new Date(last.t).getUTCHours() + new Date(last.t).getUTCMinutes() / 60;

  // Today's and yesterday's range (UTC days), classic reference levels.
  const day = Math.floor(last.t / DAY_MS);
  let dHi = -Infinity;
  let dLo = Infinity;
  let pHi = -Infinity;
  let pLo = Infinity;
  let prevDay = null;
  for (let i = n - 1; i >= 0; i--) {
    const bd = Math.floor(bars[i].t / DAY_MS);
    if (bd === day) {
      dHi = Math.max(dHi, bars[i].h);
      dLo = Math.min(dLo, bars[i].l);
    } else {
      if (prevDay === null) prevDay = bd;
      if (bd !== prevDay) break;
      pHi = Math.max(pHi, bars[i].h);
      pLo = Math.min(pLo, bars[i].l);
    }
  }

  const T = last.end ?? last.t + (ctx.tfMs || 0);
  const aux = [];
  for (let k = 0; k < AUX_SLOTS; k++) aux.push(...auxFeatures(ctx.aux?.[k], T, ctx.tfMs || 0, ctx.baseMs || ctx.tfMs || 0));

  const values = {
    ret1: ret(1),
    ret4: ret(4),
    ret16: ret(16),
    ret64: ret(64),
    rsi: (rsi(closes) - 50) / 50,
    distEma20: (last.c - ema20[n - 1]) / atr14,
    distEma50: (last.c - ema50[n - 1]) / atr14,
    ema20Slope: (ema20[n - 1] - ema20[n - 6]) / atr14,
    emaSpread: (ema20[n - 1] - ema50[n - 1]) / atr14,
    distSma200: clip((last.c - sma200) / atr14, 30),
    volRegime: Math.log(atr14 / atr100),
    range: (last.h - last.l) / atr14,
    closeLoc: last.h > last.l ? (last.c - last.l) / (last.h - last.l) - 0.5 : 0,
    donchian: hi50 > lo50 ? (last.c - lo50) / (hi50 - lo50) - 0.5 : 0,
    bbZ: (last.c - sma20) / sd20,
    tickVol: avgVol > 0 && last.v > 0 ? Math.log(last.v / avgVol) : 0,
    dayLoc: dHi > dLo ? (last.c - dLo) / (dHi - dLo) - 0.5 : 0,
    prevDayLoc: pHi > pLo ? clip((last.c - pLo) / (pHi - pLo) - 0.5, 3) : 0,
    hourSin: Math.sin((2 * Math.PI * hour) / 24),
    hourCos: Math.cos((2 * Math.PI * hour) / 24),
    aux0r1: aux[0],
    aux0r4: aux[1],
    aux1r1: aux[2],
    aux1r4: aux[3],
    aux2r1: aux[4],
    aux2r4: aux[5],
  };
  return { x: FEATURE_NAMES.map((k) => (Number.isFinite(values[k]) ? values[k] : 0)), atr: atr14 };
}

// Feature description with related-market names filled in.
function featureLabel(i, auxNames = []) {
  return FEATURES[i][1].replace(/\{(\d)\}/g, (_, k) => auxNames[k] || `rynek powiązany ${Number(k) + 1}`);
}

module.exports = { computeFeatures, featureLabel, lastClosedIndex, FEATURES, FEATURE_NAMES, MIN_BARS, AUX_SLOTS };
