// AI advisor for XAUUSD: learns continuously from closed candles and suggests
// BUY / SELL / WAIT with stop loss and take profit.
//
// Learning loop, repeated for every closed bar:
//   1. compute features from the bars so far; for LONG and for SHORT every
//      model estimates the probability that take profit is hit before stop loss,
//   2. store those predictions and wait for the market to answer,
//   3. when TP, SL or the time limit is reached, score the stored predictions
//      (the models never saw that outcome, so the score is out-of-sample) and
//      only then train the models on it.
//
// Governance (the part that keeps it honest): the model first trades "on
// paper" (every candidate signal is followed to TP/SL/time, costs included,
// with no money at stake). A hint is shown to you only when
//   - the models have learned from enough outcomes,
//   - the probability clears break-even (including spread) by AI_MIN_EDGE,
//   - the recent paper trades are profitable and statistically convincing
//     (t-stat of the average R >= AI_MIN_TSTAT), i.e. not just luck.
// Otherwise the advisor says WAIT and tells you why.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { computeFeatures, FEATURES, FEATURE_NAMES } = require('./features');
const { Scaler, Linear, MLP, Ensemble, contributions } = require('./model');

const MODEL_VERSION = 2;
const EVAL_WINDOW = 1000; // outcomes used for the rolling skill score
const MIN_EVALS = 300; // outcomes needed before a skill score counts
const RECENT_TRADES = 200;
const PAPER_WINDOW = 100; // paper trades used to decide whether hints are shown
const MIN_PAPER = 30;
const DIRS = ['long', 'short'];
const MODEL_NAMES = ['linear', 'mlp', 'ensemble'];
const MODEL_LABELS = { linear: 'regresja logistyczna', mlp: 'sieć neuronowa', ensemble: 'zespół modeli' };

const TF_MINUTES = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };

const DEFAULTS = {
  timeframe: 'M15',
  horizon: 16, // bars a trade may stay open before it is closed at market
  slAtr: 1.0, // stop loss distance in ATR(14)
  tpAtr: 1.5, // take profit distance in ATR(14)
  minEdge: 0.05, // required probability above break-even to suggest a trade
  minTstat: 1.5, // how convincing the paper-trading profit must be
  minSamples: 1000, // outcomes to learn from before any hint is shown
  costUsd: 0.35, // spread + commission per ounce, in USD
  maxBars: 20000,
  file: null,
};

function parseBar(raw) {
  const b = Array.isArray(raw)
    ? { t: raw[0], o: raw[1], h: raw[2], l: raw[3], c: raw[4], v: raw[5] }
    : { t: raw?.t, o: raw?.o, h: raw?.h, l: raw?.l, c: raw?.c, v: raw?.v };
  for (const k of ['t', 'o', 'h', 'l', 'c']) b[k] = Number(b[k]);
  b.v = Number(b.v) || 0;
  if (![b.t, b.o, b.h, b.l, b.c].every(Number.isFinite)) return null;
  if (b.t < 1e12) b.t *= 1000; // seconds -> ms
  if (b.l <= 0 || b.h < Math.max(b.o, b.c, b.l) || b.l > Math.min(b.o, b.c)) return null;
  return b;
}

function newLearners(state) {
  const n = FEATURE_NAMES.length;
  return Object.fromEntries(DIRS.map((dir, k) => {
    const linear = new Linear(n, {}, state?.[dir]?.linear);
    const mlp = new MLP(n, { seed: 42 + k }, state?.[dir]?.mlp);
    return [dir, { linear, mlp, ensemble: new Ensemble([linear, mlp]) }];
  }));
}

