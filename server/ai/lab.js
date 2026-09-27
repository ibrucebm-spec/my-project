// The strategy lab and the trading desk.
//
// Lab: from one stream of base candles (M15 from cTrader) it builds higher
// timeframes (H1, H4, ...) and runs several strategies side by side, each
// with its own models and its own honest track record (champion/challenger).
// Testing many strategies makes it easy to find one that "worked" by luck, so
// the paper-trading t-stat every strategy must reach is raised accordingly
// (Bonferroni correction).
//
// Desk: after every base candle it looks at the strategies that have proven
// an edge and just produced a signal, resolves conflicts (opposite signals =
// stay out), applies risk rules (position size from account balance and risk
// %, spread guard, daily loss limit) and keeps one position at a time, whose
// real outcome goes into the desk's track record.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { Strategy, TF_MINUTES } = require('./strategy');
const { adjustedThreshold, tradeMetrics } = require('./stats');
const { AUX_SLOTS } = require('./features');
const { isGoldMarketOpen } = require('../market');
const { Journal } = require('./journal');

const LAB_VERSION = 3;
const DAY_MS = 86_400_000;
const LEDGER_MAX = 5000;
const DEFAULT_STRATEGIES = 'M15:1:1.5:16,M15:1.5:3:32,H1:1:1.5:12,H1:1.5:3:24,H4:1:1.5:6,H4:1.5:3:12';
const DEFAULT_AUX = ['EURUSD', 'XAGUSD', 'USDJPY'];
const ACTION_WORD = { long: 'KUPNO', short: 'SPRZEDAŻ' };

const DEFAULTS = {
  baseTf: 'M15',
  strategies: DEFAULT_STRATEGIES,
  auxSymbols: DEFAULT_AUX,
  costUsd: 0.35,
  minEdge: 0.05,
  minSamples: 1000,
  minTstat: 1.5, // before the multiple-testing correction
  riskPct: 1, // % of balance risked per trade
  dailyLossR: 3, // stop giving hints for the day after losing this many R
  maxSpreadMult: 2, // no hints while the live spread is above this × costUsd
  maxBars: 30000,
  dir: null, // data directory; null = keep everything in memory only
  saveDelayMs: 20000,
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

// "M15:1:1.5:16,H1:1:1.5:12" -> [{ tf, slAtr, tpAtr, horizon }]
function parseStrategies(text) {
  return String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [tf, sl, tp, h] = s.split(':');
      return { tf: String(tf).toUpperCase(), slAtr: Number(sl), tpAtr: Number(tp), horizon: Math.round(Number(h)) };
    })
    .filter((s) => TF_MINUTES[s.tf] && s.slAtr > 0 && s.tpAtr > 0 && s.horizon > 0);
}

// Builds higher-timeframe candles (UTC-aligned buckets) from base candles.
class Aggregator {
  constructor(tfMs, baseMs) {
    this.tfMs = tfMs;
    this.baseMs = baseMs;
    this.cur = null;
  }

  // Returns the candles completed by this base bar. A bucket normally closes
  // with its last base bar; if the market stopped before that (Friday close),
  // it closes when the next bucket starts and is marked `late`.
  push(bar) {
    const bucket = Math.floor(bar.t / this.tfMs) * this.tfMs;
    const out = [];
    if (this.cur && this.cur.t !== bucket) {
      out.push({ bar: this.cur, late: true });
      this.cur = null;
    }
    const end = bar.t + this.baseMs;
    if (!this.cur) this.cur = { t: bucket, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, end };
    else {
      this.cur.h = Math.max(this.cur.h, bar.h);
      this.cur.l = Math.min(this.cur.l, bar.l);
      this.cur.c = bar.c;
      this.cur.v += bar.v;
      this.cur.end = end;
    }
    if (end >= bucket + this.tfMs) {
      out.push({ bar: this.cur, late: false });
      this.cur = null;
    }
    return out;
  }
}

const packBars = (bars) => bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]);
const unpackBars = (rows) => (rows || []).map(parseBar).filter(Boolean);

