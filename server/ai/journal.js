// Personal trading coach: learns from YOUR gold trades.
//
// The cBot sends the trader's closed and open XAUUSD positions. For every
// trade the journal reconstructs the market at the moment of entry (the same
// features the desk uses) and learns which conditions lead to the trader's
// winners and losers:
//   - a small, heavily regularised model (a trader has tens or hundreds of
//     trades, not thousands) estimates the chance that a trade taken in given
//     conditions ends in profit,
//   - it is tested honestly: each trade is predicted by a model trained only
//     on the trades before it,
//   - plain-language insights show where the trader makes and loses money
//     (session, direction, market regime, holding time, with/against the AI).
// For open positions it gives live feedback based on what it has learned.

const { computeFeatures, lastClosedIndex, FEATURE_NAMES } = require('./features');
const { regimeOf, REGIME_LABELS } = require('./strategy');
const { sigmoid } = require('./model');

const MIN_TRADES = 30; // before the personal model gives opinions
const TRAIN_WINDOW = 1500; // most recent closed trades the model learns from (your recent style matters most)
const REFITS = 25; // walk-forward refits over the whole history (bounded work for active traders)
const RECOMPUTE_MS = 30_000; // at most one full re-analysis per 30 s while trades keep changing
const DAY_MS = 86_400_000;
const idx = (name) => FEATURE_NAMES.indexOf(name);

// Inputs of the personal model: direction-aware versions of the desk features
// (a rising market is good for a buy and bad for a sell) plus conditions.
const DIRECTIONAL = ['ret4', 'ret16', 'ret64', 'rsi', 'emaSpread', 'distSma200', 'donchian', 'bbZ', 'dayLoc', 'prevDayLoc', 'aux0r4', 'aux1r4'].map(idx);
const NEUTRAL = ['volRegime', 'range', 'hourSin', 'hourCos'].map(idx);
const INPUT_LABELS = [
  'kierunek (kupno/sprzedaż)',
  'wejście z ruchem ostatnich 4 świec', 'wejście z ruchem ostatnich 16 świec', 'wejście z trendem 64 świec', 'RSI w stronę pozycji',
  'EMA20/EMA50 w stronę pozycji', 'SMA200 w stronę pozycji', 'pozycja w zakresie 50 świec', 'Bollinger w stronę pozycji',
  'położenie w dziennym zakresie', 'względem wczorajszego high/low', 'dolar (EURUSD) w stronę pozycji', 'srebro w stronę pozycji',
  'zmienność', 'wielkość ostatniej świecy', 'pora dnia', 'pora dnia',
];

function sessionOf(t) {
  const h = new Date(t).getUTCHours();
  if (h >= 7 && h < 13) return 'Londyn';
  if (h >= 13 && h < 21) return 'Nowy Jork';
  return 'Azja';
}

function holdingOf(ms) {
  if (ms < 3_600_000) return 'do 1 h';
  if (ms < 4 * 3_600_000) return '1–4 h';
  if (ms < DAY_MS) return '4–24 h';
  return 'ponad dzień';
}

// Batch logistic regression with strong L2 (few samples, avoid overfitting).
function fitLogistic(X, y, { lambda = 30, iters = 300, lr = 0.5 } = {}) {
  const n = X.length;
  const d = X[0].length;
  // Flat typed arrays: several times faster than nested JS arrays.
  const F = new Float64Array(n * d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) F[i * d + j] = X[i][j];
  const w = new Float64Array(d);
  const gw = new Float64Array(d);
  const pos = y.reduce((a, v) => a + v, 0);
  let b = Math.log((pos + 1) / (n - pos + 1));
  for (let it = 0; it < iters; it++) {
    gw.fill(0);
    let gb = 0;
    for (let i = 0, o = 0; i < n; i++, o += d) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * F[o + j];
      const e = 1 / (1 + Math.exp(-z)) - y[i];
      gb += e;
      for (let j = 0; j < d; j++) gw[j] += e * F[o + j];
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + (lambda * w[j]) / n);
    b -= lr * (gb / n);
  }
  return { w: Array.from(w), b };
}

const predictWith = (m, x) => sigmoid(x.reduce((z, v, j) => z + m.w[j] * v, m.b));

class Journal {
  constructor(lab, state) {
    this.lab = lab;
    this.trades = new Map((state?.trades || []).map((t) => [t.id, t]));
    this.aiAtOpen = state?.aiAtOpen || {}; // desk opinion recorded when a live position first appeared
    this.positions = [];
    this.positionsAt = 0;
    this.dirty = false; // unsaved changes
    this.cache = null;
  }

