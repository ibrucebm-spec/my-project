(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 2) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const money = (n) => (typeof n === 'number' ? `${n >= 0 ? '+' : ''}${fmt(n)} $` : '–');
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 60) return `${Math.floor(s)} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h`;
    return `${Math.floor(s / 86400)} d`;
  };
  const SOURCE_LABEL = { mt5: 'MT5 na żywo', myfxbook: 'Myfxbook API' };
  const storage = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // One AudioContext for the whole page: browsers cap how many can exist, and
  // it has to be unlocked by a user gesture (ticking the checkbox).
  let audio = null;
  const unlockAudio = () => {
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume();
    } catch {}
  };

  const onlyQualified = $('only-qualified');
  const sound = $('sound');
  onlyQualified.checked = storage.get('onlyQualified', true);
  sound.checked = storage.get('sound', false);
  onlyQualified.onchange = () => { storage.set('onlyQualified', onlyQualified.checked); render(); };
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
  const firstSeen = new Map(); // row key -> time first shown (for the highlight)
  let firstRender = true;

  const visible = (t) => !onlyQualified.checked || t.rating.qualifies;

  function renderPrice() {
    const priceEl = $('price');
    const p = state.goldPrice;
    priceEl.textContent = typeof p === 'number' ? fmt(p) : '–';
    priceEl.classList.toggle('stale', !!state.goldPriceStale);
    priceEl.title = state.goldPriceAt ? `Cena z MT5, aktualizacja ${ago(state.goldPriceAt)} temu` : 'Brak ceny: podłącz EA z MT5 na wykresie XAUUSD';
    $('price-note').textContent = typeof p !== 'number' ? 'brak źródła ceny' : state.goldPriceStale ? `nieaktualna (${ago(state.goldPriceAt)})` : '';
    if (typeof p === 'number' && p !== lastPrice) {
      priceEl.classList.toggle('up', lastPrice !== null && p > lastPrice);
      priceEl.classList.toggle('down', lastPrice !== null && p < lastPrice);
      lastPrice = p;
    }
  }

  function render() {
    if (!state) return;
    const traders = state.traders;
    const now = Date.now();
    renderPrice();

    const f = state.filters;
    $('filters').textContent = `Filtry: konto ≥ ${f.minAgeWeeks} tyg., max DD ≤ ${f.maxDrawdownPct}%, wynik ≥ ${f.minScore}, bez martingale/grid`;
    $('market-banner').hidden = state.marketOpen !== false;
    const staleCount = traders.filter((t) => t.stale).length;
    $('stale-banner').hidden = staleCount === 0;
    $('stale-banner').textContent = `Uwaga: ${staleCount} ${staleCount === 1 ? 'źródło nie przysyła' : 'źródła nie przysyłają'} danych. Ich pozycje są oznaczone jako nieaktualne i mogą już nie istnieć.`;

    // Positions
    const rows = [];
    for (const t of traders.filter(visible)) {
      for (const p of t.positions) rows.push({ t, p });
    }
    rows.sort((a, b) => new Date(b.p.openTime) - new Date(a.p.openTime));
    $('pos-count').textContent = rows.length;
    $('no-positions').hidden = rows.length > 0;
    const liveKeys = new Set();
    $('positions').innerHTML = rows
      .map(({ t, p }) => {
        const key = `${t.key}|${p.id}`;
        liveKeys.add(key);
        if (!firstSeen.has(key)) firstSeen.set(key, firstRender ? 0 : now);
        const isNew = now - firstSeen.get(key) < 3000;
        return `<tr class="${isNew ? 'new' : ''} ${t.stale ? 'stale-row' : ''}">
          <td>${esc(t.name)}${t.stale ? '<span class="badge warn">nieaktualne</span>' : ''}</td>
          <td class="${p.side}">${p.side === 'buy' ? 'KUPNO' : 'SPRZEDAŻ'}</td>
          <td>${fmt(p.lots)}</td>
          <td>${fmt(p.openPrice)}</td>
          <td class="${p.sl ? '' : 'nosl'}">${p.sl ? fmt(p.sl) : 'brak'}</td>
          <td>${p.tp ? fmt(p.tp) : '–'}</td>
          <td class="${p.profit >= 0 ? 'pos' : 'neg'}">${money(p.profit)}</td>
          <td>${ago(p.openTime)}</td>
        </tr>`;
      })
      .join('');
    for (const k of firstSeen.keys()) if (!liveKeys.has(k)) firstSeen.delete(k);
    firstRender = false;

    // Ranking. Rejected traders stay listed (dimmed, with reasons) so it is clear why they are hidden.
    $('ranking').innerHTML = traders
      .map((t) => {
        const r = t.rating;
        const s = t.stats;
        const name = t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)}</a>` : esc(t.name);
        const badges = [
          `<span class="src">${esc(SOURCE_LABEL[t.source] || t.source)}</span>`,
          t.accountType ? `<span class="src">${t.accountType === 'real' ? 'konto REAL' : t.accountType === 'demo' ? 'konto DEMO' : esc(t.accountType)}</span>` : '',
        ].join('');
        const notes = [
          t.stale ? `<div class="note warn">Brak danych od ${ago(t.lastSeenAt)}: źródło nie odpowiada.</div>` : `<div class="note">Aktualizacja ${ago(t.lastSeenAt)} temu</div>`,
          t.statsSource === 'manual' ? '<div class="note">Statystyki wpisane ręcznie w EA: sprawdź je na stronie sygnału.</div>' : '',
        ].join('');
        return `<li class="trader ${r.qualifies ? '' : 'rejected'} ${t.stale ? 'stale-row' : ''}">
          <div class="trader-head">
            <span class="trader-name">${name}</span>
            <span class="score">${r.score}</span>
          </div>
          <div class="badges">${badges}</div>
          <div class="bar"><span style="width:${r.score}%"></span></div>
          <div class="stats">
            <span>Zysk <b>${fmt(s.growthPct, 0)}%</b></span>
            <span title="Liczony tylko dla kont z co najmniej rokiem historii">Rocznie <b>${r.annualizedPct === null ? '< 1 rok' : `${fmt(r.annualizedPct, 0)}%`}</b></span>
            <span>Max DD <b>${typeof s.maxDrawdownPct === 'number' ? `${fmt(s.maxDrawdownPct, 1)}%` : '–'}</b></span>
            <span>Wiek <b>${s.ageWeeks ?? '–'} tyg.</b></span>
            <span>PF <b>${fmt(s.profitFactor, 2)}</b></span>
            <span>Pozycje <b>${t.positions.length}</b></span>
          </div>
          ${r.reasons.length ? `<div class="reasons">✕ ${r.reasons.map(esc).join(' · ')}</div>` : ''}
          ${notes}
        </li>`;
      })
      .join('') || '<p class="empty">Brak podłączonych traderów. Ustaw Myfxbook w pliku .env albo podłącz MT5 (README).</p>';
  }

  function addFeed(kind, e) {
    const li = document.createElement('li');
    const p = e.position;
    const verb = kind === 'opened' ? 'otworzył' : 'zamknął';
    const result = kind === 'closed' && typeof p.profit === 'number'
      ? ` <span class="${p.profit >= 0 ? 'pos' : 'neg'}" title="Ostatni znany wynik przed zamknięciem">≈ ${money(p.profit)}</span>`
      : '';
    li.innerHTML = `<time>${new Date().toLocaleTimeString('pl-PL')}</time><b>${esc(e.trader.name)}</b> ${verb}
      <span class="${p.side}">${p.side === 'buy' ? 'KUPNO' : 'SPRZEDAŻ'}</span> ${fmt(p.lots)} lot @ ${fmt(p.openPrice)}${result}`;
    const feed = $('feed');
    feed.prepend(li);
    while (feed.children.length > 100) feed.lastChild.remove();
  }

  function beep() {
    if (!audio || audio.state !== 'running') return;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.3);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.3);
  }

  function onEvent(kind, e) {
    if (onlyQualified.checked && !e.trader.rating.qualifies) return;
    addFeed(kind, e);
    if (kind !== 'opened') return;
    if (sound.checked) beep();
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      const p = e.position;
      new Notification(`${e.trader.name}: ${p.side === 'buy' ? 'KUPNO' : 'SPRZEDAŻ'} XAUUSD`, {
        body: `${p.lots} lot @ ${p.openPrice}${p.sl ? `, SL ${p.sl}` : ', bez SL'}${p.tp ? `, TP ${p.tp}` : ''}`,
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
    es.addEventListener('opened', (m) => onEvent('opened', JSON.parse(m.data)));
    es.addEventListener('closed', (m) => onEvent('closed', JSON.parse(m.data)));
  }

  // Refresh relative times locally; flag a silent server (it pushes at least every 5 s).
  setInterval(() => {
    if (lastStateAt && Date.now() - lastStateAt > 15000) setConn('err', 'brak danych z serwera');
    render();
  }, 1000);

  connect();
})();
