// Small statistics toolkit used by the model governance.

// Standard normal CDF (Abramowitz-Stegun 7.1.26, error < 1.5e-7).
function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Inverse standard normal CDF (Acklam's rational approximation, rel. error < 1.2e-9).
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// When K strategies are tested at once, the best of them looks good by luck
// far more often than a single one. Bonferroni correction: the t-stat a
// strategy must reach so that the chance of a lucky false positive across
// all K stays the same as for one strategy at `baseT`.
function adjustedThreshold(baseT, k) {
  if (k <= 1) return baseT;
  const alpha = 1 - normCdf(baseT);
  return normInv(1 - alpha / k);
}

// Performance summary of a list of trade results in R.
function tradeMetrics(rs) {
  let sum = 0;
  let win = 0;
  let loss = 0;
  let peak = 0;
  let eq = 0;
  let maxDd = 0;
  for (const r of rs) {
    sum += r;
    if (r > 0) win += r;
    else loss -= r;
    eq += r;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  const n = rs.length;
  const avg = n ? sum / n : null;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, r) => a + (r - avg) ** 2, 0) / (n - 1)) : null;
  return {
    n,
    totalR: sum,
    avgR: avg,
    profitFactor: loss > 0 ? win / loss : win > 0 ? Infinity : null,
    maxDrawdownR: maxDd,
    tstat: sd > 0 ? (avg / sd) * Math.sqrt(n) : null,
  };
}

module.exports = { normCdf, normInv, adjustedThreshold, tradeMetrics };