  // Close time of the newest trade received (the cBot resends only newer ones).
  lastCloseTime() {
    let m = null;
    for (const t of this.trades.values()) if (m === null || t.closeTime > m) m = t.closeTime;
    return m;
  }

  toState() {
    return { trades: [...this.trades.values()], aiAtOpen: this.aiAtOpen };
  }

  // [id, side(+1/-1), entryTimeSec, entryPrice, closeTimeSec, closePrice, volumeUnits, netProfit]
  addTrades(rows) {
    let n = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!Array.isArray(r) || r.length < 8) continue;
      const [id, side, et, ep, ct, cp, vol, profit] = r;
      const t = {
        id: String(id),
        side: Number(side) > 0 ? 1 : -1,
        entryTime: Number(et) < 1e12 ? Number(et) * 1000 : Number(et),
        entry: Number(ep),
        closeTime: Number(ct) < 1e12 ? Number(ct) * 1000 : Number(ct),
        close: Number(cp),
        volume: Number(vol),
        profit: Number(profit),
      };
      if (![t.entryTime, t.entry, t.closeTime, t.close, t.profit].every(Number.isFinite) || t.entry <= 0) continue;
      if (this.trades.has(t.id)) continue;
      const ai = this.aiAtOpen[t.id.split(':')[0]];
      if (ai) t.ai = ai;
      this.trades.set(t.id, t);
      n++;
    }
    if (n) this.touch();
    return n;
  }

  // [id, side, entryTimeSec, entryPrice, volumeUnits, sl, tp, netProfit]
  setPositions(rows) {
    if (!Array.isArray(rows)) return;
    const d = this.currentDecision();
    const byStrat = this.fastestHint();
    const cutoff = Date.now() - 90 * DAY_MS;
    for (const [id, v] of Object.entries(this.aiAtOpen)) if (!(v.at > cutoff)) delete this.aiAtOpen[id];
    this.positions = rows.filter((r) => Array.isArray(r) && r.length >= 8).map(([id, side, et, ep, vol, sl, tp, profit]) => {
      const p = {
        id: String(id), side: Number(side) > 0 ? 1 : -1, entryTime: Number(et) < 1e12 ? Number(et) * 1000 : Number(et),
        entry: Number(ep), volume: Number(vol), sl: Number(sl) || null, tp: Number(tp) || null, profit: Number(profit),
      };
      // Remember what the desk thought when this position first appeared.
      if (!this.aiAtOpen[p.id] && Date.now() - p.entryTime < 30 * 60_000) {
        const dir = p.side > 0 ? 'long' : 'short';
        this.aiAtOpen[p.id] = {
          at: Date.now(),
          deskAction: d?.action || 'wait',
          agrees: d?.action === dir,
          against: d?.action && d.action !== 'wait' && d.action !== dir,
          p: byStrat ? (p.side > 0 ? byStrat.pLong : byStrat.pShort) : null,
        };
        this.dirty = true;
      }
      return p;
    });
    this.positionsAt = Date.now();
  }

  // The desk decision only if it is still valid (not from hours ago).
  currentDecision() {
    const d = this.lab.desk.decision;
    return d && Date.now() <= d.validUntil ? d : null;
  }

  fastestHint() {
    const s = this.lab.strategies.find((x) => x.hint);
    return s ? s.hint : null;
  }

  touch() {
    this.dirty = true;
    this.stale = true;
  }

  // Market features at a given time from the lab's stored candles (null when
  // the candles for that time are no longer or not yet in memory).
  featuresAt(time) {
    const base = this.lab.base;
    const ms = this.lab.baseMs;
    const i = lastClosedIndex(base, time, ms);
    if (i < 259) return null;
    // The candles right before `time` must be known: either the last one
    // closed just before it, or a later candle exists and `time` fell into a
    // gap with no trading (weekend, daily break). Otherwise they have not
    // arrived yet; try again later instead of using stale data.
    const fresh = time - (base[i].t + ms) <= 2 * ms;
    const inGap = i + 1 < base.length && base[i + 1].t + ms >= time;
    if (!fresh && !inGap) return null;
    return computeFeatures(base.slice(i - 259, i + 1), { tfMs: ms, baseMs: ms, aux: this.lab.auxCtx() });
  }

  // Market conditions at the newest candle (for open positions; works when
  // the market is closed too, e.g. a position held over the weekend).
  latestFeatures() {
    const base = this.lab.base;
    if (base.length < 260) return null;
    const ms = this.lab.baseMs;
    return computeFeatures(base.slice(-260), { tfMs: ms, baseMs: ms, aux: this.lab.auxCtx() });
  }

  // Fill in market conditions for trades whose candles have arrived since.
  refresh() {
    let n = 0;
    for (const t of this.trades.values()) {
      if (t.x) continue;
      const f = this.featuresAt(t.entryTime);
      if (!f) continue;
      t.x = f.x.map((v) => Math.round(v * 1000) / 1000);
      t.atr = f.atr;
      n++;
    }
    if (n) this.touch();
  }

  inputs(t, stats) {
    const z = (j) => {
      const s = stats[j];
      return s.sd > 0 ? Math.max(-4, Math.min(4, (t.x[j] - s.mean) / s.sd)) : 0;
    };
    return [t.side, ...DIRECTIONAL.map((j) => t.side * z(j)), ...NEUTRAL.map((j) => z(j))];
  }

  featureStats(list) {
    const stats = {};
    for (const j of [...DIRECTIONAL, ...NEUTRAL]) {
      const v = list.map((t) => t.x[j]);
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      stats[j] = { mean, sd: Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) };
    }
    return stats;
  }

  // Personal model + honest walk-forward test + insights. Cached until trades change.
  // Heavy (model fits), so it is throttled: while trades keep changing the
  // previous result is served for up to RECOMPUTE_MS instead of blocking the
  // server after every candle.
  analyze() {
    if (this.cache && (!this.stale || Date.now() - this.cacheAt < RECOMPUTE_MS)) return this.cache;
    const all = [...this.trades.values()].sort((a, b) => a.closeTime - b.closeTime);
    const learnable = all.filter((t) => t.x).sort((a, b) => a.entryTime - b.entryTime);

    // Walk-forward: each trade is predicted by a model trained only on trades
    // that had already CLOSED when it was opened (their results were known).
    const byClose = [...learnable].sort((a, b) => a.closeTime - b.closeTime);
    const tested = [];
    let model = null;
    let stats = null;
    let trainedOn = 0;
    let known = 0; // trades in byClose closed before the current entry
    let knownWins = 0;
    const every = Math.max(5, Math.ceil(learnable.length / REFITS));
    for (const t of learnable) {
      while (known < byClose.length && byClose[known].closeTime <= t.entryTime) {
        knownWins += byClose[known].profit > 0 ? 1 : 0;
        known++;
      }
      if (known < MIN_TRADES) continue;
      if (!model || known - trainedOn >= every) {
        const train = byClose.slice(Math.max(0, known - TRAIN_WINDOW), known);
        stats = this.featureStats(train);
        model = fitLogistic(train.map((x) => this.inputs(x, stats)), train.map((x) => (x.profit > 0 ? 1 : 0)));
        trainedOn = known;
      }
      tested.push({ t, p: predictWith(model, this.inputs(t, stats)), base: (knownWins + 1) / (known + 2) });
    }
    let evaluation = null;
    if (tested.length >= 10) {
      const ll = (q, y) => -Math.log(Math.max(1e-9, y ? q : 1 - q));
      let m = 0;
      let b = 0;
      let wins = 0;
      for (const { t, p, base } of tested) {
        const y = t.profit > 0 ? 1 : 0;
        m += ll(p, y);
        b += ll(base, y);
        wins += y;
      }
      const skipped = tested.filter(({ p }) => p < 0.4);
      evaluation = {
        tested: tested.length,
        skill: 1 - m / b,
        allProfit: tested.reduce((a, { t }) => a + t.profit, 0),
        skippedCount: skipped.length,
        skippedProfit: skipped.reduce((a, { t }) => a + t.profit, 0),
        winRate: wins / tested.length,
      };
    }

    // Final model on all trades, used for open positions.
    let finalModel = null;
    if (learnable.length >= MIN_TRADES) {
      const recent = byClose.slice(-TRAIN_WINDOW);
      const st = this.featureStats(recent);
      const mdl = fitLogistic(recent.map((t) => this.inputs(t, st)), recent.map((t) => (t.profit > 0 ? 1 : 0)));
      finalModel = { stats: st, model: mdl };
    }

    this.cache = { all, learnable, evaluation, finalModel, insights: this.insights(all) };
    this.cacheAt = Date.now();
    this.stale = false;
    return this.cache;
  }

  insights(all) {
    const groups = {};
    const add = (dim, key, t) => {
      const g = (groups[`${dim}|${key}`] ||= { dim, key, n: 0, wins: 0, profit: 0 });
      g.n++;
      g.wins += t.profit > 0 ? 1 : 0;
      g.profit += t.profit;
    };
    for (const t of all) {
      add('Sesja', sessionOf(t.entryTime), t);
      add('Kierunek', t.side > 0 ? 'kupno' : 'sprzedaż', t);
      add('Czas trzymania', holdingOf(t.closeTime - t.entryTime), t);
      if (t.x) add('Reżim rynku', REGIME_LABELS[regimeOf(t.x)], t);
      if (t.ai) add('Względem desku AI', t.ai.against ? 'wbrew deskowi' : t.ai.agrees ? 'zgodnie z deskiem' : 'desk czekał', t);
    }
    const rows = Object.values(groups).map((g) => ({ ...g, winRate: g.wins / g.n, avgProfit: g.profit / g.n }));
    const solid = rows.filter((g) => g.n >= 5);
    const best = [...solid].sort((a, b) => b.avgProfit - a.avgProfit).slice(0, 3).filter((g) => g.avgProfit > 0);
    const worst = [...solid].sort((a, b) => a.avgProfit - b.avgProfit).slice(0, 3).filter((g) => g.avgProfit < 0);
    return { segments: rows.sort((a, b) => a.dim.localeCompare(b.dim) || b.n - a.n), best, worst };
  }

  // What the coach says about an open position right now.
  coach(p, analysis, f) {
    const lotSize = this.lab.live.account?.lotSize || 100;
    const out = {
      id: p.id, side: p.side > 0 ? 'long' : 'short', entry: p.entry, lots: p.volume / lotSize, sl: p.sl, tp: p.tp,
      profit: p.profit, entryTime: new Date(p.entryTime).toISOString(),
    };
    if (f && analysis.finalModel) {
      const { stats, model } = analysis.finalModel;
      out.pWin = predictWith(model, this.inputs({ side: p.side, x: f.x }, stats));
    }
    if (f) out.regime = REGIME_LABELS[regimeOf(f.x)];
    const h = this.fastestHint();
    if (h) out.deskP = p.side > 0 ? h.pLong : h.pShort;
    const d = this.currentDecision();
    const dir = out.side;
    out.desk = !d ? 'brak aktualnej decyzji desku' : d.action === 'wait' ? 'desk czeka' : d.action === dir ? 'zgodna z deskiem' : 'przeciwna do sygnału desku';
    out.noStop = !p.sl;
    return out;
  }

  snapshot() {
    const a = this.analyze();
    const now = this.positions.length ? this.latestFeatures() : null; // market right now, once
    const profits = a.all.map((t) => t.profit);
    const wins = profits.filter((v) => v > 0);
    const losses = profits.filter((v) => v <= 0);
    const grossLoss = -losses.reduce((x, y) => x + y, 0);
    const currency = this.lab.live.account?.currency || '';
    const top = a.finalModel
      ? a.finalModel.model.w.map((w, i) => ({ label: INPUT_LABELS[i], w })).sort((x, y) => Math.abs(y.w) - Math.abs(x.w)).slice(0, 4)
      : [];
    return {
      currency,
      n: a.all.length,
      learnable: a.learnable.length,
      minTrades: MIN_TRADES,
      winRate: a.all.length ? wins.length / a.all.length : null,
      totalProfit: profits.reduce((x, y) => x + y, 0),
      avgWin: wins.length ? wins.reduce((x, y) => x + y, 0) / wins.length : null,
      avgLoss: losses.length ? losses.reduce((x, y) => x + y, 0) / losses.length : null,
      profitFactor: grossLoss > 0 ? wins.reduce((x, y) => x + y, 0) / grossLoss : null,
      evaluation: a.evaluation,
      drivers: top,
      insights: a.insights,
      open: this.positions.map((p) => this.coach(p, a, now)),
      positionsAt: this.positionsAt ? new Date(this.positionsAt).toISOString() : null,
      last: a.all.slice(-10).reverse().map((t) => ({
        side: t.side > 0 ? 'long' : 'short', entry: t.entry, close: t.close, profit: t.profit,
        entryTime: new Date(t.entryTime).toISOString(), closeTime: new Date(t.closeTime).toISOString(),
        session: sessionOf(t.entryTime), regime: t.x ? REGIME_LABELS[regimeOf(t.x)] : null,
      })),
    };
  }
}

module.exports = { Journal, MIN_TRADES, fitLogistic, sessionOf };
