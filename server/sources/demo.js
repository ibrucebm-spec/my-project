// Simulated gold traders so the dashboard can be tried without any account.
// Every trader is clearly marked as source "demo" in the UI.

const PROFILES = [
  { id: 'd1', name: 'AurumSwing', style: 'swing', stats: { growthPct: 184, maxDrawdownPct: 14.2, ageWeeks: 142, profitFactor: 1.9, winRatePct: 58 } },
  { id: 'd2', name: 'LondonGoldDesk', style: 'swing', stats: { growthPct: 96, maxDrawdownPct: 9.8, ageWeeks: 118, profitFactor: 1.7, winRatePct: 55 } },
  { id: 'd3', name: 'XAU_Breakout_Pro', style: 'scalp', stats: { growthPct: 312, maxDrawdownPct: 22.5, ageWeeks: 88, profitFactor: 1.6, winRatePct: 63 } },
  { id: 'd4', name: 'SteadyBullion', style: 'swing', stats: { growthPct: 61, maxDrawdownPct: 6.1, ageWeeks: 160, profitFactor: 2.1, winRatePct: 61 } },
  { id: 'd5', name: 'GoldRocket1000%', style: 'martingale', stats: { growthPct: 1040, maxDrawdownPct: 18.0, ageWeeks: 20, profitFactor: 3.4, winRatePct: 97 } },
  { id: 'd6', name: 'NeverLoseGold', style: 'grid', stats: { growthPct: 420, maxDrawdownPct: 12.0, ageWeeks: 40, profitFactor: 2.8, winRatePct: 99 } },
  { id: 'd7', name: 'AsiaSessionXAU', style: 'scalp', stats: { growthPct: 138, maxDrawdownPct: 17.3, ageWeeks: 64, profitFactor: 1.5, winRatePct: 57 } },
  { id: 'd8', name: 'HighRiskHero', style: 'swing', stats: { growthPct: 520, maxDrawdownPct: 58.0, ageWeeks: 52, profitFactor: 1.3, winRatePct: 49 } },
];

const PIP_VALUE_PER_LOT = 100; // 1 lot XAUUSD = 100 oz -> $100 per $1 move

function start(store) {
  let price = 5120 + Math.random() * 40;
  let drift = 0;
  let seq = 0;
  const book = new Map(PROFILES.map((p) => [p.id, []]));

  const round = (v) => Math.round(v * 100) / 100;
  const openPos = (profile, side, lots, withStops) => ({
    id: `${profile.id}-${++seq}`,
    symbol: 'XAUUSD',
    side,
    lots,
    openPrice: round(price),
    openTime: new Date().toISOString(),
    sl: withStops ? round(side === 'buy' ? price - 12 : price + 12) : 0,
    tp: withStops ? round(side === 'buy' ? price + 24 : price - 24) : 0,
  });

  function act(profile) {
    const pos = book.get(profile.id);
    const r = Math.random();
    const side = drift >= 0 ? 'buy' : 'sell';

    // Close positions that hit SL/TP.
    for (let i = pos.length - 1; i >= 0; i--) {
      const p = pos[i];
      const hitTp = p.tp && (p.side === 'buy' ? price >= p.tp : price <= p.tp);
      const hitSl = p.sl && (p.side === 'buy' ? price <= p.sl : price >= p.sl);
      if (hitTp || hitSl) pos.splice(i, 1);
    }

    switch (profile.style) {
      case 'swing':
        if (pos.length < 2 && r < 0.02) pos.push(openPos(profile, side, 0.5, true));
        else if (pos.length && r > 0.995) pos.shift();
        break;
      case 'scalp':
        if (pos.length < 1 && r < 0.05) pos.push(openPos(profile, Math.random() < 0.5 ? 'buy' : 'sell', 1, true));
        else if (pos.length && r > 0.96) pos.shift();
        break;
      case 'martingale': {
        const last = pos[pos.length - 1];
        if (!last && r < 0.05) pos.push(openPos(profile, side, 0.1, false));
        else if (last) {
          const against = last.side === 'buy' ? price < last.openPrice - 3 : price > last.openPrice + 3;
          if (against && pos.length < 7) pos.push({ ...openPos(profile, last.side, round(last.lots * 2), false) });
          const avg = pos.reduce((a, p) => a + p.openPrice * p.lots, 0) / pos.reduce((a, p) => a + p.lots, 0);
          const inProfit = last.side === 'buy' ? price > avg + 1 : price < avg - 1;
          if (inProfit) pos.length = 0;
        }
        break;
      }
      case 'grid': {
        const last = pos[pos.length - 1];
        if (!last && r < 0.05) pos.push(openPos(profile, side, 0.2, false));
        else if (last) {
          const against = last.side === 'buy' ? price < last.openPrice - 2 : price > last.openPrice + 2;
          if (against && pos.length < 10) pos.push(openPos(profile, last.side, 0.2, false));
          const first = pos[0];
          const back = first.side === 'buy' ? price > first.openPrice : price < first.openPrice;
          if (back) pos.length = 0;
        }
        break;
      }
    }

    store.upsertTrader({
      source: 'demo',
      id: profile.id,
      name: profile.name,
      stats: profile.stats,
      positions: pos.map((p) => ({
        ...p,
        currentPrice: round(price),
        profit: round((p.side === 'buy' ? price - p.openPrice : p.openPrice - price) * p.lots * PIP_VALUE_PER_LOT),
      })),
    });
  }

  const timer = setInterval(() => {
    drift = drift * 0.97 + (Math.random() - 0.5) * 0.4;
    price = Math.max(100, price + drift + (Math.random() - 0.5) * 1.2);
    store.setGoldPrice(round(price));
    PROFILES.forEach(act);
  }, 1000);

  console.log(`[demo] symulacja ${PROFILES.length} traderów XAUUSD`);
  return () => clearInterval(timer);
}

module.exports = { start };
