(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 2) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const pct = (n, d = 0) => (typeof n === 'number' && isFinite(n) ? `${fmt(n * 100, d)}%` : '–');
  const signed = (n, d = 2) => (typeof n === 'number' && isFinite(n) ? `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n), d)}` : '–');
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
  const STATUS = {
    learning: ['uczy się', 'st-learning'],
    'no-edge': ['brak przewagi', 'st-noedge'],
    proven: ['przewaga udowodniona', 'st-proven'],
  };
  const MODEL_SHORT = { linear: 'regresja', mlp: 'sieć neuronowa', gbdt: 'GBDT', ensemble: 'zespół' };
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
  if ('Notification' in window && Notification.permission === 'granted') $('notify-btn').textContent = 'Powiadomienia włączone';

  let state = null;
  let lastStateAt = 0;
  let lastPrice = null;

  function renderHeader(lab) {
    const el = $('price');
    const p = state.price;
    el.textContent = typeof p === 'number' ? fmt(p) : '–';
    el.classList.toggle('stale', !!state.priceStale);
    $('price-note').textContent = typeof p !== 'number' ? 'brak danych z cTradera' : state.priceStale ? `nieaktualna (${ago(state.priceAt)})` : '';
    if (typeof p === 'number' && p !== lastPrice) {
      el.classList.toggle('up', lastPrice !== null && p > lastPrice);
      el.classList.toggle('down', lastPrice !== null && p < lastPrice);
      lastPrice = p;
    }
    const sp = lab.live.spread;
    const wide = typeof sp === 'number' && sp > lab.params.maxSpreadMult * lab.params.costUsd;
    $('spread').textContent = typeof sp === 'number' ? `${fmt(sp)} $` : '–';
    $('spread').className = wide ? 'neg' : '';
    const acc = lab.live.account;
    $('balance').textContent = acc ? `${fmt(acc.balance)} ${acc.currency}` : '–';
  }

  function probRow(label, p, be) {
    const w = Math.max(0, Math.min(100, (p || 0) * 100));
    return `<div class="prob">
      <span class="prob-label">${label}</span>
      <div class="prob-bar"><span style="width:${w}%"></span><i style="left:${(be || 0) * 100}%" title="próg opłacalności"></i></div>
      <span class="prob-val">${pct(p)}</span>
    </div>`;
  }

  function renderDecision(lab) {
    const d = lab.decision;
    $('decision-time').textContent = d ? `po świecy ${lab.baseTf} z ${time(d.barTime)}` : '';
    if (!d) {
      $('decision').innerHTML = `<p class="empty">Czekam na dane z cTradera. Uruchom cBota <b>XauAiFeeder</b> na wykresie XAUUSD (README).</p>`;
      return;
    }
    const act = d.action;
    const parts = [`<div class="action ${act}">${ACTION[act]}</div>`, `<p class="why">${esc(d.why)}</p>`];
    if (act !== 'wait') {
      const z = d.sizing;
      const size = !z ? '<b>–</b><small>brak danych konta</small>'
        : z.ok ? `<b>${fmt(z.lots, z.lots < 0.1 ? 3 : 2)} lota</b><small>ryzyko ${fmt(z.riskMoney)} ${esc(z.currency)} (${fmt(z.riskPct, 1)}%)</small>`
          : `<b class="neg">za małe konto</b><small>${esc(z.note)}</small>`;
      parts.push(`<div class="levels">
        <div><span>Wejście</span><b>${fmt(d.entry)}</b></div>
        <div><span>Stop loss</span><b class="neg">${fmt(d.sl)}</b></div>
        <div><span>Take profit</span><b class="pos">${fmt(d.tp)}</b></div>
        <div><span>Wielkość pozycji</span>${size}</div>
        <div><span>Oczekiwany wynik</span><b>${signed(d.ev)} R</b><small>RR 1:${fmt(d.rr, 1)}</small></div>
      </div>`);
      if (d.expired) {
        parts.push('<div class="guard"><b>Podpowiedź wygasła.</b> Minęła więcej niż jedna świeca od sygnału; nie wchodź już po tej cenie.</div>');
      } else if (typeof d.drift === 'number' && Math.abs(d.drift) >= 0.3) {
        parts.push(`<div class="guard"><b>Cena odjechała o ${signed(d.drift, 1)} R od wejścia.</b> ${d.drift > 0 ? 'Ruch już się odbył; wejście teraz ma gorszy stosunek zysku do ryzyka.' : 'Cena idzie przeciw sygnałowi; wejście teraz jest bliżej stop lossa.'} Rozważ pominięcie.</div>`);
      }
      parts.push(`<div class="probs">${probRow('Szansa na TP', d.p, d.breakeven)}
        <div class="muted small">Pionowa kreska to próg opłacalności (${pct(d.breakeven)}) po uwzględnieniu spreadu. Podpowiedź ważna do ${time(d.validUntil)}, potem cena odjedzie od wejścia.</div></div>`);
      parts.push(`<div class="meta">Strategia: <b>${esc(d.strategyLabel)}</b> · model: ${esc(d.model)} · papier: ${d.paper.n} transakcji, ${signed(d.paper.avgR)} R, t-stat ${fmt(d.paper.tstat)}</div>`);
      if (d.confirmations?.length) parts.push(`<div class="meta">Potwierdzają: ${d.confirmations.map(esc).join('; ')}</div>`);
    }
    if (d.blocked) {
      parts.push(`<div class="guard"><b>Zablokowany sygnał ${ACTION[d.blocked.action]}:</b><ul>${d.blocked.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`);
    }
    if (d.reasons?.length) {
      parts.push(`<div class="reasons"><div class="muted small">Co najbardziej wpływa na ocenę AI:</div><ul>${d.reasons
        .map((r) => `<li><span class="${r.effect > 0 ? 'pos' : 'neg'}">${r.effect > 0 ? '▲ wspiera' : '▼ przeciw'}</span> ${esc(r.label)}</li>`)
        .join('')}</ul></div>`);
    }
    const o = lab.open;
    if (o && !d.committed) { // an earlier hint is still running
      parts.push(`<div class="open-note">Poprzednia podpowiedź desku jest w toku: <b class="${o.side === 'long' ? 'buy' : 'sell'}">${ACTION[o.side]}</b> od ${fmt(o.entry)} (SL ${fmt(o.sl)}, TP ${fmt(o.tp)}), ${esc(o.label)}.</div>`);
    }
    $('decision').innerHTML = parts.join('');
  }

  function renderLedger(lab) {
    const l = lab.ledger;
    if (!l.n) {
      $('ledger-tiles').innerHTML = '<p class="empty">Desk nie dał jeszcze żadnej podpowiedzi. To normalne: podpowiada dopiero, gdy któraś strategia udowodni przewagę.</p>';
      $('ledger-table').innerHTML = '';
      renderEquity([]);
      return;
    }
    const tile = (label, value, cls = '') => `<div class="tile"><span>${label}</span><b class="${cls}">${value}</b></div>`;
    const pf = l.profitFactor === null ? '–' : isFinite(l.profitFactor) ? fmt(l.profitFactor) : '∞';
    $('ledger-tiles').innerHTML = `<div class="tiles">
      ${tile('Transakcje', l.n.toLocaleString('pl-PL'))}
      ${tile('Trafione TP', pct(l.wins / l.n))}
      ${tile('Średnio', `${signed(l.avgR)} R`, l.avgR >= 0 ? 'pos' : 'neg')}
      ${tile('Razem', `${signed(l.totalR, 1)} R`, l.totalR >= 0 ? 'pos' : 'neg')}
      ${tile('Profit factor', pf)}
      ${tile('Max obsunięcie', `${fmt(l.maxDrawdownR, 1)} R`)}
    </div>
    <p class="muted small">${l.live.n
      ? `<b>Na żywo:</b> ${l.live.n} transakcji, TP ${pct(l.live.wins / l.live.n)}, średnio ${signed(l.live.avgR)} R, razem ${signed(l.live.totalR, 1)} R. Pozostałe ${l.n - l.live.n} to symulacja na historii (też na danych, których AI nie widziało).`
      : `Wszystkie ${l.n} transakcji to symulacja na historii (na danych, których AI nie widziało). Wyniki na żywo pojawią się tu osobno.`}</p>`;
    renderEquity(l.equity, l.n);
    $('ledger-table').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Wejście</th><th>Strategia</th><th>Kierunek</th><th>Cena</th><th>Wynik</th><th>R</th></tr></thead>
      <tbody>${l.last.map((x) => `<tr>
        <td>${time(x.t)}${x.live ? ' <span class="badge st-proven">na żywo</span>' : ''}</td><td>${esc(x.label.split(' · ')[0])}</td>
        <td class="${x.side === 'long' ? 'buy' : 'sell'}">${ACTION[x.side]}</td>
        <td>${fmt(x.entry)}</td><td>${RESULT[x.result]}</td>
        <td class="${x.r >= 0 ? 'pos' : 'neg'}">${signed(x.r)} R</td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  // Equity curve in R: one series, 2px line, 10% area wash to the zero line,
  // end value labelled, crosshair + tooltip on hover.
  let equityKey = '';
  let equityData = null;
  function renderEquity(points, n) {
    const box = $('equity');
    const key = `${points.length}:${points[points.length - 1]}:${box.clientWidth}`;
    if (key === equityKey) return;
    equityKey = key;
    if (points.length < 2) {
      box.innerHTML = '';
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const W = Math.max(280, box.clientWidth);
    const H = 180;
    const ys = [0, ...points];
    const endText = `${signed(ys[ys.length - 1], 1)} R`;
    const pad = { l: 44, r: 20 + endText.length * 7.5, t: 12, b: 22 };
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    if (hi - lo < 1) hi = lo + 1;
    const stepRaw = (hi - lo) / 4;
    const mag = 10 ** Math.floor(Math.log10(stepRaw));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= stepRaw);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const x = (i) => pad.l + (i / (ys.length - 1)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b);
    const ticks = [];
    for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);
    const line = ys.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const area = `${line}L${x(ys.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
    const last = ys[ys.length - 1];
    const perPoint = (n || points.length) / points.length;
    box.setAttribute('aria-label', `Krzywa wyniku desku: ${signed(last, 1)} R po ${n} transakcjach`);
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      ${ticks.map((v) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${signed(v, 0).replace('+0', '0').replace('−0', '0')}</text>`).join('')}
      <line class="zero" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/>
      <path class="eq-area" d="${area}"/>
      <path class="eq-line" d="${line}"/>
      <circle class="eq-dot" cx="${x(ys.length - 1)}" cy="${y(last)}" r="4"/>
      <text class="end-label" x="${x(ys.length - 1) + 8}" y="${y(last) + 4}">${endText}</text>
      <text class="axis" x="${pad.l}" y="${H - 4}">transakcja 1</text>
      <text class="axis" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${n}</text>
      <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
      <rect class="hit" x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}"/>
    </svg>`;
    equityData = { ys, x, y, perPoint, pad, W };
  }

  const tooltip = $('tooltip');
  $('equity').addEventListener('pointermove', (e) => {
    if (!equityData) return;
    const svg = $('equity').querySelector('svg');
    const rect = svg.getBoundingClientRect();
    const { ys, x, perPoint, pad, W } = equityData;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(ys.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (ys.length - 1))));
    const cross = svg.querySelector('.cross');
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    tooltip.hidden = false;
    tooltip.textContent = '';
    const v = document.createElement('b');
    v.textContent = `${signed(ys[i], 1)} R`;
    const lbl = document.createElement('span');
    lbl.textContent = i === 0 ? 'start' : `po transakcji ${Math.round(i * perPoint)}`;
    tooltip.append(v, lbl);
    tooltip.style.left = `${Math.min(window.innerWidth - 170, e.clientX + 12)}px`;
    tooltip.style.top = `${e.clientY + 12}px`;
  });
  $('equity').addEventListener('pointerleave', () => {
    tooltip.hidden = true;
    $('equity').querySelector('.cross')?.setAttribute('visibility', 'hidden');
  });
  window.addEventListener('resize', () => { equityKey = ''; if (state) renderLedger(state.lab); });

  function renderLab(lab) {
    const th = lab.threshold;
    const rows = lab.strategies.map((s) => {
      const [label, cls] = STATUS[s.status];
      const prog = Math.min(1, s.learned / s.minSamples);
      const skill = (dir) => {
        const m = s.models[dir];
        const v = m.skill[m.best];
        return `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v === null ? '–' : `${signed(v * 100, 1)}%`}</span> <small>${MODEL_SHORT[m.best]}</small>`;
      };
      const p = s.paper;
      const tOk = p.tstat !== null && p.tstat >= p.threshold;
      const h = s.hint;
      const lastSig = h && h.action !== 'wait' ? `<span class="${h.action === 'long' ? 'buy' : 'sell'}">${ACTION[h.action]}</span> (${time(h.barTime)})` : '–';
      const rr = h?.regimeRecord;
      const regime = h?.regimeLabel
        ? `${esc(h.regimeLabel)}${rr && rr.n ? ` <small>(${rr.n} trans., ${signed(rr.avgR)} R${rr.ok ? '' : ', <span class="neg">wyłączona</span>'})</small>` : ''}`
        : '–';
      return `<li class="strat">
        <div class="strat-head"><b>${esc(s.label)}</b><span class="badge ${cls}">${label}</span></div>
        ${s.ready ? '' : `<div class="bar"><span style="width:${prog * 100}%"></span></div>`}
        <div class="strat-grid">
          <span>Wyniki nauki</span><b>${s.learned.toLocaleString('pl-PL')}${s.ready ? '' : ` / ${s.minSamples}`}</b>
          <span>Przewaga nad zgadywaniem</span><b>K ${skill('long')} · S ${skill('short')}</b>
          <span>Papier (${p.n} trans.)</span><b>${signed(p.avgR)} R, t-stat <span class="${tOk ? 'pos' : ''}">${fmt(p.tstat)}</span> / ${fmt(p.threshold)}</b>
          <span>Reżim rynku teraz</span><b>${regime}</b>
          <span>Ostatni sygnał</span><b>${lastSig}</b>
        </div>
      </li>`;
    }).join('');
    $('lab').innerHTML = `<p class="muted small">Próg dowodu: t-stat ≥ ${fmt(th.tstat)} na transakcjach papierowych (bazowo ${fmt(th.base, 1)}, podniesiony, bo testujemy ${th.strategies} strategii naraz) i minimum 50 transakcji. K/S = kupno/sprzedaż, obok model, który przewiduje najlepiej.</p>
      <ul class="strats">${rows}</ul>`;
  }

  function renderData(lab) {
    const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
    const acc = lab.live.account;
    const aux = lab.aux.map((a) => kv(esc(a.symbol), a.bars ? `${a.bars.toLocaleString('pl-PL')} świec, ostatnia ${ago(a.lastBarTime)} temu` : '<span class="neg">brak danych</span>')).join('');
    $('data').innerHTML = [
      kv(`Świece XAUUSD ${lab.baseTf}`, lab.bars.toLocaleString('pl-PL')),
      kv('Ostatnia świeca', lab.lastBarTime ? `${time(lab.lastBarTime)} (${ago(lab.lastBarTime)} temu)` : '–'),
      aux,
      kv('Saldo konta', acc ? `${fmt(acc.balance)} ${esc(acc.currency)}` : 'brak (stary cBot?)'),
      kv('Ryzyko na transakcję', `${fmt(lab.params.riskPct, 1)}% salda`),
      kv('Zakładany spread', `${fmt(lab.params.costUsd)} $ (blokada powyżej ${fmt(lab.params.costUsd * lab.params.maxSpreadMult)} $)`),
      kv('Zmierzony spread (mediana 24 h)', lab.live.spreadMedian === null ? `zbieram dane (${lab.live.spreadSamples}/30 min)` : `${fmt(lab.live.spreadMedian)} $`),
      lab.live.spreadMedian !== null && lab.live.spreadMedian > lab.params.costUsd * 1.15
        ? `<div class="guard">Twój broker ma wyższy spread (${fmt(lab.live.spreadMedian)} $) niż zakłada AI (${fmt(lab.params.costUsd)} $), więc wyniki są zbyt optymistyczne. Wpisz w pliku .env <b>AI_COST_USD=${lab.live.spreadMedian.toFixed(2)}</b> i uruchom ponownie start.bat. AI przeliczy wszystko na zapisanej historii.</div>`
        : '',
      kv('Dzienny limit straty', `${lab.params.dailyLossR} R`),
    ].join('');
  }

  function renderJournal(j) {
    const box = $('journal');
    const money = (v) => (typeof v === 'number' ? `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))} ${esc(j.currency)}` : '–');
    if (!j.n && !j.open.length) {
      box.innerHTML = '<p class="empty">Brak Twoich transakcji na złocie. Trener zacznie się uczyć, gdy cBot prześle historię Twojego konta (cBot v2) albo gdy zamkniesz pierwsze pozycje.</p>';
      return;
    }
    const parts = [];
    for (const p of j.open) {
      const pw = typeof p.pWin === 'number'
        ? `W podobnych warunkach Twoje transakcje ${p.side === 'long' ? 'kupna' : 'sprzedaży'} kończyły się zyskiem w <b>${pct(p.pWin)}</b> przypadków.`
        : `Model osobisty potrzebuje ${j.minTrades} transakcji, żeby oceniać (teraz ${j.learnable}).`;
      parts.push(`<div class="coach ${p.side}">
        <div><b class="${p.side === 'long' ? 'buy' : 'sell'}">${ACTION[p.side]}</b> ${fmt(p.lots, p.lots < 0.1 ? 3 : 2)} lota od ${fmt(p.entry)} · <span class="${p.profit >= 0 ? 'pos' : 'neg'}">${money(p.profit)}</span></div>
        <div class="small">${pw} Desk AI: ${esc(p.desk)}${typeof p.deskP === 'number' ? `, szansa TP wg modelu ${pct(p.deskP)}` : ''}.${p.regime ? ` Rynek: ${esc(p.regime)}.` : ''}</div>
        ${p.noStop ? '<div class="small neg">Pozycja bez stop lossa: jedna świeca może zabrać dużą część konta.</div>' : ''}
      </div>`);
    }
    if (j.n) {
      const tile = (label, value, cls = '') => `<div class="tile"><span>${label}</span><b class="${cls}">${value}</b></div>`;
      parts.push(`<div class="tiles">
        ${tile('Twoje transakcje', j.n)}
        ${tile('Zyskowne', pct(j.winRate))}
        ${tile('Wynik', money(j.totalProfit), j.totalProfit >= 0 ? 'pos' : 'neg')}
        ${tile('Średni zysk / strata', `${money(j.avgWin)} / ${money(j.avgLoss)}`)}
        ${tile('Profit factor', fmt(j.profitFactor))}
      </div>`);
      const e = j.evaluation;
      if (!e) {
        parts.push(`<p class="muted small">Model osobisty uczy się: ${j.learnable} z ${j.minTrades + 10} transakcji z danymi rynku potrzebnych do uczciwego testu.</p>`);
      } else {
        const better = e.skippedCount && -e.skippedProfit > 0;
        parts.push(`<p class="small">Test na ${e.tested} Twoich transakcjach (każda oceniona modelem uczonym tylko na wcześniejszych): trener przewiduje Twoje wyniki <b class="${e.skill > 0 ? 'pos' : 'neg'}">${e.skill > 0 ? 'lepiej' : 'nie lepiej'}</b> niż przypadek (${signed(e.skill * 100, 1)}%).
          ${e.skippedCount ? `Gdybyś pomijał transakcje ocenione poniżej 40% (${e.skippedCount}), Twój wynik byłby ${better ? 'lepszy' : 'gorszy'} o ${fmt(Math.abs(e.skippedProfit))} ${esc(j.currency)}.` : ''}</p>`);
      }
      if (j.drivers.length) {
        parts.push(`<div class="reasons"><div class="muted small">Co najbardziej decyduje o Twoich wynikach:</div><ul>${j.drivers
          .map((d) => `<li><span class="${d.w > 0 ? 'pos' : 'neg'}">${d.w > 0 ? '▲ pomaga' : '▼ szkodzi'}</span> ${esc(d.label)}</li>`).join('')}</ul></div>`);
      }
      const ins = j.insights;
      const seg = (g) => `<li><b>${esc(g.dim)}: ${esc(g.key)}</b> · ${g.n} trans., zyskowne ${pct(g.winRate)}, średnio ${money(g.avgProfit)}</li>`;
      if (ins.best.length || ins.worst.length) {
        parts.push(`<div class="insights">
          ${ins.best.length ? `<div><div class="muted small">Tu zarabiasz:</div><ul class="pos-list">${ins.best.map(seg).join('')}</ul></div>` : ''}
          ${ins.worst.length ? `<div><div class="muted small">Tu tracisz:</div><ul class="neg-list">${ins.worst.map(seg).join('')}</ul></div>` : ''}
        </div>`);
      }
      parts.push(`<div class="table-wrap"><table>
        <thead><tr><th>Otwarcie</th><th>Kierunek</th><th>Wejście</th><th>Wyjście</th><th>Wynik</th><th>Sesja</th></tr></thead>
        <tbody>${j.last.map((t) => `<tr><td>${time(t.entryTime)}</td>
          <td class="${t.side === 'long' ? 'buy' : 'sell'}">${ACTION[t.side]}</td><td>${fmt(t.entry)}</td><td>${fmt(t.close)}</td>
          <td class="${t.profit >= 0 ? 'pos' : 'neg'}">${money(t.profit)}</td><td>${esc(t.session)}</td></tr>`).join('')}</tbody>
      </table></div>`);
    }
    box.innerHTML = parts.join('');
  }

  // ---- AI analyst chat ----
  const chat = [];
  function addChat(role, text) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.textContent = text;
    $('analyst-log').append(el);
    el.scrollIntoView({ block: 'nearest' });
    return el;
  }
  async function ask(question) {
    if (state && !state.analyst) {
      addChat('system', 'Analityk AI jest wyłączony. Utwórz klucz API na console.anthropic.com, kliknij dwukrotnie analityk.bat w folderze desku, wklej klucz i uruchom ponownie start.bat.');
      return;
    }
    addChat('user', question);
    const pending = addChat('assistant', 'Analizuję…');
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history: chat }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      pending.textContent = body.answer;
      chat.push({ role: 'user', content: question }, { role: 'assistant', content: body.answer });
    } catch (err) {
      pending.className = 'msg system';
      pending.textContent = err.message;
    }
  }
  $('analyst-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('analyst-input').value.trim();
    if (!q) return;
    $('analyst-input').value = '';
    ask(q);
  });
  for (const b of document.querySelectorAll('#analyst .chips button')) b.addEventListener('click', () => ask(b.dataset.q));

  function render() {
    if (!state) return;
    const lab = state.lab;
    renderHeader(lab);
    $('market-banner').hidden = state.marketOpen !== false;
    const barAge = lab.lastBarTime ? Date.now() - new Date(lab.lastBarTime) : Infinity;
    const staleBars = state.marketOpen && lab.bars > 0 && barAge > (lab.tfMinutes * 3 + 2) * 60_000;
    $('stale-banner').hidden = !staleBars;
    $('stale-banner').textContent = staleBars
      ? `Uwaga: od ${ago(lab.lastBarTime)} nie przyszła nowa świeca z cTradera. Decyzja może być nieaktualna. Sprawdź, czy cBot XauAiFeeder działa.`
      : '';
    document.body.classList.toggle('stale-hint', staleBars);
    renderDecision(lab);
    renderLedger(lab);
    renderLab(lab);
    renderData(lab);
    renderJournal(lab.journal);
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

  function onSignal(d) {
    if (sound.checked) beep();
    if ('Notification' in window && Notification.permission === 'granted') {
      const size = d.sizing?.ok ? `, ${fmt(d.sizing.lots, 2)} lota` : '';
      new Notification(`AI Desk: ${ACTION[d.action]} XAUUSD`, {
        body: `Wejście ${fmt(d.entry)}, SL ${fmt(d.sl)}, TP ${fmt(d.tp)}${size}. ${d.strategyLabel}`,
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
