// One trading strategy: a timeframe (M15, H1, H4, ...) plus a trade profile
// (stop loss / take profit in ATR, maximum holding time). Each strategy has
// its own models, learns on its own and keeps its own honest track record.
//
// Learning loop, for every closed bar of the strategy's timeframe:
//   1. compute features; for LONG and for SHORT every model estimates the
//      probability that take profit is hit before stop loss,
//   2. store the predictions and wait for the market to answer,
//   3. when TP, SL or the time limit is reached, score the stored predictions
//      (out-of-sample by construction) and only then train on the outcome.
//
// Before a strategy may send a hint to the desk it has to prove itself by
// paper trading: every candidate signal is followed to TP/SL/time with costs,
// one position at a time, and the average result must be positive with a
// t-stat above the lab's threshold (corrected for testing many strategies).

const { EventEmitter } = require('events');
const { computeFeatures, featureLabel, FEATURE_NAMES } = require('./features');
const { Scaler, Linear, MLP, Ensemble, contributions } = require('./model');
const { GBDT } = require('./gbdt');

const EVAL_WINDOW = 1000; // outcomes used for the rolling skill score
const MIN_EVALS = 300; // outcomes needed before a skill score counts
const PAPER_WINDOW = 250; // recent paper trades used to decide whether hints are shown
const MIN_PAPER = 50;
const MAX_BARS = 400;
const DIRS = ['long', 'short'];
const MODEL_NAMES = ['linear', 'mlp', 'gbdt', 'ensemble'];
const MODEL_LABELS = {
  linear: 'regresja logistyczna',
  mlp: 'sieć neuronowa',
  gbdt: 'drzewa gradientowe (GBDT)',
  ensemble: 'zespół modeli',
};
const TF_MINUTES = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };

// Market regimes: direction of the trend (EMA20 vs EMA50 in ATR) × volatility
// (ATR now vs its long average). A strategy that works in a calm uptrend can
// lose money in a volatile range, so every paper trade is booked under the
// regime it was opened in, and a strategy is switched off in regimes where it
// has been losing.
const REGIMES = ['up-calm', 'up-volatile', 'range-calm', 'range-volatile', 'down-calm', 'down-volatile'];
const REGIME_LABELS = {
  'up-calm': 'trend wzrostowy, spokojnie',
  'up-volatile': 'trend wzrostowy, nerwowo',
  'range-calm': 'konsolidacja, spokojnie',
  'range-volatile': 'konsolidacja, nerwowo',
  'down-calm': 'trend spadkowy, spokojnie',
  'down-volatile': 'trend spadkowy, nerwowo',
};
const REGIME_MIN_TRADES = 20;
const REGIME_WINDOW = 60; // recent paper trades per regime that decide (early losses fade out)
const I_SPREAD = FEATURE_NAMES.indexOf('emaSpread');
const I_VOL = FEATURE_NAMES.indexOf('volRegime');

function regimeOf(x) {
  const trend = x[I_SPREAD] > 1 ? 'up' : x[I_SPREAD] < -1 ? 'down' : 'range';
  return `${trend}-${x[I_VOL] > 0.1 ? 'volatile' : 'calm'}`;
}

const emptyRegimes = () => Object.fromEntries(REGIMES.map((r) => [r, { n: 0, sumR: 0, recent: [] }]));

const DEFAULTS = {
  costUsd: 0.35, // spread + commission per ounce, in USD
  minEdge: 0.05, // required probability above break-even to suggest a trade
  minSamples: 1000, // outcomes to learn from before any hint is shown
  minTstat: 1.5, // paper-trading t-stat required (the lab passes a corrected one)
  gbdtEvery: null, // retrain the trees after this many new outcomes (default: ~10 days of M15)
  gbdtWindow: 4000, // ... on this many most recent outcomes
  gbdtMin: 800, // first training once this many outcomes exist
};

function strategyId(spec) {
  return `${spec.tf}-${spec.slAtr}-${spec.tpAtr}-${spec.horizon}`;
}