class Lab extends EventEmitter {
  constructor(opts = {}) {
    super();
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    this.opts = { ...DEFAULTS, ...given };
    const o = this.opts;
    this.baseTf = String(o.baseTf).toUpperCase();
    this.baseMs = (TF_MINUTES[this.baseTf] || 15) * 60_000;
    this.auxSymbols = (Array.isArray(o.auxSymbols) ? o.auxSymbols : String(o.auxSymbols).split(','))
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, AUX_SLOTS);

    const specs = (Array.isArray(o.strategies) ? o.strategies : parseStrategies(o.strategies)).filter((s) => {
      const ms = TF_MINUTES[s.tf] * 60_000;
      if (ms < this.baseMs || ms % this.baseMs) {
        console.warn(`[lab] strategia ${s.tf} pominięta: interwał musi być wielokrotnością ${this.baseTf}`);
        return false;
      }
      return true;
    });
    // Multiple-testing correction: more strategies = stricter proof required.
    this.threshold = adjustedThreshold(o.minTstat, specs.length);
    this.strategies = specs.map((spec) => new Strategy(spec, {
      costUsd: o.costUsd, minEdge: o.minEdge, minSamples: o.minSamples, minTstat: this.threshold, baseMs: this.baseMs,
      ...(o.strategyOpts || {}),
    }, this.auxSymbols));
    for (const s of this.strategies) s.on('trade', (t) => this.onDeskTrade(t, s));

