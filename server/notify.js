// Phone notifications through a Telegram bot (optional).
// Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env (npm run telegram helps).

const fmt = (n, d = 2) => (typeof n === 'number' && isFinite(n) ? n.toFixed(d).replace('.', ',') : '–');
const ACTION = { long: 'KUPNO', short: 'SPRZEDAŻ' };

function createNotifier({ token, chatId } = {}) {
  const enabled = !!(token && chatId);

  async function send(text) {
    if (!enabled) return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error(`[telegram] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.ok;
    } catch (err) {
      console.error('[telegram] nie udało się wysłać powiadomienia:', err.message);
      return false;
    }
  }

  const signalText = (d) => {
    const size = d.sizing?.ok ? `\nPozycja: ${fmt(d.sizing.lots, d.sizing.lots < 0.1 ? 3 : 2)} lota (ryzyko ${fmt(d.sizing.riskMoney)} ${d.sizing.currency})` : '';
    return `🤖 XAU AI Desk: ${ACTION[d.action]} XAUUSD\n`
      + `Wejście ${fmt(d.entry)} · SL ${fmt(d.sl)} · TP ${fmt(d.tp)}${size}\n`
      + `Szansa TP ${Math.round(d.p * 100)}% (próg ${Math.round(d.breakeven * 100)}%)\n`
      + `${d.strategyLabel}\nWażna do ${new Date(d.validUntil).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`;
  };

  const tradeText = (t) => `${t.r >= 0 ? '✅' : '❌'} Podpowiedź ${ACTION[t.side]} od ${fmt(t.entry)} zakończona: `
    + `${{ tp: 'take profit', sl: 'stop loss', time: 'koniec czasu' }[t.result]}, ${t.r >= 0 ? '+' : ''}${fmt(t.r)} R`;

  return { enabled, send, signalText, tradeText };
}

module.exports = { createNotifier };