function strategyLabel(spec) {
  const hours = (spec.horizon * TF_MINUTES[spec.tf]) / 60;
  const hold = hours >= 24 ? `${+(hours / 24).toFixed(1)} d` : `${+hours.toFixed(1)} h`;
  return `${spec.tf} · SL ${spec.slAtr}×ATR / TP ${spec.tpAtr}×ATR · do ${hold}`;
}

class Strategy extends EventEmitter {
  constructor(spec, opts = {}, auxNames = []) {
    super();
    this.spec = spec;
    this.id = strategyId(spec);
    this.label = strategyLabel(spec);
    this.opts = { ...DEFAULTS, ...opts };
    this.tfMs = TF_MINUTES[spec.tf] * 60_000;
    this.baseMs = opts.baseMs || this.tfMs;
    this.gbdtEvery = this.opts.gbdtEvery || Math.max(250, Math.round((1000 * 15) / TF_MINUTES[spec.tf]));
    this.auxNames = auxNames;
    this.signature = JSON.stringify({ spec, f: FEATURE_NAMES, cost: this.opts.costUsd, aux: auxNames });
    this.bars = [];
    this.reset();
  }

  reset() {
    const n = FEATURE_NAMES.length;
    this.scaler = new Scaler(n);
    this.learners = {};
    DIRS.forEach((dir, k) => {
      const linear = new Linear(n);
      const mlp = new MLP(n, { seed: 42 + k });
      const gbdt = new GBDT({ seed: 7 + k, trees: 30 });
      this.learners[dir] = { linear, mlp, gbdt, ensemble: new Ensemble([linear, mlp, gbdt]) };
    });
    this.buffer = { z: [], long: [], short: [] }; // training set for the trees
    this.pending = [];
    this.paperOpen = false;
    this.hint = null;
    this.stats = {
      learned: 0,
      base: { long: { n: 0, wins: 0 }, short: { n: 0, wins: 0 } },
      // Per direction: rolling [logloss linear, mlp, gbdt, ensemble, naive].
      evals: { long: [], short: [] },
      paper: [], // R of recent paper trades
      paperTotal: { n: 0, sumR: 0 },
      regimes: emptyRegimes(), // paper results per market regime
    };
  }

  // Has this strategy been losing in the given regime? (needs enough trades to say)
  regimeRecord(regime) {
    const r = this.stats.regimes[regime];
    const recent = r.recent || [];
    const sum = recent.reduce((a, b) => a + b, 0);
    return {
      regime, label: REGIME_LABELS[regime], n: recent.length, total: r.n,
      avgR: recent.length ? sum / recent.length : null,
      ok: recent.length < REGIME_MIN_TRADES || sum >= 0,
    };
  }

  naive(dir) {
    const b = this.stats.base[dir];
    return (b.wins + 1) / (b.n + 2);
  }

  // Out-of-sample skill of one model: 1 - logloss(model) / logloss(naive).
  // > 0 means it predicts better than always guessing the average win rate.
  skill(dir, name) {
    const e = this.stats.evals[dir];
    if (e.length < MIN_EVALS) return null;
    if (name === 'gbdt' && !this.learners[dir].gbdt.trained) return null;
    const k = MODEL_NAMES.indexOf(name);
    let m = 0;
    let b = 0;
    for (const row of e) {
      m += row[k];
      b += row[4];
    }
    return 1 - m / b;
  }

  bestModel(dir) {
    let best = 'ensemble';
    let bestSkill = this.skill(dir, best);
    for (const name of MODEL_NAMES) {
      const s = this.skill(dir, name);
      if (s !== null && (bestSkill === null || s > bestSkill)) {
        best = name;
        bestSkill = s;
      }
    }
    return { name: best, skill: bestSkill };
  }