    this.signature = JSON.stringify({ v: LAB_VERSION, base: this.baseTf, aux: this.auxSymbols });
    this.version = 0;
    this.saveTimer = null;
    this.resetData();
    this.load();
  }

  resetData() {
    this.base = [];
    this.aux = new Map(this.auxSymbols.map((s) => [s, []]));
    this.aggs = new Map();
    for (const s of this.strategies) {
      if (!this.aggs.has(s.spec.tf)) this.aggs.set(s.spec.tf, new Aggregator(TF_MINUTES[s.spec.tf] * 60_000, this.baseMs));
    }
    this.desk = { open: null, ledger: [], decision: null };
    this.live = { price: null, priceAt: 0, spread: null, spreadAt: 0, account: null, accountAt: 0 };
    this.spreads = []; // one sample per minute while the market is open, last 24 h
    this.journal = new Journal(this);
  }

  // The real cost of trading: the median spread over the last day, compared
  // with the cost the strategies assume (AI_COST_USD).
  sampleSpread(spread, now) {
    const last = this.spreads[this.spreads.length - 1];
    if (last && now - last[0] < 60_000) return;
    if (!isGoldMarketOpen(new Date(now))) return;
    this.spreads.push([now, spread]);
    while (this.spreads.length && now - this.spreads[0][0] > DAY_MS) this.spreads.shift();
  }

  spreadMedian() {
    if (this.spreads.length < 30) return null;
    const v = this.spreads.map((x) => x[1]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  }

  auxCtx() {
    return this.auxSymbols.map((s) => this.aux.get(s));
  }

  lastBaseTime() {
    return this.base.length ? this.base[this.base.length - 1].t : null;
  }

  auxSlot(name) {
    const n = String(name).toUpperCase();
    return this.auxSymbols.findIndex((s) => n === s || n.startsWith(s));
  }

  // Payload from the cTrader cBot / MT5 EA.
  ingest(body) {
    if (body.timeframe && String(body.timeframe).toUpperCase() !== this.baseTf) {
      throw new Error(`interwał ${body.timeframe} nie pasuje do AI_TIMEFRAME=${this.baseTf}`);
    }
    const now = Date.now();
    if (typeof body.price === 'number' && body.price > 0) {
      this.live.price = body.price;
      this.live.priceAt = now;
      this.version++;
    }
    if (typeof body.spread === 'number' && body.spread >= 0) {
      this.live.spread = body.spread;
      this.live.spreadAt = now;
      this.sampleSpread(body.spread, now);
    }
    const a = body.account;
    if (a && [a.balance, a.valuePerUnit, a.lotSize].every((v) => typeof v === 'number' && v > 0)) {
      this.live.account = {
        balance: a.balance,
        currency: String(a.currency || '').slice(0, 10),
        lotSize: a.lotSize,
        valuePerUnit: a.valuePerUnit,
        minUnits: a.minUnits > 0 ? a.minUnits : a.lotSize / 100,
        stepUnits: a.stepUnits > 0 ? a.stepUnits : a.lotSize / 100,
      };
      this.live.accountAt = now;
    }

    const last = {};
    let auxAccepted = 0;
    for (const [name, rows] of Object.entries(body.aux || {})) {
      const slot = this.auxSlot(name);
      if (slot < 0) continue;
      auxAccepted += this.addAux(this.auxSymbols[slot], rows);
      const series = this.aux.get(this.auxSymbols[slot]);
      last[name] = series.length ? series[series.length - 1].t : null;
    }

    // The trader's own gold trades (closed) and open positions, for the coach.
    let tradesAccepted = 0;
    if (Array.isArray(body.trades)) tradesAccepted = this.journal.addTrades(body.trades);
    if (Array.isArray(body.positions)) this.journal.setPositions(body.positions);

    const list = Array.isArray(body.bars) ? body.bars : [];
    const bars = list.map(parseBar).filter(Boolean).sort((x, y) => x.t - y.t);
    let accepted = 0;
    for (const bar of bars) {
      const lt = this.lastBaseTime();
      if (lt !== null && bar.t <= lt) continue;
      this.stepBase(bar);
      accepted++;
    }
    if (accepted || tradesAccepted) this.journal.refresh();
    if (accepted || auxAccepted || tradesAccepted || (this.journal.dirty && this.opts.dir)) {
      this.version++;
      this.scheduleSave();
    }
    last[body.symbol || 'XAUUSD'] = this.lastBaseTime();
    last.trades = this.journal.lastCloseTime();
    return { accepted, auxAccepted, tradesAccepted, ignored: bars.length - accepted, invalid: list.length - bars.length, last };
  }

  addAux(sym, rows) {
    const series = this.aux.get(sym);
    const bars = (Array.isArray(rows) ? rows : []).map(parseBar).filter(Boolean).sort((x, y) => x.t - y.t);
    let n = 0;
    for (const b of bars) {
      if (series.length && b.t <= series[series.length - 1].t) continue;
      series.push(b);
      n++;
    }
    if (series.length > this.opts.maxBars + 1000) series.splice(0, series.length - this.opts.maxBars);
    return n;
  }

  // Base bar -> higher-timeframe bars -> strategies -> desk decision.
  stepBase(bar) {
    bar.end = bar.t + this.baseMs;
    this.base.push(bar);
    if (this.base.length > this.opts.maxBars + 1000) this.base.splice(0, this.base.length - this.opts.maxBars);
    const aux = this.auxCtx();
    const live = Date.now() - bar.end < 2 * this.baseMs;
    for (const [tf, agg] of this.aggs) {
      for (const { bar: b, late } of agg.push(bar)) {
        for (const s of this.strategies) if (s.spec.tf === tf) s.onBar(b, { aux, late, live });
      }
    }
    this.decide(bar);
  }

  sizing(slDist) {
    const a = this.live.account;
    if (!a || !(slDist > 0)) return null;
    const riskMoney = (a.balance * this.opts.riskPct) / 100;
    const perUnit = slDist * a.valuePerUnit;
    let units = Math.floor(riskMoney / perUnit / a.stepUnits) * a.stepUnits;
    const minRiskPct = ((a.minUnits * perUnit) / a.balance) * 100;
    if (units < a.minUnits) {
      return {
        ok: false, currency: a.currency, minLots: a.minUnits / a.lotSize, minRiskPct,
        note: `Nawet minimalna pozycja (${+(a.minUnits / a.lotSize).toFixed(3)} lota) to ryzyko ${minRiskPct.toFixed(1)}% kapitału, więcej niż ustawione ${this.opts.riskPct}%.`,
      };
    }
    units = Math.round(units * 1e6) / 1e6;
    const risk = units * perUnit;
    return { ok: true, lots: units / a.lotSize, units, riskMoney: risk, riskPct: (risk / a.balance) * 100, currency: a.currency };
  }

  guards(bar) {
    const out = [];
    const live = Date.now() - bar.end < 2 * this.baseMs;
    const { spread, spreadAt } = this.live;
    const maxSpread = this.opts.maxSpreadMult * this.opts.costUsd;
    if (live && spread !== null && Date.now() - spreadAt < 60_000 && spread > maxSpread) {
      out.push(`spread ${spread.toFixed(2)} $ jest ponad ${this.opts.maxSpreadMult}× wyższy niż zakładany koszt (${this.opts.costUsd} $), np. przy newsach`);
    }
    const day = Math.floor(bar.t / DAY_MS);
    const todayR = this.desk.ledger.filter((t) => Math.floor(t.t / DAY_MS) === day).reduce((a, t) => a + t.r, 0);
    if (todayR <= -this.opts.dailyLossR) {
      out.push(`dzienny limit straty osiągnięty (${todayR.toFixed(1)} R, limit −${this.opts.dailyLossR} R), przerwa do jutra`);
    }
    return out;
  }

  waitReason() {
    const ready = this.strategies.filter((s) => s.stats.learned >= s.opts.minSamples);
    if (!ready.length) {
      const top = [...this.strategies].sort((a, b) => b.stats.learned - a.stats.learned)[0];
      return top ? `laboratorium uczy się (najdalej: ${top.label}, ${top.stats.learned} z ${top.opts.minSamples} wyników)` : 'brak strategii';
    }
    const proven = ready.filter((s) => s.isProven());
    if (!proven.length) {
      const ranked = ready.map((s) => ({ s, p: s.paperRecord() })).sort((a, b) => (b.p.tstat ?? -99) - (a.p.tstat ?? -99));
      const b = ranked[0];
      const t = b.p.tstat === null ? '–' : b.p.tstat.toFixed(2);
      return `żadna strategia nie udowodniła jeszcze przewagi (najlepsza: ${b.s.label}, t-stat ${t}, wymagane ${this.threshold.toFixed(2)})`;
    }
    return `strategie z udowodnioną przewagą (${proven.length}) nie widzą teraz okazji`;
  }

  decide(bar) {
    const fresh = this.strategies.filter((s) => s.hint && !s.hint.late && s.hint.barEnd === bar.end && s.hint.action !== 'wait');
    let decision;
    // A proven strategy that saw a signal but refused it (e.g. it loses in the
    // current market regime) is the most useful thing to tell the trader.
    const refused = this.strategies.find((s) => s.hint && s.hint.barEnd === bar.end && s.hint.refused);
    if (!fresh.length) {
      decision = { action: 'wait', why: refused ? `${refused.label}: ${refused.hint.why}` : this.waitReason() };
    } else if (new Set(fresh.map((s) => s.hint.action)).size > 1) {
      decision = {
        action: 'wait',
        why: `strategie się nie zgadzają (${fresh.map((s) => `${s.spec.tf}: ${ACTION_WORD[s.hint.action]}`).join(', ')}), lepiej nie wchodzić`,
      };
    } else {
      const ranked = fresh.sort((a, b) => (b.paperRecord().tstat ?? 0) - (a.paperRecord().tstat ?? 0));
      const primary = ranked[0];
      const h = primary.hint;
      const sign = h.action === 'long' ? 1 : -1;
      decision = {
        action: h.action,
        why: `${primary.label}: ${h.why}`,
        strategy: primary.id,
        strategyLabel: primary.label,
        model: h.modelLabel,
        entry: h.entry,
        sl: h.entry - sign * h.slDist,
        tp: h.entry + sign * h.tpDist,
        slDist: h.slDist,
        rr: h.rr,
        p: h.p,
        breakeven: h.breakeven,
        ev: h.ev,
        reasons: h.reasons,
        confirmations: ranked.slice(1).map((s) => s.label),
        paper: primary.paperRecord(),
      };
      const blocked = this.guards(bar);
      if (blocked.length) {
        decision.blocked = { action: decision.action, reasons: blocked };
        decision.action = 'wait';
        decision.why = `sygnał ${ACTION_WORD[h.action]} zablokowany przez zarządzanie ryzykiem`;
      } else if (!this.desk.open && primary.commitTrade()) {
        this.desk.open = {
          strategy: primary.id, label: primary.label, t: h.barTime, side: h.action, entry: h.entry, sl: decision.sl, tp: decision.tp,
          live: Date.now() - bar.end < 2 * this.baseMs, // false = found while learning on history
        };
        decision.committed = true;
      }
    }
    decision.barTime = bar.t;
    decision.validUntil = bar.end + this.baseMs;
    const prev = this.desk.decision;
    this.desk.decision = decision;
    const live = Date.now() - bar.end < 2 * this.baseMs;
    if (live && decision.action !== 'wait' && (decision.committed || prev?.action !== decision.action)) this.emit('signal', this.snapshotDecision());
  }

  onDeskTrade(t, s) {
    const open = this.desk.open && this.desk.open.strategy === t.strategy && this.desk.open.t === t.t ? this.desk.open : null;
    const trade = { ...t, label: s.label, live: !!open?.live };
    this.desk.ledger.push(trade);
    if (this.desk.ledger.length > LEDGER_MAX) this.desk.ledger.shift();
    if (open) this.desk.open = null;
    this.emit('trade', trade);
  }

  snapshotDecision() {
    const d = this.desk.decision;
    if (!d) return null;
    const now = Date.now();
    // How far the price has moved since the signal, in R. Chasing a move that
    // already happened changes the trade's odds, so the page warns about it.
    let drift = null;
    if (d.action !== 'wait' && this.live.price && now - this.live.priceAt < 60_000) {
      drift = ((d.action === 'long' ? 1 : -1) * (this.live.price - d.entry)) / d.slDist;
    }
    return {
      ...d,
      barTime: new Date(d.barTime).toISOString(),
      validUntil: new Date(d.validUntil).toISOString(),
      expired: now > d.validUntil,
      drift,
      sizing: d.slDist ? this.sizing(d.slDist) : null,
    };
  }

  snapshot() {
    const ledger = this.desk.ledger;
    const m = tradeMetrics(ledger.map((t) => t.r));
    const liveTrades = ledger.filter((t) => t.live);
    const lm = tradeMetrics(liveTrades.map((t) => t.r));
    let eq = 0;
    const equity = ledger.map((t) => (eq += t.r));
    const step = Math.max(1, Math.ceil(equity.length / 400));
    const last = this.lastBaseTime();
    return {
      baseTf: this.baseTf,
      tfMinutes: this.baseMs / 60_000,
      bars: this.base.length,
      lastBarTime: last ? new Date(last).toISOString() : null,
      lastClose: this.base.length ? this.base[this.base.length - 1].c : null,
      aux: this.auxSymbols.map((symbol) => {
        const s = this.aux.get(symbol);
        return { symbol, bars: s.length, lastBarTime: s.length ? new Date(s[s.length - 1].t).toISOString() : null };
      }),
      live: {
        spread: this.live.spread,
        spreadAt: this.live.spreadAt ? new Date(this.live.spreadAt).toISOString() : null,
        spreadMedian: this.spreadMedian(),
        spreadSamples: this.spreads.length,
        account: this.live.account && { balance: this.live.account.balance, currency: this.live.account.currency },
      },
      params: {
        costUsd: this.opts.costUsd, minEdge: this.opts.minEdge, riskPct: this.opts.riskPct,
        dailyLossR: this.opts.dailyLossR, maxSpreadMult: this.opts.maxSpreadMult, minSamples: this.opts.minSamples,
      },
      threshold: { tstat: this.threshold, base: this.opts.minTstat, strategies: this.strategies.length },
      decision: this.snapshotDecision(),
      open: this.desk.open && { ...this.desk.open, t: new Date(this.desk.open.t).toISOString() },
      strategies: this.strategies.map((s) => s.snapshot()),
      learned: Math.max(0, ...this.strategies.map((s) => s.stats.learned)),
      journal: this.journal.snapshot(),
      ledger: {
        ...m,
        wins: ledger.filter((t) => t.result === 'tp').length,
        losses: ledger.filter((t) => t.result === 'sl').length,
        timeouts: ledger.filter((t) => t.result === 'time').length,
        equity: equity.filter((_, i) => i % step === 0 || i === equity.length - 1),
        live: { ...lm, wins: liveTrades.filter((t) => t.result === 'tp').length },
        last: ledger.slice(-15).reverse().map((t) => ({ ...t, t: new Date(t.t).toISOString(), closedAt: new Date(t.closedAt).toISOString() })),
      },
    };
  }

  // ---- persistence -------------------------------------------------------

  labFile() {
    return path.join(this.opts.dir, 'lab.json');
  }

  strategyFile(s) {
    return path.join(this.opts.dir, 'strategies', `${s.id}.json`);
  }

  scheduleSave() {
    if (!this.opts.dir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, this.opts.saveDelayMs);
    this.saveTimer.unref?.();
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.opts.dir) return;
    const write = (file, data) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
      fs.renameSync(`${file}.tmp`, file);
    };
    try {
      for (const s of this.strategies) write(this.strategyFile(s), s.toState());
      write(this.labFile(), {
        signature: this.signature,
        base: packBars(this.base),
        aux: Object.fromEntries([...this.aux].map(([k, v]) => [k, packBars(v)])),
        desk: this.desk,
        account: this.live.account,
        spreads: this.spreads,
        journal: this.journal.toState(),
      });
      this.journal.dirty = false;
    } catch (err) {
      console.error('[lab] nie udało się zapisać stanu:', err.message);
    }
  }

  load() {
    if (!this.opts.dir || !fs.existsSync(this.labFile())) return;
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.labFile(), 'utf8'));
    } catch (err) {
      console.error('[lab] plik stanu jest uszkodzony, zaczynam od zera:', err.message);
      return;
    }
    if (state.signature !== this.signature) {
      console.log('[lab] nowa wersja AI albo zmienione rynki powiązane: zaczynam naukę od zera (cBot prześle historię ponownie)');
      return;
    }
    this.base = unpackBars(state.base).map((b) => ({ ...b, end: b.t + this.baseMs }));
    for (const [k, rows] of Object.entries(state.aux || {})) if (this.aux.has(k)) this.aux.set(k, unpackBars(rows));
    this.desk = { open: null, ledger: [], decision: null, ...state.desk };
    this.live.account = state.account || null;
    this.spreads = state.spreads || [];
    this.journal = new Journal(this, state.journal);

    const restored = new Set();
    for (const s of this.strategies) {
      try {
        const file = this.strategyFile(s);
        if (fs.existsSync(file) && s.fromState(JSON.parse(fs.readFileSync(file, 'utf8')))) restored.add(s);
      } catch (err) {
        console.error(`[lab] stan strategii ${s.label} uszkodzony: ${err.message}`);
      }
    }
    const fresh = this.strategies.filter((s) => !restored.has(s));
    if (fresh.length && this.base.length) {
      console.log(`[lab] nowe/zmienione strategie (${fresh.map((s) => s.label).join('; ')}) uczą się na ${this.base.length} zapisanych świecach`);
    }
    // Rebuild higher-timeframe bars; strategies without saved state learn from the history.
    const aux = this.auxCtx();
    for (const bar of this.base) {
      for (const [tf, agg] of this.aggs) {
        for (const { bar: b, late } of agg.push(bar)) {
          for (const s of this.strategies) {
            if (s.spec.tf !== tf) continue;
            if (restored.has(s)) s.pushBar(b);
            else s.onBar(b, { aux, late });
          }
        }
      }
    }
    this.version++;
  }
}

module.exports = { Lab, Aggregator, parseBar, parseStrategies, DEFAULT_STRATEGIES, DEFAULT_AUX };
