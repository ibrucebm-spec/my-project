// Gradient boosted decision trees for binary classification (the same family
// of models as XGBoost / LightGBM, which dominate tabular prediction in the
// industry). Histogram-based: every feature is cut into quantile bins, so a
// full retrain on thousands of samples takes a fraction of a second.
//
// Unlike the online learners, trees are trained in batches: the strategy
// retrains them walk-forward on the most recent outcomes (e.g. every 500 new
// results on the last 6000), and always predicts with the latest model.

const { sigmoid, logit } = require('./model');

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DEFAULTS = {
  trees: 40,
  depth: 3,
  lr: 0.1, // shrinkage
  lambda: 5, // L2 on leaf values
  minHess: 8, // min sum of hessians in a leaf (~32 samples at p = 0.5)
  bins: 24,
  subsample: 0.8,
  colsample: 0.8,
  seed: 1,
};

class GBDT {
  constructor(opts = {}, state) {
    this.opts = { ...DEFAULTS, ...opts };
    this.base = state?.base ?? null; // null = not trained yet
    this.forest = state?.forest ?? [];
    this.fits = state?.fits ?? 0;
    this.trainedOn = state?.trainedOn ?? 0;
  }

  get trained() {
    return this.base !== null;
  }

  predict(x) {
    if (!this.trained) return null;
    let z = this.base;
    for (const tree of this.forest) {
      let node = tree;
      while (node.v === undefined) node = x[node.f] <= node.t ? node.l : node.r;
      z += this.opts.lr * node.v;
    }
    return sigmoid(z);
  }

  fit(X, y) {
    const n = X.length;
    if (!n) return;
    const d = X[0].length;
    const { trees, depth, lr, lambda, minHess, bins, subsample, colsample } = this.opts;
    const rand = rng(this.opts.seed * 7919 + this.fits);

    // Quantile bin edges per feature; bin(v) = first k with v <= edges[k].
    const edges = [];
    const B = new Uint8Array(n * d);
    const col = new Float64Array(n);
    for (let j = 0; j < d; j++) {
      for (let i = 0; i < n; i++) col[i] = X[i][j];
      const sorted = Float64Array.from(col).sort();
      const e = [];
      for (let q = 1; q < bins; q++) {
        const v = sorted[Math.floor((q * n) / bins)];
        if (!e.length || v > e[e.length - 1]) e.push(v);
      }
      if (e.length && e[e.length - 1] >= sorted[n - 1]) e.pop(); // no empty right side
      edges.push(e);
      for (let i = 0; i < n; i++) {
        let lo = 0;
        let hi = e.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (col[i] <= e[mid]) hi = mid;
          else lo = mid + 1;
        }
        B[i * d + j] = lo;
      }
    }

    const mean = y.reduce((a, b) => a + b, 0) / n;
    const base = logit(Math.min(0.99, Math.max(0.01, mean)));
    const F = new Float64Array(n).fill(base);
    const g = new Float64Array(n);
    const h = new Float64Array(n);
    const forest = [];
    const histG = new Float64Array(bins + 1);
    const histH = new Float64Array(bins + 1);

    const build = (rows, level, cols) => {
      let G = 0;
      let H = 0;
      for (const i of rows) {
        G += g[i];
        H += h[i];
      }
      const leaf = { v: -G / (H + lambda) };
      if (level >= depth || H < 2 * minHess) return leaf;
      const parentScore = (G * G) / (H + lambda);
      let best = null;
      for (const j of cols) {
        const nb = edges[j].length + 1;
        if (nb < 2) continue;
        histG.fill(0, 0, nb);
        histH.fill(0, 0, nb);
        for (const i of rows) {
          const b = B[i * d + j];
          histG[b] += g[i];
          histH[b] += h[i];
        }
        let gl = 0;
        let hl = 0;
        for (let b = 0; b < nb - 1; b++) {
          gl += histG[b];
          hl += histH[b];
          const hr = H - hl;
          if (hl < minHess || hr < minHess) continue;
          const gr = G - gl;
          const gain = (gl * gl) / (hl + lambda) + (gr * gr) / (hr + lambda) - parentScore;
          if (gain > 1e-6 && (!best || gain > best.gain)) best = { gain, j, b };
        }
      }
      if (!best) return leaf;
      const left = [];
      const right = [];
      for (const i of rows) (B[i * d + best.j] <= best.b ? left : right).push(i);
      return { f: best.j, t: edges[best.j][best.b], l: build(left, level + 1, cols), r: build(right, level + 1, cols) };
    };

    const all = Array.from({ length: n }, (_, i) => i);
    for (let t = 0; t < trees; t++) {
      for (let i = 0; i < n; i++) {
        const p = sigmoid(F[i]);
        g[i] = p - y[i];
        h[i] = Math.max(p * (1 - p), 1e-6);
      }
      const rows = subsample < 1 ? all.filter(() => rand() < subsample) : all;
      let cols = [];
      for (let j = 0; j < d; j++) if (rand() < colsample) cols.push(j);
      if (!cols.length) cols = [Math.floor(rand() * d)];
      const tree = build(rows, 0, cols);
      forest.push(tree);
      for (let i = 0; i < n; i++) {
        const x = X[i];
        let node = tree;
        while (node.v === undefined) node = x[node.f] <= node.t ? node.l : node.r;
        F[i] += lr * node.v;
      }
    }

    this.base = base;
    this.forest = forest;
    this.fits++;
    this.trainedOn = n;
  }

  toJSON() {
    return { base: this.base, forest: this.forest, fits: this.fits, trainedOn: this.trainedOn };
  }
}

module.exports = { GBDT };
