'use strict';

const app = document.getElementById('app');
const toastHost = document.getElementById('toast-host');

let pendingTopicFilter = null; // { rag, category } handed from the dashboard to the Topics list
let ovCategory = ''; // dashboard category scope ('' = all, 'none' = uncategorised)
let ragFocus = ''; // dashboard legend highlight

function setNav(name) {
  document.querySelectorAll('.nav-item').forEach((a) => {
    const on = a.dataset.nav === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

function setHash(hash) {
  if (typeof history === 'undefined') return;
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
}

document.getElementById('btn-home').addEventListener('click', () => showOverview());
document.getElementById('btn-new-topic').addEventListener('click', () => openNewTopicModal());
document.querySelectorAll('.nav-item').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const n = a.dataset.nav;
    if (n === 'overview') showOverview();
    else if (n === 'topics') showHome();
    else if (n === 'calendar') showCalendar();
    else if (n === 'settings') showSettings();
    else showWeekly();
    window.scrollTo(0, 0);
  });
});

function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3800);
}

async function api(path, options = {}) {
  // Some corporate proxies only pass GET and POST, so PATCH/DELETE are sent as POST with an override header.
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const method = (options.method || 'GET').toUpperCase();
  if (method === 'PATCH' || method === 'DELETE' || method === 'PUT') headers['X-HTTP-Method-Override'] = method;
  const res = await fetch(String(path).replace(/^\//, ''), {
    ...options,
    method: headers['X-HTTP-Method-Override'] ? 'POST' : method,
    headers
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || 'Invalid response' };
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


function plainTextSnippet(html, maxLen) {
  const plain = String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  const lim = maxLen == null ? 80 : maxLen;
  if (plain.length <= lim) return plain;
  const cut = plain.slice(0, lim);
  const nicer = cut.replace(/\s+\S*$/, '').trimEnd();
  return (nicer.length >= Math.min(40, lim) ? nicer : cut.trimEnd()) + '…';
}


function formatDate(isoDate) {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(d).padStart(2, '0');
  return dd + '-' + months[m - 1] + '-' + y;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/** UTC day of week: 0=Sun … 5=Fri … 6=Sat */
function utcDow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Snap to Friday on or before date (week-ending Friday). */
function fridayOnOrBefore(dateStr) {
  const dow = utcDow(dateStr); // 0 Sun … 5 Fri
  const back = (dow + 2) % 7; // Fri→0, Sat→1, Sun→2, Mon→3, … Thu→6
  return addDays(dateStr, -back);
}

/** Monday of the Mon–Fri week that ends on fridayStr (must be a Friday). */
function mondayOfWeekEnding(fridayStr) {
  return addDays(fridayStr, -4);
}

/** Week-ending Friday for the Mon–Fri week containing dateStr (Sat/Sun → previous Fri). */
function weekEndingFridayContaining(dateStr) {
  const dow = utcDow(dateStr);
  if (dow === 0) return addDays(dateStr, -2);
  if (dow === 6) return addDays(dateStr, -1);
  return addDays(dateStr, 5 - dow);
}

function inferPeriod(cadence, previous) {
  if (cadence === 'weekly') {
    let friday;
    if (previous && previous.period_end) {
      // Next week after previous week-ending Friday
      const prevFri = fridayOnOrBefore(previous.period_end);
      friday = addDays(prevFri, 7);
    } else {
      friday = weekEndingFridayContaining(todayUTC());
    }
    return { period_start: mondayOfWeekEnding(friday), period_end: friday };
  }

  // Fortnightly / monthly: always advance from previous period_end (never today if that lands before it)
  const span = cadence === 'fortnightly' ? 13 : 29; // inclusive length − 1
  if (previous && previous.period_end) {
    const start = addDays(previous.period_end, 1);
    const end = addDays(start, span);
    return { period_start: start, period_end: end };
  }
  const end = todayUTC();
  const start = addDays(end, -span);
  return { period_start: start, period_end: end };
}

function isEmptyRich(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  return !(tmp.textContent || '').replace(/\u00a0/g, ' ').trim();
}

function ragChip(rag) {
  if (!rag) return '<span class="chip chip-inactive">No report</span>';
  const label = rag === 'Blue' ? 'Complete' : rag;
  return `<span class="chip chip-rag-${escapeHtml(rag)}" title="${escapeHtml(rag)}">${escapeHtml(label)}</span>`;
}

// Loaded from /api/categories (managed on the Settings page); never hard-code names here.
let CATEGORIES = [];
let ROLES = []; // [{id, name}] from /api/roles (managed on the Settings page)
async function loadRoleList() {
  try { ROLES = await api('/api/roles'); } catch { /* keep previous list */ }
}

async function loadCategoryNames() {
  try { CATEGORIES = (await api('/api/categories')).map((c) => c.name); } catch { /* keep previous list */ }
}

function podChips(pod) {
  if (!pod || !pod.length) return '';
  return `<div class="pod-chips" aria-label="POD">${pod.map((m) =>
    `<span class="pod-chip" title="${escapeHtml(m.role)}">${escapeHtml(m.name)} <em>${escapeHtml(m.role)}</em></span>`).join('')}</div>`;
}

function categoryTag(c) {
  return `<span class="cat-tag${c ? '' : ' cat-none'}">${escapeHtml(c || 'Uncategorised')}</span>`;
}

function avatar(name) {
  const parts = String(name || '').replace(/[^\p{L}\s.]/gu, '').split(/[\s.]+/).filter(Boolean);
  const ini = parts.length ? (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() : '?';
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="avatar" style="--av:${h}" aria-hidden="true">${escapeHtml(ini)}</span>`;
}

function cadenceChip(c) {
  return `<span class="chip chip-cadence">${escapeHtml(c)}</span>`;
}

function cadenceText(c) {
  if (!c) return '—';
  return `<span class="cadence-text">${escapeHtml(c)}</span>`;
}

function trendChip(t) {
  if (!t) return '';
  const map = {
    Improving: { arrow: '↗', label: 'Improving', cls: 'trend-up' },
    Stable: { arrow: '→', label: 'Stable', cls: 'trend-flat' },
    Declining: { arrow: '↘', label: 'Declining', cls: 'trend-down' }
  };
  const m = map[t] || { arrow: '→', label: t, cls: 'trend-flat' };
  // Trend is an arrow only — never visible wording (label kept for screen readers).
  return `<span class="trend-unit ${m.cls}" role="img" aria-label="${escapeHtml(m.label)}">` +
    `<span class="trend-arrow" aria-hidden="true">${m.arrow}</span>` +
    `</span>`;
}

function statusUnit(rag, trend) {
  const trendHtml = trend ? trendChip(trend) : '';
  return `<div class="status-unit">${ragChip(rag)}${trendHtml}</div>`;
}

/** Selectable chip group; returns { field, value get/set, addEventListener }. */
function createChoiceControl({ id, label, options, value, groupClass }) {
  const field = document.createElement('div');
  field.className = 'field';
  const lab = document.createElement('label');
  lab.id = `${id}-label`;
  lab.textContent = label;
  field.appendChild(lab);

  const group = document.createElement('div');
  group.className = `choice-group${groupClass ? ` ${groupClass}` : ''}`;
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', `${id}-label`);

  const hidden = document.createElement('input');
  hidden.type = 'hidden';
  hidden.id = id;
  hidden.value = value;
  group.appendChild(hidden);

  const buttons = [];
  function paint() {
    for (const btn of buttons) {
      const on = btn.dataset.value === hidden.value;
      btn.classList.toggle('is-selected', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `choice-chip${opt.chipClass ? ` ${opt.chipClass}` : ''}`;
    btn.dataset.value = opt.value;
    btn.setAttribute('role', 'radio');
    btn.innerHTML = opt.html != null ? opt.html : escapeHtml(opt.label);
    if (opt.html != null) btn.setAttribute('aria-label', opt.label);
    btn.addEventListener('click', () => {
      if (hidden.value === opt.value) return;
      hidden.value = opt.value;
      paint();
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    });
    buttons.push(btn);
    group.appendChild(btn);
  }
  paint();
  field.appendChild(group);

  return {
    field,
    get value() { return hidden.value; },
    set value(v) {
      hidden.value = v;
      paint();
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    },
    addEventListener(type, fn) { hidden.addEventListener(type, fn); }
  };
}

/* ── Rich text editor ─────────────────────────────────────────────────────── */

function createRte(id, { placeholder = '', value = '', className = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = className ? `rte ${className}` : 'rte';
  wrap.dataset.rteId = id;

  const toolbar = document.createElement('div');
  toolbar.className = 'rte-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Formatting');

  const buttons = [
    { cmd: 'bold', label: 'B', title: 'Bold', style: 'font-weight:700' },
    { cmd: 'italic', label: 'I', title: 'Italic', style: 'font-style:italic' },
    { cmd: 'underline', label: 'U', title: 'Underline', style: 'text-decoration:underline' },
    { cmd: 'insertUnorderedList', label: '•', title: 'Bullet list' },
    { cmd: 'insertOrderedList', label: '1.', title: 'Numbered list' },
    { cmd: 'removeFormat', label: 'Clear', title: 'Clear formatting' }
  ];

  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = b.title;
    btn.setAttribute('aria-label', b.title);
    btn.textContent = b.label;
    if (b.style) btn.setAttribute('style', b.style);
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      editor.focus();
      document.execCommand(b.cmd, false, null);
    });
    toolbar.appendChild(btn);
  }

  const editor = document.createElement('div');
  editor.className = 'rte-editor';
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.dataset.placeholder = placeholder;
  editor.innerHTML = value || '';

  wrap.appendChild(toolbar);
  wrap.appendChild(editor);

  wrap.getHtml = () => editor.innerHTML;
  wrap.setHtml = (html) => { editor.innerHTML = html || ''; };
  wrap.setWarn = (on) => wrap.classList.toggle('required-warn', !!on);
  wrap.focus = () => editor.focus();

  return wrap;
}

/* ── Views ────────────────────────────────────────────────────────────────── */

async function showOverview() {
  setNav('overview');
  setHash('#overview');
  app.innerHTML = '<div class="loading">Loading overview…</div>';
  try {
    const q = ovCategory ? '?category=' + encodeURIComponent(ovCategory) : '';
    const [topics, dash] = await Promise.all([api('/api/topics'), api('/api/dashboard' + q).catch(() => null)]);
    renderOverview(topics, dash);
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderOverview(topics, dash) {
  const inScope = (t) => !ovCategory || (ovCategory === 'none' ? !t.category : t.category === ovCategory);
  const active = topics.filter((t) => t.active !== false && inScope(t));
  const ragOf = (t) => (t.latest_report && t.latest_report.rag) || '';
  const counts = { Red: 0, Amber: 0, Green: 0, Blue: 0, none: 0 };
  for (const t of active) { const r = ragOf(t); if (counts[r] !== undefined && r) counts[r] += 1; else counts.none += 1; }

  const RAG_RANK = { Red: 0, Amber: 1 };
  const attention = active
    .filter((t) => ragOf(t) === 'Red' || ragOf(t) === 'Amber')
    .sort((a, b) => RAG_RANK[ragOf(a)] - RAG_RANK[ragOf(b)] || (a.sort_order || 0) - (b.sort_order || 0));
  const recent = active
    .filter((t) => t.latest_report)
    .sort((a, b) => String(b.latest_report.created_at || b.latest_report.period_end).localeCompare(String(a.latest_report.created_at || a.latest_report.period_end)))
    .slice(0, 5);

  // Overdue: one row per topic, with how many reporting weeks it has missed.
  const overdueBy = new Map();
  if (dash) for (const e of dash.overdue) {
    const o = overdueBy.get(e.topic_id) || { ...e, weeks: 0, oldest: e.date };
    o.weeks += 1;
    if (e.date < o.oldest) o.oldest = e.date;
    overdueBy.set(e.topic_id, o);
  }
  const overdue = [...overdueBy.values()].sort((a, b) => a.oldest.localeCompare(b.oldest));
  const upcoming = dash ? dash.upcoming.filter((e) => e.type === 'due').sort((a, b) => a.date.localeCompare(b.date)) : [];

  const ending = weekEndingFridayContaining(todayUTC());
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const nowLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const goTopics = (rag) => { pendingTopicFilter = { rag, category: ovCategory }; showHome(); };

  app.innerHTML = '';

  // ── Hero ──
  const attN = counts.Red + counts.Amber;
  const headline = !active.length ? 'No active topics in this scope.'
    : attN ? `${attN} of ${active.length} topic${active.length === 1 ? '' : 's'} ${attN === 1 ? 'has' : 'have'} non-green status` + (overdue.length ? ` · ${overdue.length} overdue for an update` : '')
    : overdue.length ? `All on track · ${overdue.length} overdue for an update` : 'All topics on track and up to date';
  const hero = document.createElement('div');
  hero.className = 'ov-hero';
  hero.innerHTML = `<div class="ov-hero-text"><h1>${greet}</h1><p>${escapeHtml(nowLabel)} · Week ending ${escapeHtml(formatDate(ending))}</p>
      <p class="ov-headline">${escapeHtml(headline)}</p></div>
    <div class="ov-controls">
      <div class="seg-control" role="group" aria-label="Scope by category">
        ${[['', 'All'], ...CATEGORIES.filter((c) => c === ovCategory || topics.some((t) => t.active !== false && t.category === c)).map((c) => [c, c])].map(([v, l]) =>
          `<button type="button" data-cat="${escapeHtml(v)}" aria-pressed="${ovCategory === v}">${escapeHtml(l)}</button>`).join('')}
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="ov-refresh" title="Reload the latest data">↻ Refresh</button>
    </div>`;
  hero.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { ovCategory = b.dataset.cat; showOverview(); }));
  hero.querySelector('#ov-refresh').addEventListener('click', () => { showOverview(); toast('Dashboard refreshed'); });
  app.appendChild(hero);

  // ── Health bar: current RAG mix, clickable ──
  const health = document.createElement('section');
  health.className = 'ov-card ov-health';
  const hseg = [...RAG_ORDER, 'none'].filter((k) => counts[k] > 0).map((k) =>
    `<button type="button" class="ov-hseg rag-${k}" data-rag="${k}" style="flex:${counts[k]}" data-tip="${k === 'none' ? 'No report' : RAG_LABEL[k]}: ${counts[k]}" aria-label="${k === 'none' ? 'No report' : RAG_LABEL[k]}: ${counts[k]} — show in topic list">${counts[k]}</button>`).join('');
  health.innerHTML = `<div class="ov-health-head"><h2>Portfolio health<small>${active.length} active topic${active.length === 1 ? '' : 's'} · latest status · click to filter</small></h2>${ragLegend()}</div>
    <div class="ov-hbar">${hseg || '<span class="ov-empty">No topics yet.</span>'}</div>`;
  health.querySelectorAll('.ov-hseg').forEach((b) => b.addEventListener('click', () => goTopics(b.dataset.rag === 'none' ? 'none' : b.dataset.rag)));
  app.appendChild(health);

  // ── KPI strip ──
  const tw = dash && dash.this_week;
  const openComments = dash ? dash.comments.reduce((n, c) => n + c.open, 0) : 0;
  const ms14 = dash ? dash.milestones.filter((m) => m.days <= 14).length : 0;
  const kpis = [
    { n: attN, label: 'Red / Amber', sub: counts.Red ? `${counts.Red} red` : 'none red', cls: counts.Red ? 'red' : attN ? 'amber' : 'green', go: () => document.getElementById('ov-attention').scrollIntoView({ behavior: 'smooth', block: 'start' }) },
    { n: tw ? `${tw.in}/${tw.due}` : '–', label: 'In for this week', sub: `w/e ${shortDate(ending)}`, cls: tw && tw.due && tw.in === tw.due ? 'green' : '', go: () => { location.hash = '#weekly=' + ending; } },
    { n: overdue.length, label: 'Overdue updates', sub: overdue.length ? `${dash.overdue.length} missed week${dash.overdue.length === 1 ? '' : 's'}` : 'all caught up', cls: overdue.length ? 'red' : 'green', go: () => document.getElementById('ov-schedule').scrollIntoView({ behavior: 'smooth', block: 'start' }) },
    { n: openComments, label: 'Open review comments', sub: openComments ? `${dash.comments.length} topic${dash.comments.length === 1 ? '' : 's'}` : 'nothing to resolve', cls: openComments ? 'amber' : '', go: () => document.getElementById('ov-comments').scrollIntoView({ behavior: 'smooth', block: 'start' }) },
    { n: ms14, label: 'Milestones · 14 days', sub: dash && dash.milestones[0] ? `next ${shortDate(dash.milestones[0].date)}` : 'none scheduled', cls: '', go: () => document.getElementById('ov-milestones').scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  ];
  const strip = document.createElement('div');
  strip.className = 'ov-kpis';
  for (const k of kpis) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ov-kpi ' + k.cls;
    b.innerHTML = `<b>${k.n}</b><span>${escapeHtml(k.label)}</span><em>${escapeHtml(k.sub)}</em>`;
    b.addEventListener('click', k.go);
    strip.appendChild(b);
  }
  app.appendChild(strip);

  // ── helpers ──
  function card(title, note, id) {
    const c = document.createElement('section');
    c.className = 'ov-card';
    if (id) c.id = id;
    c.innerHTML = `<h2>${title}<small>${note}</small></h2>`;
    return c;
  }
  function rows(c, items, emptyMsg) {
    if (!items.length) { c.insertAdjacentHTML('beforeend', `<p class="ov-empty">${escapeHtml(emptyMsg)}</p>`); return; }
    const ul = document.createElement('ul');
    ul.className = 'ov-list';
    for (const it of items) {
      const li = document.createElement('li');
      li.innerHTML = `<button type="button" class="ov-row"><span class="ov-row-name">${escapeHtml(it.name)}</span>${it.right}<span class="ov-row-sub">${escapeHtml(it.sub)}</span></button>`;
      li.querySelector('button').addEventListener('click', () => (it.go ? it.go() : showTopic(it.id)));
      ul.appendChild(li);
    }
    c.appendChild(ul);
  }
  const layout = document.createElement('div');
  layout.className = 'ov-layout';
  const main = document.createElement('div');
  main.className = 'ov-main';
  const side = document.createElement('div');
  side.className = 'ov-side';
  layout.append(main, side);

  // ── Main: per-topic heatmap ──
  if (dash) {
    const weeks = dash.trend.map((w) => w.week_ending);
    const head = weeks.map((w) => `<button type="button" class="hm-wk" data-week="${w}" title="Open weekly pack for ${escapeHtml(formatDate(w))}">${shortDate(w)}</button>`).join('');
    const body = dash.heatmap.map((h) => {
      const cells = h.cells.map((c) => {
        if (!c.rag) return '<span class="hm-cell hm-empty"></span>';
        if (c.carried && c.week_ending >= dash.week_ending) return `<span class="hm-cell hm-empty hm-pending" data-tip="${escapeHtml(h.topic_name)} · w/e ${escapeHtml(formatDate(c.week_ending))}: report not yet due"></span>`;
        const tip = `${h.topic_name} · w/e ${formatDate(c.week_ending)}: ${RAG_LABEL[c.rag]}${c.carried ? ' (no report — carried over)' : ''}`;
        return `<button type="button" class="hm-cell rag-${c.rag}${c.carried ? ' hm-carried' : ''}" data-rag="${c.rag}" data-topic="${h.topic_id}" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}"></button>`;
      }).join('');
      return `<div class="hm-row"><button type="button" class="hm-name" data-topic="${h.topic_id}">${escapeHtml(h.topic_name)}</button><div class="hm-cells">${cells}</div></div>`;
    }).join('');
    const heat = card('Status history', 'Last 8 weeks · solid = reported, dashed = carried over, hatched = none', 'ov-heat');
    heat.insertAdjacentHTML('beforeend', `<div class="hm"><div class="hm-row hm-headrow"><span></span><div class="hm-cells">${head}</div></div>${body || '<p class="ov-empty">No topics yet.</p>'}</div>`);
    heat.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => { location.hash = '#weekly=' + b.dataset.week; }));
    heat.querySelectorAll('[data-topic]').forEach((b) => b.addEventListener('click', () => showTopic(b.dataset.topic)));
    main.appendChild(heat);
  }

  // ── Main: non-green status ──
  const attCard = card('Non-green status', `${attention.length} Red / Amber`, 'ov-attention');
  rows(attCard, attention.map((t) => ({
    id: t.id, name: t.name,
    right: statusUnit(t.latest_report.rag, t.latest_report.trend),
    sub: plainTextSnippet(t.latest_report.gtg_plan || t.latest_report.exec_summary || '', 130) || (t.owner || 'No owner')
  })), 'Nothing is Red or Amber.');
  main.appendChild(attCard);

  // ── Main: recent updates ──
  const recentCard = card('Recent updates', 'Latest submitted');
  rows(recentCard, recent.map((t) => ({
    id: t.id, name: t.name,
    right: statusUnit(t.latest_report.rag, t.latest_report.trend),
    sub: `${t.owner || 'No owner'} · ${formatDate(t.latest_report.period_end)} · ${plainTextSnippet(t.latest_report.exec_summary || '', 90)}`
  })), 'No updates yet.');
  main.appendChild(recentCard);

  // ── Side ──
  if (dash) {
    const sched = card('Reporting schedule', '<a href="#calendar" class="dash-link">Calendar →</a>', 'ov-schedule');
    const schedItems = [
      ...overdue.map((e) => ({ id: e.topic_id, name: e.topic_name, right: `<span class="cal-pill cal-overdue">${e.weeks > 1 ? e.weeks + ' wks overdue' : 'Overdue'}</span>`, sub: `Since ${formatDate(e.oldest)}${e.owner ? ' · ' + e.owner : ''}` })),
      ...upcoming.filter((e, i, a) => !overdueBy.has(e.topic_id) && a.findIndex((x) => x.topic_id === e.topic_id) === i).slice(0, 5).map((e) => ({ id: e.topic_id, name: e.topic_name, right: '<span class="cal-pill cal-due">Due</span>', sub: `${formatDate(e.date)}${e.owner ? ' · ' + e.owner : ''}` }))
    ];
    rows(sched, schedItems.slice(0, 7), 'Nothing overdue or due in the next 14 days.');
    side.appendChild(sched);

    const ms = card('Upcoming milestones', 'Next 30 days', 'ov-milestones');
    rows(ms, dash.milestones.map((m) => ({
      id: m.topic_id, name: m.description || 'Milestone',
      right: `<span class="ov-days${m.days <= 3 ? ' soon' : ''}">${m.days === 0 ? 'Today' : m.days === 1 ? 'Tomorrow' : 'in ' + m.days + 'd'}</span>`,
      sub: `${m.topic_name} · ${formatDate(m.date)}`
    })), 'No key dates in the next 30 days.');
    side.appendChild(ms);

    const mov = card('Status changes', 'Latest vs previous report');
    rows(mov, dash.movements.slice(0, 5).map((m) => ({
      id: m.topic_id, name: m.topic_name,
      right: `<span class="dash-move dash-${m.direction}">${m.direction === 'worse' ? '▼' : '▲'} ${RAG_LABEL[m.from]} → ${RAG_LABEL[m.to]}</span>`,
      sub: `Week ending ${formatDate(m.week_ending)}`
    })), 'No status changes yet.');
    main.appendChild(mov);

    const cm = card('Open review comments', openComments ? `${openComments} unresolved` : '', 'ov-comments');
    rows(cm, dash.comments.slice(0, 5).map((c) => ({
      id: c.topic_id, name: c.topic_name,
      right: `<span class="ov-count">${c.open}</span>`,
      sub: `${c.open} unresolved thread${c.open === 1 ? '' : 's'} · latest w/e ${formatDate(c.week_ending)}`
    })), 'No unresolved comments.');
    side.appendChild(cm);

    // Breakdown by category / business unit
    const brk = card('Breakdown', '');
    const modeKey = 'ovBreakdown';
    let mode = 'category';
    try { mode = sessionStorage.getItem(modeKey) || 'category'; } catch { /* ignore */ }
    const paint = () => {
      const src = mode === 'unit' ? dash.units : dash.categories;
      const keys = Object.keys(src).filter((k) => ['Red', 'Amber', 'Green', 'Blue', 'none'].some((r) => src[k][r] > 0));
      const tot = (d) => ['Red', 'Amber', 'Green', 'Blue', 'none'].reduce((n, r) => n + d[r], 0);
      const mx = Math.max(1, ...keys.map((k) => tot(src[k])));
      brk.querySelector('.brk-body').innerHTML = keys.map((k) => {
        const d = src[k];
        const segs = [...RAG_ORDER, 'none'].filter((r) => d[r] > 0).map((r) =>
          `<span class="dash-seg rag-${r}" style="flex:${d[r]}" data-tip="${escapeHtml(k)} · ${r === 'none' ? 'No report' : RAG_LABEL[r]}: ${d[r]}"></span>`).join('');
        return `<div class="dash-hrow"><span class="dash-hlabel">${escapeHtml(k)}</span><div class="dash-hbar"><div class="dash-hstack" style="width:${(tot(d) / mx) * 100}%">${segs}</div></div><span class="dash-hn">${tot(d)}</span></div>`;
      }).join('') || '<p class="ov-empty">No topics yet.</p>';
      brk.querySelectorAll('.brk-tab').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    };
    brk.querySelector('h2').insertAdjacentHTML('beforeend', '');
    brk.querySelector('small').outerHTML = `<span class="seg-control seg-sm" role="group" aria-label="Group by">
      <button type="button" class="brk-tab" data-mode="category">Category</button><button type="button" class="brk-tab" data-mode="unit">Business unit</button></span>`;
    brk.insertAdjacentHTML('beforeend', '<div class="brk-body"></div>');
    brk.querySelectorAll('.brk-tab').forEach((b) => b.addEventListener('click', () => {
      mode = b.dataset.mode;
      try { sessionStorage.setItem(modeKey, mode); } catch { /* ignore */ }
      paint();
    }));
    paint();
    side.appendChild(brk);
  } else {
    side.appendChild(card('Dashboard unavailable', '')).insertAdjacentHTML('beforeend', '<p class="ov-empty">Could not load schedule data. Try Refresh.</p>');
  }

  app.appendChild(layout);
  const sync = () => { layout.dataset.focus = ragFocus; };
  sync();
  health.querySelectorAll('.dash-leg').forEach((b) => b.addEventListener('click', () => {
    ragFocus = ragFocus === b.dataset.focus ? '' : b.dataset.focus;
    document.querySelectorAll('.dash-leg').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.focus === ragFocus)));
    health.dataset.focus = layout.dataset.focus = ragFocus;
  }));
  health.dataset.focus = ragFocus;
}

