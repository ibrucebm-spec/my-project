// AI analyst: answers questions about the desk in plain Polish, the way an
// analyst on a trading floor would brief a trader. It reads the live desk
// state (decision, strategies, regimes, results) and explains it. It never
// makes up prices and never overrides the desk's risk rules.
//
// Optional: needs ANTHROPIC_API_KEY in .env.

// The SDK is installed by start.bat (npm install). Without it the analyst is
// simply off; the rest of the desk works as before.
let Anthropic = null;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch {
  Anthropic = null;
}

const MODEL = 'claude-opus-5';

const SYSTEM = `Jesteś analitykiem na desku tradingowym złota (XAUUSD) w aplikacji XAU AI Desk. Rozmawiasz z traderem po polsku.

Dostajesz aktualny stan desku w formacie JSON: decyzję desku, laboratorium strategii (każda strategia ma własne modele uczenia maszynowego, wyniki handlu na papierze, t-stat i wyniki w podziale na reżimy rynku), wyniki desku (w R, czyli wielokrotnościach ryzyka), dane rynkowe, ustawienia ryzyka oraz transakcje samego tradera z oceną jego osobistego modelu (w jakich warunkach zarabia, a w jakich traci).

Zasady:
- Opieraj się wyłącznie na danych z JSON. Nie wymyślaj cen, wiadomości ani wydarzeń, których tam nie ma. Jeśli czegoś nie wiesz (np. kalendarza makro), powiedz to wprost.
- Wyjaśniaj prosto, jak doświadczony analityk początkującemu traderowi. Tłumacz pojęcia (R, t-stat, reżim, spread) przy pierwszym użyciu.
- Bądź uczciwy: jeśli desk nie ma udowodnionej przewagi, powiedz to jasno. Nie zachęcaj do łamania zasad desku (blokad ryzyka, limitu dziennego, wielkości pozycji).
- Nie składaj obietnic zysku. Decyzja należy do tradera.
- Odpowiadaj zwięźle: kilka krótkich akapitów albo punkty. Bez nagłówków markdown, bez tabel.`;

