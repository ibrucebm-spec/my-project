const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependencies). Existing env vars win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

module.exports = {
  port: num(process.env.PORT, 3000),
  sources: (process.env.DATA_SOURCES || 'mt5')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  ingestToken: process.env.INGEST_TOKEN || '',
  myfxbook: {
    email: process.env.MYFXBOOK_EMAIL || '',
    password: process.env.MYFXBOOK_PASSWORD || '',
    pollSeconds: Math.max(30, num(process.env.MYFXBOOK_POLL_SECONDS, 60)),
  },
  filters: {
    minAgeWeeks: num(process.env.MIN_AGE_WEEKS, 26),
    maxDrawdownPct: num(process.env.MAX_DRAWDOWN_PCT, 30),
    minScore: num(process.env.MIN_SCORE, 40),
  },
};