/* ── Dashboard charts (Overview) ──────────────────────────────────────────── */

const RAG_ORDER = ['Red', 'Amber', 'Green', 'Blue'];
const RAG_LABEL = { Red: 'Red', Amber: 'Amber', Green: 'Green', Blue: 'Complete' };

function ragLegend() {
  return '<div class="dash-legend">' + RAG_ORDER.map((r) =>
    `<button type="button" class="dash-leg" data-focus="${r}" aria-pressed="${ragFocus === r}" title="Highlight ${RAG_LABEL[r]} across the charts"><i class="dash-sw rag-${r}"></i>${RAG_LABEL[r]}</button>`).join('') + '</div>';
}

/* One shared tooltip for [data-tip] elements. */
const tipEl = document.createElement('div');
tipEl.className = 'dash-tip';
tipEl.setAttribute('role', 'tooltip');
document.body.appendChild(tipEl);
function placeTip(target) {
  tipEl.textContent = target.dataset.tip;
  tipEl.classList.add('on');
  const r = target.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  tipEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  tipEl.style.top = Math.max(8, r.top - tipEl.offsetHeight - 8) + 'px';
}
document.addEventListener('mouseover', (e) => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t) placeTip(t); });
document.addEventListener('mouseout', (e) => { if (e.target.closest && e.target.closest('[data-tip]')) tipEl.classList.remove('on'); });
document.addEventListener('focusin', (e) => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t) placeTip(t); });
document.addEventListener('focusout', () => tipEl.classList.remove('on'));

function shortDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/* ── Settings: categories ─────────────────────────────────────────────────── */