// The desk state is large; send what an analyst needs, rounded.
function briefState(state) {
  const lab = state.lab;
  const r = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v ?? null);
  const d = lab.decision;
  return {
    teraz: state.at,
    rynekOtwarty: state.marketOpen,
    cena: r(state.price),
    cenaNieaktualna: state.priceStale,
    spread: r(lab.live.spread),
    spreadMediana24h: r(lab.live.spreadMedian),
    zakladanyKosztUsd: lab.params.costUsd,
    konto: lab.live.account,
    ustawieniaRyzyka: { ryzykoProcent: lab.params.riskPct, dziennyLimitR: lab.params.dailyLossR },
    progDowodu: { tstat: r(lab.threshold.tstat), strategii: lab.threshold.strategies },
    decyzja: d && {
      akcja: d.action, dlaczego: d.why, strategia: d.strategyLabel, model: d.model,
      wejscie: r(d.entry), sl: r(d.sl), tp: r(d.tp), szansaTP: r(d.p), progOplacalnosci: r(d.breakeven),
      oczekiwanyWynikR: r(d.ev), pozycja: d.sizing, zablokowane: d.blocked, potwierdzenia: d.confirmations,
      czynniki: d.reasons?.map((x) => ({ cecha: x.label, wplyw: x.effect > 0 ? 'wspiera' : 'przeciw', sila: r(Math.abs(x.effect)) })),
      wygasla: d.expired, przesuniecieCenyR: r(d.drift), swieca: d.barTime,
    },
    otwartaPodpowiedz: lab.open,
    strategie: lab.strategies.map((s) => ({
      nazwa: s.label, status: s.status, wynikiNauki: s.learned,
      przewagaModeli: { kupno: r(s.models.long.skill[s.models.long.best], 4), sprzedaz: r(s.models.short.skill[s.models.short.best], 4), najlepszyModelKupno: s.models.long.best, najlepszyModelSprzedaz: s.models.short.best },
      papier: { transakcji: s.paper.n, sredniR: r(s.paper.avgR), tstat: r(s.paper.tstat), wymagane: r(s.paper.threshold) },
      obecnyRezim: s.hint?.regimeLabel,
      wynikiWRezimach: s.regimes.filter((x) => x.n).map((x) => ({ rezim: x.label, transakcji: x.n, sredniR: r(x.avgR) })),
      ostatniSygnal: s.hint && { akcja: s.hint.action, dlaczego: s.hint.why, czas: s.hint.barTime },
    })),
    wynikiDesku: {
      transakcji: lab.ledger.n, sredniR: r(lab.ledger.avgR), razemR: r(lab.ledger.totalR, 1),
      profitFactor: r(lab.ledger.profitFactor), maxObsuniecieR: r(lab.ledger.maxDrawdownR, 1),
      naZywo: { transakcji: lab.ledger.live.n, sredniR: r(lab.ledger.live.avgR), razemR: r(lab.ledger.live.totalR, 1) },
      ostatnie: lab.ledger.last.slice(0, 8).map((t) => ({ czas: t.t, strategia: t.label, kierunek: t.side, wynik: t.result, R: t.r, naZywo: t.live })),
    },
    dane: { swiece: lab.bars, ostatniaSwieca: lab.lastBarTime, rynkiPowiazane: lab.aux },
    transakcjeTradera: lab.journal && {
      waluta: lab.journal.currency, liczba: lab.journal.n, zyskowne: r(lab.journal.winRate), wynik: r(lab.journal.totalProfit),
      sredniZysk: r(lab.journal.avgWin), sredniaStrata: r(lab.journal.avgLoss), profitFactor: r(lab.journal.profitFactor),
      testModeluOsobistego: lab.journal.evaluation && {
        przetestowanych: lab.journal.evaluation.tested, przewagaNadPrzypadkiem: r(lab.journal.evaluation.skill, 3),
        pominieteSlabeTransakcje: lab.journal.evaluation.skippedCount, ichWynik: r(lab.journal.evaluation.skippedProfit),
      },
      coDecyduje: lab.journal.drivers.map((d) => ({ czynnik: d.label, wplyw: d.w > 0 ? 'pomaga' : 'szkodzi' })),
      gdzieZarabia: lab.journal.insights.best.map((g) => `${g.dim}: ${g.key} (${g.n} trans., średnio ${r(g.avgProfit)})`),
      gdzieTraci: lab.journal.insights.worst.map((g) => `${g.dim}: ${g.key} (${g.n} trans., średnio ${r(g.avgProfit)})`),
      otwartePozycje: lab.journal.open.map((p) => ({
        kierunek: p.side, loty: r(p.lots, 3), wejscie: p.entry, sl: p.sl, tp: p.tp, wynik: r(p.profit),
        szansaZyskuWgHistoriiTradera: r(p.pWin), desk: p.desk, szansaTPwgModeluDesku: r(p.deskP), rezim: p.regime, bezStopLossa: p.noStop,
      })),
      ostatnie: lab.journal.last.slice(0, 8),
    },
  };
}

function createAnalyst({ apiKey } = {}) {
  const enabled = !!apiKey && !!Anthropic;
  if (apiKey && !Anthropic) console.warn('[analityk] brak biblioteki @anthropic-ai/sdk: uruchom start.bat albo npm install');
  const client = enabled ? new Anthropic({ apiKey }) : null;

  // history: earlier turns of this conversation [{ role, content }], plain text.
  async function ask(question, state, history = []) {
    if (!enabled) throw new Error('Analityk AI jest wyłączony: dodaj ANTHROPIC_API_KEY do pliku .env (instrukcja w README).');
    const context = `Aktualny stan desku (JSON):\n${JSON.stringify(briefState(state))}`;
    const messages = [
      ...history.slice(-8).filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })),
      { role: 'user', content: `${context}\n\nPytanie tradera: ${question}` },
    ];
    if (messages[0].role !== 'user') messages.shift();
    try {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        output_config: { effort: 'medium' },
        // If the model declines, the API retries on a fallback model in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages,
      });
      if (response.stop_reason === 'refusal') return 'Analityk nie może odpowiedzieć na to pytanie. Spróbuj zapytać inaczej.';
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return text || 'Analityk nie zwrócił odpowiedzi. Spróbuj ponownie.';
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('Klucz ANTHROPIC_API_KEY jest nieprawidłowy.');
      if (err instanceof Anthropic.RateLimitError) throw new Error('Za dużo pytań naraz, spróbuj za chwilę.');
      if (err instanceof Anthropic.APIConnectionError) throw new Error('Brak połączenia z serwerem Claude. Sprawdź internet.');
      if (err instanceof Anthropic.APIError) throw new Error(`Błąd API Claude (${err.status}): ${err.message}`);
      throw err;
    }
  }

  return { enabled, ask };
}

module.exports = { createAnalyst, briefState, MODEL };