  paperRecord() {
    const r = this.stats.paper;
    if (r.length < 2) return { n: r.length, avgR: r.length ? r[0] : null, tstat: null };
    const avg = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - avg) ** 2, 0) / (r.length - 1));
    return { n: r.length, avgR: avg, tstat: sd > 0 ? (avg / sd) * Math.sqrt(r.length) : null };
  }

  // Proof of edge: the recent paper trades are profitable beyond what luck
  // explains, and the strategy is not in the red over its whole life.
  isProven() {
    const p = this.paperRecord();
    const life = this.stats.paperTotal;
    return p.n >= MIN_PAPER && p.avgR > 0 && p.tstat >= this.opts.minTstat && life.sumR > 0;
  }

  // Only keeps the bar for feature computation (used when rebuilding state).
  pushBar(bar) {
    this.bars.push(bar);
    if (this.bars.length > MAX_BARS + 200) this.bars.splice(0, this.bars.length - MAX_BARS);
  }

  // A new closed bar of this strategy's timeframe.
  //   ctx.aux  – related-market series for the features
  //   ctx.late – the bar was completed only by a later bar (e.g. after the
  //              weekend), so nobody could have traded at its close
  //   ctx.live – the bar has just closed (not a history replay)
  onBar(bar, ctx = {}) {
    this.pushBar(bar);
    this.resolvePending(bar);

    const f = computeFeatures(this.bars, { tfMs: this.tfMs, baseMs: this.baseMs, aux: ctx.aux });
    if (!f) {
      this.hint = null;
      return null;
    }
    this.scaler.update(f.x);
    const z = this.scaler.transform(f.x);
    const regime = regimeOf(f.x);
    const inRegime = this.regimeRecord(regime);
    const { slAtr, tpAtr } = this.spec;
    const { minEdge, minSamples, costUsd } = this.opts;
    const slDist = slAtr * f.atr;
    const tpDist = tpAtr * f.atr;
    const rr = tpAtr / slAtr;
    const costR = costUsd / slDist;
    // Conservative break-even: every trade that misses TP counts as a full loss.
    const breakeven = (1 + costR) / (rr + 1);
    const ev = (q) => q * rr - (1 - q) - costR;

    const preds = {};
    const chosen = {};
    for (const dir of DIRS) {
      const naive = this.naive(dir);
      preds[dir] = MODEL_NAMES.map((name) => this.learners[dir][name].predict(z) ?? naive);
      const best = this.bestModel(dir);
      chosen[dir] = { ...best, p: preds[dir][MODEL_NAMES.indexOf(best.name)] };
    }

    const ready = this.stats.learned >= minSamples;
    const dir = chosen.long.p - breakeven >= chosen.short.p - breakeven ? 'long' : 'short';
    const c = chosen[dir];
    const candidate = ready && !ctx.late && c.p >= breakeven + minEdge;
    const paper = this.paperRecord();
    const proven = this.isProven();
    const word = dir === 'long' ? 'KUPNA' : 'SPRZEDAŻY';
    let action = 'wait';
    let why;
    let refused = null;
    if (!ready) why = `uczy się: ${this.stats.learned} z ${minSamples} wyników`;
    else if (ctx.late) why = 'świeca zamknięta po przerwie w handlu, bez sygnału';
    else if (!candidate) why = 'za mała pewność, żeby pokryć ryzyko i spread';
    else if (!proven) {
      why = paper.n < MIN_PAPER
        ? `sygnał ${word} tylko na papierze: zbiera wyniki (${paper.n}/${MIN_PAPER})`
        : `sygnał ${word} tylko na papierze: brak udowodnionej przewagi`;
    } else if (!inRegime.ok) {
      refused = 'regime';
      why = `sygnał ${word} odrzucony: w reżimie „${inRegime.label}” ta strategia traci (${inRegime.n} transakcji, średnio ${inRegime.avgR.toFixed(2)} R)`;
    } else {
      action = dir;
      why = `${MODEL_LABELS[c.name]} ocenia szansę na TP na ${Math.round(c.p * 100)}% (próg opłacalności ${Math.round(breakeven * 100)}%)`;
    }

    const sample = { t: bar.t, entry: bar.c, slDist, tpDist, costR, z, preds, regime, age: 0, long: null, short: null, trade: null, paper: null };
    if (candidate && !this.paperOpen) {
      sample.paper = dir;
      this.paperOpen = true;
    }
    this.pending.push(sample);

    this.hint = {
      barTime: bar.t,
      barEnd: bar.end ?? bar.t + this.tfMs,
      late: !!ctx.late,
      action,
      refused,
      why,
      ready,
      proven,
      direction: dir,
      model: c.name,
      modelLabel: MODEL_LABELS[c.name],
      skill: c.skill,
      entry: bar.c,
      atr: f.atr,
      slDist,
      tpDist,
      rr,
      pLong: chosen.long.p,
      pShort: chosen.short.p,
      p: c.p,
      breakeven,
      ev: ev(c.p),
      regime,
      regimeLabel: REGIME_LABELS[regime],
      regimeRecord: inRegime,
      // Explanations cost ~30 model evaluations, so only for bars someone sees.
      reasons: ctx.live ? this.explain(dir, c.name, z) : [],
    };
    return this.hint;
  }

  // The desk decided to act on this bar's hint: follow it as a real trade.
  commitTrade() {
    const s = this.pending[this.pending.length - 1];
    const h = this.hint;
    if (!s || !h || h.action === 'wait' || s.t !== h.barTime) return null;
    s.trade = h.action;
    return { strategy: this.id, t: s.t, side: h.action };
  }

  explain(dir, name, z) {
    return contributions(this.learners[dir][name], z)
      .map((effect, i) => ({ feature: FEATURE_NAMES[i], label: featureLabel(i, this.auxNames), effect }))
      .filter((r) => Math.abs(r.effect) > 0.005)
      .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
      .slice(0, 5);
  }

  // Result of a hypothetical trade opened at the sample's bar, or null while
  // it is still running. A bar that touches both SL and TP counts as a loss.
  outcome(dir, s, bar) {
    const sign = dir === 'long' ? 1 : -1;
    const tpPx = s.entry + sign * s.tpDist;
    const slPx = s.entry - sign * s.slDist;
    const hitSl = dir === 'long' ? bar.l <= slPx : bar.h >= slPx;
    const hitTp = dir === 'long' ? bar.h >= tpPx : bar.l <= tpPx;
    if (hitSl) {
      // A gap through the stop (e.g. Monday open) loses more than 1R.
      const gapped = dir === 'long' ? bar.o < slPx : bar.o > slPx;
      return { win: 0, r: gapped ? (sign * (bar.o - s.entry)) / s.slDist : -1, result: 'sl', at: bar.t };
    }
    if (hitTp) return { win: 1, r: s.tpDist / s.slDist, result: 'tp', at: bar.t };
    if (s.age >= this.spec.horizon) return { win: 0, r: (sign * (bar.c - s.entry)) / s.slDist, result: 'time', at: bar.t };
    return null;
  }

  resolvePending(bar) {
    const still = [];
    for (const s of this.pending) {
      s.age++;
      for (const dir of DIRS) {
        if (s[dir]) continue;
        s[dir] = this.outcome(dir, s, bar);
        if (!s[dir]) continue;
        const r = s[dir].r - s.costR;
        if (s.paper === dir) {
          this.stats.paper.push(r);
          if (this.stats.paper.length > PAPER_WINDOW) this.stats.paper.shift();
          this.stats.paperTotal.n++;
          this.stats.paperTotal.sumR += r;
          if (s.regime) {
            const g = this.stats.regimes[s.regime];
            g.n++;
            g.sumR += r;
            (g.recent ||= []).push(r);
            if (g.recent.length > REGIME_WINDOW) g.recent.shift();
          }
          this.paperOpen = false;
        }
        if (s.trade === dir) {
          const sign = dir === 'long' ? 1 : -1;
          this.emit('trade', {
            strategy: this.id, t: s.t, closedAt: s[dir].at, side: dir, entry: s.entry,
            sl: s.entry - sign * s.slDist, tp: s.entry + sign * s.tpDist,
            r: Math.round(r * 100) / 100, result: s[dir].result,
          });
        }
      }
      if (s.long && s.short) this.learnFrom(s);
      else still.push(s);
    }
    this.pending = still;
  }

  learnFrom(s) {
    const ll = (q, y) => -Math.log(Math.max(1e-9, y ? q : 1 - q));
    for (const dir of DIRS) {
      const y = s[dir].win;
      const evals = this.stats.evals[dir];
      evals.push([...s.preds[dir].map((q) => ll(q, y)), ll(this.naive(dir), y)]);
      if (evals.length > EVAL_WINDOW) evals.shift();
      const base = this.stats.base[dir];
      base.n++;
      base.wins += y;
      this.learners[dir].linear.learn(s.z, y);
      this.learners[dir].mlp.learn(s.z, y);
    }
    const buf = this.buffer;
    buf.z.push(s.z.map((v) => Math.round(v * 1000) / 1000));
    buf.long.push(s.long.win);
    buf.short.push(s.short.win);
    const { gbdtWindow, gbdtMin } = this.opts;
    if (buf.z.length > gbdtWindow + 500) {
      const cut = buf.z.length - gbdtWindow;
      for (const k of ['z', 'long', 'short']) buf[k].splice(0, cut);
    }
    this.stats.learned++;
    if (buf.z.length >= gbdtMin && this.stats.learned % this.gbdtEvery === 0) this.retrainTrees();
  }

  retrainTrees() {
    const { gbdtWindow } = this.opts;
    const X = this.buffer.z.slice(-gbdtWindow);
    for (const dir of DIRS) this.learners[dir].gbdt.fit(X, this.buffer[dir].slice(-gbdtWindow));
  }

  snapshot() {
    const models = Object.fromEntries(DIRS.map((dir) => [dir, {
      best: this.bestModel(dir).name,
      skill: Object.fromEntries(MODEL_NAMES.map((m) => [m, this.skill(dir, m)])),
      baseRate: this.stats.base[dir].n ? this.stats.base[dir].wins / this.stats.base[dir].n : null,
    }]));
    const paper = this.paperRecord();
    const ready = this.stats.learned >= this.opts.minSamples;
    const proven = this.isProven();
    return {
      id: this.id,
      label: this.label,
      ...this.spec,
      bars: this.bars.length,
      learned: this.stats.learned,
      minSamples: this.opts.minSamples,
      ready,
      proven,
      status: !ready ? 'learning' : proven ? 'proven' : 'no-edge',
      models,
      gbdt: { trainedOn: this.learners.long.gbdt.trainedOn, fits: this.learners.long.gbdt.fits },
      paper: { ...paper, minN: MIN_PAPER, threshold: this.opts.minTstat, total: this.stats.paperTotal },
      regimes: REGIMES.map((r) => this.regimeRecord(r)),
      hint: this.hint && { ...this.hint, barTime: new Date(this.hint.barTime).toISOString(), barEnd: new Date(this.hint.barEnd).toISOString() },
    };
  }

  toState() {
    return {
      signature: this.signature,
      scaler: this.scaler,
      learners: Object.fromEntries(DIRS.map((d) => [d, { linear: this.learners[d].linear, mlp: this.learners[d].mlp, gbdt: this.learners[d].gbdt }])),
      buffer: this.buffer,
      pending: this.pending,
      paperOpen: this.paperOpen,
      hint: this.hint,
      stats: this.stats,
    };
  }

  // Restores learned state; returns false when the state belongs to other settings.
  fromState(state) {
    if (!state || state.signature !== this.signature) return false;
    const n = FEATURE_NAMES.length;
    this.scaler = new Scaler(n, state.scaler);
    DIRS.forEach((dir, k) => {
      const s = state.learners[dir];
      const linear = new Linear(n, {}, s.linear);
      const mlp = new MLP(n, { seed: 42 + k }, s.mlp);
      const gbdt = new GBDT({ seed: 7 + k, trees: 30 }, s.gbdt);
      this.learners[dir] = { linear, mlp, gbdt, ensemble: new Ensemble([linear, mlp, gbdt]) };
    });
    this.buffer = state.buffer;
    this.pending = state.pending;
    this.paperOpen = state.paperOpen;
    this.hint = state.hint;
    this.stats = state.stats;
    this.stats.regimes = this.stats.regimes || emptyRegimes();
    return true;
  }
}

module.exports = { Strategy, strategyId, strategyLabel, regimeOf, MODEL_NAMES, MODEL_LABELS, TF_MINUTES, REGIMES, REGIME_LABELS };
