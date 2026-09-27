// Feature extraction from closed XAUUSD candles.
//
// Every feature uses only the current bar and the bars before it, never the
// future, so the model can be evaluated honestly on data it has not seen.
// Price distances are expressed in ATR units: that keeps them comparable
// between a calm market at 1800 $ and a wild one at 5000 $.

const WINDOW = 200; // bars used to compute one feature vector
const MIN_BARS = 120; // fewer bars than this = not enough history yet

// Name and Polish description of each feature (used to explain hints).
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
  ['volRegime', 'zmienność teraz vs średnio'],
  ['range', 'wielkość ostatniej świecy'],
  ['closeLoc', 'zamknięcie w świecy (góra/dół)'],
  ['donchian', 'pozycja w zakresie 50 świec'],
  ['bbZ', 'odchylenie od średniej (Bollinger)'],
  ['tickVol', 'wolumen tickowy vs średni'],
  ['hourSin', 'pora dnia (sesja)'],
  ['hourCos', 'pora dnia (sesja)'],
];
const FEATURE_NAMES = FEATURES.map((f) => f[0]);

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

// ATR(14) of the last bar in `bars` (simple average of true ranges).
function atr(bars, period = 14) {
  const tr = trueRanges(bars.slice(-(period + 1)));
  return mean(tr.slice(-period));
}

// Returns { x: number[], atr } for the last bar in `bars`, or null when there
// is not enough history.
function computeFeatures(allBars) {
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
  const last20 = closes.slice(-20);
  const sma20 = mean(last20);
  const sd20 = Math.sqrt(mean(last20.map((v) => (v - sma20) ** 2))) || atr14;
  const hi50 = Math.max(...bars.slice(-50).map((b) => b.h));
  const lo50 = Math.min(...bars.slice(-50).map((b) => b.l));
  const vols = bars.slice(-50).map((b) => b.v || 0);
  const avgVol = mean(vols);
  const hour = new Date(last.t).getUTCHours() + new Date(last.t).getUTCMinutes() / 60;

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
    volRegime: Math.log(atr14 / atr100),
    range: (last.h - last.l) / atr14,
    closeLoc: last.h > last.l ? (last.c - last.l) / (last.h - last.l) - 0.5 : 0,
    donchian: hi50 > lo50 ? (last.c - lo50) / (hi50 - lo50) - 0.5 : 0,
    bbZ: (last.c - sma20) / sd20,
    tickVol: avgVol > 0 && last.v > 0 ? Math.log(last.v / avgVol) : 0,
    hourSin: Math.sin((2 * Math.PI * hour) / 24),
    hourCos: Math.cos((2 * Math.PI * hour) / 24),
  };
  return { x: FEATURE_NAMES.map((k) => (Number.isFinite(values[k]) ? values[k] : 0)), atr: atr14 };
}

module.exports = { computeFeatures, atr, FEATURES, FEATURE_NAMES, MIN_BARS };
