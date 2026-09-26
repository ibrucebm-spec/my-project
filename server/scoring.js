// Ranking and risk filters for gold traders.
//
// The goal is to surface traders with *durable* returns, not the ones with the
// biggest short-term growth. Accounts that average down with growing lots
// (martingale) or stack many losing positions (grid) look great until a single
// strong gold move wipes them out, so they are flagged and pushed down.

const GOLD_RE = /XAU|GOLD/i;

function isGoldSymbol(symbol) {
  return typeof symbol === 'string' && GOLD_RE.test(symbol);
}

function isLosing(p) {
  if (typeof p.profit === 'number') return p.profit < 0;
  if (typeof p.currentPrice !== 'number') return false;
  return p.side === 'buy' ? p.currentPrice < p.openPrice : p.currentPrice > p.openPrice;
}

// Detects averaging-down patterns among open positions.
function detectRiskPatterns(positions) {
  const result = { martingale: false, grid: false, details: [] };
  for (const side of ['buy', 'sell']) {
    const same = positions
      .filter((p) => p.side === side)
      .sort((a, b) => new Date(a.openTime) - new Date(b.openTime));
    if (same.length < 2) continue;

    // Chain of entries each opened at a worse price than the previous one.
    let chain = 1;
    let lotIncreases = 0;
    let bestChain = 1;
    let bestLotIncreases = 0;
    for (let i = 1; i < same.length; i++) {
      const prev = same[i - 1];
      const cur = same[i];
      const worse = side === 'buy' ? cur.openPrice < prev.openPrice : cur.openPrice > prev.openPrice;
      if (worse && cur.lots >= prev.lots) {
        chain++;
        if (cur.lots >= prev.lots * 1.3) lotIncreases++;
      } else {
        chain = 1;
        lotIncreases = 0;
      }
      if (chain > bestChain) {
        bestChain = chain;
        bestLotIncreases = lotIncreases;
      }
    }
    if (bestChain >= 3 && bestLotIncreases >= 1) {
      result.martingale = true;
      result.details.push(`${side}: ${bestChain} dokładanych pozycji z rosnącym lotem`);
    }

    const losing = same.filter(isLosing).length;
    if (losing >= 5) {
      result.grid = true;
      result.details.push(`${side}: ${losing} stratnych pozycji otwartych naraz`);
    }
  }
  return result;
}

function annualizedGrowthPct(growthPct, ageWeeks) {
  const weeks = Math.max(4, ageWeeks || 0);
  const factor = 1 + (growthPct || 0) / 100;
  if (factor <= 0) return -100;
  return (Math.pow(factor, 52 / weeks) - 1) * 100;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Returns { score 0-100, qualifies, reasons[], risk, annualizedPct, slSharePct }
function scoreTrader(trader, filters) {
  const s = trader.stats || {};
  const positions = trader.positions || [];
  const reasons = [];

  const age = s.ageWeeks || 0;
  const dd = s.maxDrawdownPct;
  // Only annualize with at least a year of history; extrapolating a few good
  // months to a full year produces absurd, misleading numbers.
  const annualizedPct = age >= 52 ? annualizedGrowthPct(s.growthPct, age) : null;
  const risk = detectRiskPatterns(positions);
  // Patterns seen earlier stay flagged after the basket is closed.
  const memory = trader.riskMemory || {};
  risk.martingale = risk.martingale || !!memory.martingale;
  risk.grid = risk.grid || !!memory.grid;

  let slSharePct = s.slUsagePct;
  if (positions.length > 0) {
    slSharePct = (positions.filter((p) => p.sl && p.sl > 0).length / positions.length) * 100;
  }

  if (age < filters.minAgeWeeks) reasons.push(`konto za młode (${age} tyg. < ${filters.minAgeWeeks})`);
  if (typeof dd !== 'number') reasons.push('brak danych o drawdownie');
  else if (dd > filters.maxDrawdownPct) reasons.push(`drawdown ${dd.toFixed(1)}% > ${filters.maxDrawdownPct}%`);
  if ((s.growthPct || 0) <= 0) reasons.push('brak zysku');
  if (risk.martingale) reasons.push('wzorzec martingale');
  if (risk.grid) reasons.push('wzorzec grid');
  if (typeof s.winRatePct === 'number' && s.winRatePct >= 90) {
    reasons.push(`win rate ${s.winRatePct}% (typowe dla martingale/grid)`);
  }

  // Return relative to risk (Calmar-like): 5x annual return / max DD = full marks.
  // Younger accounts use their raw growth, never an extrapolated one.
  const calmar = (annualizedPct ?? (s.growthPct || 0)) / Math.max(1, dd || 100);
  const returnPts = clamp(calmar * 10, 0, 50);
  const agePts = clamp((age / 104) * 20, 0, 20);
  const pf = s.profitFactor;
  const pfPts = typeof pf === 'number' ? clamp((pf - 1) * 15, 0, 15) : 7;
  const slPts = typeof slSharePct === 'number' ? (slSharePct / 100) * 15 : 7;

  let score = returnPts + agePts + pfPts + slPts;
  if (risk.martingale) score *= 0.3;
  else if (risk.grid) score *= 0.5;
  else if (typeof s.winRatePct === 'number' && s.winRatePct >= 90) score *= 0.6;
  score = Math.round(clamp(score, 0, 100));

  if (score < filters.minScore && reasons.length === 0) reasons.push(`wynik ${score} < ${filters.minScore}`);

  return {
    score,
    qualifies: reasons.length === 0,
    reasons,
    risk,
    annualizedPct: annualizedPct === null ? null : Math.round(annualizedPct * 10) / 10,
    slSharePct: typeof slSharePct === 'number' ? Math.round(slSharePct) : null,
  };
}

module.exports = { isGoldSymbol, detectRiskPatterns, annualizedGrowthPct, scoreTrader };
