const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependencies). Existing env vars win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  // Windows Notepad may save a UTF-8 BOM at the start of the file.
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

module.exports = {
  port: num(process.env.PORT, 3000),
  // Local machine only by default; set HOST=0.0.0.0 to expose on the network.
  host: process.env.HOST || '127.0.0.1',
  memoryFile: path.join(__dirname, '..', 'data', 'risk-memory.json'),
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