class Advisor extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.tfMs = (TF_MINUTES[this.opts.timeframe] || 15) * 60_000;
    this.signature = JSON.stringify({
      v: MODEL_VERSION, f: FEATURE_NAMES,
      ...Object.fromEntries(['timeframe', 'horizon', 'slAtr', 'tpAtr', 'costUsd'].map((k) => [k, this.opts[k]])),
    });
    this.bars = [];
    this.version = 0;
    this.reset();
    this.load();
  }

  reset() {
    this.scaler = new Scaler(FEATURE_NAMES.length);
    this.learners = newLearners();
    this.pending = [];
    this.tradeOpen = false;
    this.paperOpen = false;
    this.hint = null;
    this.stats = {
      learned: 0,
      base: { long: { n: 0, wins: 0 }, short: { n: 0, wins: 0 } },
      // Per direction: rolling [logloss linear, mlp, ensemble, naive baseline].
      evals: { long: [], short: [] },
      trades: { n: 0, wins: 0, losses: 0, timeouts: 0, sumR: 0, recent: [] },
      paper: [], // R of recent paper trades
    };
  }

  // Paper-trading record: is the model making money on trades nobody saw
  // in advance, by more than chance would explain?
  paperRecord() {
    const r = this.stats.paper;
    if (r.length < 2) return { n: r.length, avgR: r.length ? r[0] : null, tstat: null };
    const avg = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - avg) ** 2, 0) / (r.length - 1));
    return { n: r.length, avgR: avg, tstat: sd > 0 ? (avg / sd) * Math.sqrt(r.length) : null };
  }

  // Appends closed bars (oldest first). Bars at or before the last known one
  // are ignored, so the platform feeder can safely resend history.
  addBars(timeframe, rawBars) {
    if (timeframe && String(timeframe).toUpperCase() !== this.opts.timeframe) {
      throw new Error(`interwał ${timeframe} nie pasuje do AI_TIMEFRAME=${this.opts.timeframe}`);
    }
    const list = Array.isArray(rawBars) ? rawBars : [];
    const bars = list.map(parseBar).filter(Boolean).sort((a, b) => a.t - b.t);
    let accepted = 0;
    for (const bar of bars) {
      if (this.bars.length && bar.t <= this.bars[this.bars.length - 1].t) continue;
      this.step(bar);
      accepted++;
    }
    if (accepted) {
      this.version++;
      this.save();
    }
    return { accepted, ignored: bars.length - accepted, invalid: list.length - bars.length, lastBarTime: this.lastBarTime() };
  }

  lastBarTime() {
    return this.bars.length ? this.bars[this.bars.length - 1].t : null;
  }

  // Out-of-sample skill of one model: 1 - logloss(model) / logloss(naive).
  // > 0 means it predicts better than always guessing the average win rate.
  skill(dir, name) {
    const e = this.stats.evals[dir];
    if (e.length < MIN_EVALS) return null;
    const k = MODEL_NAMES.indexOf(name);
    let m = 0;
    let b = 0;
    for (const row of e) {
      m += row[k];
      b += row[3];
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

  step(bar) {
    this.bars.push(bar);
    if (this.bars.length > this.opts.maxBars) this.bars.splice(0, this.bars.length - this.opts.maxBars);
    this.resolvePending(bar);

    const f = computeFeatures(this.bars);
    if (!f) {
      this.hint = null;
      return;
    }
    this.scaler.update(f.x);
    const z = this.scaler.transform(f.x);
    const { slAtr, tpAtr, minEdge, minTstat, minSamples, costUsd } = this.opts;
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
      preds[dir] = MODEL_NAMES.map((name) => this.learners[dir][name].predict(z));
      const best = this.bestModel(dir);
      chosen[dir] = { ...best, p: preds[dir][MODEL_NAMES.indexOf(best.name)] };
    }

    const ready = this.stats.learned >= minSamples;
    const dir = chosen.long.p - breakeven >= chosen.short.p - breakeven ? 'long' : 'short';
    const c = chosen[dir];
    const candidate = ready && c.p >= breakeven + minEdge;
    const paper = this.paperRecord();
    const proven = paper.n >= MIN_PAPER && paper.avgR > 0 && paper.tstat >= minTstat;
    let action = 'wait';
    let why;
    if (!ready) why = `model uczy się: ${this.stats.learned} z ${minSamples} wyników`;
    else if (!candidate) why = 'za mała pewność, żeby pokryć ryzyko i spread';
    else if (!proven) {
      why = paper.n < MIN_PAPER
        ? `sygnał ${dir === 'long' ? 'KUPNA' : 'SPRZEDAŻY'} tylko na papierze: model zbiera wyniki (${paper.n}/${MIN_PAPER} transakcji)`
        : `sygnał ${dir === 'long' ? 'KUPNA' : 'SPRZEDAŻY'} tylko na papierze: ostatnie transakcje papierowe nie dowodzą przewagi`;
    } else {
      action = dir;
      why = `${MODEL_LABELS[c.name]} ocenia szansę na TP na ${Math.round(c.p * 100)}% (próg opłacalności ${Math.round(breakeven * 100)}%)`;
    }

    const sample = { t: bar.t, entry: bar.c, slDist, tpDist, costR, z, preds, age: 0, long: null, short: null, trade: null, paper: null };
    // One trade at a time, like a trader following the hints would.
    if (candidate && !this.paperOpen) {
      sample.paper = dir;
      this.paperOpen = true;
    }
    if (action !== 'wait' && !this.tradeOpen) {
      sample.trade = action;
      this.tradeOpen = true;
    }
    this.pending.push(sample);

    const prevAction = this.hint?.action;
    this.hint = {
      barTime: bar.t,
      action,
      why,
      ready,
      direction: dir,
      model: c.name,
      modelLabel: MODEL_LABELS[c.name],
      skill: c.skill,
      candidate: candidate ? dir : null,
      paper,
      entry: bar.c,
      atr: f.atr,
      pLong: chosen.long.p,
      pShort: chosen.short.p,
      breakeven,
      evLong: ev(chosen.long.p),
      evShort: ev(chosen.short.p),
      long: { sl: bar.c - slDist, tp: bar.c + tpDist },
      short: { sl: bar.c + slDist, tp: bar.c - tpDist },
      reasons: this.explain(dir, c.name, z),
    };
    const live = Date.now() - bar.t < 3 * this.tfMs;
    if (live && action !== 'wait' && action !== prevAction) this.emit('signal', this.hint);
  }

  explain(dir, name, z) {
    return contributions(this.learners[dir][name], z)
      .map((effect, i) => ({ feature: FEATURES[i][0], label: FEATURES[i][1], effect }))
      .filter((r) => Math.abs(r.effect) > 0.005)
      .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
      .slice(0, 4);
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
      return { win: 0, r: gapped ? (sign * (bar.o - s.entry)) / s.slDist : -1, result: 'sl' };
    }
    if (hitTp) return { win: 1, r: s.tpDist / s.slDist, result: 'tp' };
    if (s.age >= this.opts.horizon) return { win: 0, r: (sign * (bar.c - s.entry)) / s.slDist, result: 'time' };
    return null;
  }

  resolvePending(bar) {
    const still = [];
    for (const s of this.pending) {
      s.age++;
      for (const dir of DIRS) {
        if (s[dir]) continue;
        s[dir] = this.outcome(dir, s, bar);
        if (s[dir] && s.trade === dir) this.recordTrade(s, dir);
        if (s[dir] && s.paper === dir) this.recordPaper(s, dir);
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
      const base = this.stats.base[dir];
      const naive = (base.wins + 1) / (base.n + 2);
      const evals = this.stats.evals[dir];
      evals.push([...s.preds[dir].map((q) => ll(q, y)), ll(naive, y)]);
      if (evals.length > EVAL_WINDOW) evals.shift();
      base.n++;
      base.wins += y;
      this.learners[dir].linear.learn(s.z, y);
      this.learners[dir].mlp.learn(s.z, y);
    }
    this.stats.learned++;
  }

  recordPaper(s, dir) {
    this.stats.paper.push(s[dir].r - s.costR);
    if (this.stats.paper.length > PAPER_WINDOW) this.stats.paper.shift();
    this.paperOpen = false;
  }

  recordTrade(s, dir) {
    const o = s[dir];
    const r = o.r - s.costR;
    const t = this.stats.trades;
    t.n++;
    t.sumR += r;
    if (o.result === 'tp') t.wins++;
    else if (o.result === 'sl') t.losses++;
    else t.timeouts++;
    t.recent.push({ t: s.t, side: dir, entry: s.entry, r: Math.round(r * 100) / 100, result: o.result });
    if (t.recent.length > RECENT_TRADES) t.recent.shift();
    this.tradeOpen = false;
  }

  snapshot() {
    const t = this.stats.trades;
    const recent = t.recent.slice(-100);
    const models = Object.fromEntries(DIRS.map((dir) => [dir, {
      best: this.bestModel(dir).name,
      skill: Object.fromEntries(MODEL_NAMES.map((m) => [m, this.skill(dir, m)])),
      baseRate: this.stats.base[dir].n ? this.stats.base[dir].wins / this.stats.base[dir].n : null,
    }]));
    return {
      timeframe: this.opts.timeframe,
      tfMinutes: this.tfMs / 60_000,
      params: Object.fromEntries(['horizon', 'slAtr', 'tpAtr', 'minEdge', 'minTstat', 'costUsd'].map((k) => [k, this.opts[k]])),
      bars: this.bars.length,
      lastBarTime: this.lastBarTime() ? new Date(this.lastBarTime()).toISOString() : null,
      lastClose: this.bars.length ? this.bars[this.bars.length - 1].c : null,
      learned: this.stats.learned,
      minSamples: this.opts.minSamples,
      ready: this.stats.learned >= this.opts.minSamples,
      hint: this.hint && { ...this.hint, barTime: new Date(this.hint.barTime).toISOString() },
      models,
      modelLabels: MODEL_LABELS,
      paper: this.paperRecord(),
      trades: {
        n: t.n, wins: t.wins, losses: t.losses, timeouts: t.timeouts,
        totalR: t.sumR,
        avgR: t.n ? t.sumR / t.n : null,
        recentN: recent.length,
        recentWinRate: recent.length ? recent.filter((x) => x.result === 'tp').length / recent.length : null,
        recentAvgR: recent.length ? recent.reduce((a, x) => a + x.r, 0) / recent.length : null,
        open: this.tradeOpen,
        last: t.recent.slice(-10).reverse().map((x) => ({ ...x, t: new Date(x.t).toISOString() })),
      },
    };
  }

  save() {
    if (!this.opts.file) return;
    const state = {
      signature: this.signature,
      timeframe: this.opts.timeframe,
      bars: this.bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]),
      scaler: this.scaler,
      learners: Object.fromEntries(DIRS.map((d) => [d, { linear: this.learners[d].linear, mlp: this.learners[d].mlp }])),
      pending: this.pending,
      tradeOpen: this.tradeOpen,
      paperOpen: this.paperOpen,
      hint: this.hint,
      stats: this.stats,
    };
    try {
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
      const tmp = `${this.opts.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.opts.file);
    } catch (err) {
      console.error('[ai] nie udało się zapisać modelu:', err.message);
    }
  }

  load() {
    if (!this.opts.file || !fs.existsSync(this.opts.file)) return;
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.opts.file, 'utf8'));
    } catch (err) {
      console.error('[ai] plik modelu jest uszkodzony, zaczynam od zera:', err.message);
      return;
    }
    if (state.timeframe !== this.opts.timeframe) {
      console.log(`[ai] zmieniony interwał (${state.timeframe} -> ${this.opts.timeframe}): zaczynam od zera, cTrader/MT5 prześle nową historię`);
      return;
    }
    const bars = (state.bars || []).map(parseBar).filter(Boolean);
    if (state.signature === this.signature) {
      this.bars = bars;
      this.scaler = new Scaler(FEATURE_NAMES.length, state.scaler);
      this.learners = newLearners(state.learners);
      this.pending = state.pending || [];
      this.tradeOpen = !!state.tradeOpen;
      this.paperOpen = !!state.paperOpen;
      this.hint = state.hint || null;
      this.stats = state.stats;
      return;
    }
    // Settings changed (SL/TP, horizon, ...): old lessons no longer apply,
    // so relearn from scratch on the stored history.
    console.log(`[ai] zmienione ustawienia modelu: uczę się od nowa na ${bars.length} zapisanych świecach`);
    for (const b of bars) this.step(b);
    this.version++;
    this.save();
  }
}

module.exports = { Advisor, parseBar, DEFAULTS, TF_MINUTES, MODEL_NAMES };
