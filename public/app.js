(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 2) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const pct = (n, d = 0) => (typeof n === 'number' && isFinite(n) ? `${fmt(n * 100, d)}%` : '–');
  const signed = (n, d = 2) => (typeof n === 'number' && isFinite(n) ? `${n >= 0 ? '+' : ''}${fmt(n, d)}` : '–');
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 60) return `${Math.floor(s)} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h`;
    return `${Math.floor(s / 86400)} d`;
  };
  const time = (iso) => new Date(iso).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const ACTION = { long: 'KUPNO', short: 'SPRZEDAŻ', wait: 'CZEKAJ' };
  const RESULT = { tp: 'TP', sl: 'SL', time: 'czas' };
  const storage = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  let audio = null;
  const unlockAudio = () => {
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume();
    } catch {}
  };
  const sound = $('sound');
  sound.checked = storage.get('sound', false);
  sound.onchange = () => { storage.set('sound', sound.checked); if (sound.checked) unlockAudio(); };
  document.addEventListener('click', () => { if (sound.checked) unlockAudio(); }, { once: true });

  $('notify-btn').onclick = async () => {
    if (!('Notification' in window)) return alert('Ta przeglądarka nie obsługuje powiadomień.');
    const p = await Notification.requestPermission();
    $('notify-btn').textContent = p === 'granted' ? 'Powiadomienia włączone' : 'Powiadomienia zablokowane';
  };

  let state = null;
  let lastStateAt = 0;
  let lastPrice = null;

  function renderPrice() {
    const el = $('price');
    const p = state.price;
    el.textContent = typeof p === 'number' ? fmt(p) : '–';
    el.classList.toggle('stale', !!state.priceStale);
    $('price-note').textContent = typeof p !== 'number' ? 'brak danych z MT5' : state.priceStale ? `nieaktualna (${ago(state.priceAt)})` : '';
    if (typeof p === 'number' && p !== lastPrice) {
      el.classList.toggle('up', lastPrice !== null && p > lastPrice);
      el.classList.toggle('down', lastPrice !== null && p < lastPrice);
      lastPrice = p;
    }
  }

  function probRow(label, p, be) {
    const w = Math.max(0, Math.min(100, (p || 0) * 100));
    return `<div class="prob">
      <span class="prob-label">${label}</span>
      <div class="prob-bar"><span style="width:${w}%"></span><i style="left:${(be || 0) * 100}%" title="próg opłacalności"></i></div>
      <span class="prob-val">${pct(p)}</span>
    </div>`;
  }

  function renderHint(ai) {
    const h = ai.hint;
    $('hint-time').textContent = h ? `świeca ${ai.timeframe} z ${time(h.barTime)}` : '';
    if (!h) {
      $('hint').innerHTML = `<p class="empty">Czekam na dane z MT5. AI potrzebuje co najmniej 120 świec, żeby zacząć (teraz ${ai.bars}). Uruchom EA <b>XauAiFeeder</b> na wykresie XAUUSD (README).</p>`;
      return;
    }
    const act = h.action;
    const lv = act === 'wait' ? null : h[act];
    const levels = lv ? `<div class="levels">
        <div><span>Wejście</span><b>${fmt(h.entry)}</b></div>
        <div><span>Stop loss</span><b class="neg">${fmt(lv.sl)}</b></div>
        <div><span>Take profit</span><b class="pos">${fmt(lv.tp)}</b></div>
        <div><span>Ryzyko</span><b>${fmt(Math.abs(h.entry - lv.sl))} $/oz</b></div>
        <div><span>Oczekiwany wynik</span><b>${signed(act === 'long' ? h.evLong : h.evShort)} R</b></div>
      </div>` : '';
    const dirWord = h.direction === 'long' ? 'KUPNA' : 'SPRZEDAŻY';
    const reasons = h.reasons.length
      ? `<div class="reasons"><div class="muted small">Co najbardziej wpływa na ocenę ${dirWord} (${esc(h.modelLabel)}):</div><ul>${h.reasons
        .map((r) => `<li><span class="${r.effect > 0 ? 'pos' : 'neg'}">${r.effect > 0 ? '▲ wspiera' : '▼ przeciw'}</span> ${esc(r.label)}</li>`)
        .join('')}</ul></div>`
      : '';
    $('hint').innerHTML = `
      <div class="action ${act}">${ACTION[act]}</div>
      <p class="why">${esc(h.why)}</p>
      ${levels}
      <div class="probs">
        ${probRow('Szansa TP dla KUPNA', h.pLong, h.breakeven)}
        ${probRow('Szansa TP dla SPRZEDAŻY', h.pShort, h.breakeven)}
        <div class="muted small">Pionowa kreska to próg opłacalności (${pct(h.breakeven)}): poniżej niego transakcja statystycznie traci po uwzględnieniu spreadu.</div>
      </div>
      ${reasons}`;
  }

  function renderLearning(ai) {
    const prog = Math.min(1, ai.learned / ai.minSamples);
    const models = ['long', 'short'].map((dir) => {
      const m = ai.models[dir];
      return `<tr><td>${dir === 'long' ? 'KUPNO' : 'SPRZEDAŻ'}</td>${['linear', 'mlp', 'ensemble']
        .map((k) => `<td class="${m.best === k ? 'best' : ''} ${m.skill[k] > 0 ? 'pos' : m.skill[k] < 0 ? 'neg' : ''}">${m.skill[k] === null ? '–' : signed(m.skill[k] * 100, 1) + '%'}</td>`)
        .join('')}<td>${pct(m.baseRate)}</td></tr>`;
    }).join('');
    const pp = ai.paper;
    $('learning').innerHTML = `
      <div class="kv"><span>Świece w pamięci</span><b>${ai.bars.toLocaleString('pl-PL')}</b></div>
      <div class="kv"><span>Ostatnia świeca</span><b>${ai.lastBarTime ? `${time(ai.lastBarTime)} (${ago(ai.lastBarTime)} temu)` : '–'}</b></div>
      <div class="kv"><span>Wyniki, z których AI się nauczyło</span><b>${ai.learned.toLocaleString('pl-PL')}</b></div>
      <div class="bar"><span style="width:${prog * 100}%"></span></div>
      <div class="muted small">${ai.ready ? 'Model przeszedł okres nauki i może podpowiadać.' : `Okres nauki: ${ai.learned} / ${ai.minSamples}. Do tego czasu AI nie daje podpowiedzi.`}</div>
      <h3>Przewaga modeli nad zgadywaniem</h3>
      <div class="table-wrap"><table>
        <thead><tr><th></th><th>Regresja</th><th>Sieć neuronowa</th><th>Zespół</th><th>TP bazowo</th></tr></thead>
        <tbody>${models}</tbody>
      </table></div>
      <div class="muted small">Wartość &gt; 0% oznacza, że model przewiduje lepiej niż zgadywanie średniej, na ostatnich 1000 wynikach, których wcześniej nie widział. Pogrubiony: model aktualnie używany.</div>
      <h3>Handel na papierze</h3>
      <div class="kv"><span>Transakcje (ostatnie ${pp.n})</span><b>${signed(pp.avgR)} R średnio</b></div>
      <div class="kv"><span>Pewność statystyczna (t-stat)</span><b class="${pp.tstat >= ai.params.minTstat ? 'pos' : ''}">${fmt(pp.tstat)} / wymagane ${fmt(ai.params.minTstat, 1)}</b></div>`;
  }

  function renderRecord(ai) {
    const t = ai.trades;
    if (!t.n) {
      $('record').innerHTML = `<p class="empty">AI nie dało jeszcze żadnej podpowiedzi. To normalne: podpowiada dopiero po udowodnieniu przewagi.</p>`;
      return;
    }
    const rows = t.last.map((x) => `<tr>
        <td>${time(x.t)}</td><td class="${x.side === 'long' ? 'buy' : 'sell'}">${ACTION[x.side]}</td>
        <td>${fmt(x.entry)}</td><td>${RESULT[x.result]}</td><td class="${x.r >= 0 ? 'pos' : 'neg'}">${signed(x.r)} R</td></tr>`).join('');
    $('record').innerHTML = `
      <div class="tiles">
        <div class="tile"><span>Podpowiedzi</span><b>${t.n}</b></div>
        <div class="tile"><span>Trafione TP</span><b>${pct(t.wins / t.n)}</b></div>
        <div class="tile"><span>Średnio na transakcję</span><b class="${t.avgR >= 0 ? 'pos' : 'neg'}">${signed(t.avgR)} R</b></div>
        <div class="tile"><span>Razem</span><b class="${t.totalR >= 0 ? 'pos' : 'neg'}">${signed(t.totalR, 1)} R</b></div>
        <div class="tile"><span>Ostatnie ${t.recentN}</span><b class="${t.recentAvgR >= 0 ? 'pos' : 'neg'}">${signed(t.recentAvgR)} R</b></div>
      </div>
      <div class="muted small">R = wielokrotność ryzyka. +1,5 R to trafiony TP, −1 R to stop loss; spread jest już odjęty. ${t.open ? 'Jedna podpowiedź jest teraz w toku.' : ''}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Świeca</th><th>Kierunek</th><th>Wejście</th><th>Wynik</th><th>R</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  function render() {
    if (!state) return;
    const ai = state.ai;
    renderPrice();
    $('market-banner').hidden = state.marketOpen !== false;
    // New closed bars should arrive every timeframe; allow two missed bars.
    const barAge = ai.lastBarTime ? Date.now() - new Date(ai.lastBarTime) : Infinity;
    const staleBars = state.marketOpen && ai.bars > 0 && barAge > (ai.tfMinutes * 3 + 2) * 60_000;
    $('stale-banner').hidden = !staleBars;
    $('stale-banner').textContent = staleBars
      ? `Uwaga: od ${ago(ai.lastBarTime)} nie przyszła nowa świeca z MT5. Podpowiedź może być nieaktualna. Sprawdź, czy EA XauAiFeeder działa.`
      : '';
    document.body.classList.toggle('stale-hint', staleBars);
    renderHint(ai);
    renderLearning(ai);
    renderRecord(ai);
  }

  function beep() {
    if (!audio || audio.state !== 'running') return;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.4);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.4);
  }

  function onSignal(h) {
    if (sound.checked) beep();
    if ('Notification' in window && Notification.permission === 'granted') {
      const lv = h[h.action];
      new Notification(`AI: ${ACTION[h.action]} XAUUSD`, {
        body: `Wejście ${fmt(h.entry)}, SL ${fmt(lv.sl)}, TP ${fmt(lv.tp)}. ${h.why}`,
      });
    }
  }

  function setConn(cls, text) {
    $('conn').className = `dot ${cls}`;
    $('conn-text').textContent = text;
  }

  function connect() {
    const es = new EventSource('/api/stream');
    es.addEventListener('open', () => setConn('ok', 'połączono z serwerem'));
    es.addEventListener('error', () => setConn('err', 'serwer nie odpowiada, ponawiam…'));
    es.addEventListener('state', (m) => {
      state = JSON.parse(m.data);
      lastStateAt = Date.now();
      setConn('ok', 'połączono z serwerem');
      render();
    });
    es.addEventListener('signal', (m) => onSignal(JSON.parse(m.data)));
  }

  setInterval(() => {
    if (lastStateAt && Date.now() - lastStateAt > 15000) setConn('err', 'brak danych z serwera');
    render();
  }, 1000);

  connect();
})();
