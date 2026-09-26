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
  const storage = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const onlyQualified = $('only-qualified');
  const sound = $('sound');
  onlyQualified.checked = storage.get('onlyQualified', true);
  sound.checked = storage.get('sound', false);
  onlyQualified.onchange = () => { storage.set('onlyQualified', onlyQualified.checked); render(); };
  sound.onchange = () => storage.set('sound', sound.checked);

  $('notify-btn').onclick = async () => {
    if (!('Notification' in window)) return alert('Ta przeglądarka nie obsługuje powiadomień.');
    const p = await Notification.requestPermission();
    $('notify-btn').textContent = p === 'granted' ? 'Powiadomienia włączone' : 'Powiadomienia zablokowane';
  };

  let state = null;
  let lastPrice = null;
  const seen = new Set();
  let firstRender = true;

  const visible = (t) => !onlyQualified.checked || t.rating.qualifies;

  function render() {
    if (!state) return;
    const traders = state.traders;

    // Price
    const priceEl = $('price');
    if (typeof state.goldPrice === 'number') {
      priceEl.textContent = fmt(state.goldPrice);
      priceEl.classList.toggle('up', lastPrice !== null && state.goldPrice > lastPrice);
      priceEl.classList.toggle('down', lastPrice !== null && state.goldPrice < lastPrice);
      lastPrice = state.goldPrice;
    }

    const f = state.filters;
    $('filters').textContent = `Filtry: konto ≥ ${f.minAgeWeeks} tyg., max DD ≤ ${f.maxDrawdownPct}%, wynik ≥ ${f.minScore}, bez martingale/grid`;
    $('market-banner').hidden = state.marketOpen !== false;

    // Positions
    const rows = [];
    for (const t of traders.filter(visible)) {
      for (const p of t.positions) rows.push({ t, p });
    }
    rows.sort((a, b) => new Date(b.p.openTime) - new Date(a.p.openTime));
    $('pos-count').textContent = rows.length;
    $('no-positions').hidden = rows.length > 0;
    $('positions').innerHTML = rows
      .map(({ t, p }) => {
        const key = `${t.key}|${p.id}`;
        const isNew = !firstRender && !seen.has(key);
        seen.add(key);
        return `<tr class="${isNew ? 'new' : ''}">
          <td>${esc(t.name)}<span class="src">${esc(t.source)}</span></td>
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
    firstRender = false;

    // Ranking
    // Rejected traders stay listed (dimmed, with reasons) so it is clear why they are hidden.
    $('ranking').innerHTML = traders
      .map((t) => {
        const r = t.rating;
        const s = t.stats;
        const name = t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)}</a>` : esc(t.name);
        return `<li class="trader ${r.qualifies ? '' : 'rejected'}">
          <div class="trader-head">
            <span class="trader-name">${name}<span class="src">${esc(t.source)}</span></span>
            <span class="score">${r.score}</span>
          </div>
          <div class="bar"><span style="width:${r.score}%"></span></div>
          <div class="stats">
            <span>Zysk <b>${fmt(s.growthPct, 0)}%</b></span>
            <span>Rocznie <b>${fmt(r.annualizedPct, 0)}%</b></span>
            <span>Max DD <b>${fmt(s.maxDrawdownPct, 1)}%</b></span>
            <span>Wiek <b>${s.ageWeeks ?? '–'} tyg.</b></span>
            <span>PF <b>${fmt(s.profitFactor, 2)}</b></span>
            <span>Pozycje <b>${t.positions.length}</b></span>
          </div>
          ${r.reasons.length ? `<div class="reasons">✕ ${r.reasons.map(esc).join(' · ')}</div>` : ''}
        </li>`;
      })
      .join('') || '<p class="empty">Brak podłączonych traderów. Ustaw Myfxbook w pliku .env albo podłącz MT5 (README).</p>';
  }

  function addFeed(kind, e) {
    const li = document.createElement('li');
    const p = e.position;
    const verb = kind === 'opened' ? 'otworzył' : 'zamknął';
    li.innerHTML = `<time>${new Date().toLocaleTimeString('pl-PL')}</time><b>${esc(e.trader.name)}</b> ${verb}
      <span class="${p.side}">${p.side === 'buy' ? 'KUPNO' : 'SPRZEDAŻ'}</span> ${fmt(p.lots)} lot @ ${fmt(p.openPrice)}
      ${kind === 'closed' && typeof p.profit === 'number' ? `<span class="${p.profit >= 0 ? 'pos' : 'neg'}">${money(p.profit)}</span>` : ''}`;
    const feed = $('feed');
    feed.prepend(li);
    while (feed.children.length > 100) feed.lastChild.remove();
  }

  function beep() {
    try {
      const ctx = new AudioContext();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.3);
    } catch {}
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

  function connect() {
    const es = new EventSource('/api/stream');
    es.addEventListener('open', () => { $('conn').className = 'dot ok'; $('conn-text').textContent = 'na żywo'; });
    es.addEventListener('error', () => { $('conn').className = 'dot err'; $('conn-text').textContent = 'rozłączono, ponawiam…'; });
    es.addEventListener('state', (m) => { state = JSON.parse(m.data); render(); });
    es.addEventListener('opened', (m) => onEvent('opened', JSON.parse(m.data)));
    es.addEventListener('closed', (m) => onEvent('closed', JSON.parse(m.data)));
  }

  connect();
})();
