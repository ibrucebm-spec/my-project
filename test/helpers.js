// Synthetic M15 gold-like candles. `momentum` is the autocorrelation of bar
// returns: 0 = pure random walk (nothing to learn), 0.3 = clear pattern.
function genBars(n, { momentum = 0, seed = 7, start = Date.parse('2024-01-01T00:00:00Z') } = {}) {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  let p = 2000;
  let prev = 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = momentum * prev + g() * 2;
    prev = r;
    const o = p;
    const c = p + r;
    out.push([start + i * 15 * 60_000, o, Math.max(o, c) + Math.abs(g()) * 0.8, Math.min(o, c) - Math.abs(g()) * 0.8, c, 100]);
    p = c;
  }
  return out;
}

module.exports = { genBars };
