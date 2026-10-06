// Signal: request triage dashboard for account managers
(() => {
  const $ = id => document.getElementById(id);
  // ---------- settings & scoring ----------
  const DEFAULTS = { dailyHours: 6, ackHours: 2, bigArr: 50000, renewalDays: 90, effortMode: 'complexFirst',
    weights: { who: 1, effort: 1, value: 1, deadline: 1, account: 1 } };
  const FACTORS = [['who', 'Who asked', 2], ['effort', 'Effort', 3], ['value', 'Value', 3], ['deadline', 'Deadline', 3], ['account', 'Account (key, renewing or at risk)', 2]];
  const WHO = { client_happy: 1, client_unhappy: 2, internal_senior: 2, internal_peer: 0 };
  const VALUE = { revenue: 3, retention: 3, leadership: 2, colleague: 1 };
  const VALUE_LABEL = { revenue: 'Revenue generating', retention: 'Retention', leadership: 'Internal, for leadership', colleague: 'Internal, for a colleague' };
  const EFFORT_LABEL = { quick: 'quick', moderate: 'moderate', complex: 'complex' };
  const EST = { quick: 0.5, moderate: 2, complex: 6 };

  let docs = [], requests = [], clients = [], S = { ...DEFAULTS, weights: { ...DEFAULTS.weights } }, learning = { follows: 0, events: [] };
  let ready = false, col = null, sampleFn = null;
  let view = 'queue', filter = 'all';

  function derive() {
    requests = docs.filter(d => d.kind === 'request');
    clients = docs.filter(d => d.kind === 'client').sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const s = docs.find(d => d.id === 'settings') || {};
    S = { ...DEFAULTS, ...s, weights: { ...DEFAULTS.weights, ...(s.weights || {}) } };
    const l = docs.find(d => d.id === 'learning') || {};
    learning = { follows: l.follows || 0, events: Array.isArray(l.events) ? l.events : [] };
  }

  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const endOfDay = d => { const x = new Date(d); x.setHours(23, 59, 0, 0); return x; };
  const fridayEnd = d => { const x = new Date(d); x.setDate(x.getDate() + (5 - x.getDay() + 7) % 7); x.setHours(17, 0, 0, 0); return x; };
  const startOfWeek = d => { const x = startOfDay(d); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; };
  const dateOnly = s => new Date(s + 'T00:00');
  const daysUntil = (s, now) => Math.round((dateOnly(s) - startOfDay(now)) / 864e5);
  const clientOf = r => r.clientId ? clients.find(c => c.id === r.clientId) : null;
  const effortPts = c => S.effortMode === 'quickFirst' ? ({ quick: 3, moderate: 2, complex: 1 }[c] ?? 2) : ({ quick: 1, moderate: 2, complex: 3 }[c] ?? 2);
  function accountInfo(c, now) {
    if (!c) return { big: false, renewing: false, atRisk: false, days: null };
    const big = Number(c.arr) >= S.bigArr && Number(c.arr) > 0;
    const days = c.renewal ? daysUntil(c.renewal, now) : null;
    const atRisk = c.health !== null && c.health !== undefined && c.health !== '' && Number(c.health) < 50;
    return { big, renewing: days !== null && days >= 0 && days <= S.renewalDays, atRisk, days };
  }
  function deadlinePts(r, now) {
    if (r.source === 'client') return 3;
    if (!r.dueAt) return 1;
    const due = new Date(r.dueAt);
    if (due <= endOfDay(now)) return 3;
    if (due <= fridayEnd(now)) return 2;
    return 1;
  }
  function score(r, now = new Date()) {
    const a = accountInfo(clientOf(r), now);
    const p = {
      who: WHO[r.source === 'client' ? 'client_' + (r.mood || 'happy') : 'internal_' + (r.seniority || 'peer')] ?? 0,
      effort: effortPts(r.complexity), value: VALUE[r.value] ?? 1, deadline: deadlinePts(r, now),
      account: ((a.big || a.renewing) ? 1 : 0) + (a.atRisk ? 1 : 0),
    };
    let got = 0, max = 0;
    for (const [k, , m] of FACTORS) { got += p[k] * S.weights[k]; max += m * S.weights[k]; }
    const s = max ? Math.round(got / max * 100) / 10 : 0;
    return { p, s, got, a };
  }
  const band = s => s >= 7.5 ? 'b-hot' : s >= 5 ? 'b-warm' : 'b-cool';
  const meter = (s, lg) => { const on = Math.round(s); let h = ''; for (let i = 0; i < 10; i++) h += `<i class="${i < on ? 'on' : ''}" style="--i:${i}"></i>`; return `<span class="meter ${lg ? 'lg' : ''}" aria-hidden="true">${h}</span>`; };

  function computeDue(r) {
    if (r.customDue) return new Date(r.customDue + 'T' + (r.customTime || '17:00')).toISOString();
    const asked = new Date(r.requestedAt);
    if (r.source === 'client') return new Date(asked.getTime() + 48 * 3600e3).toISOString();
    if (r.urgency === 'today') { const five = new Date(asked); five.setHours(17, 0, 0, 0); return (asked < five ? five : endOfDay(asked)).toISOString(); }
    if (r.urgency === 'week') return fridayEnd(asked).toISOString();
    return null;
  }
  const followDue = (r, now) => r.status === 'waiting' && r.followUp && dateOnly(r.followUp) <= endOfDay(now);
  const inQueue = (r, now) => r.status === 'open' || !r.status || followDue(r, now);
  const est = r => followDue(r, new Date()) ? 0.25 : (Number(r.estimate) > 0 ? Number(r.estimate) : EST[r.complexity] ?? 2);
  const needsReply = (r, now) => r.source === 'client' && r.status !== 'done' && !r.ackAt && (now - new Date(r.requestedAt)) > S.ackHours * 3600e3;
  function ranked(now) {
    const dueVal = r => r.dueAt ? new Date(r.dueAt).getTime() : Infinity;
    return requests.filter(r => inQueue(r, now)).map(r => ({ r, sc: score(r, now) }))
      .sort((a, b) => (b.sc.got - a.sc.got) || ((dueVal(a.r) - dueVal(b.r)) || 0) || (new Date(a.r.requestedAt) - new Date(b.r.requestedAt)));
  }
  const isDueToday = (r, now) => followDue(r, now) || (r.dueAt && new Date(r.dueAt) <= endOfDay(now));
  function plan(now) {
    const q = ranked(now);
    const doneToday = requests.filter(r => r.status === 'done' && r.doneAt && new Date(r.doneAt) >= startOfDay(now)).reduce((t, r) => t + est(r), 0);
    const remaining = Math.max(S.dailyHours - doneToday, 0);
    const due = q.filter(x => isDueToday(x.r, now));
    const dueHours = due.reduce((t, x) => t + est(x.r), 0);
    const items = [...due]; let used = dueHours;
    for (const x of q) { if (items.includes(x)) continue; if (used + est(x.r) <= remaining) { items.push(x); used += est(x.r); } }
    return { items, used, remaining, doneToday, dueHours, over: dueHours > remaining };
  }

  // ---------- learning loop ----------
  function insights() {
    const ev = learning.events, n = ev.length, total = n + learning.follows;
    if (n < 5) return { total, n, list: [] };
    const out = [];
    for (const [k, label] of FACTORS) {
      let hi = 0, lo = 0;
      ev.forEach(e => { const d = (e.chosen?.[k] ?? 0) - (e.top?.[k] ?? 0); if (d > 0) hi++; else if (d < 0) lo++; });
      const H = hi / n, L = lo / n;
      if (k === 'effort') {
        const lowerEffortPicked = S.effortMode === 'complexFirst' ? L : H; // picked quicker tasks
        const biggerPicked = S.effortMode === 'complexFirst' ? H : L;
        if (lowerEffortPicked >= 0.6 && S.effortMode === 'complexFirst') out.push({ text: `You often finish quicker tasks before bigger, higher-ranked ones (${Math.round(lowerEffortPicked * 100)}% of the time). Switch so quick wins score higher?`, patch: { effortMode: 'quickFirst' } });
        else if (biggerPicked >= 0.6 && S.effortMode === 'quickFirst') out.push({ text: `You often pick bigger tasks over quick wins (${Math.round(biggerPicked * 100)}% of the time). Switch so bigger tasks score higher?`, patch: { effortMode: 'complexFirst' } });
        continue;
      }
      const w = S.weights[k];
      if (H >= 0.6 && w < 2) out.push({ text: `You tend to pick requests that score higher on ${label.toLowerCase()} than the top-ranked one (${Math.round(H * 100)}% of the time). Give it more weight (${w} to ${w + 0.25})?`, patch: { weights: { ...S.weights, [k]: w + 0.25 } } });
      else if (L >= 0.6 && w > 0) out.push({ text: `You often skip past requests that score high on ${label.toLowerCase()} (${Math.round(L * 100)}% of the time). Give it less weight (${w} to ${w - 0.25})?`, patch: { weights: { ...S.weights, [k]: w - 0.25 } } });
    }
    return { total, n, list: out.slice(0, 3) };
  }
  let lastInsights = [];

  // ---------- formatting ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDay = d => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtTime = d => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const fmtH = h => h < 1 ? `${Math.round(h * 60)}m` : `${+h.toFixed(2)}h`;
  const money = n => '£' + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });
  function fmtWhen(iso, now) {
    const d = new Date(iso); const y = new Date(now); y.setDate(y.getDate() - 1);
    if (sameDay(d, now)) return 'today ' + fmtTime(d);
    if (sameDay(d, y)) return 'yesterday ' + fmtTime(d);
    return fmtDay(d);
  }
  function fmtDue(r, now) {
    if (followDue(r, now)) return { text: 'Follow up today', cls: 'today' };
    if (!r.dueAt) return { text: 'No deadline', cls: '' };
    const d = new Date(r.dueAt), t = fmtTime(d), h = d.getHours();
    if (d < now) { const hrs = Math.round((now - d) / 3600e3); return { text: hrs < 24 ? `Overdue by ${Math.max(hrs, 1)}h (was ${t})` : `Overdue since ${fmtDay(d)}`, cls: 'overdue' }; }
    const tm = new Date(now); tm.setDate(tm.getDate() + 1);
    if (sameDay(d, now)) return { text: h >= 17 ? `Today by end of day (${t})` : `Today by ${t}`, cls: 'today' };
    if (sameDay(d, tm)) return { text: h < 12 ? `Tomorrow morning (${t})` : h < 17 ? `Tomorrow afternoon (${t})` : `Tomorrow by end of day (${t})`, cls: '' };
    return { text: `${fmtDay(d)} by ${t}`, cls: '' };
  }
  const clientName = r => clientOf(r)?.name || r.clientName || '';
  const healthBand = h => h >= 70 ? 'Healthy' : h >= 50 ? 'Watch' : 'At risk';
  const shortMoney = n => n >= 1e6 ? '£' + +(n / 1e6).toFixed(1) + 'm' : n >= 1000 ? '£' + Math.round(n / 1000) + 'k' : money(n);
  function accountText(r, short) {
    const c = clientOf(r); const name = clientName(r);
    if (!name) return r.source === 'client' ? 'No account linked' : 'Internal, no account';
    if (!c) return name;
    const bits = [name];
    if (c.arr) bits.push((short ? shortMoney(c.arr) : money(c.arr)) + ' ARR');
    if (c.health !== null && c.health !== undefined && c.health !== '') bits.push(`health ${c.health}/100 (${healthBand(Number(c.health))})`);
    return bits.join(', ');
  }
  function askedBy(r) {
    const who = [r.requester, r.role].filter(Boolean).join(', ');
    if (r.source === 'client') return (who || 'Unknown contact') + (clientName(r) ? ` at ${clientName(r)}` : '') + (r.mood === 'unhappy' ? ' (unhappy)' : '');
    return (who || 'A colleague') + (r.seniority === 'senior' ? ' (leadership)' : ' (colleague)');
  }
  function details(r, now) {
    return [
      ['Asked by', askedBy(r)],
      ['Effort', `About ${fmtH(est(r))} (${EFFORT_LABEL[r.complexity] || 'moderate'})`],
      ['Value', VALUE_LABEL[r.value] || 'Revenue generating'],
      ['Deadline', fmtDue(r, now).text],
      ['Account', accountText(r)],
    ];
  }
  const detailsText = (r, now) => details(r, now).map(([k, v]) => `${k}: ${v}`).join('\n');
  const factsHtml = (r, now) => `<dl class="facts">${details(r, now).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  function tags(r, now, sc) {
    let t = '';
    if (r.source === 'client') t += r.mood === 'unhappy' ? '<span class="tag hot">Unhappy client</span>' : '<span class="tag client">Client</span>';
    else t += r.seniority === 'senior' ? '<span class="tag">Leadership</span>' : '<span class="tag">Colleague</span>';
    if (needsReply(r, now)) t += '<span class="tag hot">Reply needed</span>';
    if (followDue(r, now)) t += '<span class="tag warm">Follow-up due</span>';
    const a = sc?.a;
    if (a?.renewing) t += `<span class="tag warm">Renews in ${a.days}d</span>`;
    else if (a?.big) t += '<span class="tag accent">Key account</span>';
    const c = clientOf(r);
    if (c && c.health !== null && c.health !== undefined && c.health !== '' && Number(c.health) < 50) t += '<span class="tag hot">At-risk account</span>';
    return t;
  }
  function whoText(r) {
    return [r.requester, r.role, clientName(r)].filter(Boolean).map(esc).join(', ');
  }
  const toLocalInput = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const isoDate = d => toLocalInput(d).slice(0, 10);
  const newId = p => (p || 'r') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- storage ----------
  const LS_KEY = 'triage-v2';
  function loadLocal() {
    try {
      const v2 = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (Array.isArray(v2)) return v2;
      const v1 = JSON.parse(localStorage.getItem('triage-requests-v1') || '[]');
      return v1.map(x => ({ ...x, kind: 'request' }));
    } catch { return []; }
  }
  const saveLocal = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(docs)); } catch {} };
  function dbError(e) {
    const c = e && e.code;
    if (c === 'quota_exceeded') toast('Storage is full. Delete some finished requests to free up space.');
    else if (c === 'invalid_argument') toast("You can't save changes on this page.");
    else toast("Couldn't save that change. Check your connection and try again.");
  }
  async function putDoc(d) {
    const { id, ...body } = d;
    if (col) { try { await col.doc(id).set(body); return true; } catch (e) { dbError(e); return false; } }
    const i = docs.findIndex(x => x.id === id);
    if (i >= 0) docs[i] = d; else docs.push(d);
    saveLocal(); derive(); render(); return true;
  }
  async function removeDoc(id) {
    if (col) { try { await col.doc(id).delete(); } catch (e) { dbError(e); } return; }
    docs = docs.filter(x => x.id !== id); saveLocal(); derive(); render();
  }
  async function saveSettings(patch) {
    const next = { ...S, ...patch }; await putDoc({ id: 'settings', kind: 'settings', ...next });
  }

  // ---------- actions ----------
  async function markDone(r) {
    const now = new Date(); const q = ranked(now); const idx = q.findIndex(x => x.r.id === r.id);
    await putDoc({ ...r, status: 'done', doneAt: now.toISOString() });
    if (idx >= 0 && q.length > 1) {
      const L = { id: 'learning', kind: 'learning', follows: learning.follows, events: [...learning.events] };
      if (idx === 0) L.follows++;
      else { L.events.push({ at: now.toISOString(), chosen: q[idx].sc.p, top: q[0].sc.p }); L.events = L.events.slice(-60); }
      await putDoc(L);
    }
    toast('Marked done');
  }
  async function acknowledge(r) { await putDoc({ ...r, ackAt: new Date().toISOString() }); toast('Marked as replied'); }

  // ---------- render ----------
  function filterTabs() {
    return `<div class="tabs" role="group" aria-label="Source">${[['all', 'All'], ['client', 'Clients'], ['internal', 'Internal']].map(([k, l]) => `<button data-filter="${k}" aria-pressed="${filter === k}">${l}</button>`).join('')}</div>`;
  }
  const pass = r => filter === 'all' || r.source === filter;

  function render() {
    const now = new Date();
    const q = ranked(now);
    const waiting = requests.filter(r => r.status === 'waiting' && !followDue(r, now));
    $('cWaiting').textContent = waiting.length ? waiting.length : '';
    if (ready) {
      const overdue = q.filter(({ r }) => r.dueAt && new Date(r.dueAt) < now).length;
      const today = q.filter(({ r }) => isDueToday(r, now) && !(r.dueAt && new Date(r.dueAt) < now)).length;
      const bits = [`${q.length} open`]; if (today) bits.push(`${today} due today`); if (overdue) bits.push(`${overdue} overdue`);
      $('sub').textContent = q.length ? bits.join(', ') : 'Your queue is clear';
    }
    const main = $('main');
    if (!ready) { main.innerHTML = '<p class="muted">Loading…</p>'; return; }
    if (view === 'queue') main.innerHTML = queueView(q, now);
    else if (view === 'waiting') main.innerHTML = waitingView(waiting, now);
    else if (view === 'done') main.innerHTML = doneView(now);
    else main.innerHTML = clientsView(now);
  }

  function queueView(q, now) {
    const late = q.filter(({ r }) => needsReply(r, now)).length + requests.filter(r => r.status === 'waiting' && !followDue(r, now) && needsReply(r, now)).length;
    const fups = q.filter(({ r }) => followDue(r, now)).length;
    const P = plan(now);
    let alerts = '';
    if (late) alerts += `<div class="alert hot"><b>${late} client${late > 1 ? 's' : ''}</b> waiting more than ${S.ackHours}h for a reply</div>`;
    if (P.over) alerts += `<div class="alert hot"><b>${fmtH(P.dueHours)}</b> of work due today, ${fmtH(P.remaining)} left in your day</div>`;
    if (fups) alerts += `<div class="alert warm"><b>${fups} follow-up${fups > 1 ? 's' : ''}</b> due today</div>`;
    let rows = '';
    q.forEach(({ r, sc }, i) => {
      if (!pass(r)) return;
      const due = fmtDue(r, now); const c = clientOf(r);
      const acct = c ? [c.arr ? shortMoney(c.arr) + ' ARR' : '', c.health != null && c.health !== '' ? `health ${c.health}/100 (${healthBand(Number(c.health))})` : ''].filter(Boolean).join(', ') : '';
      const who = r.requester || (r.source === 'client' ? 'Unknown contact' : 'A colleague');
      const whoSub = [r.role, r.source === 'client' ? clientName(r) : 'Internal'].filter(Boolean).join(', ');
      rows += `<tr>
        <td class="i first a"><div class="acts">${r.source === 'client' ? (r.ackAt ? `<button class="btn sm replied" disabled title="Replied ${esc(fmtWhen(r.ackAt, now))}">Replied</button>` : `<button class="btn sm" data-act="ack" data-id="${r.id}" title="I've replied to let them know I'm on it">Replied</button>`) : ''}${followDue(r, now) ? `<button class="btn sm" data-act="reopen" data-id="${r.id}">Back to queue</button>` : ''}<button class="btn sm" data-act="done" data-id="${r.id}">Done</button></div></td>
        <td class="i"><span class="rank">${i + 1}</span></td>
        <td class="i req"><button class="title-btn" data-act="edit" data-id="${r.id}">${esc(r.title)}</button><div class="tagrow">${tags(r, now, sc)}</div></td>
        <td class="i c-who">${esc(who)}<span class="l2">${esc(whoSub)}</span></td>
        <td class="i c-val">${esc(VALUE_LABEL[r.value] || '')}</td>
        <td class="i due-c ${due.cls}">${esc(due.text)}<span class="l2">asked ${esc(fmtWhen(r.requestedAt, now))}</span></td>
        <td class="i">About ${fmtH(est(r))}<span class="l2">${esc(EFFORT_LABEL[r.complexity] || 'moderate')}</span></td>
        <td class="i">${clientName(r) ? esc(clientName(r)) : '<span class="muted">None</span>'}${acct ? `<span class="l2">${esc(acct)}</span>` : ''}</td>
        <td class="i last"><div class="scorecell ${band(sc.s)}" title="${esc(detailsText(r, now))}">${meter(sc.s)}<b>${sc.s.toFixed(1)}</b><span class="sr">out of 10</span></div></td>
      </tr>`;
    });
    const pct = P.remaining ? Math.min(P.used / P.remaining * 100, 100) : 100;
    const planCard = `<div class="card">
      <h4>Today's plan</h4>
      <p class="muted" style="margin:0">${fmtH(P.used)} planned of ${fmtH(P.remaining)} left${P.doneToday ? `, ${fmtH(P.doneToday)} already done` : ''}</p>
      <div class="cap ${P.over ? 'over' : ''}"><span style="width:${pct}%"></span></div>
      ${P.items.length ? `<ol class="plan">${P.items.map(x => `<li><span>${esc(x.r.title)}</span><span>${fmtH(est(x.r))}</span></li>`).join('')}</ol>` : '<p class="muted" style="margin:0">Nothing planned yet.</p>'}
      ${P.over ? `<p class="warnline">You're over capacity. Use this to agree new deadlines before taking on more.</p>` : ''}
    </div>`;
    const I = insights(); lastInsights = I.list;
    const insightCard = `<div class="card">
      <h4>Scoring insights</h4>
      ${I.total ? `<p class="muted" style="margin:0">You followed the ranking ${learning.follows} of ${I.total} times.</p>` : '<p class="muted" style="margin:0">As you mark requests done, this tracks when you work out of order and suggests changes to the scoring.</p>'}
      ${I.total && I.n < 5 ? `<p class="muted" style="margin:6px 0 0">Suggestions appear after 5 out-of-order picks (${I.n} so far).</p>` : ''}
      ${I.n >= 5 && !I.list.length ? '<p class="muted" style="margin:6px 0 0">No clear pattern yet. The scoring matches how you work.</p>' : ''}
      ${I.list.map((s, i) => `<div class="sugg"><p>${esc(s.text)}</p><button class="btn sm" data-act="apply" data-i="${i}">Apply</button></div>`).join('')}
    </div>`;
    return `${alerts ? `<div class="alerts">${alerts}</div>` : ''}${hero(q[0], now)}
      <div class="cols"><section>
        <div class="sec-head"><h3>Ranked queue</h3>${filterTabs()}</div>
        <p class="scroll-hint">Scroll sideways to see every detail.</p>
        <div class="tablewrap" tabindex="0" role="region" aria-label="Ranked queue"><table class="qt">
          <thead><tr><th class="i first a"><span class="sr">Actions</span></th><th class="i">#</th><th class="i">Request</th><th class="i c-who">Asked by</th><th class="i c-val">Value</th><th class="i">Deadline</th><th class="i">Effort</th><th class="i">Account</th><th class="i last">Priority</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="9" class="i first last list-empty">No open requests here.</td></tr>'}</tbody>
        </table></div>
        <p class="foot-note">Priority is scored out of 10 from who asked, effort, value, deadline and account. Deadlines re-score as they get closer. Hover a score to see the full request details.</p>
      </section><aside>${planCard}${insightCard}</aside></div>`;
  }

  function hero(top, now) {
    if (!top) {
      const any = requests.length > 0;
      return `<section class="empty">
        <h2>${any ? 'Nothing open right now' : 'Nothing in your queue yet'}</h2>
        <p>${any ? 'New requests will be ranked here as they come in.' : 'Add the requests coming in from clients and your team, and the most important one will always sit here.'}${sampleFn ? ' You can also paste an email or Slack message and Claude will fill in the details.' : ''}</p>
        <div class="acts"><button class="btn primary" data-act="add">Add request</button>
        ${sampleFn ? '<button class="btn" data-act="paste">Paste a message</button>' : ''}
        ${any ? '' : '<button class="btn" data-act="examples">Add 3 examples</button>'}</div></section>`;
    }
    const { r, sc } = top; const due = fmtDue(r, now);
    return `<section class="next ${band(sc.s)}" aria-label="Highest priority request">
      <div>
        <p class="kicker">Do this next</p>
        <h2>${esc(r.title)}</h2>
        ${factsHtml(r, now)}
      </div>
      <div class="gauge">
        <div class="score-num">${sc.s.toFixed(1)}<small>/ 10</small></div>
        ${meter(sc.s, true)}
        <div class="hero-acts">
          <button class="btn on-hero ghost" data-act="edit" data-id="${r.id}">Edit</button>
          ${r.source === 'client' ? (r.ackAt ? `<button class="btn on-hero replied" disabled title="Replied ${esc(fmtWhen(r.ackAt, now))}">Replied</button>` : `<button class="btn on-hero ghost" data-act="ack" data-id="${r.id}">Mark replied</button>`) : ''}
          <button class="btn on-hero" data-act="done" data-id="${r.id}">Mark done</button>
        </div>
      </div></section>`;
  }

  function waitingView(list, now) {
    const rows = list.filter(pass).sort((a, b) => (a.followUp || '9').localeCompare(b.followUp || '9')).map(r => `<li class="row s">
      <div class="main"><button class="title-btn" data-act="edit" data-id="${r.id}">${esc(r.title)}</button>
        <div class="meta-s">${tags(r, now, score(r, now))}<span>${whoText(r)}</span>${r.waitingOn ? `<span>Waiting on ${esc(r.waitingOn)}</span>` : ''}</div></div>
      <div class="due"><span class="lbl">Follow up </span>${r.followUp ? 'Follow up ' + esc(fmtDay(dateOnly(r.followUp))) : 'No follow-up date'}</div>
      <div class="acts"><button class="btn sm" data-act="reopen" data-id="${r.id}">Back to queue</button><button class="btn sm" data-act="done" data-id="${r.id}">Done</button></div>
    </li>`).join('');
    return `<div class="sec-head"><h3>Waiting on someone</h3>${filterTabs()}</div>
      <ol class="list">${rows || '<li class="list-empty">Nothing blocked. When a request is stuck on someone else, set its status to "Waiting on someone" and it moves here until the follow-up date.</li>'}</ol>`;
  }

  function doneView(now) {
    const rows = requests.filter(r => r.status === 'done' && pass(r)).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).map(r => `<li class="row s done">
      <div class="main"><button class="title-btn" data-act="edit" data-id="${r.id}">${esc(r.title)}</button>
        <div class="meta-s">${tags(r, now)}<span>${whoText(r)}</span></div></div>
      <div class="due"><span class="lbl">Done </span>${r.doneAt ? 'Done ' + esc(fmtWhen(r.doneAt, now)) : ''}</div>
      <div class="acts"><button class="btn sm" data-act="reopen" data-id="${r.id}">Reopen</button></div>
    </li>`).join('');
    return `<div class="sec-head"><h3>Done</h3>${filterTabs()}</div>
      <ol class="list">${rows || '<li class="list-empty">Finished requests will show up here.</li>'}</ol>`;
  }

  function clientsView(now) {
    const rows = clients.map(c => {
      const a = accountInfo(c, now);
      const reqs = requests.filter(r => r.clientId === c.id);
      const open = reqs.filter(r => r.status !== 'done').length;
      let t = '';
      if (a.renewing) t += `<span class="tag warm">Renews in ${a.days}d</span>`;
      if (a.big) t += '<span class="tag accent">Key account</span>';
      if (c.health != null && c.health !== '') t += `<span class="tag ${c.health >= 70 ? '' : c.health >= 50 ? 'warm' : 'hot'}">Health ${c.health}/100, ${healthBand(Number(c.health))}</span>`;
      if (!c.arr && !c.renewal && c.health == null) t += '<span class="tag">Add ARR, renewal and health</span>';
      return `<li class="row s">
        <div class="main"><button class="title-btn" data-act="client" data-id="${c.id}">${esc(c.name)}</button>
          <div class="meta-s">${t}${c.arr ? `<span>${money(c.arr)} ARR</span>` : ''}${c.renewal ? `<span>renews ${esc(fmtDay(dateOnly(c.renewal)))}</span>` : ''}</div></div>
        <div class="due">${open} open, ${reqs.length - open} done</div>
        <div class="acts"><button class="btn sm" data-act="client" data-id="${c.id}">Open</button></div>
      </li>`;
    }).join('');
    return `<div class="sec-head"><h3>Clients</h3><button class="btn sm" data-act="newclient">Add client</button></div>
      <ol class="list">${rows || '<li class="list-empty">Add your accounts with their ARR, renewal dates and health scores, so requests from key and renewing accounts rank higher.</li>'}</ol>
      <p class="foot-note">Requests rank higher when the account has ARR of ${money(S.bigArr)} or more, renews within ${S.renewalDays} days, or has a health score under 50 (at risk). An at-risk key account gets the biggest boost. Change the thresholds in Settings.</p>`;
  }

  // ---------- request dialog ----------
  const dlg = $('dlg');
  let editingId = null, valueTouched = false, estTouched = false;
  const radio = (root, name) => (root.querySelector(`input[name="${name}"]:checked`) || {}).value || null;
  const setRadio = (root, name, v) => root.querySelectorAll(`input[name="${name}"]`).forEach(i => { i.checked = i.value === v; });
  function syncGroups() {
    const client = radio(dlg, 'source') === 'client';
    $('gMood').hidden = !client; $('clientNote').hidden = !client; $('gAck').hidden = !client;
    $('clientLbl').textContent = client ? 'Client account' : 'Related account (optional)';
    $('gSeniority').hidden = client; $('gUrgency').hidden = client;
    $('whoLbl').textContent = client ? 'Contact name' : 'Requested by';
    $('gWaiting').hidden = radio(dlg, 'status') !== 'waiting';
  }
  function autoFill() {
    if (!valueTouched) { const src = radio(dlg, 'source'); setRadio(dlg, 'value', src === 'client' ? 'revenue' : radio(dlg, 'seniority') === 'senior' ? 'leadership' : 'colleague'); }
    if (!estTouched) $('fEst').value = EST[radio(dlg, 'complexity') || 'moderate'];
  }
  function readForm() {
    const source = radio(dlg, 'source') || 'client';
    const cname = $('fClient').value.trim();
    const c = cname ? clients.find(x => x.name.toLowerCase() === cname.toLowerCase()) : null;
    const r = {
      title: $('fTitle').value.trim(), details: $('fDetails').value.trim(), requester: $('fWho').value.trim(), role: $('fRole').value.trim(),
      source, clientId: c ? c.id : null, clientName: c ? c.name : (cname || null),
      mood: source === 'client' ? (radio(dlg, 'mood') || 'happy') : null,
      seniority: source === 'internal' ? (radio(dlg, 'seniority') || 'peer') : null,
      complexity: radio(dlg, 'complexity') || 'moderate', estimate: Number($('fEst').value) > 0 ? Number($('fEst').value) : null,
      value: radio(dlg, 'value') || 'revenue', urgency: source === 'internal' ? (radio(dlg, 'urgency') || 'week') : null,
      customDue: $('fDue').value || null, customTime: $('fDueTime').value || '17:00',
      requestedAt: ($('fAsked').value ? new Date($('fAsked').value) : new Date()).toISOString(),
      status: radio(dlg, 'status') || 'open',
      waitingOn: $('fWaitOn').value.trim(), followUp: $('fFollow').value || null,
    };
    r.dueAt = computeDue(r);
    return r;
  }
  function updatePreview() {
    const r = readForm(); const sc = score(r);
    $('preview').className = 'preview ' + band(sc.s);
    const extra = r.clientName && !r.clientId ? `<span class="pv-parts">New account: add ${esc(r.clientName)}'s ARR, renewal date and health score in Clients.</span>` : '';
    $('preview').innerHTML = `<span class="pv-score">${sc.s.toFixed(1)}<small> / 10</small></span>${meter(sc.s)}${factsHtml(r, new Date())}${extra}`;
  }
  let ackWas = null, doneWas = null;
  function openDialog(r) {
    editingId = r && r.id ? r.id : null;
    $('dlgTitle').textContent = editingId ? 'Edit request' : 'Add request';
    $('delBtn').hidden = !editingId; $('titleErr').hidden = true;
    $('fTitle').value = r?.title || ''; $('fDetails').value = r?.details || ''; $('fWho').value = r?.requester || ''; $('fRole').value = r?.role || '';
    $('fClient').value = r ? (clientName(r) || '') : '';
    $('clientList').innerHTML = clients.map(c => `<option value="${esc(c.name)}">`).join('');
    $('fAsked').value = toLocalInput(r?.requestedAt ? new Date(r.requestedAt) : new Date());
    $('fDue').value = r?.customDue || ''; $('fDueTime').value = r?.customTime || '17:00';
    setRadio(dlg, 'source', r?.source || 'client'); setRadio(dlg, 'mood', r?.mood || 'happy');
    setRadio(dlg, 'seniority', r?.seniority || 'senior'); setRadio(dlg, 'complexity', r?.complexity || 'moderate');
    setRadio(dlg, 'urgency', r?.urgency || 'week'); setRadio(dlg, 'status', r?.status || 'open');
    $('fWaitOn').value = r?.waitingOn || '';
    const fu = new Date(); fu.setDate(fu.getDate() + 2); $('fFollow').value = r?.followUp || isoDate(fu);
    ackWas = r?.ackAt || null; doneWas = r?.doneAt || null;
    $('fAck').checked = !!ackWas;
    valueTouched = !!r?.value; if (r?.value) setRadio(dlg, 'value', r.value);
    estTouched = !!r?.estimate; $('fEst').value = r?.estimate || '';
    autoFill(); syncGroups(); updatePreview();
    dlg.showModal(); setTimeout(() => $('fTitle').focus(), 30);
  }
  dlg.addEventListener('change', e => {
    if (e.target.name === 'value') valueTouched = true;
    if (e.target.id === 'fEst') estTouched = true;
    if (['source', 'seniority', 'complexity'].includes(e.target.name)) autoFill();
    syncGroups(); updatePreview();
  });
  dlg.addEventListener('input', e => { if (['fAsked', 'fDue', 'fDueTime', 'fClient', 'fEst', 'fWho', 'fRole'].includes(e.target.id)) { if (e.target.id === 'fEst') estTouched = true; updatePreview(); } });
  $('cancelBtn').onclick = () => dlg.close();
  $('saveBtn').onclick = async () => {
    const r = readForm();
    if (!r.title) { $('titleErr').hidden = false; $('fTitle').focus(); return; }
    const existing = requests.find(x => x.id === editingId);
    dlg.close();
    if (r.clientName && !r.clientId) {
      const c = { id: newId('c'), kind: 'client', name: r.clientName, arr: null, renewal: null, health: null, createdAt: new Date().toISOString() };
      if (await putDoc(c)) r.clientId = c.id;
    }
    const item = { id: editingId || newId(), kind: 'request', ...r,
      ackAt: r.source === 'client' && $('fAck').checked ? (ackWas || new Date().toISOString()) : null,
      doneAt: r.status === 'done' ? (doneWas || new Date().toISOString()) : null,
      createdAt: existing?.createdAt || new Date().toISOString() };
    if (r.status === 'done' && existing && existing.status !== 'done') { await markDone({ ...existing, ...item }); return; }
    await putDoc(item);
    toast(editingId ? 'Request updated' : 'Request saved');
  };
  $('delBtn').onclick = async () => { const id = editingId; dlg.close(); await removeDoc(id); toast('Request deleted'); };

  // ---------- settings dialog ----------
  const sdlg = $('setDlg'); let draftW = {};
  function drawWeights() {
    $('weights').innerHTML = FACTORS.map(([k, l]) => `<span>${l}</span><span class="stepper"><button type="button" data-w="${k}" data-d="-0.25" aria-label="Lower ${l}">−</button><output>${draftW[k].toFixed(2)}</output><button type="button" data-w="${k}" data-d="0.25" aria-label="Raise ${l}">+</button></span>`).join('');
  }
  function fillSettings(src) {
    $('sHours').value = src.dailyHours; $('sAck').value = src.ackHours; $('sArr').value = src.bigArr; $('sRenew').value = src.renewalDays;
    setRadio(sdlg, 'effortMode', src.effortMode); draftW = { ...src.weights }; drawWeights();
  }
  $('settingsBtn').onclick = () => { fillSettings(S); sdlg.showModal(); };
  $('weights').addEventListener('click', e => { const b = e.target.closest('[data-w]'); if (!b) return; const k = b.dataset.w; draftW[k] = Math.min(2, Math.max(0, draftW[k] + Number(b.dataset.d))); drawWeights(); });
  $('setReset').onclick = () => fillSettings(DEFAULTS);
  $('setCancel').onclick = () => sdlg.close();
  $('setSave').onclick = async () => {
    const num = (id, d) => { const v = Number($(id).value); return v > 0 ? v : d; };
    const changedScoring = radio(sdlg, 'effortMode') !== S.effortMode || FACTORS.some(([k]) => draftW[k] !== S.weights[k]);
    sdlg.close();
    await saveSettings({ dailyHours: num('sHours', 6), ackHours: num('sAck', 2), bigArr: Number($('sArr').value) >= 0 ? Number($('sArr').value) : 50000, renewalDays: num('sRenew', 90), effortMode: radio(sdlg, 'effortMode') || 'complexFirst', weights: draftW });
    if (changedScoring) await putDoc({ id: 'learning', kind: 'learning', follows: 0, events: [] });
    toast('Settings saved');
  };

  // ---------- client dialog ----------
  const cdlg = $('cliDlg'); let editingClient = null, cCtl = null;
  function openClient(c) {
    editingClient = c?.id || null;
    $('cliTitle').textContent = c ? c.name : 'Add client';
    $('cName').value = c?.name || ''; $('cArr').value = c?.arr ?? ''; $('cRenew').value = c?.renewal || ''; $('cHealth').value = c?.health ?? '';
    $('cNameErr').hidden = true; $('cDel').hidden = !c;
    const reqs = c ? requests.filter(r => r.clientId === c.id).sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || '')) : [];
    $('cHistWrap').hidden = !c;
    $('cHist').innerHTML = reqs.map(r => `<li><span>${esc(r.title)}</span><span>${r.status === 'done' ? 'Done ' + esc(fmtDay(new Date(r.doneAt || r.requestedAt))) : r.status === 'waiting' ? 'Waiting' : 'Open'}</span></li>`).join('') || '<li><span class="muted">No requests yet.</span></li>';
    $('cAiWrap').hidden = !sampleFn || !reqs.length;
    $('cAiOut').hidden = true; $('cAiOut').textContent = ''; $('cAiStatus').textContent = ''; $('cAiGo').disabled = false;
    cdlg.showModal();
  }
  cdlg.addEventListener('close', () => cCtl?.abort());
  $('cCancel').onclick = () => cdlg.close();
  $('cSave').onclick = async () => {
    const name = $('cName').value.trim();
    if (!name) { $('cNameErr').hidden = false; $('cName').focus(); return; }
    const old = clients.find(c => c.id === editingClient);
    const arr = $('cArr').value === '' ? null : Number($('cArr').value);
    cdlg.close();
    const hv = $('cHealth').value === '' ? null : Math.max(0, Math.min(100, Math.round(Number($('cHealth').value))));
    await putDoc({ id: editingClient || newId('c'), kind: 'client', name, arr, renewal: $('cRenew').value || null, health: hv, createdAt: old?.createdAt || new Date().toISOString() });
    toast('Client saved');
  };
  $('cDel').onclick = async () => { const id = editingClient; cdlg.close(); await removeDoc(id); toast('Client deleted. Their requests are kept.'); };
  $('cAiGo').onclick = async () => {
    const c = clients.find(x => x.id === editingClient); if (!c || !sampleFn) return;
    const reqs = requests.filter(r => r.clientId === c.id).sort((a, b) => (a.requestedAt || '').localeCompare(b.requestedAt || ''));
    const lines = reqs.map(r => `- ${fmtDay(new Date(r.requestedAt))}: ${r.title}${r.details ? ` (${r.details})` : ''}. Status: ${r.status === 'done' ? 'done ' + fmtDay(new Date(r.doneAt || r.requestedAt)) : r.status === 'waiting' ? 'waiting on ' + (r.waitingOn || 'someone') : 'open'}${r.mood === 'unhappy' ? '. Client was unhappy' : ''}`).join('\n');
    const prompt = `You help an account manager prepare for a QBR or renewal conversation. Using ONLY the information below, write a short account summary in plain text (no markdown headings or bold; use "- " bullets), under 200 words, with four short sections labelled on their own line: What we delivered, Open issues, Patterns and risks, Talking points. Do not invent facts.

Account: ${c.name}
ARR: ${c.arr ? money(c.arr) : 'unknown'}
Renewal: ${c.renewal ? fmtDay(dateOnly(c.renewal)) : 'unknown'}
Health score: ${c.health ?? 'unknown'}${c.health != null ? '/100 (' + healthBand(Number(c.health)) + ')' : ''}
Requests from this client, oldest first:
${lines.slice(0, 12000)}`;
    cCtl = new AbortController(); $('cAiGo').disabled = true; $('cAiStatus').textContent = 'Writing summary…'; $('cAiOut').hidden = false; $('cAiOut').textContent = '';
    try {
      await sampleFn(prompt, { signal: cCtl.signal, cache: false, onText: ({ text }) => { $('cAiStatus').textContent = ''; $('cAiOut').textContent = text; } });
      $('cAiStatus').textContent = '';
    } catch (e) { $('cAiStatus').textContent = aiErr(e); if (!e?.text) $('cAiOut').hidden = true; }
    $('cAiGo').disabled = false;
  };

  // ---------- update dialog ----------
  const udlg = $('updDlg'); let uCtl = null;
  $('updateBtn').onclick = () => { $('updOut').hidden = true; $('updOut').textContent = ''; $('updStatus').textContent = ''; $('updCopy').hidden = true; $('updGo').textContent = 'Write update'; udlg.showModal(); };
  $('updClose').onclick = () => udlg.close();
  udlg.addEventListener('close', () => uCtl?.abort());
  $('updGo').onclick = async () => {
    const now = new Date(); const period = radio(udlg, 'period') || 'day';
    const start = period === 'day' ? startOfDay(now) : startOfWeek(now);
    const line = r => `- ${r.title}${clientName(r) ? ` [${clientName(r)}]` : ''}${r.requester ? `, asked by ${[r.requester, r.role].filter(Boolean).join(', ')}` : ''}${r.details ? `: ${r.details}` : ''}`;
    const done = requests.filter(r => r.status === 'done' && r.doneAt && new Date(r.doneAt) >= start);
    const next = ranked(now).slice(0, 6).map(x => x.r);
    const wait = requests.filter(r => r.status === 'waiting');
    const prompt = `Write a concise ${period === 'day' ? 'end-of-day' : 'end-of-week'} update from an account manager to her manager, in her voice. Plain text only: no markdown headings or bold, "- " bullets are fine. Under 170 words. Use up to three short sections, each labelled on its own line: Done, Up next, Waiting on others (leave out any that are empty). Lead with outcomes, group by client where it helps, one line per bullet. Use only the items below and do not invent details.

Done ${period === 'day' ? 'today' : 'this week'}:
${done.map(line).join('\n') || '- nothing logged'}

Up next, highest priority first:
${next.map(line).join('\n') || '- nothing open'}

Waiting on others:
${wait.map(r => `${line(r)} (waiting on ${r.waitingOn || 'someone'}${r.followUp ? `, follow up ${fmtDay(dateOnly(r.followUp))}` : ''})`).join('\n') || '- nothing'}`;
    uCtl = new AbortController(); $('updGo').disabled = true; $('updStatus').textContent = 'Writing your update…'; $('updOut').hidden = false; $('updOut').textContent = ''; $('updCopy').hidden = true;
    try {
      await sampleFn(prompt, { signal: uCtl.signal, cache: false, onText: ({ text }) => { $('updStatus').textContent = ''; $('updOut').textContent = text; } });
      $('updStatus').textContent = ''; $('updCopy').hidden = false; $('updGo').textContent = 'Rewrite';
    } catch (e) { $('updStatus').textContent = aiErr(e); if (!e?.text) $('updOut').hidden = true; }
    $('updGo').disabled = false;
  };
  $('updCopy').onclick = async () => {
    const text = $('updOut').textContent;
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { const sel = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents($('updOut')); sel.removeAllRanges(); sel.addRange(rg); toast('Text selected. Press Ctrl+C or Cmd+C to copy.'); }
  };

  function aiErr(e) {
    const c = e && e.code;
    if (c === 'cancelled') return '';
    if (c === 'not_granted') { sampleFn = null; $('pasteBtn').hidden = true; $('updateBtn').hidden = true; return "Claude isn't allowed on this page."; }
    if (c === 'rate_limited') return 'Too many requests right now. Try again in a minute.';
    return "Couldn't finish that. Try again.";
  }

  // ---------- paste with Claude ----------
  const pdlg = $('pasteDlg'); let ctl = null;
  function openPaste() { $('pasteText').value = ''; $('pasteStatus').textContent = ''; $('pasteGo').disabled = false; pdlg.showModal(); setTimeout(() => $('pasteText').focus(), 30); }
  $('pasteCancel').onclick = () => pdlg.close();
  pdlg.addEventListener('close', () => ctl?.abort());
  const pick = (v, ok, d) => ok.includes(v) ? v : d;
  $('pasteGo').onclick = async () => {
    const msg = $('pasteText').value.trim();
    if (!msg) { $('pasteStatus').textContent = 'Paste a message first.'; return; }
    ctl = new AbortController();
    $('pasteGo').disabled = true; $('pasteStatus').textContent = 'Reading the message…';
    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const known = clients.map(c => c.name).slice(0, 200).join(', ');
    const prompt = `You triage incoming requests for an account manager at a startup. Today is ${today}.${known ? ` Her client accounts include: ${known}.` : ''}
Read the message below and reply with only one JSON object with these keys:
"title": short action-style summary of what is being asked, under 70 characters
"details": one or two sentences of useful context, or ""
"requester": name of the person asking, or ""
"role": their job title or role if stated or clear from the signature, or ""
"client": for client requests, the company name (match one of her accounts if it fits), else ""
"source": "client" if it comes from a customer, "internal" if from someone in the company
"clientMood": for clients, "unhappy" if they complain, chase, sound frustrated, mention problems, errors, escalation or cancelling, otherwise "happy"; null for internal
"seniority": for internal, "senior" if from a direct manager, senior stakeholder, leadership or the CEO, otherwise "peer"; null for clients
"complexity": "quick" (under about 30 minutes), "moderate" (a few hours), or "complex" (a day or more, or needs several people)
"estimateHours": your best estimate of hours of work, as a number
"value": "revenue" if it creates new revenue (upsell, expansion, new deal, pricing proposal); "retention" if it protects existing revenue (fixing a client issue, renewal risk, a complaint, a client deliverable); otherwise "leadership" if requested by senior people, otherwise "colleague"
"urgency": "today" if needed immediately, today or by end of day; "week" if by end of the week; "anytime" if no rush
"deadline": a specific date in YYYY-MM-DD if one is stated or clearly implied, else null
"deadlineTime": a time in HH:MM (24h) if stated or implied (e.g. "first thing" = 09:00, "end of day" = 17:00), else null
Example: {"title":"Send Q3 usage report to Acme","details":"Dana wants it before their board meeting.","requester":"Dana","role":"COO","client":"Acme","source":"client","clientMood":"happy","seniority":null,"complexity":"moderate","estimateHours":1.5,"value":"revenue","urgency":"week","deadline":null}

Message:
"""
${msg.slice(0, 6000)}
"""`;
    try {
      const j = await sampleFn.json(prompt, { modelTier: 'quick', signal: ctl.signal });
      const source = pick(j?.source, ['client', 'internal'], 'client');
      const eh = Number(j?.estimateHours);
      const r = {
        title: String(j?.title || '').slice(0, 140), details: String(j?.details || ''), requester: String(j?.requester || ''), role: String(j?.role || ''),
        clientName: String(j?.client || '') || null,
        customTime: /^\d{2}:\d{2}$/.test(j?.deadlineTime || '') ? j.deadlineTime : '17:00',
        source, mood: pick(j?.clientMood, ['happy', 'unhappy'], 'happy'), seniority: pick(j?.seniority, ['senior', 'peer'], 'peer'),
        complexity: pick(j?.complexity, ['quick', 'moderate', 'complex'], 'moderate'),
        estimate: eh > 0 && eh < 200 ? Math.round(eh * 4) / 4 : null,
        value: pick(j?.value, ['revenue', 'retention', 'leadership', 'colleague'], source === 'client' ? 'revenue' : 'colleague'),
        urgency: pick(j?.urgency, ['today', 'week', 'anytime'], 'week'),
        customDue: /^\d{4}-\d{2}-\d{2}$/.test(j?.deadline || '') ? j.deadline : null,
      };
      const c = r.clientName ? clients.find(x => x.name.toLowerCase() === r.clientName.toLowerCase()) : null;
      if (c) { r.clientId = c.id; r.clientName = c.name; }
      pdlg.close(); openDialog(r); $('dlgTitle').textContent = 'Check and save';
    } catch (e) {
      $('pasteGo').disabled = false;
      const c = e && e.code;
      if (c === 'cancelled') { $('pasteStatus').textContent = ''; return; }
      $('pasteStatus').textContent = c === 'invalid_json' ? "Couldn't pick out a request. Try pasting just the part that asks for something." : (aiErr(e) || "Couldn't read that message. Try again, or add the request yourself.");
    }
  };

  // ---------- examples ----------
  async function addExamples() {
    const now = new Date(), h = 3600e3, day = 864e5;
    const halcyon = { id: newId('c'), kind: 'client', name: 'Halcyon Capital Markets', arr: 120000, renewal: isoDate(new Date(now.getTime() + 40 * day)), health: 42, createdAt: now.toISOString() };
    const albion = { id: newId('c'), kind: 'client', name: 'Albion Bank', arr: 240000, renewal: isoDate(new Date(now.getTime() + 75 * day)), health: 78, createdAt: now.toISOString() };
    await putDoc(halcyon); await putDoc(albion);
    const tomorrow = new Date(now.getTime() + day);
    const ex = [
      { title: 'Fix failed trade reconciliation in the daily settlement report', details: 'T+1 settlement breaks have shown up in the report two days running. Their ops team is escalating internally.', requester: 'Marcus Webb', role: 'Head of Operations', clientId: halcyon.id, clientName: halcyon.name, source: 'client', mood: 'unhappy', complexity: 'moderate', estimate: 1.5, value: 'retention', requestedAt: new Date(now.getTime() - 3 * h).toISOString(), customDue: now.getHours() < 15 ? isoDate(now) : isoDate(tomorrow), customTime: now.getHours() < 15 ? '17:00' : '09:00' },
      { title: 'Prepare renewal pricing proposal for Albion Bank', details: 'Multi-year option plus an add-on for the treasury analytics module, ahead of the procurement call.', requester: 'Sarah Okafor', role: 'VP Sales', clientId: albion.id, clientName: albion.name, source: 'internal', seniority: 'senior', complexity: 'complex', estimate: 4, value: 'revenue', urgency: 'week', requestedAt: new Date(now.getTime() - 20 * h).toISOString(), customDue: isoDate(tomorrow), customTime: now.getHours() < 15 ? '09:30' : '14:00' },
      { title: 'Send the open banking API onboarding checklist to Implementation', details: 'For the new KYC integration rollout.', requester: 'Jordan Patel', role: 'Implementation Manager', source: 'internal', seniority: 'peer', complexity: 'quick', estimate: 0.25, value: 'colleague', urgency: 'week', requestedAt: new Date(now.getTime() - 5 * h).toISOString() },
    ];
    for (const e of ex) {
      const r = { details: '', role: '', mood: null, seniority: null, urgency: null, customDue: null, customTime: '17:00', clientId: null, clientName: null, ...e };
      r.dueAt = computeDue(r);
      await putDoc({ id: newId(), kind: 'request', ...r, status: 'open', ackAt: null, doneAt: null, waitingOn: '', followUp: null, createdAt: now.toISOString() });
    }
  }

  // ---------- events ----------
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act],[data-filter],[data-view]'); if (!b) return;
    if (b.dataset.filter) { filter = b.dataset.filter; render(); return; }
    if (b.dataset.view && b.closest('.nav')) { view = b.dataset.view; render(); return; }
    const act = b.dataset.act, r = requests.find(x => x.id === b.dataset.id);
    if (act === 'add') openDialog(null);
    else if (act === 'paste') openPaste();
    else if (act === 'examples') addExamples();
    else if (act === 'edit' && r) openDialog(r);
    else if (act === 'done' && r) markDone(r);
    else if (act === 'ack' && r) acknowledge(r);
    else if (act === 'reopen' && r) { await putDoc({ ...r, status: 'open', doneAt: null }); toast('Back in the queue'); }
    else if (act === 'client') openClient(clients.find(c => c.id === b.dataset.id));
    else if (act === 'newclient') openClient(null);
    else if (act === 'apply') {
      const s = lastInsights[Number(b.dataset.i)]; if (!s) return;
      await saveSettings(s.patch); await putDoc({ id: 'learning', kind: 'learning', follows: 0, events: [] });
      toast('Scoring updated. Tracking starts fresh.');
    }
  });
  $('addBtn').onclick = () => openDialog(null);
  $('pasteBtn').onclick = openPaste;

  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2800); }

  // nav aria-current fix
  const _render = render;
  render = function () { _render(); document.querySelectorAll('.nav [data-view]').forEach(b => { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }); };

  // ---------- init ----------
  render();
  setInterval(() => { if (!document.querySelector('dialog[open]')) render(); }, 60000);
  (async () => {
    if (!window.claude || typeof window.claude.use !== 'function') { docs = loadLocal(); derive(); ready = true; render(); return; }
    const [db, user, sample] = await Promise.all([
      claude.use('db').catch(() => null), claude.use('user').catch(() => null), claude.use('sample').catch(() => null),
    ]);
    sampleFn = sample; $('pasteBtn').hidden = !sample; $('updateBtn').hidden = !sample;
    const uid = user ? await user.id() : null;
    if (db && uid) {
      col = db.collection('data/users/' + uid);
      col.onSnapshot(snap => { docs = snap.docs.map(d => ({ id: d.id, ...d.data() })); derive(); ready = true; render(); },
        () => toast('Lost connection to your saved requests. Reload the page to reconnect.'));
    } else { docs = loadLocal(); derive(); ready = true; render(); }
  })();
})();
