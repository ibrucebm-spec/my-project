const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependencies). Existing env vars win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  // Windows Notepad may save a UTF-8 BOM at the start of the file.
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
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
const timeframe = (process.env.AI_TIMEFRAME || 'M15').toUpperCase();

module.exports = {
  port: num(process.env.PORT, 3000),
  // Local machine only by default; set HOST=0.0.0.0 to expose on the network.
  host: process.env.HOST || '127.0.0.1',
  ingestToken: process.env.INGEST_TOKEN || '',
  ai: {
    timeframe,
    horizon: num(process.env.AI_HORIZON_BARS, 16),
    slAtr: num(process.env.AI_SL_ATR, 1.0),
    tpAtr: num(process.env.AI_TP_ATR, 1.5),
    minEdge: num(process.env.AI_MIN_EDGE, 0.05),
    minTstat: num(process.env.AI_MIN_TSTAT, 1.5),
    minSamples: num(process.env.AI_MIN_SAMPLES, 1000),
    costUsd: num(process.env.AI_COST_USD, 0.35),
    file: path.join(__dirname, '..', 'data', `model-XAUUSD-${timeframe}.json`),
  },
};