async function showSettings() {
  setNav('settings');
  setHash('#settings');
  app.innerHTML = '<div class="loading">Loading settings…</div>';
  try {
    const [cats, roles] = await Promise.all([api('/api/categories'), api('/api/roles')]);
    renderSettings(cats, roles);
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Failed to load settings: ${escapeHtml(err.message)}</div>`;
  }
}

function renderSettings(cats, roles) {
  CATEGORIES = cats.map((c) => c.name);
  ROLES = roles;
  app.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = `<div><h1>Settings</h1><p>Manage the lists used across the app.</p></div>`;
  app.appendChild(head);

  app.appendChild(buildListCard({
    title: 'Categories', noun: 'category', items: cats, countKey: 'topic_count', countNoun: 'topic',
    endpoint: '/api/categories',
    help: 'What kind of work a topic is. Renaming updates every topic that uses it. Order controls how categories appear in filters and charts.',
    placeholder: 'Add a category, e.g. Initiative', reassignTo: 'name', reassignNone: 'Uncategorised'
  }));
  const rolesCard = buildListCard({
    title: 'POD roles', noun: 'role', items: roles, countKey: 'member_count', countNoun: 'member',
    endpoint: '/api/roles',
    help: 'The roles a POD member can hold on a topic, e.g. Tech lead. Renaming updates every POD that uses it. Every topic needs a POD with at least one member.',
    placeholder: 'Add a role, e.g. Architect', reassignTo: 'id', reassignNone: null
  });
  rolesCard.style.marginTop = '1rem';
  app.appendChild(rolesCard);
  app.appendChild(buildImportExportCard());
}

// A reorderable, renamable, deletable list (categories, roles). cfg.reassignTo is the item field the
// DELETE ?reassign= param carries; reassignNone is the label for "leave blank" (null = a target is required).
function buildListCard(cfg) {
  const { items, endpoint, noun } = cfg;
  const card = document.createElement('section');
  card.className = 'panel settings-card';
  card.innerHTML = `
    <h2 class="settings-title">${escapeHtml(cfg.title)}</h2>
    <p class="settings-help">${escapeHtml(cfg.help)}</p>
    <ul class="cat-list"></ul>
    <form class="cat-add" autocomplete="off">
      <label class="sr-only">New ${noun}</label>
      <input type="text" maxlength="40" placeholder="${escapeHtml(cfg.placeholder)}" />
      <button type="submit" class="btn btn-primary">Add</button>
    </form>`;
  const ul = card.querySelector('.cat-list');
  const run = async (fn, okMsg) => {
    try { await fn(); if (okMsg) toast(okMsg); await showSettings(); } catch (err) { toast(err.message, 'error'); await showSettings(); }
  };
  const cap = noun[0].toUpperCase() + noun.slice(1);

  if (!items.length) ul.innerHTML = `<li class="cat-empty">No ${noun}s yet — add your first below.</li>`;
  items.forEach((c, i) => {
    const n = c[cfg.countKey];
    const li = document.createElement('li');
    li.className = 'cat-row';
    li.innerHTML = `
      <div class="cat-move">
        <button type="button" class="icon-btn" data-up aria-label="Move ${escapeHtml(c.name)} up" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="icon-btn" data-down aria-label="Move ${escapeHtml(c.name)} down" ${i === items.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
      <input class="cat-name" type="text" maxlength="40" value="${escapeHtml(c.name)}" aria-label="${cap} name" />
      <span class="cat-count">${n} ${cfg.countNoun}${n === 1 ? '' : 's'}</span>
      <button type="button" class="btn btn-ghost btn-sm btn-danger-text" data-del>Delete</button>`;
    const input = li.querySelector('.cat-name');
    let busy = false;
    const rename = () => {
      const v = input.value.trim();
      if (!v) { input.value = c.name; return; }
      if (v !== c.name && !busy) { busy = true; run(() => api(endpoint + '/' + encodeURIComponent(c.id), { method: 'PATCH', body: JSON.stringify({ name: v }) }), cap + ' renamed'); }
    };
    input.addEventListener('blur', rename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') rename();
      if (e.key === 'Escape') { input.value = c.name; input.blur(); }
    });
    const move = (d) => {
      const ids = items.map((x) => x.id);
      ids.splice(i + d, 0, ids.splice(i, 1)[0]);
      run(() => api(endpoint + '/order', { method: 'POST', body: JSON.stringify({ ids }) }));
    };
    li.querySelector('[data-up]').addEventListener('click', () => move(-1));
    li.querySelector('[data-down]').addEventListener('click', () => move(1));
    li.querySelector('[data-del]').addEventListener('click', () => confirmDeleteListItem(cfg, c, run));
    ul.appendChild(li);
  });

  card.querySelector('.cat-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = card.querySelector('.cat-add input');
    const name = inp.value.trim();
    if (!name) return inp.focus();
    run(() => api(endpoint, { method: 'POST', body: JSON.stringify({ name }) }), cap + ' added');
  });
  return card;
}

function buildImportExportCard() {
  const card = document.createElement('section');
  card.className = 'panel settings-card';
  card.style.marginTop = '1rem';
  const csvRow = (kind, label, file, tpl) => `
    <div class="ie-row" data-kind="${kind}"><strong>${label}</strong>
      <a class="btn" href="api/${file}" download="${file}">Export CSV</a>
      <button type="button" class="btn btn-primary" data-import>Import CSV…</button>
      <a class="btn btn-ghost" href="api/templates/${tpl}.csv" download="${tpl}_template.csv">Template</a>
      <input type="file" accept=".csv,text/csv" hidden />
      <div class="import-result" aria-live="polite"></div></div>`;
  card.innerHTML = `
    <h2 class="settings-title">Import / export</h2>
    <h3 class="settings-sub">Full backup</h3>
    <p class="settings-help">One JSON file with categories, roles, topics (with POD and due day), every report, key dates and review comments. Restoring merges into the current data: items are matched by id (topics also by name), updated or created, and nothing is deleted, so it is safe to re-run. Use it to back up, move to another machine, or load a complete history.</p>
    <div class="ie-row" data-kind="backup"><strong>Everything</strong>
      <a class="btn" href="api/backup.json" download>Download backup</a>
      <button type="button" class="btn btn-primary" data-import>Restore from backup…</button>
      <input type="file" accept=".json,application/json" hidden />
      <div class="import-result" aria-live="polite"></div></div>
    <h3 class="settings-sub" style="margin-top:1.25rem">CSV (edit in Excel)</h3>
    <p class="settings-help"><strong>Topics:</strong> rows match an existing topic by <code>id</code> or <code>name</code> and update it (blank cells are left unchanged); other rows create new topics, which need <code>name</code>, <code>category</code>, <code>cadence</code> and <code>pod</code>. <code>due_day</code> is Monday–Friday (default Friday). <code>pod</code> is a list of members like <code>A. Chen (Owner); B. Lee (Tech lead)</code> using roles from Settings; when given it replaces the POD.</p>
    <p class="settings-help"><strong>Reports</strong> (for historic data): the topic must already exist. Each row needs <code>topic</code> (name), <code>period_end</code> (a Friday, YYYY-MM-DD), <code>rag</code>, <code>trend</code> and <code>exec_summary</code>; <code>gtg_plan</code> is needed for Red/Amber. <code>period_start</code> defaults to the Monday. A row with the same topic and <code>period_end</code> updates that report. Plain text is fine in the narrative columns. Imported reports are dated by their period, so they never replace a newer report as the latest.</p>
    <p class="settings-help"><strong>Key dates:</strong> each row needs <code>topic</code> (name), <code>date</code> (YYYY-MM-DD) and <code>description</code>. A row with the same topic, date and description updates that milestone.</p>
    <p class="settings-help">Import topics first, then reports and key dates. Rows with problems are skipped and listed; valid rows are still applied.</p>
    ${csvRow('topics', 'Topics', 'topics.csv', 'topics')}
    ${csvRow('reports', 'Reports', 'reports.csv', 'reports')}
    ${csvRow('key-dates', 'Key dates', 'key-dates.csv', 'key-dates')}`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  card.querySelectorAll('.ie-row').forEach((row) => {
    row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-top:.75rem';
    row.querySelector('strong').style.minWidth = '5.5rem';
    row.querySelector('.import-result').style.cssText = 'flex-basis:100%';
    const input = row.querySelector('input[type=file]');
    const out = row.querySelector('.import-result');
    const kind = row.dataset.kind;
    row.querySelector('[data-import]').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        if (kind === 'backup') {
          const res = await api('/api/backup/import', { method: 'POST', body: JSON.stringify({ backup: text }) });
          const parts = ['categories', 'roles', 'topics', 'reports', 'key_dates', 'comments']
            .map((k) => [k.replace('_', ' '), res[k]]).filter(([, c]) => c.created || c.updated || c.skipped)
            .map(([k, c]) => `<li><strong>${escapeHtml(k)}</strong>: ${c.created} created, ${c.updated} updated${c.skipped ? `, ${c.skipped} skipped` : ''}</li>`);
          out.innerHTML = `<ul>${parts.join('') || '<li>Nothing to import.</li>'}</ul>` +
            (res.errors.length ? `<p>Problems:</p><ul>${res.errors.map((e) => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul>` : '');
          toast('Backup restored');
          return;
        }
        const res = await api('/api/' + kind + '/import', { method: 'POST', body: JSON.stringify({ csv: text }) });
        const errs = res.errors || [];
        out.innerHTML = `<p>${res.created} created, ${res.updated} updated${errs.length ? `, ${plural(errs.length, 'row')} skipped` : ''}.</p>` +
          (errs.length ? `<ul>${errs.map((e) => `<li>Line ${e.line}: ${escapeHtml(e.message)}</li>`).join('')}</ul>` : '');
        toast(`Import done: ${res.created} created, ${res.updated} updated`);
      } catch (err) {
        out.textContent = '';
        toast(err.message, 'error');
      }
    });
  });
  return card;
}

function confirmDeleteListItem(cfg, item, run) {
  const others = cfg.items.filter((c) => c.id !== item.id);
  const n = item[cfg.countKey];
  const required = cfg.reassignNone === null;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  const blocked = required && n && !others.length;
  backdrop.innerHTML = `<div class="modal">
    <h2>Delete “${escapeHtml(item.name)}”?</h2>
    ${n ? `<p>${n} ${cfg.countNoun}${n === 1 ? ' uses' : 's use'} this ${cfg.noun}. Move ${n === 1 ? 'it' : 'them'} to:</p>
    <div class="field"><select id="list-reassign">${required ? '' : `<option value="">${escapeHtml(cfg.reassignNone)}</option>`}${others.map((o) => `<option value="${escapeHtml(o[cfg.reassignTo])}">${escapeHtml(o.name)}</option>`).join('')}</select></div>` : `<p>Nothing uses it.</p>`}
    ${blocked ? `<p class="field-hint">Add another ${cfg.noun} first.</p>` : ''}
    <div class="modal-actions"><button type="button" class="btn btn-ghost" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-ok ${blocked ? 'disabled' : ''}>Delete</button></div></div>`;
  const close = () => backdrop.remove();
  backdrop.querySelector('[data-cancel]').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  backdrop.querySelector('[data-ok]').addEventListener('click', () => {
    const sel = backdrop.querySelector('#list-reassign');
    close();
    run(() => api(cfg.endpoint + '/' + encodeURIComponent(item.id) + '?reassign=' + encodeURIComponent(sel ? sel.value : ''), { method: 'DELETE' }), cfg.noun[0].toUpperCase() + cfg.noun.slice(1) + ' deleted');
  });
  document.body.appendChild(backdrop);
  backdrop.querySelector('[data-ok]').focus();
}

/* ── Calendar ─────────────────────────────────────────────────────────────── */

let calCategory = '';

async function showCalendar(month) {
  setNav('calendar');
  month = month || todayUTC().slice(0, 7);
  setHash('#calendar=' + month);
  app.innerHTML = '<div class="loading">Loading calendar…</div>';
  try {
    renderCalendar(await api('/api/calendar?month=' + encodeURIComponent(month)), month);
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Failed to load calendar: ${escapeHtml(err.message)}</div>`;
  }
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function renderCalendar(cal, month) {
  app.innerHTML = '';
  const label = new Date(month + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = `
    <div>
      <h1>Reporting calendar</h1>
      <p>When each report is due, and when prep starts (${cal.prep_lead_days} working days before). Click an entry to open the topic.</p>
    </div>
    <div class="page-head-actions">
      <div class="field">
        <label class="sr-only" for="cal-cat">Category</label>
        <select id="cal-cat">
          <option value="">All categories</option>
          ${CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
        </select>
      </div>
      <div class="cal-nav">
        <button type="button" class="btn btn-ghost btn-sm" id="cal-prev" aria-label="Previous month">◀</button>
        <strong class="cal-month">${escapeHtml(label)}</strong>
        <button type="button" class="btn btn-ghost btn-sm" id="cal-next" aria-label="Next month">▶</button>
        <button type="button" class="btn btn-ghost btn-sm" id="cal-today">Today</button>
      </div>
    </div>`;
  app.appendChild(head);
  head.querySelector('#cal-prev').addEventListener('click', () => showCalendar(shiftMonth(month, -1)));
  head.querySelector('#cal-next').addEventListener('click', () => showCalendar(shiftMonth(month, 1)));
  head.querySelector('#cal-today').addEventListener('click', () => showCalendar());
  const catSel = head.querySelector('#cal-cat');
  catSel.value = calCategory;
  catSel.addEventListener('change', () => { calCategory = catSel.value; renderCalendar(cal, month); });

  const legend = document.createElement('div');
  legend.className = 'cal-legend';
  legend.innerHTML = `<span><i class="cal-pill cal-prep">Prep</i> prep starts</span><span><i class="cal-pill cal-due">Due</i> report due</span>
    <span><i class="cal-pill cal-submitted">Done</i> submitted</span><span><i class="cal-pill cal-overdue">Late</i> overdue</span>`;
  app.appendChild(legend);

  const events = cal.events.filter((e) => !calCategory || e.category === calCategory);
  const byDate = new Map();
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }

  const grid = document.createElement('div');
  grid.className = 'cal-grid';
  for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    grid.insertAdjacentHTML('beforeend', `<div class="cal-dow">${d}</div>`);
  }
  for (let d = cal.grid_from; d <= cal.grid_to; d = addDays(d, 1)) {
    const inMonth = d.startsWith(month);
    const evs = byDate.get(d) || [];
    const cell = document.createElement('div');
    cell.className = 'cal-day' + (inMonth ? '' : ' cal-out') + (d === cal.today ? ' cal-today' : '') + (evs.length ? '' : ' cal-empty');
    cell.innerHTML = `<span class="cal-num">${Number(d.slice(8))}<span class="cal-num-m"> ${shortDate(d).split(' ')[1]}</span></span>`;
    for (const e of evs) {
      const kind = e.type === 'prep' ? 'prep' : e.status === 'submitted' ? 'submitted' : e.status === 'overdue' ? 'overdue' : 'due';
      const word = e.type === 'prep' ? 'Prep' : kind === 'submitted' ? 'Done' : kind === 'overdue' ? 'Late' : 'Due';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `cal-ev cal-${kind}`;
      b.title = `${e.type === 'prep' ? 'Prep starts' : 'Report due'} · ${e.topic_name}${e.category ? ' · ' + e.category : ''} · ${e.cadence}\nDue ${formatDate(e.due_date)}${e.owner ? ' · ' + e.owner : ''}`;
      b.innerHTML = `<b>${word}</b> ${escapeHtml(e.topic_name)}`;
      b.addEventListener('click', () => showTopic(e.topic_id));
      cell.appendChild(b);
    }
    grid.appendChild(cell);
  }
  app.appendChild(grid);
}


async function showHome() {
  setNav('topics');
  setHash('#topics');
  app.innerHTML = '<div class="loading">Loading topics…</div>';
  try {
    const topics = await api('/api/topics');
    renderHome(topics);
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Failed to load topics: ${escapeHtml(err.message)}</div>`;
  }
}

function renderHome(topics) {
  const active = topics.filter((t) => t.active !== false);
  app.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = `
    <div>
      <h1>Topics</h1>
      <p>Select a topic to enter the next status update.</p>
    </div>
  `;
  app.appendChild(head);

  if (!active.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No topics yet. Create one to get started.';
    app.appendChild(empty);
    return;
  }

  const RAG_RANK = { Red: 0, Amber: 1, Green: 2, Blue: 3 };

  const toolbar = document.createElement('div');
  toolbar.className = 'list-toolbar';
  toolbar.innerHTML = `
    <div class="field toolbar-search">
      <label class="sr-only" for="topic-filter-q">Search</label>
      <input id="topic-filter-q" type="search" placeholder="Search title, owner, BU…" autocomplete="off" />
    </div>
    <div class="field">
      <label class="sr-only" for="topic-filter-rag">Filter RAG</label>
      <select id="topic-filter-rag">
        <option value="">All RAG</option>
        <option value="Red">Red</option>
        <option value="Amber">Amber</option>
        <option value="Green">Green</option>
        <option value="Blue">Blue — Complete</option>
        <option value="none">No report</option>
      </select>
    </div>
    <div class="field">
      <label class="sr-only" for="topic-filter-category">Filter category</label>
      <select id="topic-filter-category">
        <option value="">All categories</option>
        ${CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
        <option value="none">Uncategorised</option>
      </select>
    </div>
    <div class="field">
      <label class="sr-only" for="topic-filter-cadence">Filter cadence</label>
      <select id="topic-filter-cadence">
        <option value="">All cadence</option>
        <option value="weekly">Weekly</option>
        <option value="fortnightly">Fortnightly</option>
        <option value="monthly">Monthly</option>
      </select>
    </div>
    <div class="field">
      <label class="sr-only" for="topic-sort">Sort</label>
      <select id="topic-sort">
        <option value="priority-asc" selected>Reporting order</option>
        <option value="name-asc">Name A–Z</option>
        <option value="name-desc">Name Z–A</option>
        <option value="rag-asc">RAG (worst first)</option>
        <option value="rag-desc">RAG (best first)</option>
        <option value="period-desc">Last period (newest)</option>
        <option value="period-asc">Last period (oldest)</option>
        <option value="owner-asc">Owner A–Z</option>
        <option value="owner-desc">Owner Z–A</option>
        <option value="cadence-asc">Cadence (weekly first)</option>
        <option value="cadence-desc">Cadence (monthly first)</option>
      </select>
    </div>
  `;
  app.appendChild(toolbar);

  const meta = document.createElement('div');
  meta.className = 'list-meta';
  app.appendChild(meta);

  const bulk = document.createElement('div');
  bulk.className = 'bulk-bar';
  bulk.hidden = true;
  app.appendChild(bulk);

  const list = document.createElement('div');
  list.className = 'topic-list';
  list.setAttribute('role', 'table');
  list.setAttribute('aria-label', 'Topics');
  app.appendChild(list);
  const selected = new Set();
  let visibleIds = [];
  const SORT_COLS = { name: ['name-asc', 'name-desc'], owner: ['owner-asc', 'owner-desc'], cadence: ['cadence-asc', 'cadence-desc'], rag: ['rag-asc', 'rag-desc'], period: ['period-asc', 'period-desc'] };
  const BULK_FIELDS = {
    cadence: { label: 'Cadence', options: [['weekly', 'Weekly'], ['fortnightly', 'Fortnightly'], ['monthly', 'Monthly']] },
    due_day: { label: 'Due day', options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((d, i) => [String(i + 1), d]) },
    category: { label: 'Category', options: CATEGORIES.map((c) => [c, c]) },
    business_unit: { label: 'Business unit', text: true },
    owner: { label: 'Owner', text: true }
  };

  function paintBulk() {
    bulk.hidden = !selected.size;
    if (!selected.size) { bulk.innerHTML = ''; return; }
    const field = bulk.dataset.field || 'cadence';
    const f = BULK_FIELDS[field];
    bulk.innerHTML = `<strong>${selected.size} selected</strong>
      <label class="sr-only" for="bulk-field">Field to update</label>
      <select id="bulk-field">${Object.entries(BULK_FIELDS).map(([k, v]) => `<option value="${k}"${k === field ? ' selected' : ''}>Set ${v.label.toLowerCase()}</option>`).join('')}</select>
      ${f.text ? '<input id="bulk-value" type="text" placeholder="New value" />' : `<select id="bulk-value">${f.options.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('')}</select>`}
      <button type="button" class="btn btn-primary btn-sm" data-apply>Apply to ${selected.size}</button>
      <button type="button" class="btn btn-ghost btn-sm btn-danger" data-del>Delete ${selected.size}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-clear>Clear selection</button>`;
    bulk.querySelector('[data-del]').addEventListener('click', async () => {
      const ids = [...selected];
      const names = ids.map((id) => (topics.find((x) => x.id === id) || {}).name).filter(Boolean);
      const list = names.slice(0, 5).join(', ') + (names.length > 5 ? ` and ${names.length - 5} more` : '');
      if (!window.confirm(`Permanently delete ${ids.length} topic${ids.length === 1 ? '' : 's'} (${list}) along with all their reports, key dates, review comments and POD? This can’t be undone.`)) return;
      let ok = 0; const failed = [];
      for (const id of ids) {
        try {
          await api('/api/topics/' + encodeURIComponent(id), { method: 'DELETE' });
          const i = topics.findIndex((x) => x.id === id); if (i >= 0) topics.splice(i, 1);
          const j = active.findIndex((x) => x.id === id); if (j >= 0) active.splice(j, 1);
          selected.delete(id); ok++;
        } catch (err) { failed.push(err.message); }
      }
      toast(`${ok} topic${ok === 1 ? '' : 's'} deleted${failed.length ? `; ${failed.length} failed: ${failed[0]}` : ''}`, failed.length ? 'error' : undefined);
      if (!active.length) return showHome();
      paint();
    });
    bulk.querySelector('#bulk-field').addEventListener('change', (e) => { bulk.dataset.field = e.target.value; paintBulk(); });
    bulk.querySelector('[data-clear]').addEventListener('click', () => { selected.clear(); paint(); });
    bulk.querySelector('[data-apply]').addEventListener('click', async (e) => {
      const raw = bulk.querySelector('#bulk-value').value.trim();
      if (f.text === undefined && !raw) return;
      const value = field === 'due_day' ? Number(raw) : raw;
      const btn = e.currentTarget;
      btn.disabled = true;
      let ok = 0; const failed = [];
      for (const id of [...selected]) {
        try {
          const updated = await api('/api/topics/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ [field]: value }) });
          const t = topics.find((x) => x.id === id);
          if (t) Object.assign(t, updated);
          ok++;
        } catch (err) { failed.push(err.message); }
      }
      btn.disabled = false;
      if (!failed.length) selected.clear();
      toast(`${f.label} updated on ${ok} topic${ok === 1 ? '' : 's'}${failed.length ? `; ${failed.length} failed: ${failed[0]}` : ''}`, failed.length ? 'error' : undefined);
      paint();
    });
  }

  const qInput = toolbar.querySelector('#topic-filter-q');
  const ragFilter = toolbar.querySelector('#topic-filter-rag');
  const cadenceFilter = toolbar.querySelector('#topic-filter-cadence');
  const categoryFilter = toolbar.querySelector('#topic-filter-category');
  if (pendingTopicFilter) {
    ragFilter.value = pendingTopicFilter.rag || '';
    categoryFilter.value = pendingTopicFilter.category || '';
    pendingTopicFilter = null;
  }
  const sortSelect = toolbar.querySelector('#topic-sort');

  function filteredSorted() {
    const q = (qInput.value || '').trim().toLowerCase();
    const ragF = ragFilter.value;
    const cadF = cadenceFilter.value;
    let rows = active.slice();

    if (q) {
      rows = rows.filter((t) => {
        const name = (t.name || '').toLowerCase();
        const owner = (t.owner || '').toLowerCase();
        const desc = (t.description || '').toLowerCase();
        const bu = (t.business_unit || '').toLowerCase();
        return name.includes(q) || owner.includes(q) || desc.includes(q) || bu.includes(q);
      });
    }
    if (ragF === 'none') {
      rows = rows.filter((t) => !t.latest_report || !t.latest_report.rag);
    } else if (ragF) {
      rows = rows.filter((t) => t.latest_report && t.latest_report.rag === ragF);
    }
    if (cadF) {
      rows = rows.filter((t) => t.cadence === cadF);
    }
    if (categoryFilter.value) {
      rows = rows.filter((t) => (categoryFilter.value === 'none' ? !t.category : t.category === categoryFilter.value));
    }

    const sort = sortSelect.value;
    rows.sort((a, b) => {
      const la = a.latest_report;
      const lb = b.latest_report;
      if (sort === 'priority-asc') {
        return ((a.sort_order || 0) - (b.sort_order || 0)) || (a.name || '').localeCompare(b.name || '');
      }
      if (sort === 'name-asc') return (a.name || '').localeCompare(b.name || '');
      if (sort === 'name-desc') return (b.name || '').localeCompare(a.name || '');
      if (sort === 'owner-asc' || sort === 'owner-desc') {
        const cmp = (a.owner || '').localeCompare(b.owner || '');
        return (sort === 'owner-asc' ? cmp : -cmp) || (a.name || '').localeCompare(b.name || '');
      }
      if (sort === 'cadence-asc' || sort === 'cadence-desc') {
        const order = { weekly: 0, fortnightly: 1, monthly: 2 };
        const cmp = (order[a.cadence] ?? 9) - (order[b.cadence] ?? 9);
        return (sort === 'cadence-asc' ? cmp : -cmp) || (a.name || '').localeCompare(b.name || '');
      }
      if (sort === 'rag-asc' || sort === 'rag-desc') {
        const ra = la && la.rag != null ? (RAG_RANK[la.rag] ?? 9) : 9;
        const rb = lb && lb.rag != null ? (RAG_RANK[lb.rag] ?? 9) : 9;
        const cmp = ra - rb;
        return (sort === 'rag-asc' ? cmp : -cmp) || (a.name || '').localeCompare(b.name || '');
      }
      if (sort === 'period-desc' || sort === 'period-asc') {
        const pa = (la && la.period_end) || '';
        const pb = (lb && lb.period_end) || '';
        const cmp = pa < pb ? -1 : pa > pb ? 1 : 0;
        return (sort === 'period-asc' ? cmp : -cmp) || (a.name || '').localeCompare(b.name || '');
      }
      return 0;
    });
    return rows;
  }

  function paint() {
    const rows = filteredSorted();
    list.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'topic-list-row topic-list-head';
    header.setAttribute('role', 'row');
    const sortBtn = (col, label) => {
      const [asc, desc] = SORT_COLS[col];
      const cur = sortSelect.value;
      const arrow = cur === asc ? ' ▲' : cur === desc ? ' ▼' : '';
      return `<div role="columnheader" aria-sort="${cur === asc ? 'ascending' : cur === desc ? 'descending' : 'none'}"><button type="button" class="th-sort" data-sortcol="${col}">${label}${arrow}</button></div>`;
    };
    header.innerHTML = `
      <div role="columnheader" class="topic-list-sel"><input type="checkbox" data-selall aria-label="Select all shown topics" /></div>
      ${sortBtn('name', 'Topic')}
      ${sortBtn('owner', 'Owner')}
      ${sortBtn('cadence', 'Cadence')}
      ${sortBtn('rag', 'Status')}
      ${sortBtn('period', 'Last period')}
      <div role="columnheader"><span class="sr-only">Actions</span></div>
    `;
    list.appendChild(header);
    header.querySelectorAll('[data-sortcol]').forEach((b) => b.addEventListener('click', () => {
      const [asc, desc] = SORT_COLS[b.dataset.sortcol];
      sortSelect.value = sortSelect.value === asc ? desc : asc;
      paint();
    }));
    visibleIds = rows.map((t) => t.id);
    const selAll = header.querySelector('[data-selall]');
    const nSel = visibleIds.filter((id) => selected.has(id)).length;
    selAll.checked = nSel > 0 && nSel === visibleIds.length;
    selAll.indeterminate = nSel > 0 && nSel < visibleIds.length;
    selAll.addEventListener('change', () => {
      for (const id of visibleIds) selAll.checked ? selected.add(id) : selected.delete(id);
      paint();
    });
    paintBulk();

    meta.textContent = rows.length === active.length
      ? `${rows.length} topic${rows.length === 1 ? '' : 's'}`
      : `${rows.length} of ${active.length} topics`;

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state empty-filtered';
      const msg = document.createElement('p');
      msg.textContent = 'No topics match these filters.';
      empty.appendChild(msg);
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'btn btn-ghost btn-sm';
      clearBtn.textContent = 'Clear filters';
      clearBtn.addEventListener('click', () => {
        qInput.value = '';
        ragFilter.value = '';
        cadenceFilter.value = '';
        categoryFilter.value = '';
        sortSelect.value = 'priority-asc';
        paint();
      });
      empty.appendChild(clearBtn);
      list.appendChild(empty);
      return;
    }

    for (const t of rows) {
      const latest = t.latest_report;
      const period = !latest
        ? 'No updates yet'
        : t.cadence === 'weekly'
          ? `Week ending ${formatDate(latest.period_end)}`
          : formatDate(latest.period_end);
      const desc = (t.description || '').replace(/\s+/g, ' ').trim();
      const summary = latest && latest.exec_summary
        ? String(latest.exec_summary).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
      const rawSnippet = desc || summary;
      const snippet = rawSnippet.length > 120 ? rawSnippet.slice(0, 117) + '…' : rawSnippet;

      const row = document.createElement('div');
      row.className = 'topic-list-row' + (latest && latest.rag ? ' rag-edge-' + latest.rag : '');
      row.setAttribute('role', 'row');
      row.tabIndex = 0;
      const open = () => showTopic(t.id);
      row.addEventListener('click', (e) => {
        if (e.target.closest('button, input, select, label')) return;
        open();
      });
      row.addEventListener('keydown', (e) => {
        if (e.target.closest('button, input, select, label')) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });

      row.innerHTML = `
        <div class="topic-list-sel" role="cell"><input type="checkbox" data-sel aria-label="Select ${escapeHtml(t.name)}"${selected.has(t.id) ? ' checked' : ''} /></div>
        <div class="topic-list-topic" role="cell">
          <div class="topic-list-name">${escapeHtml(t.name)} ${categoryTag(t.category)}</div>
          ${snippet ? `<div class="topic-list-snippet">${escapeHtml(snippet)}</div>` : ''}
        </div>
        <div class="topic-list-owner" role="cell">
          ${t.owner ? avatar(t.owner) : ''}
          <span class="owner-text">${t.owner ? escapeHtml(t.owner) : '—'}
          ${t.business_unit ? `<span class="topic-list-bu">${escapeHtml(t.business_unit)}</span>` : ''}</span>
        </div>
        <div class="topic-list-cadence" role="cell"><select class="cadence-select" data-cadence aria-label="Cadence for ${escapeHtml(t.name)}">${['weekly', 'fortnightly', 'monthly'].map((c) => `<option value="${c}"${t.cadence === c ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="topic-list-status" role="cell">${latest
          ? statusUnit(latest.rag, latest.trend)
          : statusUnit(null, null)}</div>
        <div class="topic-list-period" role="cell">${escapeHtml(period)}</div>
        <div class="topic-list-actions" role="cell">
          <button type="button" class="btn btn-ghost btn-sm" data-edit>Edit</button>
        </div>
      `;
      row.querySelector('[data-sel]').addEventListener('change', (e) => {
        e.target.checked ? selected.add(t.id) : selected.delete(t.id);
        row.classList.toggle('is-selected', e.target.checked);
        const n = visibleIds.filter((id) => selected.has(id)).length;
        const all = list.querySelector('[data-selall]');
        all.checked = n > 0 && n === visibleIds.length;
        all.indeterminate = n > 0 && n < visibleIds.length;
        paintBulk();
      });
      if (selected.has(t.id)) row.classList.add('is-selected');
      const cadSel = row.querySelector('[data-cadence]');
      cadSel.addEventListener('click', (e) => e.stopPropagation());
      cadSel.addEventListener('keydown', (e) => e.stopPropagation());
      cadSel.addEventListener('change', async () => {
        const prev = t.cadence;
        cadSel.disabled = true;
        try {
          await api('/api/topics/' + encodeURIComponent(t.id), { method: 'PATCH', body: JSON.stringify({ cadence: cadSel.value }) });
          t.cadence = cadSel.value;
          toast(`${t.name}: ${t.cadence}`);
          if (cadenceFilter.value || sortSelect.value === 'cadence-asc') paint();
        } catch (err) {
          cadSel.value = prev;
          toast(err.message, 'error');
        } finally { cadSel.disabled = false; }
      });
      row.querySelector('[data-edit]').addEventListener('click', (e) => {
        e.stopPropagation();
        openTopicModal(t, { afterSave: 'home' });
      });
      list.appendChild(row);
    }
  }

  qInput.addEventListener('input', paint);
  ragFilter.addEventListener('change', paint);
  cadenceFilter.addEventListener('change', paint);
  categoryFilter.addEventListener('change', paint);
  sortSelect.addEventListener('change', paint);
  paint();
}


function formatFriHeader(isoDate) {
  // Week-ending Friday headers: dd-mmm-yyyy (Mike brief)
  return formatDate(isoDate);
}

/** Packed 8-week key-dates text grid: descriptions in cells, shared rows on clash, no Item column. */
function renderKeyDatesGrid(weekFridays, currentEnding, keyDates) {
  if (!keyDates || !keyDates.length || !weekFridays || weekFridays.length !== 8) return null;

  const byWeek = new Map();
  for (const fri of weekFridays) byWeek.set(fri, []);
  const outside = [];
  const sorted = keyDates.slice().sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') || (a.description || '').localeCompare(b.description || '')
  );
  for (const kd of sorted) {
    if (!kd.date) continue;
    const fri = weekEndingFridayContaining(kd.date);
    if (!byWeek.has(fri)) {
      outside.push(kd);
      continue;
    }
    byWeek.get(fri).push(kd);
  }

  const inWindow = weekFridays.some((f) => byWeek.get(f).length > 0);
  // Omit entire block if topic has no key dates that render (none in window and none outside)
  if (!inWindow && !outside.length) return null;

  const wrap = document.createElement('div');
  wrap.className = 'key-dates-block weekly-key-dates';
  const label = document.createElement('div');
  label.className = 'panel-label';
  label.textContent = 'Key dates';
  wrap.appendChild(label);

  if (inWindow) {
    // Pack: row i holds the i-th milestone of each week column (extra rows only on clash)
    let maxStack = 0;
    weekFridays.forEach((fri) => {
      maxStack = Math.max(maxStack, (byWeek.get(fri) || []).length);
    });

    const scroll = document.createElement('div');
    scroll.className = 'key-dates-scroll';
    const table = document.createElement('table');
    table.className = 'key-dates-grid';
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', 'Key dates by week');

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    weekFridays.forEach((fri, i) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.className = 'kd-col-head';
      if (fri === currentEnding) th.classList.add('is-current-week');
      if (i < 4) th.classList.add('is-past-week');
      if (i > 4) th.classList.add('is-future-week');
      th.innerHTML = '<span class="kd-col-dow">Fri</span><span class="kd-col-date">' +
        escapeHtml(formatFriHeader(fri)) + '</span>';
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let r = 0; r < maxStack; r++) {
      const tr = document.createElement('tr');
      weekFridays.forEach((fri, i) => {
        const td = document.createElement('td');
        td.className = 'kd-cell';
        if (fri === currentEnding) td.classList.add('is-current-week');
        if (i < 4) td.classList.add('is-past-week');
        if (i > 4) td.classList.add('is-future-week');
        const items = byWeek.get(fri) || [];
        const kd = items[r];
        if (kd) {
          const full = (kd.description || 'Untitled').trim();
          const tip = full + ' · ' + formatDate(kd.date);
          const span = document.createElement('span');
          span.className = 'kd-cell-text';
          span.textContent = full;
          span.title = tip;
          td.classList.add('has-item');
          td.appendChild(span);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);
  }

  if (outside.length) {
    const out = document.createElement('p');
    out.className = 'key-dates-outside';
    out.innerHTML = '<span class="key-dates-outside-label">Outside window:</span> ' +
      outside.map((kd) => escapeHtml(kd.description || 'Untitled') + ' · ' + escapeHtml(formatDate(kd.date))).join(' · ');
    wrap.appendChild(out);
  }
  return wrap;
}

async function openTopicModal(existing = null, opts = {}) {
  const editing = Boolean(existing);
  const afterSave = opts.afterSave || (editing ? 'topic' : 'home');

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const cadence = (existing && existing.cadence) || 'weekly';
  const dueDay = Number(existing && existing.due_day) || 5;
  const priorityVal = existing && existing.sort_order != null && existing.sort_order !== ''
    ? Number(existing.sort_order)
    : '';
  backdrop.innerHTML = `
    <div class="modal modal-wide">
      <h2>${editing ? 'Edit topic' : 'New topic'}</h2>
      <div class="field">
        <label for="topic-name">Title <span class="req-mark" title="Required">*</span></label>
        <input id="topic-name" type="text" autocomplete="off" required value="${escapeHtml((existing && existing.name) || '')}" />
      </div>
      <div class="field">
        <label for="topic-description">Description</label>
        <textarea id="topic-description" rows="3" placeholder="Optional brief for this topic…">${escapeHtml((existing && existing.description) || '')}</textarea>
      </div>
      <div class="field">
        <label for="topic-category">Category <span class="req-mark" title="Required">*</span></label>
        <select id="topic-category" required>
          <option value=""${existing && existing.category ? '' : ' selected'} disabled>Select a category…</option>
          ${CATEGORIES.map((c) => `<option value="${escapeHtml(c)}"${existing && existing.category === c ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
        <p class="field-hint">Project, proof of concept (POC), or an AI use case progressing towards production.</p>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="topic-owner">Owner</label>
          <input id="topic-owner" type="text" autocomplete="off" value="${escapeHtml((existing && existing.owner) || '')}" />
        </div>
        <div class="field">
          <label for="topic-bu">Business unit</label>
          <input id="topic-bu" type="text" autocomplete="off" value="${escapeHtml((existing && existing.business_unit) || '')}" />
        </div>
      </div>
      <div class="field">
        <label>POD <span class="req-mark" title="Required">*</span></label>
        <div class="pod-edit" id="topic-pod"></div>
        <button type="button" class="btn btn-ghost btn-sm" id="pod-add">+ Add member</button>
        <p class="field-hint">The team delivering this topic: at least one member, each with a role. Roles are managed in Settings.</p>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="topic-cadence">Cadence</label>
          <select id="topic-cadence">
            <option value="weekly"${cadence === 'weekly' ? ' selected' : ''}>Weekly</option>
            <option value="fortnightly"${cadence === 'fortnightly' ? ' selected' : ''}>Fortnightly</option>
            <option value="monthly"${cadence === 'monthly' ? ' selected' : ''}>Monthly</option>
          </select>
        </div>
        <div class="field">
          <label for="topic-due-day">Due day</label>
          <select id="topic-due-day">
            ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((d, i) => `<option value="${i + 1}"${dueDay === i + 1 ? ' selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="topic-priority">Reporting order</label>
          <input id="topic-priority" type="number" min="1" step="1" placeholder="e.g. 1" value="${priorityVal === '' || Number.isNaN(priorityVal) ? '' : escapeHtml(String(priorityVal))}" />
          <p class="field-hint">Position in the weekly pack and topic list; 1 is reported first.</p>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="button" class="btn btn-primary" data-save>${editing ? 'Save' : 'Create'}</button>
      </div>
    </div>
  `;

  const close = () => backdrop.remove();
  backdrop.querySelector('[data-cancel]').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  const podBox = backdrop.querySelector('#topic-pod');
  const addPodRow = (m = {}) => {
    const row = document.createElement('div');
    row.className = 'pod-row';
    row.innerHTML = `
      <input type="text" class="pod-name" maxlength="80" placeholder="Name" autocomplete="off" aria-label="Member name" value="${escapeHtml(m.name || '')}" />
      <select class="pod-role" aria-label="Role">
        <option value=""${m.role_id ? '' : ' selected'} disabled>Role…</option>
        ${ROLES.map((r) => `<option value="${escapeHtml(r.id)}"${m.role_id === r.id ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
      </select>
      <button type="button" class="icon-btn" aria-label="Remove member">✕</button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    podBox.appendChild(row);
    return row;
  };
  ((existing && existing.pod) || []).forEach(addPodRow);
  if (!podBox.children.length) addPodRow();
  backdrop.querySelector('#pod-add').addEventListener('click', () => addPodRow().querySelector('.pod-name').focus());

  backdrop.querySelector('[data-save]').addEventListener('click', async () => {
    const pod = [...podBox.querySelectorAll('.pod-row')].map((r) => ({ name: r.querySelector('.pod-name').value.trim(), role_id: r.querySelector('.pod-role').value }))
      .filter((m) => m.name || m.role_id);
    const name = backdrop.querySelector('#topic-name').value.trim();
    const description = backdrop.querySelector('#topic-description').value.trim();
    const cadenceVal = backdrop.querySelector('#topic-cadence').value;
    const owner = backdrop.querySelector('#topic-owner').value.trim();
    const business_unit = backdrop.querySelector('#topic-bu').value.trim();
    const priorityRaw = backdrop.querySelector('#topic-priority').value.trim();
    const category = backdrop.querySelector('#topic-category').value;
    if (!name) {
      toast('Title is required', 'error');
      return;
    }
    if (!category) {
      toast('Choose a category', 'error');
      backdrop.querySelector('#topic-category').focus();
      return;
    }
    if (!pod.length) {
      toast('Add at least one POD member', 'error');
      return;
    }
    if (pod.some((m) => !m.name || !m.role_id)) {
      toast('Every POD member needs a name and a role', 'error');
      return;
    }
    const payload = { name, description, cadence: cadenceVal, due_day: Number(backdrop.querySelector('#topic-due-day').value), owner, business_unit, category, pod };
    if (priorityRaw !== '') {
      const n = Number(priorityRaw);
      if (!Number.isFinite(n) || n < 1) {
        toast('Reporting order must be a number ≥ 1', 'error');
        return;
      }
      payload.sort_order = Math.round(n);
    }
    try {
      if (editing) {
        await api('/api/topics/' + encodeURIComponent(existing.id), {
          method: 'PATCH',
          body: JSON.stringify(payload)
        });
        toast('Topic updated');
        close();
        if (afterSave === 'home') showHome();
        else showTopic(existing.id);
      } else {
        const created = await api('/api/topics', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        toast('Topic created');
        close();
        showHome();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.body.appendChild(backdrop);
  backdrop.querySelector('#topic-name').focus();
}

function openNewTopicModal() {
  openTopicModal(null);
}


async function loadTopicWithHistory(topicId) {
  const topics = await api('/api/topics');
  const topic = topics.find((t) => t.id === topicId);
  if (!topic) return { topic: null, history: [] };
  let history = [];
  try {
    history = await api(`/api/topics/${encodeURIComponent(topicId)}/reports`);
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }
  return { topic, history };
}

function topicHeadHtml(topic) {
  const topicDesc = (topic.description || '').replace(/\s+/g, ' ').trim();
  return `
    <div>
      <h1>${escapeHtml(topic.name)}</h1>
      ${topicDesc ? `<p class="topic-page-desc">${escapeHtml(topicDesc)}</p>` : ''}
      <p>
        ${categoryTag(topic.category)}
        ${cadenceText(topic.cadence)}
        ${topic.owner ? `<span class="topic-owner"> · ${escapeHtml(topic.owner)}</span>` : ''}
        ${topic.business_unit ? `<span class="topic-owner"> · ${escapeHtml(topic.business_unit)}</span>` : ''}
      </p>
      ${podChips(topic.pod)}
    </div>`;
}

/** Topic page: header plus the list of reports; click a report to drill in. */
/** Simple calendar-quarter timeline of key dates, as HTML. `anchor` is a YYYY-MM-DD inside the quarter to show. */
function quarterTimelineHtml(dates, anchor) {
  dates = Array.isArray(dates) ? dates : [];
  const a = new Date((anchor || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  const q = Math.floor(a.getUTCMonth() / 3);
  const y = a.getUTCFullYear();
  const start = Date.UTC(y, q * 3, 1);
  const end = Date.UTC(y, q * 3 + 3, 1);
  const pct = (t) => ((t - start) / (end - start)) * 100;
  const months = [0, 1, 2].map((i) => new Date(Date.UTC(y, q * 3 + i, 1)));
  const inQ = dates.filter((d) => { const t = Date.parse(d.date + 'T00:00:00Z'); return t >= start && t < end; })
    .sort((m, n) => m.date.localeCompare(n.date));
  const today = Date.now();
  const marks = inQ.map((d, i) => `<span class="qt-mark" style="left:${pct(Date.parse(d.date + 'T00:00:00Z')).toFixed(2)}%" data-tip="${escapeHtml(formatDate(d.date) + ' · ' + d.description)}"><span class="qt-dot">${i + 1}</span></span>`).join('');
  const legend = inQ.map((d, i) => `<li><span class="qt-num">${i + 1}</span><span class="qt-date">${escapeHtml(shortDate(d.date))}</span><span class="qt-desc">${escapeHtml(d.description)}</span></li>`).join('');
  return `<div class="panel-label">Q${q + 1} ${y} timeline</div>
    <div class="qt"><div class="qt-months">${months.map((m) => `<span>${m.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}</span>`).join('')}</div>
    <div class="qt-track">${today >= start && today < end ? `<div class="qt-today" style="left:${pct(today).toFixed(2)}%"><em>Today</em></div>` : ''}${marks}</div>
    ${inQ.length ? `<ol class="qt-legend">${legend}</ol>` : ''}</div>
    ${inQ.length ? '' : '<p class="report-empty">No key dates this quarter.</p>'}`;
}

async function quarterTimelinePanel(topicId, anchor) {
  let dates = [];
  try { dates = await api(`/api/topics/${encodeURIComponent(topicId)}/key-dates`); } catch { dates = []; }
  const sec = document.createElement('section');
  sec.className = 'panel';
  sec.innerHTML = quarterTimelineHtml(dates, anchor);
  return sec;
}

async function showTopic(topicId) {
  setNav('topics');
  setHash('#topic=' + topicId);
  app.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const { topic, history } = await loadTopicWithHistory(topicId);
    if (!topic) {
      app.innerHTML = '<div class="empty-state">Topic not found.</div>';
      return;
    }
    app.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'page-head';
    head.innerHTML = topicHeadHtml(topic);
    const actions = document.createElement('div');
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-ghost';
    back.textContent = '← Topics';
    back.addEventListener('click', () => showHome());
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-ghost';
    edit.textContent = 'Edit topic';
    edit.addEventListener('click', () => openTopicModal(topic));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-primary';
    add.textContent = 'New update';
    add.addEventListener('click', () => showTopicUpdate(topic.id));
    const kdBtn = document.createElement('button');
    kdBtn.type = 'button';
    kdBtn.className = 'btn btn-ghost';
    kdBtn.textContent = 'Key dates';
    kdBtn.addEventListener('click', () => showKeyDates(topic.id));
    actions.append(back, ' ', kdBtn, ' ', edit, ' ', add);
    head.appendChild(actions);
    app.appendChild(head);

    app.appendChild(await quarterTimelinePanel(topic.id));
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.innerHTML = `<h2><span class="panel-label">Reports</span></h2>`;
    if (!history.length) {
      panel.insertAdjacentHTML('beforeend', '<p class="report-empty">No reports yet for this topic.</p>');
    } else {
      const RANK = { Red: 0, Amber: 1, Green: 2, Blue: 3 };
      const tb = document.createElement('div');
      tb.className = 'list-toolbar';
      tb.innerHTML = `
        <div class="field toolbar-search"><label class="sr-only" for="rep-q">Search</label><input id="rep-q" type="search" placeholder="Search reports…" autocomplete="off" /></div>
        <div class="field"><label class="sr-only" for="rep-rag">Filter RAG</label><select id="rep-rag"><option value="">All RAG</option><option>Red</option><option>Amber</option><option>Green</option><option value="Blue">Blue — Complete</option></select></div>
        <div class="field"><label class="sr-only" for="rep-trend">Filter trend</label><select id="rep-trend"><option value="">All trends</option><option>Improving</option><option>Stable</option><option>Declining</option></select></div>
        <div class="field"><label class="sr-only" for="rep-sort">Sort</label><select id="rep-sort"><option value="period-desc">Newest first</option><option value="period-asc">Oldest first</option><option value="rag-asc">RAG (worst first)</option><option value="rag-desc">RAG (best first)</option></select></div>`;
      panel.appendChild(tb);
      const meta = document.createElement('div');
      meta.className = 'list-meta';
      panel.appendChild(meta);
      const bulk = document.createElement('div');
      bulk.className = 'bulk-bar';
      bulk.hidden = true;
      panel.appendChild(bulk);
      var list = document.createElement('div');
      list.className = 'topic-list';
      const sel = new Set();
      let shown = [];
      const q = tb.querySelector('#rep-q'), ragF = tb.querySelector('#rep-rag'), trF = tb.querySelector('#rep-trend'), sortS = tb.querySelector('#rep-sort');
      const plain = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const paintBulkR = () => {
        bulk.hidden = !sel.size;
        if (!sel.size) { bulk.innerHTML = ''; return; }
        bulk.innerHTML = `<strong>${sel.size} selected</strong>
          <label class="sr-only" for="rep-bulk-trend">Set trend</label>
          <select id="rep-bulk-trend"><option value="">Set trend…</option><option>Improving</option><option>Stable</option><option>Declining</option></select>
          <button type="button" class="btn btn-ghost btn-sm btn-danger" data-del>Delete ${sel.size}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-clear>Clear selection</button>`;
        bulk.querySelector('[data-clear]').addEventListener('click', () => { sel.clear(); paintR(); });
        bulk.querySelector('#rep-bulk-trend').addEventListener('change', async (e) => {
          const trend = e.target.value;
          if (!trend) return;
          let ok = 0; const failed = [];
          for (const id of [...sel]) {
            try { const u = await api('/api/reports/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ trend }) }); const r = history.find((x) => x.id === id); if (r) Object.assign(r, u); ok++; }
            catch (err) { failed.push(err.message); }
          }
          if (!failed.length) sel.clear();
          toast(`Trend updated on ${ok} report${ok === 1 ? '' : 's'}${failed.length ? `; ${failed.length} failed: ${failed[0]}` : ''}`, failed.length ? 'error' : undefined);
          paintR();
        });
        bulk.querySelector('[data-del]').addEventListener('click', async () => {
          if (!window.confirm(`Delete ${sel.size} report${sel.size === 1 ? '' : 's'}? This can’t be undone.`)) return;
          let ok = 0; const failed = [];
          for (const id of [...sel]) {
            try { await api('/api/reports/' + encodeURIComponent(id), { method: 'DELETE' }); const i = history.findIndex((x) => x.id === id); if (i >= 0) history.splice(i, 1); sel.delete(id); ok++; }
            catch (err) { failed.push(err.message); }
          }
          toast(`${ok} report${ok === 1 ? '' : 's'} deleted${failed.length ? `; ${failed.length} failed: ${failed[0]}` : ''}`, failed.length ? 'error' : undefined);
          paintR();
        });
      };
      function paintR() {
        const term = q.value.trim().toLowerCase();
        shown = history.filter((r) => (!ragF.value || r.rag === ragF.value) && (!trF.value || r.trend === trF.value) &&
          (!term || (historyPeriodLabel(r, topic.cadence) + ' ' + plain(r.exec_summary) + ' ' + plain(r.achievements) + ' ' + plain(r.next_steps)).toLowerCase().includes(term)));
        const s = sortS.value;
        shown.sort((a, b) => {
          if (s.startsWith('rag')) { const c = (RANK[a.rag] ?? 9) - (RANK[b.rag] ?? 9); if (c) return s === 'rag-asc' ? c : -c; }
          const c = (a.period_end || '').localeCompare(b.period_end || '');
          return s === 'period-asc' ? c : -c;
        });
        meta.textContent = shown.length === history.length ? `${shown.length} report${shown.length === 1 ? '' : 's'}` : `${shown.length} of ${history.length} reports`;
        list.innerHTML = `<div class="topic-list-row topic-list-head rep-row"><div class="topic-list-sel"><input type="checkbox" data-selall aria-label="Select all shown reports" /></div><div>Period</div><div>Status</div></div>`;
        const all = list.querySelector('[data-selall]');
        const refreshAll = () => { const n = shown.filter((r) => sel.has(r.id)).length; all.checked = n > 0 && n === shown.length; all.indeterminate = n > 0 && n < shown.length; };
        all.addEventListener('change', () => { shown.forEach((r) => (all.checked ? sel.add(r.id) : sel.delete(r.id))); paintR(); });
        if (!shown.length) list.insertAdjacentHTML('beforeend', '<div class="empty-state empty-filtered"><p>No reports match these filters.</p></div>');
        for (const r of shown) {
          const snippet = plain(r.exec_summary);
          const row = document.createElement('div');
          row.className = 'topic-list-row rep-row' + (r.rag ? ' rag-edge-' + r.rag : '') + (sel.has(r.id) ? ' is-selected' : '');
          row.tabIndex = 0;
          const open = () => showReport(topic.id, r.id);
          row.addEventListener('click', (e) => { if (!e.target.closest('input, label')) open(); });
          row.addEventListener('keydown', (e) => { if (!e.target.closest('input') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } });
          row.innerHTML = `
            <div class="topic-list-sel"><input type="checkbox" data-sel aria-label="Select ${escapeHtml(historyPeriodLabel(r, topic.cadence))}"${sel.has(r.id) ? ' checked' : ''} /></div>
            <div class="topic-list-topic">
              <div class="topic-list-name">${escapeHtml(historyPeriodLabel(r, topic.cadence))}</div>
              ${snippet ? `<div class="topic-list-snippet">${escapeHtml(snippet.length > 160 ? snippet.slice(0, 157) + '…' : snippet)}</div>` : ''}
            </div>
            <div class="topic-list-status">${statusUnit(r.rag, r.trend)}</div>`;
          row.querySelector('[data-sel]').addEventListener('change', (e) => {
            e.target.checked ? sel.add(r.id) : sel.delete(r.id);
            row.classList.toggle('is-selected', e.target.checked);
            refreshAll(); paintBulkR();
          });
          list.appendChild(row);
        }
        refreshAll(); paintBulkR();
      }
      [q, ragF, trF, sortS].forEach((el) => el.addEventListener(el === q ? 'input' : 'change', paintR));
      paintR();
    }
    if (typeof list !== 'undefined') panel.appendChild(list);
    app.appendChild(panel);
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function confirmDeleteReport(topic, report) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.innerHTML = `<div class="modal">
    <h2>Delete this update?</h2>
    <p>${escapeHtml(topic.name)} · ${escapeHtml(historyPeriodLabel(report, topic.cadence))}. This can’t be undone. Review comments for the week are kept.</p>
    <div class="modal-actions"><button type="button" class="btn btn-ghost" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-ok>Delete</button></div></div>`;
  const close = () => backdrop.remove();
  backdrop.querySelector('[data-cancel]').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  backdrop.querySelector('[data-ok]').addEventListener('click', async () => {
    try {
      await api('/api/reports/' + encodeURIComponent(report.id), { method: 'DELETE' });
      close();
      toast('Update deleted');
      showTopic(topic.id);
    } catch (err) { toast(err.message, 'error'); }
  });
  document.body.appendChild(backdrop);
  backdrop.querySelector('[data-ok]').focus();
}

/** Read-only view of a single report. */
async function showReport(topicId, reportId) {
  setNav('topics');
  setHash('#topic=' + topicId + '/report=' + reportId);
  app.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const { topic, history } = await loadTopicWithHistory(topicId);
    const report = history.find((r) => r.id === reportId);
    if (!topic || !report) {
      app.innerHTML = '<div class="empty-state">Report not found.</div>';
      return;
    }
    app.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'page-head';
    head.innerHTML = `<div><h1>${escapeHtml(topic.name)}</h1>
      <p>${escapeHtml(historyPeriodLabel(report, topic.cadence))} ${statusUnit(report.rag, report.trend)}</p></div>`;
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-ghost';
    back.textContent = '← ' + topic.name;
    back.addEventListener('click', () => showTopic(topic.id));
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-primary';
    editBtn.textContent = 'Edit update';
    editBtn.addEventListener('click', () => showTopicUpdate(topic.id, report.id));
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-ghost btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => confirmDeleteReport(topic, report));
    const headActions = document.createElement('div');
    headActions.append(back, ' ', delBtn, ' ', editBtn);
    head.appendChild(headActions);
    app.appendChild(head);

    app.appendChild(await quarterTimelinePanel(topic.id, report.period_end));
    const defs = [
      ['Exec summary', report.exec_summary],
      ['Achievements', report.achievements],
      ['Next steps', report.next_steps]
    ];
    if (report.gtg_plan && !isEmptyRich(report.gtg_plan)) defs.push(['Get-to-green plan', report.gtg_plan]);
    for (const [label, html] of defs) {
      const sec = document.createElement('section');
      sec.className = 'panel';
      sec.innerHTML = `<h2><span class="panel-label">${escapeHtml(label)}</span></h2><div class="report-body">${html || '<p class="report-empty">—</p>'}</div>`;
      app.appendChild(sec);
    }
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

async function showTopicUpdate(topicId, reportId) {
  setNav('topics');
  if (reportId) setHash('#topic=' + topicId + '/edit=' + reportId);
  app.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const topics = await api('/api/topics');
    const topic = topics.find((t) => t.id === topicId);
    if (!topic) {
      app.innerHTML = '<div class="empty-state">Topic not found.</div>';
      return;
    }
    // History is newest-first (created_at desc) from GET /api/topics/:id/reports
    let history = [];
    try {
      history = await api(`/api/topics/${encodeURIComponent(topicId)}/reports`);
      if (!Array.isArray(history)) history = [];
    } catch {
      history = [];
    }
    const editing = reportId ? history.find((r) => r.id === reportId) : null;
    if (reportId && !editing) {
      app.innerHTML = '<div class="empty-state">Report not found.</div>';
      return;
    }
    const previous = editing || history[0] || topic.latest_report || null;
    renderTopicUpdate(topic, previous, history, editing);
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

/** Period label for history UI — newest-first list; dd-mmm-yyyy. */
function historyPeriodLabel(report, cadence) {
  if (!report) return '—';
  if (cadence === 'weekly') {
    return 'Week ending ' + formatDate(report.period_end);
  }
  const a = formatDate(report.period_start);
  const b = formatDate(report.period_end);
  if (!report.period_start) return b;
  // Compact range: "15-Sep → 28-Sep-2026"
  const aParts = a.split('-');
  const bParts = b.split('-');
  if (aParts.length === 3 && bParts.length === 3 && aParts[2] === bParts[2]) {
    return aParts[0] + '-' + aParts[1] + ' → ' + b;
  }
  return a + ' → ' + b;
}

function historySourceShort(report) {
  if (!report || !report.period_end) return '';
  return formatDate(report.period_end);
}

function renderReportPanel(title, reports, emptyMsg, cadence, copyHooks) {
  const history = Array.isArray(reports) ? reports.slice() : (reports ? [reports] : []);
  const panel = document.createElement('section');
  panel.className = 'panel previous-panel is-collapsed';
  panel.setAttribute('tabindex', '0');
  panel.setAttribute('aria-label', 'Previous updates history');

  const head = document.createElement('div');
  head.className = 'previous-head';

  const h2 = document.createElement('h2');
  h2.innerHTML = `<span class="panel-label">${escapeHtml(title)}</span>`;
  head.appendChild(h2);
  panel.appendChild(head);

  if (!history.length) {
    const empty = document.createElement('p');
    empty.className = 'report-empty';
    empty.textContent = emptyMsg || 'No previous update.';
    panel.appendChild(empty);
    return panel;
  }

  // Index 0 = newest (API: created_at desc). ◀ = older (↑index), ▶ = newer (↓index).
  let index = 0;

  const nav = document.createElement('div');
  nav.className = 'previous-nav';
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', 'Browse previous updates, newest first');

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'btn btn-ghost btn-sm previous-nav-btn';
  prevBtn.setAttribute('aria-label', 'Older update');
  prevBtn.title = 'Older update';
  prevBtn.textContent = '◀';

  const select = document.createElement('select');
  select.className = 'previous-period-select';
  select.setAttribute('aria-label', 'Select previous update period');
  history.forEach((r, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = historyPeriodLabel(r, cadence);
    select.appendChild(opt);
  });

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'btn btn-ghost btn-sm previous-nav-btn';
  nextBtn.setAttribute('aria-label', 'Newer update');
  nextBtn.title = 'Newer update';
  nextBtn.textContent = '▶';

  nav.appendChild(prevBtn);
  nav.appendChild(select);
  nav.appendChild(nextBtn);
  head.appendChild(nav);

  const copyPrimary = document.createElement('button');
  copyPrimary.type = 'button';
  copyPrimary.className = 'btn btn-ghost btn-sm previous-copy-btn';
  copyPrimary.textContent = 'Copy selected → form';
  copyPrimary.title = 'Copy the selected previous update into the new form';
  head.appendChild(copyPrimary);

  const dotsWrap = document.createElement('div');
  dotsWrap.className = 'previous-dots';
  dotsWrap.setAttribute('aria-hidden', history.length > 12 ? 'true' : 'false');
  if (history.length <= 12) {
    // older → newer (left = oldest = last index)
    for (let i = history.length - 1; i >= 0; i--) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'previous-dot';
      dot.dataset.index = String(i);
      dot.title = historyPeriodLabel(history[i], cadence);
      dot.setAttribute('aria-label', historyPeriodLabel(history[i], cadence));
      dotsWrap.appendChild(dot);
    }
  }
  panel.appendChild(dotsWrap);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-ghost btn-sm previous-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  panel.appendChild(toggle);

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'previous-body';
  panel._previousBody = bodyWrap;
  panel.appendChild(bodyWrap);

  function currentReport() {
    return history[index];
  }

  function sectionDefsFor(report) {
    const defs = [
      { key: 'exec_summary', label: 'Exec summary', html: report.exec_summary },
      { key: 'achievements', label: 'Achievements', html: report.achievements },
      { key: 'next_steps', label: 'Next steps', html: report.next_steps }
    ];
    if (report.gtg_plan && !isEmptyRich(report.gtg_plan)) {
      defs.push({ key: 'gtg_plan', label: 'Get-to-green plan', html: report.gtg_plan });
    }
    return defs;
  }

  function copySection(key, html, label) {
    if (!copyHooks || !copyHooks.fields || !copyHooks.fields[key]) return;
    copyHooks.fields[key].setHtml(html || '');
    if (typeof copyHooks.syncGtg === 'function') copyHooks.syncGtg();
    const src = historySourceShort(currentReport());
    toast(src ? `Copied ${label} (from ${src})` : `Copied ${label}`);
  }

  function copyStatus() {
    const report = currentReport();
    if (!copyHooks || !report) return;
    if (copyHooks.ragSelect && report.rag) copyHooks.ragSelect.value = report.rag;
    if (copyHooks.trendSelect && report.trend) copyHooks.trendSelect.value = report.trend;
    if (typeof copyHooks.syncGtg === 'function') copyHooks.syncGtg();
    const src = historySourceShort(report);
    toast(src ? `Copied RAG + trend (from ${src})` : 'Copied RAG + trend');
  }

  function copyAll() {
    const report = currentReport();
    if (!copyHooks || !report) return;
    copyStatus();
    for (const s of sectionDefsFor(report)) {
      if (copyHooks.fields[s.key]) copyHooks.fields[s.key].setHtml(s.html || '');
    }
    if (typeof copyHooks.syncGtg === 'function') copyHooks.syncGtg();
    const src = historySourceShort(report);
    toast(src ? `Copied update from ${src} into the form` : 'Copied previous update into the form');
  }

  if (copyHooks) {
    copyPrimary.addEventListener('click', copyAll);
  } else {
    copyPrimary.hidden = true;
  }

  function paintBody() {
    const report = currentReport();
    select.value = String(index);
    prevBtn.disabled = index >= history.length - 1;
    nextBtn.disabled = index <= 0;

    dotsWrap.querySelectorAll('.previous-dot').forEach((dot) => {
      const i = Number(dot.dataset.index);
      dot.classList.toggle('is-current', i === index);
      dot.setAttribute('aria-current', i === index ? 'true' : 'false');
    });

    const ragLabel = report.rag === 'Blue' ? 'Complete' : (report.rag || '—');
    const execPlain = String(report.exec_summary || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const snippet = execPlain.length > 90 ? execPlain.slice(0, 87) + '…' : execPlain;
    const pos = (index + 1) + ' of ' + history.length;
    toggle.innerHTML = '<span class="previous-toggle-summary">' + escapeHtml(ragLabel) +
      (report.trend ? ' · ' + escapeHtml(report.trend) : '') +
      ' · ' + escapeHtml(historyPeriodLabel(report, cadence)) +
      (snippet ? ' — ' + escapeHtml(snippet) : '') + '</span>' +
      '<span class="previous-toggle-action">Show</span>';

    bodyWrap.innerHTML = '';

    const sub = document.createElement('p');
    sub.className = 'previous-period-sub';
    sub.innerHTML = '<strong>' + escapeHtml(historyPeriodLabel(report, cadence)) + '</strong>' +
      ' <span class="previous-pos">' + escapeHtml(pos) + ' · newest first</span>';
    bodyWrap.appendChild(sub);

    const meta = document.createElement('div');
    meta.className = 'report-meta';
    meta.innerHTML = `
      ${statusUnit(report.rag, report.trend)}
      <span class="topic-period">${escapeHtml(historyPeriodLabel(report, cadence))}</span>
    `;
    if (copyHooks) {
      const copyStatusBtn = document.createElement('button');
      copyStatusBtn.type = 'button';
      copyStatusBtn.className = 'btn btn-ghost btn-sm copy-section-btn';
      const src = historySourceShort(report);
      copyStatusBtn.textContent = 'Copy status';
      copyStatusBtn.title = src ? 'Copy RAG and trend from ' + src : 'Copy RAG and trend into the form';
      copyStatusBtn.addEventListener('click', copyStatus);
      meta.appendChild(copyStatusBtn);
    }
    bodyWrap.appendChild(meta);

    for (const s of sectionDefsFor(report)) {
      const sec = document.createElement('div');
      sec.className = 'report-section';
      const labRow = document.createElement('div');
      labRow.className = 'report-section-head';
      const lab = document.createElement('div');
      lab.className = 'panel-label';
      lab.textContent = s.label;
      labRow.appendChild(lab);
      if (copyHooks) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost btn-sm copy-section-btn';
        const src = historySourceShort(report);
        btn.textContent = 'Copy to form';
        btn.title = src ? `Copy ${s.label} from ${src}` : `Copy ${s.label} into the new form`;
        btn.addEventListener('click', () => copySection(s.key, s.html, s.label));
        labRow.appendChild(btn);
      }
      const body = document.createElement('div');
      body.className = 'report-body';
      if (isEmptyRich(s.html)) {
        body.innerHTML = '<span class="report-empty">—</span>';
      } else {
        body.innerHTML = s.html;
      }
      sec.appendChild(labRow);
      sec.appendChild(body);
      bodyWrap.appendChild(sec);
    }
  }

  function setIndex(next) {
    const clamped = Math.max(0, Math.min(history.length - 1, next));
    if (clamped === index) return;
    index = clamped;
    paintBody();
  }

  prevBtn.addEventListener('click', () => setIndex(index + 1));
  nextBtn.addEventListener('click', () => setIndex(index - 1));
  select.addEventListener('change', () => setIndex(Number(select.value) || 0));
  dotsWrap.addEventListener('click', (e) => {
    const dot = e.target.closest('.previous-dot');
    if (!dot) return;
    setIndex(Number(dot.dataset.index));
  });

  toggle.addEventListener('click', () => {
    panel.classList.toggle('is-collapsed');
    const expanded = !panel.classList.contains('is-collapsed');
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const action = toggle.querySelector('.previous-toggle-action');
    if (action) action.textContent = expanded ? 'Hide' : 'Show';
  });

  panel.addEventListener('keydown', (e) => {
    if (e.target === select) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setIndex(index + 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setIndex(index - 1);
    }
  });

  paintBody();
  return panel;
}

function renderTopicUpdate(topic, previous, history, editing = null) {
  app.innerHTML = '';


  const head = document.createElement('div');
  head.className = 'page-head';
  const topicDesc = (topic.description || '').replace(/\s+/g, ' ').trim();
  head.innerHTML = `
    <div>
      <h1>${escapeHtml(topic.name)}</h1>
      ${topicDesc ? `<p class="topic-page-desc">${escapeHtml(topicDesc)}</p>` : ''}
      <p>
        ${categoryTag(topic.category)}
        ${cadenceText(topic.cadence)}
        ${topic.owner ? `<span class="topic-owner"> · ${escapeHtml(topic.owner)}</span>` : ''}
        ${topic.business_unit ? `<span class="topic-owner"> · ${escapeHtml(topic.business_unit)}</span>` : ''}
      </p>
      ${podChips(topic.pod)}
    </div>
  `;
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn btn-ghost';
  editBtn.textContent = 'Edit topic';
  editBtn.addEventListener('click', () => openTopicModal(topic));
  head.appendChild(editBtn);
  app.appendChild(head);

  const layout = document.createElement('div');
  layout.className = 'update-layout';

  const formPanel = document.createElement('section');
  formPanel.className = 'panel';
  formPanel.innerHTML = `<h2><span class="panel-label">${editing ? 'Edit update — ' + escapeHtml(historyPeriodLabel(editing, topic.cadence)) : 'New update'}</span></h2>`;

  const period = editing ? { period_start: editing.period_start, period_end: editing.period_end } : inferPeriod(topic.cadence, previous);
  const isWeekly = topic.cadence === 'weekly';

  const periodRow = document.createElement('div');
  periodRow.className = 'field-row';
  periodRow.innerHTML = isWeekly ? `
      <div class="field">
        <label for="period-end">Week ending (Friday)</label>
        <input id="period-end" type="date" value="${escapeHtml(period.period_end)}" />
        <p class="field-hint">Mon–Fri week. Period start is derived automatically.</p>
      </div>
      <input id="period-start" type="hidden" value="${escapeHtml(period.period_start)}" />
    ` : `
      <div class="field">
        <label for="period-end">${topic.cadence === 'fortnightly' ? 'Period ending' : 'Period ending'}</label>
        <input id="period-end" type="date" value="${escapeHtml(period.period_end)}" />
        <p class="field-hint">Period start is derived from cadence automatically.</p>
      </div>
      <input id="period-start" type="hidden" value="${escapeHtml(period.period_start)}" />
    `;
  formPanel.appendChild(periodRow);

  const endInput = periodRow.querySelector('#period-end');
  const startInput = periodRow.querySelector('#period-start');
  if (isWeekly) {
    const snapWeekly = () => {
      const fri = weekEndingFridayContaining(endInput.value || todayUTC());
      endInput.value = fri;
      startInput.value = mondayOfWeekEnding(fri);
    };
    endInput.addEventListener('change', snapWeekly);
    snapWeekly();
  } else {
    const snapOther = () => {
      const end = endInput.value || todayUTC();
      endInput.value = end;
      const days = topic.cadence === 'fortnightly' ? 13 : 29;
      startInput.value = addDays(end, -days);
    };
    endInput.addEventListener('change', snapOther);
    snapOther();
  }

  const statusRow = document.createElement('div');
  statusRow.className = 'field-row';
  const defaultRag = (previous && previous.rag) || '';
  const defaultTrend = (previous && previous.trend) || '';

  const ragControl = createChoiceControl({
    id: 'rag',
    label: previous && previous.rag ? 'RAG status' : 'RAG status — Select RAG',
    groupClass: 'choice-rag',
    value: defaultRag,
    options: [
      { value: 'Red', label: 'Red', chipClass: 'chip-rag-Red' },
      { value: 'Amber', label: 'Amber', chipClass: 'chip-rag-Amber' },
      { value: 'Green', label: 'Green', chipClass: 'chip-rag-Green' },
      { value: 'Blue', label: 'Complete', chipClass: 'chip-rag-Blue' }
    ]
  });
  const trendControl = createChoiceControl({
    id: 'trend',
    label: 'Trend',
    groupClass: 'choice-trend',
    value: defaultTrend,
    options: [
      { value: 'Improving', label: 'Improving', chipClass: 'trend-choice trend-up',
        html: '<span class="trend-arrow">↗</span>' },
      { value: 'Stable', label: 'Stable', chipClass: 'trend-choice trend-flat',
        html: '<span class="trend-arrow">→</span>' },
      { value: 'Declining', label: 'Declining', chipClass: 'trend-choice trend-down',
        html: '<span class="trend-arrow">↘</span>' }
    ]
  });
  statusRow.appendChild(ragControl.field);
  statusRow.appendChild(trendControl.field);
  formPanel.appendChild(statusRow);

  const fields = {};

  function addRichField(key, label, placeholder, rteClass, parent = formPanel) {
    const field = document.createElement('div');
    field.className = 'field';
    const lab = document.createElement('label');
    lab.textContent = label;
    field.appendChild(lab);
    const rte = createRte(key, { placeholder, className: rteClass || '' });
    field.appendChild(rte);
    parent.appendChild(field);
    fields[key] = rte;
    return field;
  }

  addRichField('exec_summary', 'Exec summary — for leadership', 'Brief narrative for leadership…', 'rte-hero');
  const pair = document.createElement('div');
  pair.className = 'field-pair';
  formPanel.appendChild(pair);
  addRichField('achievements', 'Achievements', 'What landed this period…', 'rte-compact', pair);
  addRichField('next_steps', 'Next steps', 'Priorities for the next period…', 'rte-compact rte-next-steps', pair);

  const gtgField = document.createElement('div');
  gtgField.className = 'field gtg-block';
  const gtgLab = document.createElement('label');
  gtgLab.innerHTML = 'Get-to-green plan <span class="hint">(required for Red / Amber)</span>';
  gtgField.appendChild(gtgLab);
  const gtgRte = createRte('gtg_plan', { placeholder: 'Actions, owners, and dates to return to Green…', className: 'rte-compact' });
  gtgField.appendChild(gtgRte);
  formPanel.appendChild(gtgField);
  fields.gtg_plan = gtgRte;
  if (editing) for (const k of ['exec_summary', 'achievements', 'next_steps', 'gtg_plan']) fields[k].setHtml(editing[k] || '');

  const ragSelect = ragControl;
  function syncGtg() {
    const needs = ragSelect.value === 'Red' || ragSelect.value === 'Amber';
    gtgField.classList.toggle('hidden', !needs);
    if (!needs) gtgRte.setWarn(false);
  }
  ragSelect.addEventListener('change', syncGtg);
  syncGtg();

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => (editing ? showReport(topic.id, editing.id) : showHome()));
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = editing ? 'Save changes' : 'Save update';
  if (editing) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-ghost btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => confirmDeleteReport(topic, editing));
    actions.appendChild(delBtn);
  }
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  formPanel.appendChild(actions);

  saveBtn.addEventListener('click', async () => {
    const payload = {
      period_start: formPanel.querySelector('#period-start').value,
      period_end: formPanel.querySelector('#period-end').value,
      rag: ragSelect.value,
      trend: trendControl.value,
      exec_summary: fields.exec_summary.getHtml(),
      achievements: fields.achievements.getHtml(),
      next_steps: fields.next_steps.getHtml(),
      gtg_plan: fields.gtg_plan.getHtml()
    };

    let ok = true;
    fields.exec_summary.setWarn(false);
    fields.gtg_plan.setWarn(false);

    if (!payload.period_start || !payload.period_end) {
      toast('Period ending date is required', 'error');
      ok = false;
    }
    if (!payload.rag) {
      toast('Select RAG status', 'error');
      ok = false;
    }
    if (!payload.trend) {
      toast('Select trend', 'error');
      ok = false;
    }
    if (isEmptyRich(payload.exec_summary)) {
      fields.exec_summary.setWarn(true);
      toast('Exec summary is required', 'error');
      ok = false;
    }
    if ((payload.rag === 'Red' || payload.rag === 'Amber') && isEmptyRich(payload.gtg_plan)) {
      fields.gtg_plan.setWarn(true);
      toast('Get-to-green plan is required for Red / Amber', 'error');
      ok = false;
    }
    if (!ok) return;

    saveBtn.disabled = true;
    try {
      if (editing) {
        await api(`/api/reports/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        toast('Update changed');
        showReport(topic.id, editing.id);
      } else {
        await api(`/api/topics/${topic.id}/reports`, { method: 'POST', body: JSON.stringify(payload) });
        toast('Update saved');
        showTopic(topic.id);
      }
    } catch (err) {
      toast(err.message, 'error');
      saveBtn.disabled = false;
    }
  });

  layout.appendChild(formPanel);
  const reportHistory = Array.isArray(history) && history.length
    ? history
    : (previous ? [previous] : []);
  layout.appendChild(
    renderReportPanel(
      'Previous update',
      reportHistory,
      'No previous update for this topic — this will be the first.',
      topic.cadence,
      {
        fields,
        ragSelect,
        trendSelect: trendControl,
        syncGtg
      }
    )
  );
  app.appendChild(layout);
  const kdLink = document.createElement('section');
  kdLink.className = 'panel kd-card';
  kdLink.innerHTML = '<div class="kd-card-head"><h2><span class="panel-label">Key dates</span></h2><button type="button" class="btn btn-ghost btn-sm">Manage key dates</button></div><p class="field-hint">Add, edit, shift or delete this topic’s key dates on their own page.</p>';
  kdLink.querySelector('button').addEventListener('click', () => showKeyDates(topic.id));
  app.appendChild(kdLink);
}


/* ── PNG export helpers ─────────────────────────────────────────────────── */

function dropRailColumn(clone) {
  const layout = clone.querySelector('.weekly-layout');
  if (!layout) return;
  layout.style.gridTemplateColumns = 'minmax(0, 1fr)';
  const pack = layout.querySelector('.weekly-pack');
  if (pack) {
    pack.style.width = 'auto';
    Array.from(pack.children).forEach((c) => { c.style.width = 'auto'; });
  }
}

async function exportPng(btn, getNode, name, onClone) {
  const node = getNode();
  if (!node || !window.ReporterPng) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Rendering…';
  try {
    await window.ReporterPng.download(node, name, onClone);
  } catch (err) {
    toast('PNG export failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ── Review comments (PowerPoint-style threaded pane) ──────────────────── */


let currentUserPromise = null;
/** Signed-in user's display name, resolved server-side (AD/Entra when deployed). */
function getCurrentUser() {
  if (!currentUserPromise) {
    currentUserPromise = api('/api/me').then((r) => (r && r.name) || 'Reviewer').catch(() => 'Reviewer');
  }
  return currentUserPromise;
}

function formatStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

const CMT_ICON = {
  bubble: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4 4v-4H5.5A1.5 1.5 0 0 1 4 14.5z"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16 9.5"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'
};

function commentThreads(item) {
  const all = Array.isArray(item.comments) ? item.comments : [];
  const roots = all.filter((c) => !c.parent_id);
  return roots.map((root) => ({
    root,
    replies: all.filter((c) => c.parent_id === root.id)
  }));
}

function openThreadCount(item) {
  return commentThreads(item).filter((t) => !t.root.resolved).length;
}

function commentInitials(name) {
  const parts = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function commentAvatar(name, small) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const el = document.createElement('span');
  el.className = 'cmt-avatar' + (small ? ' is-small' : '');
  el.style.setProperty('--cmt-hue', String(h % 360));
  el.textContent = commentInitials(name);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function commentAgo(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + ' h ago';
  if (hrs < 48) return 'Yesterday';
  return formatStamp(iso);
}

/**
 * PowerPoint-style review pane: one slide (topic) at a time, threaded comments with replies,
 * Resolve thread, edit/delete on your own comments, and prev/next navigation between topics.
 * `onChange` runs after any change so badges elsewhere on the page can refresh.
 */
function createCommentsPane(items, weekEnding, onChange) {
  const pane = document.createElement('aside');
  pane.className = 'cmt-pane';
  pane.setAttribute('data-png-skip', '');
  pane.setAttribute('aria-label', 'Comments');
  pane.hidden = true;
  pane.innerHTML =
    '<header class="cmt-head">' +
      '<div class="cmt-head-row">' +
        '<h2 class="cmt-title">Comments</h2>' +
        '<button type="button" class="btn btn-primary btn-sm cmt-new">New</button>' +
        '<button type="button" class="cmt-icon-btn cmt-close" aria-label="Close comments" title="Close">' + CMT_ICON.close + '</button>' +
      '</div>' +
      '<div class="cmt-nav">' +
        '<button type="button" class="cmt-icon-btn cmt-prev" aria-label="Previous topic" title="Previous topic">' + CMT_ICON.prev + '</button>' +
        '<div class="cmt-nav-label"><span class="cmt-topic-name"></span><span class="cmt-topic-pos"></span></div>' +
        '<button type="button" class="cmt-icon-btn cmt-next" aria-label="Next topic" title="Next topic">' + CMT_ICON.next + '</button>' +
      '</div>' +
      '<div class="cmt-filter" role="tablist" aria-label="Show">' +
        '<button type="button" role="tab" data-filter="active">Active</button>' +
        '<button type="button" role="tab" data-filter="resolved">Resolved</button>' +
        '<button type="button" role="tab" data-filter="all">All</button>' +
      '</div>' +
    '</header>' +
    '<div class="cmt-scroll">' +
      '<form class="cmt-composer" hidden>' +
        '<textarea rows="3" maxlength="2000" placeholder="Start a conversation…" aria-label="New comment"></textarea>' +
        '<div class="cmt-actions"><button type="button" class="btn btn-ghost btn-sm cmt-cancel">Cancel</button>' +
        '<button type="submit" class="btn btn-primary btn-sm">Post</button></div>' +
      '</form>' +
      '<div class="cmt-threads"></div>' +
    '</div>';

  const $ = (s) => pane.querySelector(s);
  const threadsEl = $('.cmt-threads');
  const composer = $('.cmt-composer');
  const composerText = composer.querySelector('textarea');
  let idx = 0;
  let filter = 'active';
  let me = 'Reviewer';
  getCurrentUser().then((n) => { me = n; if (!pane.hidden) render(); });

  const current = () => items[idx];
  const topicOf = (i) => (i && i.topic) || {};

  async function call(url, opts) {
    try { return await api(url, opts); } catch (err) { toast(err.message, 'error'); return null; }
  }
  function normalise(row) {
    row.resolved = row.resolved === true || row.resolved === 'true';
    row.parent_id = row.parent_id || '';
    return row;
  }
  function changed() { render(); onChange(); }

  function closeMenus() { pane.querySelectorAll('.cmt-menu').forEach((m) => m.remove()); }
  document.addEventListener('click', (e) => { if (!e.target.closest('.cmt-more, .cmt-menu')) closeMenus(); });

  function commentBlock(c, thread, isRoot) {
    const box = document.createElement('div');
    box.className = 'cmt' + (isRoot ? '' : ' is-reply');
    const mine = c.author === me;

    const top = document.createElement('div');
    top.className = 'cmt-top';
    const who = document.createElement('div');
    who.className = 'cmt-who';
    const name = document.createElement('span');
    name.className = 'cmt-author';
    name.textContent = c.author;
    const when = document.createElement('span');
    when.className = 'cmt-time';
    when.title = formatStamp(c.created_at);
    when.textContent = commentAgo(c.created_at);
    who.appendChild(name);
    who.appendChild(when);
    top.appendChild(commentAvatar(c.author, !isRoot));
    top.appendChild(who);

    const tools = document.createElement('div');
    tools.className = 'cmt-tools';
    if (isRoot) {
      const res = document.createElement('button');
      res.type = 'button';
      res.className = 'cmt-icon-btn cmt-resolve' + (c.resolved ? ' is-on' : '');
      res.innerHTML = CMT_ICON.check;
      res.title = c.resolved ? 'Reopen thread' : 'Resolve thread';
      res.setAttribute('aria-label', res.title);
      res.addEventListener('click', async () => {
        const upd = await call('/api/comments/' + encodeURIComponent(c.id), {
          method: 'PATCH', body: JSON.stringify({ resolved: !c.resolved })
        });
        if (!upd) return;
        c.resolved = upd.resolved === true || upd.resolved === 'true';
        changed();
      });
      tools.appendChild(res);
    }
    if (mine) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'cmt-icon-btn cmt-more';
      more.innerHTML = CMT_ICON.more;
      more.title = 'More actions';
      more.setAttribute('aria-label', 'More actions');
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        const had = box.querySelector('.cmt-menu');
        closeMenus();
        if (had) return;
        const menu = document.createElement('div');
        menu.className = 'cmt-menu';
        menu.setAttribute('role', 'menu');
        const mk = (label, danger, fn) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('role', 'menuitem');
          b.textContent = label;
          if (danger) b.className = 'is-danger';
          b.addEventListener('click', () => { closeMenus(); fn(); });
          menu.appendChild(b);
        };
        mk(isRoot ? 'Edit comment' : 'Edit reply', false, () => startEdit(c, box, body));
        mk(isRoot ? 'Delete thread' : 'Delete reply', true, async () => {
          const msg = isRoot && thread.replies.length ? 'Delete this comment and its replies?' : 'Delete this comment?';
          if (!window.confirm(msg)) return;
          const ok = await call('/api/comments/' + encodeURIComponent(c.id), { method: 'DELETE' });
          if (!ok) return;
          current().comments = current().comments.filter((x) => x.id !== c.id && x.parent_id !== c.id);
          changed();
        });
        tools.appendChild(menu);
      });
      tools.appendChild(more);
    }
    top.appendChild(tools);
    box.appendChild(top);

    const body = document.createElement('div');
    body.className = 'cmt-body';
    body.textContent = c.body;
    box.appendChild(body);
    return box;
  }

  function startEdit(c, box, bodyEl) {
    const form = document.createElement('form');
    form.className = 'cmt-edit';
    form.innerHTML = '<textarea rows="3" maxlength="2000" aria-label="Edit comment"></textarea>' +
      '<div class="cmt-actions"><button type="button" class="btn btn-ghost btn-sm">Cancel</button>' +
      '<button type="submit" class="btn btn-primary btn-sm">Save</button></div>';
    const ta = form.querySelector('textarea');
    ta.value = c.body;
    bodyEl.replaceWith(form);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    form.querySelector('.btn-ghost').addEventListener('click', render);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); render(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) { toast('Enter your comment', 'error'); return; }
      if (text === c.body) { render(); return; }
      const upd = await call('/api/comments/' + encodeURIComponent(c.id), {
        method: 'PATCH', body: JSON.stringify({ body: text })
      });
      if (!upd) return;
      c.body = upd.body;
      c.updated_at = upd.updated_at;
      changed();
    });
  }

  function replyBox(thread) {
    const wrap = document.createElement('form');
    wrap.className = 'cmt-reply';
    wrap.innerHTML = '<textarea rows="1" maxlength="2000" placeholder="Reply" aria-label="Reply"></textarea>' +
      '<div class="cmt-actions" hidden><button type="button" class="btn btn-ghost btn-sm">Cancel</button>' +
      '<button type="submit" class="btn btn-primary btn-sm">Reply</button></div>';
    const ta = wrap.querySelector('textarea');
    const actions = wrap.querySelector('.cmt-actions');
    const collapse = () => { ta.value = ''; ta.rows = 1; actions.hidden = true; };
    ta.addEventListener('focus', () => { ta.rows = 3; actions.hidden = false; });
    wrap.querySelector('.btn-ghost').addEventListener('click', () => { collapse(); ta.blur(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); collapse(); ta.blur(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); wrap.requestSubmit(); }
    });
    wrap.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      const item = current();
      const row = await call('/api/topics/' + encodeURIComponent(topicOf(item).id) + '/comments', {
        method: 'POST',
        body: JSON.stringify({ week_ending: weekEnding, kind: 'comment', body: text, parent_id: thread.root.id })
      });
      if (!row) return;
      item.comments.push(normalise(row));
      changed();
    });
    return wrap;
  }

  function render() {
    closeMenus();
    const item = current();
    const topic = topicOf(item);
    $('.cmt-topic-name').textContent = topic.name || 'Untitled';
    $('.cmt-topic-pos').textContent = (idx + 1) + ' of ' + items.length;
    $('.cmt-prev').disabled = idx <= 0;
    $('.cmt-next').disabled = idx >= items.length - 1;
    pane.querySelectorAll('.cmt-filter button').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.filter === filter);
      b.setAttribute('aria-selected', b.dataset.filter === filter ? 'true' : 'false');
    });

    const threads = commentThreads(item);
    const nOpen = threads.filter((t) => !t.root.resolved).length;
    const nDone = threads.length - nOpen;
    pane.querySelector('[data-filter="active"]').textContent = 'Active' + (nOpen ? ' (' + nOpen + ')' : '');
    pane.querySelector('[data-filter="resolved"]').textContent = 'Resolved' + (nDone ? ' (' + nDone + ')' : '');
    const shown = threads.filter((t) => filter === 'all' || (filter === 'resolved') === !!t.root.resolved);

    threadsEl.innerHTML = '';
    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'cmt-empty';
      empty.innerHTML = CMT_ICON.bubble +
        '<p>' + (threads.length
          ? (filter === 'resolved' ? 'No resolved comments.' : filter === 'active' ? 'All comments on this topic are resolved.' : 'No comments.')
          : 'No comments on this topic yet.') + '</p>' +
        '<p class="cmt-empty-hint">Select <b>New</b> to start a conversation.</p>';
      threadsEl.appendChild(empty);
    }
    for (const t of shown) {
      const card = document.createElement('article');
      card.className = 'cmt-thread' + (t.root.resolved ? ' is-resolved' : '');
      card.appendChild(commentBlock(t.root, t, true));
      if (t.replies.length) {
        const rep = document.createElement('div');
        rep.className = 'cmt-replies';
        for (const r of t.replies) rep.appendChild(commentBlock(r, t, false));
        card.appendChild(rep);
      }
      if (t.root.resolved) {
        const banner = document.createElement('div');
        banner.className = 'cmt-resolved-note';
        banner.innerHTML = CMT_ICON.check + '<span>Resolved</span>';
        card.appendChild(banner);
      } else {
        card.appendChild(replyBox(t));
      }
      threadsEl.appendChild(card);
    }
  }

  function highlightSection() {
    document.querySelectorAll('.weekly-section.is-commenting').forEach((s) => s.classList.remove('is-commenting'));
    if (pane.hidden) return;
    const tid = topicOf(current()).id;
    const sec = tid && document.getElementById('topic-' + tid);
    if (sec) sec.classList.add('is-commenting');
  }

  function show(i, scroll) {
    if (!items.length) return;
    idx = Math.max(0, Math.min(items.length - 1, i));
    pane.hidden = false;
    composer.hidden = true;
    composerText.value = '';
    render();
    highlightSection();
    if (scroll) {
      const tid = topicOf(current()).id;
      const sec = tid && document.getElementById('topic-' + tid);
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  function hide() {
    pane.hidden = true;
    highlightSection();
  }
  function openComposer() {
    composer.hidden = false;
    composerText.focus();
    pane.querySelector('.cmt-scroll').scrollTop = 0;
  }
  function closeComposer() { composer.hidden = true; composerText.value = ''; }

  $('.cmt-close').addEventListener('click', hide);
  $('.cmt-new').addEventListener('click', openComposer);
  $('.cmt-prev').addEventListener('click', () => show(idx - 1, true));
  $('.cmt-next').addEventListener('click', () => show(idx + 1, true));
  composer.querySelector('.cmt-cancel').addEventListener('click', closeComposer);
  pane.querySelectorAll('.cmt-filter button').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.filter; render(); }));
  composerText.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeComposer(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); composer.requestSubmit(); }
  });
  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = composerText.value.trim();
    if (!text) { composerText.focus(); return; }
    const item = current();
    const row = await call('/api/topics/' + encodeURIComponent(topicOf(item).id) + '/comments', {
      method: 'POST',
      body: JSON.stringify({ week_ending: weekEnding, kind: 'comment', body: text })
    });
    if (!row) return;
    if (!Array.isArray(item.comments)) item.comments = [];
    item.comments.push(normalise(row));
    closeComposer();
    if (filter === 'resolved') filter = 'active';
    changed();
  });
  pane.addEventListener('keydown', (e) => { if (e.key === 'Escape' && composer.hidden) hide(); });

  for (const it of items) (it.comments || []).forEach(normalise);

  return {
    el: pane,
    open: (topicId, opts) => {
      const i = items.findIndex((it) => topicOf(it).id === topicId);
      if (i >= 0) show(i, !(opts && opts.noScroll));
    },
    openNew: (topicId) => {
      const i = items.findIndex((it) => topicOf(it).id === topicId);
      if (i >= 0) { show(i, true); openComposer(); }
    },
    isOpen: () => !pane.hidden,
    refresh: () => { if (!pane.hidden) render(); }
  };
}

async function showWeekly(initialEnding) {
  setNav('weekly');
  const fromHash = typeof location !== 'undefined' && location.hash.startsWith('#weekly=')
    ? location.hash.slice('#weekly='.length)
    : '';
  const endingParam = initialEnding || fromHash;
  let ending = endingParam && /^\d{4}-\d{2}-\d{2}$/.test(endingParam)
    ? weekEndingFridayContaining(endingParam)
    : weekEndingFridayContaining(todayUTC());

  let jumpRailObserver = null;
  let jumpRailScrollLock = false;
  let jumpRailLockedTopicId = null;
  let jumpRailUnlockTimer = null;
  let jumpRailUnlockHandler = null;

  function clearJumpRailScrollLock() {
    jumpRailScrollLock = false;
    jumpRailLockedTopicId = null;
    if (jumpRailUnlockTimer) {
      clearTimeout(jumpRailUnlockTimer);
      jumpRailUnlockTimer = null;
    }
    if (jumpRailUnlockHandler) {
      window.removeEventListener('scrollend', jumpRailUnlockHandler);
      jumpRailUnlockHandler = null;
    }
  }

  function lockJumpRailUntilScrollEnds(topicId) {
    clearJumpRailScrollLock();
    jumpRailScrollLock = true;
    jumpRailLockedTopicId = topicId || null;
    const unlock = () => clearJumpRailScrollLock();
    if (typeof window !== 'undefined' && 'onscrollend' in window) {
      jumpRailUnlockHandler = unlock;
      window.addEventListener('scrollend', jumpRailUnlockHandler, { once: true });
    }
    /* Safety net for long smooth scrolls / browsers without scrollend */
    jumpRailUnlockTimer = setTimeout(unlock, 1200);
  }

  async function paint() {
    clearJumpRailScrollLock();
    if (jumpRailObserver) {
      jumpRailObserver.disconnect();
      jumpRailObserver = null;
    }
    if (typeof history !== 'undefined') {
      const hash = '#weekly=' + ending;
      if (location.hash !== hash) history.replaceState(null, '', hash);
    }

    app.innerHTML = '<div class="loading">Loading weekly view…</div>';
    let data;
    try {
      data = await api('/api/weekly?ending=' + encodeURIComponent(ending));
    } catch (err) {
      app.innerHTML = '<div class="empty-state">Failed to load: ' + escapeHtml(err.message) + '</div>';
      return;
    }

    ending = data.week_ending || ending;
    const avail = Array.isArray(data.available_weeks) ? data.available_weeks : [];
    if ((!data.items || !data.items.length) && avail.length && ending !== avail[0]) {
      if (!paint._snappedOnce) {
        paint._snappedOnce = true;
        ending = avail[0];
        return paint();
      }
    }
    app.innerHTML = '';


    const head = document.createElement('div');
    head.className = 'page-head weekly-head';
    const headLeft = document.createElement('div');
    headLeft.className = 'weekly-head-text';
    headLeft.innerHTML =
      '<h1>Weekly report</h1>' +
      '<p class="weekly-head-sub">Week ending <strong>' + escapeHtml(formatDate(data.week_ending)) + '</strong>' +
      ' <span class="weekly-period-range">' + escapeHtml(formatDate(data.period_start)) +
      ' – ' + escapeHtml(formatDate(data.period_end)) + '</span></p>';
    head.appendChild(headLeft);

    const headActions = document.createElement('div');
    headActions.className = 'page-head-actions no-print';
    const weeks = Array.isArray(data.available_weeks) ? data.available_weeks.slice() : [];
    if (ending && !weeks.includes(ending)) weeks.unshift(ending);
    if (!weeks.length) weeks.push(ending);

    const dateField = document.createElement('div');
    dateField.className = 'field weekly-date-field';
    const lab = document.createElement('label');
    lab.htmlFor = 'weekly-ending';
    lab.textContent = 'Reporting week';
    const sel = document.createElement('select');
    sel.id = 'weekly-ending';
    for (const w of weeks) {
      const opt = document.createElement('option');
      opt.value = w;
      opt.textContent = 'Week ending ' + formatDate(w);
      if (w === ending) opt.selected = true;
      sel.appendChild(opt);
    }
    dateField.appendChild(lab);
    dateField.appendChild(sel);
    const pngBtn = document.createElement('button');
    pngBtn.type = 'button';
    pngBtn.className = 'btn';
    pngBtn.textContent = 'Download PNG';
    pngBtn.title = 'Download the whole weekly report as an image';
    pngBtn.addEventListener('click', () => exportPng(pngBtn, () => document.getElementById('weekly-export'), 'weekly-report-' + data.week_ending, dropRailColumn));
    const fileLink = (ext, label, title) => {
      const a = document.createElement('a');
      a.className = 'btn';
      a.textContent = label;
      a.title = title;
      a.href = 'api/weekly.' + ext + '?ending=' + encodeURIComponent(data.week_ending);
      a.setAttribute('download', 'weekly-report-' + data.week_ending + '.' + ext);
      return a;
    };
    headActions.appendChild(dateField);
    headActions.appendChild(pngBtn);
    headActions.appendChild(fileLink('pdf', 'Download PDF', 'Download the weekly report as a PDF'));
    headActions.appendChild(fileLink('pptx', 'Download PPT', 'Download the weekly report as a PowerPoint deck'));
    head.appendChild(headActions);
    app.appendChild(head);

    sel.addEventListener('change', () => {
      ending = sel.value;
      paint();
    });

    const items = Array.isArray(data.items) ? data.items : [];
    const ragCounts = { Red: 0, Amber: 0, Green: 0, Blue: 0 };
    for (const it of items) {
      const r = (it.report && it.report.rag) || '';
      if (ragCounts[r] != null) ragCounts[r] += 1;
    }

    const cover = document.createElement('div');
    cover.className = 'weekly-cover';
    cover.innerHTML =
      '<div class="weekly-cover-title">Weekly status — week ending ' + escapeHtml(formatDate(data.week_ending)) + '</div>' +
      '<div class="weekly-cover-stats">' +
        '<button type="button" class="weekly-cover-stat weekly-cover-followups" data-png-skip hidden title="Open the first unresolved comment"></button>' +
        '<span class="weekly-cover-stat"><b>' + items.length + '</b> topic' + (items.length === 1 ? '' : 's') + '</span>' +
        '<span class="weekly-cover-stat rag-red"><b>' + ragCounts.Red + '</b> Red</span>' +
        '<span class="weekly-cover-stat rag-amber"><b>' + ragCounts.Amber + '</b> Amber</span>' +
        '<span class="weekly-cover-stat rag-green"><b>' + ragCounts.Green + '</b> Green</span>' +
        '<span class="weekly-cover-stat rag-blue"><b>' + ragCounts.Blue + '</b> Complete</span>' +
      '</div>';
    /* Win E — Needs attention callouts (under cover; same topic-{id} anchors as Win D) */
    const front = document.createElement('div');
    front.className = 'weekly-frontmatter';
    front.appendChild(cover);

    const attention = document.createElement('div');
    attention.className = 'weekly-attention';
    attention.setAttribute('aria-label', 'Red and Amber topics');
    const attentionTitle = document.createElement('div');
    attentionTitle.className = 'weekly-attention-title';
    attentionTitle.textContent = 'Red / Amber topics';
    attention.appendChild(attentionTitle);

    const attentionCandidates = items
      .filter((it) => {
        const rag = (it.report && it.report.rag) || '';
        return rag === 'Red' || rag === 'Amber';
      })
      .slice()
      .sort((a, b) => {
        const rank = { Red: 0, Amber: 1 };
        const ra = rank[(a.report && a.report.rag) || ''];
        const rb = rank[(b.report && b.report.rag) || ''];
        const raN = ra == null ? 9 : ra;
        const rbN = rb == null ? 9 : rb;
        if (raN !== rbN) return raN - rbN;
        /* items already in reporting order / sort_order — preserve that within same RAG */
        return 0;
      })
      .slice(0, 3);

    if (!items.length) {
      /* empty week: omit callouts (empty state below) */
    } else if (!attentionCandidates.length) {
      const ok = document.createElement('p');
      ok.className = 'weekly-attention-ok';
      ok.textContent = 'All topics Green or Complete';
      attention.appendChild(ok);
      front.appendChild(attention);
    } else {
      const list = document.createElement('ol');
      list.className = 'weekly-attention-list';
      for (const [attnIdx, item] of attentionCandidates.entries()) {
        const topic = item.topic || {};
        const report = item.report || {};
        const tid = topic.id || '';
        const rag = report.rag || '';
        const ragLabel = rag.toUpperCase();
        const snip = plainTextSnippet(report.exec_summary, 80);
        const li = document.createElement('li');
        li.className = 'weekly-attention-item';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'weekly-attention-link';
        btn.dataset.topicId = tid;
        const titleText = topic.name || 'Untitled';
        btn.setAttribute(
          'aria-label',
          'Jump to ' + titleText + ' — ' + ragLabel + (snip ? ': ' + snip : '')
        );
        btn.title = titleText + ' · ' + ragLabel;
        const ragClass = rag ? ('rag-' + rag.toLowerCase()) : 'rag-none';
        btn.innerHTML =
          '<span class="weekly-attention-num" aria-hidden="true">' + (attnIdx + 1) + '.' + '</span>' +
          '<span class="weekly-attention-name">' + escapeHtml(titleText) + '</span>' +
          '<span class="weekly-attention-sep" aria-hidden="true"> — </span>' +
          '<span class="weekly-attention-rag ' + ragClass + '">' + escapeHtml(ragLabel) + '</span>' +
          (snip
            ? '<span class="weekly-attention-sep" aria-hidden="true"> · </span>' +
              '<span class="weekly-attention-snip">' + escapeHtml(snip) + '</span>'
            : '');
        btn.addEventListener('click', () => {
          const target = document.getElementById('topic-' + tid);
          if (!target) return;
          const railBtn = Array.prototype.find.call(
            document.querySelectorAll('.jump-rail-item'),
            (el) => el.dataset.topicId === tid
          );
          if (railBtn) {
            document.querySelectorAll('.jump-rail-item').forEach((el) => {
              el.classList.toggle('is-active', el === railBtn);
            });
          }
          lockJumpRailUntilScrollEnds(tid);
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        li.appendChild(btn);
        list.appendChild(li);
      }
      attention.appendChild(list);
      front.appendChild(attention);
    }
    const exportWrap = document.createElement('div');
    exportWrap.id = 'weekly-export';
    exportWrap.appendChild(front);
    app.appendChild(exportWrap);

    const bubbles = new Map();
    const railBadges = new Map();
    let pane = null;
    function updateFollowUpCount() {
      const open = items.reduce((n, it) => n + openThreadCount(it), 0);
      const el = cover.querySelector('.weekly-cover-followups');
      if (el) {
        el.hidden = !open;
        el.innerHTML = '<b>' + open + '</b> open comment' + (open === 1 ? '' : 's');
      }
      for (const it of items) {
        const tid = (it.topic || {}).id;
        const total = (it.comments || []).length;
        const n = openThreadCount(it);
        const bub = bubbles.get(tid);
        if (bub) {
          bub.classList.toggle('has-open', n > 0);
          bub.classList.toggle('has-some', total > 0 && n === 0);
          bub.querySelector('.cmt-bubble-n').textContent = n ? String(n) : (total ? '✓' : '+');
          bub.title = n ? n + ' open comment' + (n === 1 ? '' : 's') + ' — open comments'
            : (total ? 'All comments resolved — open comments' : 'Add a comment');
        }
        const rb = railBadges.get(tid);
        if (rb) { rb.hidden = !n; rb.textContent = String(n); }
      }
      if (pane) pane.refresh();
    }
    cover.querySelector('.weekly-cover-followups').addEventListener('click', () => {
      const first = items.find((it) => openThreadCount(it) > 0);
      if (first && pane) pane.open(first.topic.id);
    });

    const layout = document.createElement('div');
    layout.className = 'weekly-layout';

    const pack = document.createElement('div');
    pack.className = 'weekly-pack';

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state weekly-empty';
      empty.innerHTML = '<p>No topic reports for this week.</p><p class="weekly-empty-hint">Choose another reporting week above, or add updates from the topics list.</p>';
      pack.appendChild(empty);
      layout.appendChild(pack);
      exportWrap.appendChild(layout);
      return;
    }

    pane = createCommentsPane(items, data.week_ending, updateFollowUpCount);
    app.appendChild(pane.el);

    /* Win D — topic jump rail (reporting order / sort_order — same as cards) */
    const rail = document.createElement('nav');
    rail.className = 'jump-rail';
    rail.setAttribute('data-png-skip', '');
    rail.setAttribute('aria-label', 'Topics on this page');
    const railTitle = document.createElement('div');
    railTitle.className = 'jump-rail-title';
    railTitle.textContent = 'Topics';
    rail.appendChild(railTitle);
    const railList = document.createElement('div');
    railList.className = 'jump-rail-list';
    for (const item of items) {
      const topic = item.topic || {};
      const report = item.report || {};
      const tid = topic.id || '';
      const rag = (report && report.rag) || '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'jump-rail-item';
      btn.dataset.topicId = tid;
      const ragLabel = rag === 'Blue' ? 'Complete' : (rag || 'No RAG');
      btn.setAttribute('aria-label', (topic.name || 'Untitled') + ' — ' + ragLabel);
      btn.title = (topic.name || 'Untitled') + ' · ' + ragLabel;
      const ragClass = rag ? ('rag-' + rag.toLowerCase()) : 'rag-none';
      btn.innerHTML =
        '<span class="jump-rail-dot ' + ragClass + '" aria-hidden="true"></span>' +
        '<span class="jump-rail-label">' + escapeHtml(topic.name || 'Untitled') + '</span>' +
        '<span class="jump-rail-cmt" data-png-skip hidden></span>';
      railBadges.set(tid, btn.querySelector('.jump-rail-cmt'));
      btn.addEventListener('click', () => {
        const target = document.getElementById('topic-' + tid);
        if (!target) return;
        /* Set active immediately and lock IO so mid-scroll intersections cannot overwrite it */
        railList.querySelectorAll('.jump-rail-item').forEach((el) => {
          el.classList.toggle('is-active', el === btn);
        });
        lockJumpRailUntilScrollEnds(tid);
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      railList.appendChild(btn);
    }
    rail.appendChild(railList);
    layout.appendChild(rail);

    for (const item of items) {
      const topic = item.topic || {};
      const report = item.report || {};
      const section = document.createElement('section');
      section.className = 'weekly-section panel';
      if (topic.id) section.id = 'topic-' + topic.id;

      const periodLabel = topic.cadence === 'weekly'
        ? ('Week ending ' + formatDate(report.period_end))
        : (formatDate(report.period_start) + ' – ' + formatDate(report.period_end));

      const metaBits = [];
      metaBits.push(topic.owner ? escapeHtml(topic.owner) : '<span class="report-empty">No owner</span>');
      if (topic.business_unit) metaBits.push(escapeHtml(topic.business_unit));
      if (topic.category) metaBits.push(categoryTag(topic.category));
      if (topic.cadence) metaBits.push('<span class="cadence-text">' + escapeHtml(topic.cadence) + '</span>');
      if (topic.pod && topic.pod.length) metaBits.push('POD: ' + topic.pod.map((m) => escapeHtml(m.name) + ' (' + escapeHtml(m.role) + ')').join(', '));

      const headEl = document.createElement('header');
      headEl.className = 'weekly-section-head';
      const identity = document.createElement('div');
      identity.className = 'weekly-section-identity';
      identity.innerHTML =
        '<p class="weekly-report-eyebrow">Key Topics Reporting<span class="weekly-sep"> · </span>' + escapeHtml(periodLabel) + '</p>' +
        '<h2 class="weekly-topic-title">' + escapeHtml(topic.name || 'Untitled') + '</h2>' +
        '<p class="weekly-topic-meta">' + metaBits.join('<span class="weekly-sep"> · </span>') + '</p>';
      if (item.rag_history && item.rag_history.some((h) => h.rag)) {
        const hist = document.createElement('div');
        hist.className = 'weekly-rag-history';
        hist.setAttribute('role', 'img');
        hist.setAttribute('aria-label', 'RAG history, last 8 weeks: ' + item.rag_history.map((h) => h.rag || 'no report').join(', '));
        hist.innerHTML = '<span class="weekly-rag-history-label">Last 8 weeks</span>' + item.rag_history.map((h) =>
          '<span class="rag-hist-dot rag-hist-' + (h.rag ? escapeHtml(h.rag.toLowerCase()) : 'none') + '" title="w/e ' + escapeHtml(shortDate(h.week)) + ': ' + escapeHtml(h.rag || 'no report') + '"></span>').join('');
        identity.appendChild(hist);
      }
      if (topic.description) {
        const desc = document.createElement('p');
        desc.className = 'weekly-description';
        desc.textContent = topic.description;
        identity.appendChild(desc);
      }
      headEl.appendChild(identity);
      const statusWrap = document.createElement('div');
      statusWrap.className = 'weekly-section-status';
      statusWrap.innerHTML = statusUnit(report.rag, report.trend);
      headEl.appendChild(statusWrap);
      const topicPng = document.createElement('button');
      topicPng.type = 'button';
      topicPng.className = 'btn btn-ghost btn-sm weekly-topic-png';
      topicPng.setAttribute('data-png-skip', '');
      topicPng.textContent = 'PNG';
      topicPng.title = 'Download this topic as an image';
      topicPng.addEventListener('click', () =>
        exportPng(topicPng, () => section, (topic.name || 'topic') + '-' + data.week_ending));
      headEl.insertBefore(topicPng, statusWrap);
      const bubble = document.createElement('button');
      bubble.type = 'button';
      bubble.className = 'cmt-bubble';
      bubble.setAttribute('data-png-skip', '');
      bubble.setAttribute('aria-label', 'Comments');
      bubble.innerHTML = CMT_ICON.bubble + '<span class="cmt-bubble-n"></span>';
      bubble.addEventListener('click', () => {
        const existing = openThreadCount(item) || (item.comments || []).length;
        if (existing) pane.open(topic.id, { noScroll: true }); else pane.openNew(topic.id);
      });
      bubbles.set(topic.id, bubble);
      headEl.insertBefore(bubble, topicPng);
      section.appendChild(headEl);

      const isRisk = report.rag === 'Red' || report.rag === 'Amber';
      const hasGtg = isRisk && report.gtg_plan && !isEmptyRich(report.gtg_plan);
      if (isRisk) section.classList.add('weekly-section-gtg');

      const mainRow = document.createElement('div');
      mainRow.className = 'weekly-main-row';

      const bodyRow = document.createElement('div');
      bodyRow.className = 'weekly-body';

      const execSec = document.createElement('div');
      execSec.className = 'report-section weekly-exec';
      execSec.innerHTML = '<div class="panel-label">Exec summary</div>';
      const execBody = document.createElement('div');
      execBody.className = 'report-body';
      if (isEmptyRich(report.exec_summary)) {
        execBody.innerHTML = '<span class="report-empty">—</span>';
      } else {
        execBody.innerHTML = report.exec_summary;
      }
      execSec.appendChild(execBody);
      bodyRow.appendChild(execSec);

      const twin = document.createElement('div');
      twin.className = 'weekly-twin';
      [
        { label: 'Achievements', html: report.achievements },
        { label: 'Next steps', html: report.next_steps }
      ].forEach((s) => {
        const sec = document.createElement('div');
        sec.className = 'report-section';
        const labEl = document.createElement('div');
        labEl.className = 'panel-label';
        labEl.textContent = s.label;
        const body = document.createElement('div');
        body.className = 'report-body';
        if (isEmptyRich(s.html)) {
          body.innerHTML = '<span class="report-empty">—</span>';
        } else {
          body.innerHTML = s.html;
        }
        sec.appendChild(labEl);
        sec.appendChild(body);
        twin.appendChild(sec);
      });
      bodyRow.appendChild(twin);

      if (hasGtg) {
        const gtgSec = document.createElement('div');
        gtgSec.className = 'report-section report-section-gtg';
        gtgSec.innerHTML = '<div class="panel-label">Get-to-green plan</div>';
        const gtgBody = document.createElement('div');
        gtgBody.className = 'report-body';
        gtgBody.innerHTML = report.gtg_plan;
        gtgSec.appendChild(gtgBody);
        bodyRow.appendChild(gtgSec);
      }

      mainRow.appendChild(bodyRow);

      const kdGrid = renderKeyDatesGrid(
        data.week_fridays,
        data.week_ending,
        item.key_dates || topic.key_dates || []
      );
      const allKd = item.key_dates || topic.key_dates || [];
      if (kdGrid || allKd.length) {
        const kdWrap = document.createElement('div');
        kdWrap.className = 'weekly-kd';
        const qtWrap = document.createElement('div');
        qtWrap.className = 'weekly-qt report-section';
        qtWrap.innerHTML = quarterTimelineHtml(allKd, data.week_ending);
        kdWrap.appendChild(qtWrap);
        if (kdGrid) kdWrap.appendChild(kdGrid);
        mainRow.appendChild(kdWrap);
        mainRow.classList.add('has-key-dates');
      } else {
        mainRow.classList.add('no-key-dates');
      }

      section.appendChild(mainRow);
      pack.appendChild(section);
    }

    layout.appendChild(pack);
    exportWrap.appendChild(layout);
    updateFollowUpCount();

    /* Active topic while scrolling */
    const railItems = Array.from(railList.querySelectorAll('.jump-rail-item'));
    const sections = items
      .map((it) => (it.topic && it.topic.id) ? document.getElementById('topic-' + it.topic.id) : null)
      .filter(Boolean);
    if (sections.length && typeof IntersectionObserver !== 'undefined') {
      const visible = new Map();
      jumpRailObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry);
          else visible.delete(entry.target.id);
        }
        let bestId = null;
        let bestTop = Infinity;
        visible.forEach((entry, id) => {
          const top = entry.boundingClientRect.top;
          if (top < bestTop) {
            bestTop = top;
            bestId = id;
          }
        });
        if (!bestId && sections.length) {
          /* fallback: nearest section to top of viewport */
          let near = sections[0];
          let nearDist = Infinity;
          for (const sec of sections) {
            const d = Math.abs(sec.getBoundingClientRect().top - 80);
            if (d < nearDist) { nearDist = d; near = sec; }
          }
          bestId = near.id;
        }
        if (!bestId) return;
        const activeTid = bestId.replace(/^topic-/, '');
        /* While locked: keep click-set active until target is the IO winner (or scrollend/timeout) */
        if (jumpRailScrollLock) {
          if (jumpRailLockedTopicId && activeTid === jumpRailLockedTopicId) {
            clearJumpRailScrollLock();
          } else {
            return;
          }
        }
        railItems.forEach((el) => {
          el.classList.toggle('is-active', el.dataset.topicId === activeTid);
        });
      }, { root: null, rootMargin: '-10% 0px -55% 0px', threshold: [0, 0.1, 0.25, 0.5] });
      sections.forEach((sec) => jumpRailObserver.observe(sec));
      if (railItems[0]) railItems[0].classList.add('is-active');
    }
  }

  await paint();
}



/* ── Key dates: a dedicated page per topic (#topic=ID/key-dates) ─ */

async function showKeyDates(topicId) {
  setNav('topics');
  setHash('#topic=' + topicId + '/key-dates');
  app.innerHTML = '<div class="loading">Loading…</div>';
  let topic, rows;
  try {
    topic = (await api('/api/topics')).find((t) => t.id === topicId);
    if (!topic) { app.innerHTML = '<div class="empty-state">Topic not found.</div>'; return; }
    rows = await api('/api/topics/' + encodeURIComponent(topicId) + '/key-dates');
    if (!Array.isArray(rows)) rows = [];
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
    return;
  }
  const base = 'api/topics/' + encodeURIComponent(topicId) + '/key-dates';
  const today = new Date().toISOString().slice(0, 10);
  const DAY = 86400000;
  const daysFrom = (d) => Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / DAY);
  const shiftIso = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
  const selected = new Set();
  let anchor = today;

  app.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = `<div><h1>${escapeHtml(topic.name)}</h1><p>Key dates · shown on the weekly pack and the topic timeline</p></div>`;
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-ghost';
  back.textContent = '← ' + topic.name;
  back.addEventListener('click', () => showTopic(topicId));
  const exp = document.createElement('button');
  exp.type = 'button';
  exp.className = 'btn btn-ghost';
  exp.textContent = 'Export CSV';
  exp.addEventListener('click', () => {
    const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const csv = '﻿id,topic,date,description\n' + rows.slice().sort((x, y) => x.date.localeCompare(y.date))
      .map((r) => [r.id, topic.name, r.date, r.description].map(esc).join(',')).join('\n') + '\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'key_dates_' + topic.name.replace(/[^\w]+/g, '_').toLowerCase() + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  const acts = document.createElement('div');
  acts.append(back, ' ', exp);
  head.appendChild(acts);
  app.appendChild(head);

  // Timeline for a chosen quarter
  const tl = document.createElement('section');
  tl.className = 'panel';
  app.appendChild(tl);
  function paintTimeline() {
    tl.innerHTML = `<div class="kd-tl-nav"><button type="button" class="btn btn-ghost btn-sm" data-q="-1" aria-label="Previous quarter">‹</button><button type="button" class="btn btn-ghost btn-sm" data-q="0">This quarter</button><button type="button" class="btn btn-ghost btn-sm" data-q="1" aria-label="Next quarter">›</button></div>` + quarterTimelineHtml(rows, anchor);
    tl.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
      const n = Number(b.dataset.q);
      if (!n) anchor = today;
      else { const d = new Date(anchor + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 3 * n, 1); anchor = d.toISOString().slice(0, 10); }
      paintTimeline();
    }));
  }

  const card = document.createElement('section');
  card.className = 'panel';
  card.innerHTML = `
    <h2><span class="panel-label">Key dates</span></h2>
    <form class="kd-add" autocomplete="off">
      <input type="date" id="kd-new-date" aria-label="New key date" required />
      <input type="text" id="kd-new-desc" maxlength="120" placeholder="Short description" aria-label="New key date description" required />
      <button type="submit" class="btn btn-primary btn-sm">Add</button>
    </form>
    <div class="list-toolbar" style="margin-top:.9rem">
      <div class="field toolbar-search"><label class="sr-only" for="kd-q">Search</label><input id="kd-q" type="search" placeholder="Search descriptions…" autocomplete="off" /></div>
      <div class="field"><label class="sr-only" for="kd-when">Show</label><select id="kd-when"><option value="">All dates</option><option value="upcoming">Upcoming</option><option value="past">Past</option><option value="quarter">Shown quarter</option></select></div>
      <div class="field"><label class="sr-only" for="kd-sort">Sort</label><select id="kd-sort"><option value="date-asc">Date (earliest)</option><option value="date-desc">Date (latest)</option><option value="desc-asc">Description A–Z</option><option value="desc-desc">Description Z–A</option><option value="added-desc">Recently added</option></select></div>
    </div>
    <div class="list-meta kd-meta"></div>
    <div class="bulk-bar" hidden></div>
    <div class="topic-list kd-list"></div>`;
  app.appendChild(card);
  const q = card.querySelector('#kd-q'), whenS = card.querySelector('#kd-when'), sortS = card.querySelector('#kd-sort');
  const meta = card.querySelector('.kd-meta'), bulk = card.querySelector('.bulk-bar'), list = card.querySelector('.kd-list');
  let shown = [];

  const quarterRange = () => {
    const d = new Date(anchor + 'T00:00:00Z'); const y = d.getUTCFullYear(); const m = Math.floor(d.getUTCMonth() / 3) * 3;
    return [new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), new Date(Date.UTC(y, m + 3, 1)).toISOString().slice(0, 10)];
  };
  async function each(ids, fn, okMsg) {
    let ok = 0; const failed = [];
    for (const id of ids) { try { await fn(rows.find((r) => r.id === id)); ok++; } catch (err) { failed.push(err.message); } }
    toast(`${okMsg(ok)}${failed.length ? `; ${failed.length} failed: ${failed[0]}` : ''}`, failed.length ? 'error' : undefined);
    return !failed.length;
  }
  const patch = async (kd, body) => { Object.assign(kd, await api(base + '/' + encodeURIComponent(kd.id), { method: 'PATCH', body: JSON.stringify(body) })); };
  const plural = (n) => `${n} key date${n === 1 ? '' : 's'}`;

  function paintBulk() {
    bulk.hidden = !selected.size;
    if (!selected.size) { bulk.innerHTML = ''; return; }
    bulk.innerHTML = `<strong>${selected.size} selected</strong>
      <label class="sr-only" for="kd-shift">Days to shift</label>
      <input id="kd-shift" type="number" step="1" value="7" style="width:5rem" />
      <button type="button" class="btn btn-ghost btn-sm" data-shift>Shift by days</button>
      <label class="sr-only" for="kd-setdate">Set date</label>
      <input id="kd-setdate" type="date" />
      <button type="button" class="btn btn-ghost btn-sm" data-setdate>Set date</button>
      <button type="button" class="btn btn-ghost btn-sm btn-danger" data-del>Delete ${selected.size}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-clear>Clear selection</button>`;
    bulk.querySelector('[data-clear]').addEventListener('click', () => { selected.clear(); paint(); });
    bulk.querySelector('[data-shift]').addEventListener('click', async () => {
      const n = parseInt(bulk.querySelector('#kd-shift').value, 10);
      if (!n) return toast('Enter a number of days (negative moves earlier)', 'error');
      if (await each([...selected], (kd) => patch(kd, { date: shiftIso(kd.date, n) }), (k) => `${plural(k)} moved ${n > 0 ? '+' : ''}${n} days`)) selected.clear();
      paint();
    });
    bulk.querySelector('[data-setdate]').addEventListener('click', async () => {
      const d = bulk.querySelector('#kd-setdate').value;
      if (!d) return toast('Pick a date', 'error');
      if (await each([...selected], (kd) => patch(kd, { date: d }), (k) => `${plural(k)} set to ${formatDate(d)}`)) selected.clear();
      paint();
    });
    bulk.querySelector('[data-del]').addEventListener('click', async () => {
      if (!window.confirm(`Delete ${plural(selected.size)}? This can’t be undone.`)) return;
      await each([...selected], async (kd) => { await api(base + '/' + encodeURIComponent(kd.id), { method: 'DELETE' }); rows.splice(rows.indexOf(kd), 1); selected.delete(kd.id); }, (k) => `${plural(k)} deleted`);
      paint();
    });
  }

  function paint() {
    const term = q.value.trim().toLowerCase();
    const [qs, qe] = quarterRange();
    shown = rows.filter((r) => (!term || r.description.toLowerCase().includes(term)) &&
      (!whenS.value || (whenS.value === 'upcoming' ? r.date >= today : whenS.value === 'past' ? r.date < today : r.date >= qs && r.date < qe)));
    const [k, dir] = sortS.value.split('-'); const m = dir === 'asc' ? 1 : -1;
    shown.sort((a, b) => m * (k === 'date' ? a.date.localeCompare(b.date) : k === 'desc' ? a.description.localeCompare(b.description) : (a.created_at || '').localeCompare(b.created_at || '')) || a.date.localeCompare(b.date));
    meta.textContent = shown.length === rows.length ? plural(rows.length) : `${shown.length} of ${plural(rows.length)}`;
    list.innerHTML = `<div class="topic-list-row topic-list-head kd-grid"><div class="topic-list-sel"><input type="checkbox" data-selall aria-label="Select all shown key dates" /></div><div>Date</div><div>Description</div><div>When</div><div><span class="sr-only">Actions</span></div></div>`;
    const all = list.querySelector('[data-selall]');
    const refreshAll = () => { const n = shown.filter((r) => selected.has(r.id)).length; all.checked = n > 0 && n === shown.length; all.indeterminate = n > 0 && n < shown.length; };
    all.addEventListener('change', () => { shown.forEach((r) => (all.checked ? selected.add(r.id) : selected.delete(r.id))); paint(); });
    if (!shown.length) list.insertAdjacentHTML('beforeend', `<div class="empty-state empty-filtered"><p>${rows.length ? 'No key dates match these filters.' : 'No key dates yet. Add the first one above.'}</p></div>`);
    for (const kd of shown) {
      const n = daysFrom(kd.date);
      const when = n === 0 ? 'Today' : n > 0 ? `In ${n} day${n === 1 ? '' : 's'}` : `${-n} day${n === -1 ? '' : 's'} ago`;
      const row = document.createElement('div');
      row.className = 'topic-list-row kd-grid' + (kd.date < today ? ' kd-past' : '') + (selected.has(kd.id) ? ' is-selected' : '');
      row.style.cursor = 'default';
      row.innerHTML = `
        <div class="topic-list-sel"><input type="checkbox" data-sel aria-label="Select ${escapeHtml(kd.description)}"${selected.has(kd.id) ? ' checked' : ''} /></div>
        <div><input type="date" class="kd-edit-date" value="${escapeHtml(kd.date)}" aria-label="Date" /></div>
        <div><input type="text" class="kd-edit-desc" maxlength="120" value="${escapeHtml(kd.description)}" aria-label="Description" /></div>
        <div class="topic-list-period">${when}</div>
        <div class="topic-list-actions"><button type="button" class="btn btn-ghost btn-sm kd-remove">Delete</button></div>`;
      const dateIn = row.querySelector('.kd-edit-date'), descIn = row.querySelector('.kd-edit-desc');
      const save = async () => {
        const date = dateIn.value, description = descIn.value.trim();
        if (date === kd.date && description === kd.description) return;
        if (!date || !description) { toast('A key date needs a date and a description', 'error'); dateIn.value = kd.date; descIn.value = kd.description; return; }
        try { await patch(kd, { date, description }); toast('Key date saved'); paint(); paintTimeline(); } catch (err) { toast(err.message, 'error'); }
      };
      dateIn.addEventListener('change', save);
      descIn.addEventListener('change', save);
      descIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') descIn.blur(); });
      row.querySelector('[data-sel]').addEventListener('change', (e) => {
        e.target.checked ? selected.add(kd.id) : selected.delete(kd.id);
        row.classList.toggle('is-selected', e.target.checked); refreshAll(); paintBulk();
      });
      row.querySelector('.kd-remove').addEventListener('click', async () => {
        try { await api(base + '/' + encodeURIComponent(kd.id), { method: 'DELETE' }); rows.splice(rows.indexOf(kd), 1); selected.delete(kd.id); toast('Key date deleted'); paint(); paintTimeline(); }
        catch (err) { toast(err.message, 'error'); }
      });
      list.appendChild(row);
    }
    refreshAll(); paintBulk();
  }
  [q, whenS, sortS].forEach((el) => el.addEventListener(el === q ? 'input' : 'change', paint));
  const nd = card.querySelector('#kd-new-date'), ndesc = card.querySelector('#kd-new-desc');
  card.querySelector('.kd-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      rows.push(await api(base, { method: 'POST', body: JSON.stringify({ date: nd.value, description: ndesc.value.trim() }) }));
      nd.value = ''; ndesc.value = ''; toast('Key date added'); paint(); paintTimeline(); nd.focus();
    } catch (err) { toast(err.message, 'error'); }
  });
  paintTimeline();
  paint();
}

function route() {
  const h = location.hash;
  if (h === '#settings') {
    showSettings();
  } else if (h.startsWith('#weekly')) {
    const raw = h.startsWith('#weekly=') ? h.slice('#weekly='.length) : '';
    showWeekly(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined);
  } else if (h.startsWith('#topic=')) {
    const [tid, rest] = h.slice('#topic='.length).split('/');
    if (rest && rest.startsWith('report=')) showReport(tid, rest.slice('report='.length));
    else if (rest && rest.startsWith('edit=')) showTopicUpdate(tid, rest.slice('edit='.length));
    else if (rest === 'key-dates') showKeyDates(tid);
    else showTopic(tid);
  } else if (h === '#topics') {
    showHome();
  } else if (h.startsWith('#calendar')) {
    showCalendar(/^#calendar=\d{4}-\d{2}$/.test(h) ? h.slice('#calendar='.length) : undefined);
  } else {
    showOverview();
  }
}

window.addEventListener('hashchange', route);

/* Printing is disabled — use Download PNG on the weekly report. */
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
    e.preventDefault();
    toast('Printing is disabled — use Download PNG on the weekly report', 'error');
  }
});

/* boot */
Promise.all([loadCategoryNames(), loadRoleList()]).then(route);

