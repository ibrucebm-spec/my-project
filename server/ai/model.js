// Online-learning models. Every model learns one sample at a time, so it
// keeps learning as long as the market produces new candles, and serialises
// to plain JSON so it survives restarts.
//
// Online learners (gradient boosted trees live in gbdt.js):
//   - linear:  logistic regression, stable, learns simple relations fast,
//   - mlp:     neural network with one hidden layer (tanh), can learn
//              non-linear patterns such as "RSI extreme only in a strong trend".
// Both use plain SGD and predict with an exponential moving average of their
// weights (Polyak averaging). That smooths out the noise of single updates,
// which matters a lot for data as noisy as gold prices.

// Running mean/variance per feature (Welford), used to standardise inputs.
class Scaler {
  constructor(n, state) {
    this.n = state?.n ?? 0;
    this.mean = state?.mean ?? new Array(n).fill(0);
    this.m2 = state?.m2 ?? new Array(n).fill(0);
  }

  update(x) {
    this.n++;
    for (let i = 0; i < x.length; i++) {
      const d = x[i] - this.mean[i];
      this.mean[i] += d / this.n;
      this.m2[i] += d * (x[i] - this.mean[i]);
    }
  }

  transform(x) {
    return x.map((v, i) => {
      const sd = this.n > 1 ? Math.sqrt(this.m2[i] / (this.n - 1)) : 1;
      const z = sd > 1e-12 ? (v - this.mean[i]) / sd : 0;
      return Math.max(-5, Math.min(5, z));
    });
  }

  toJSON() {
    return { n: this.n, mean: this.mean, m2: this.m2 };
  }
}

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const logit = (p) => Math.log(Math.max(1e-9, p) / Math.max(1e-9, 1 - p));

// Deterministic PRNG so a fresh network always starts from the same weights.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Feature contributions for any model: how much the log-odds change when the
// feature is replaced by its average value (0 after standardisation).
function contributions(model, x) {
  const base = logit(model.predict(x));
  return x.map((v, i) => {
    if (v === 0) return 0;
    const x0 = x.slice();
    x0[i] = 0;
    return base - logit(model.predict(x0));
  });
}

class Linear {
  constructor(n, { lr = 0.002, l2 = 1e-4, avg = 0.995 } = {}, state) {
    Object.assign(this, { lr, l2, avg });
    this.w = state?.w ?? new Array(n).fill(0);
    this.b = state?.b ?? 0;
    this.aw = state?.aw ?? this.w.slice();
    this.ab = state?.ab ?? this.b;
    this.seen = state?.seen ?? 0;
  }

  z(x, w, b) {
    let z = b;
    for (let i = 0; i < x.length; i++) z += w[i] * x[i];
    return z;
  }

  predict(x) {
    return sigmoid(this.z(x, this.aw, this.ab));
  }

  learn(x, y) {
    const err = sigmoid(this.z(x, this.w, this.b)) - y;
    for (let i = 0; i < x.length; i++) {
      this.w[i] -= this.lr * (err * x[i] + this.l2 * this.w[i]);
      this.aw[i] = this.avg * this.aw[i] + (1 - this.avg) * this.w[i];
    }
    this.b -= this.lr * err;
    this.ab = this.avg * this.ab + (1 - this.avg) * this.b;
    this.seen++;
  }

  toJSON() {
    return { w: this.w, b: this.b, aw: this.aw, ab: this.ab, seen: this.seen };
  }
}

class MLP {
  constructor(n, { hidden = 16, lr = 0.003, l2 = 1e-4, avg = 0.995, seed = 42 } = {}, state) {
    Object.assign(this, { n, hidden, lr, l2, avg });
    if (state) {
      Object.assign(this, { W1: state.W1, b1: state.b1, W2: state.W2, b2: state.b2, A: state.A, seen: state.seen });
      return;
    }
    const r = rng(seed);
    const scale = 1 / Math.sqrt(n);
    this.W1 = Array.from({ length: hidden }, () => Array.from({ length: n }, () => (r() * 2 - 1) * scale));
    this.b1 = new Array(hidden).fill(0);
    this.W2 = Array.from({ length: hidden }, () => (r() * 2 - 1) * 0.1);
    this.b2 = 0;
    this.A = this.copyParams(); // averaged parameters used for prediction
    this.seen = 0;
  }

  copyParams() {
    return { W1: this.W1.map((row) => row.slice()), b1: this.b1.slice(), W2: this.W2.slice(), b2: this.b2 };
  }

  forward(x, P) {
    const h = new Array(this.hidden);
    let z = P.b2;
    for (let j = 0; j < this.hidden; j++) {
      let a = P.b1[j];
      const row = P.W1[j];
      for (let i = 0; i < x.length; i++) a += row[i] * x[i];
      h[j] = Math.tanh(a);
      z += P.W2[j] * h[j];
    }
    return { h, p: sigmoid(z) };
  }

  predict(x) {
    return this.forward(x, this.A).p;
  }

  learn(x, y) {
    const P = { W1: this.W1, b1: this.b1, W2: this.W2, b2: this.b2 };
    const { h, p } = this.forward(x, P);
    const err = p - y;
    const k = 1 - this.avg;
    for (let j = 0; j < this.hidden; j++) {
      const dh = err * this.W2[j] * (1 - h[j] * h[j]);
      this.W2[j] -= this.lr * (err * h[j] + this.l2 * this.W2[j]);
      this.A.W2[j] += k * (this.W2[j] - this.A.W2[j]);
      const row = this.W1[j];
      const arow = this.A.W1[j];
      for (let i = 0; i < x.length; i++) {
        row[i] -= this.lr * (dh * x[i] + this.l2 * row[i]);
        arow[i] += k * (row[i] - arow[i]);
      }
      this.b1[j] -= this.lr * dh;
      this.A.b1[j] += k * (this.b1[j] - this.A.b1[j]);
    }
    this.b2 -= this.lr * err;
    this.A.b2 += k * (this.b2 - this.A.b2);
    this.seen++;
  }

  toJSON() {
    return { W1: this.W1, b1: this.b1, W2: this.W2, b2: this.b2, A: this.A, seen: this.seen };
  }
}

// Averages the probabilities of several models (skipping untrained ones).
class Ensemble {
  constructor(members) {
    this.members = members;
  }

  predict(x) {
    let sum = 0;
    let n = 0;
    for (const m of this.members) {
      const p = m.predict(x);
      if (p === null) continue;
      sum += p;
      n++;
    }
    return n ? sum / n : null;
  }
}

module.exports = { Scaler, Linear, MLP, Ensemble, contributions, sigmoid, logit };
