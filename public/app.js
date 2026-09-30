'use strict';

const app = document.getElementById('app');
const toastHost = document.getElementById('toast-host');

let pendingTopicFilter = null;

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
    const topics = await api('/api/topics');
    renderOverview(topics);
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderOverview(topics) {
  const active = topics.filter((t) => t.active !== false);
  const counts = { Red: 0, Amber: 0, Green: 0, Blue: 0, none: 0 };
  for (const t of active) {
    const r = t.latest_report && t.latest_report.rag;
    if (r && counts[r] !== undefined) counts[r] += 1; else counts.none += 1;
  }

  const ending = weekEndingFridayContaining(todayUTC());
  const staleBefore = { weekly: mondayOfWeekEnding(ending), fortnightly: addDays(mondayOfWeekEnding(ending), -7), monthly: addDays(mondayOfWeekEnding(ending), -24) };
  const due = active.filter((t) => {
    if (t.latest_report && t.latest_report.rag === 'Blue') return false;
    const pe = t.latest_report && t.latest_report.period_end;
    return !pe || pe < (staleBefore[t.cadence] || staleBefore.weekly);
  });

  const RAG_RANK = { Red: 0, Amber: 1 };
  const attention = active
    .filter((t) => t.latest_report && (t.latest_report.rag === 'Red' || t.latest_report.rag === 'Amber'))
    .sort((a, b) => RAG_RANK[a.latest_report.rag] - RAG_RANK[b.latest_report.rag] || (a.sort_order || 0) - (b.sort_order || 0));
  const recent = active
    .filter((t) => t.latest_report)
    .sort((a, b) => String(b.latest_report.created_at || b.latest_report.period_end).localeCompare(String(a.latest_report.created_at || a.latest_report.period_end)))
    .slice(0, 6);

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const nowLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  app.innerHTML = '';
  const hero = document.createElement('div');
  hero.className = 'ov-hero';
  hero.innerHTML = `<div><h1>${greet}</h1><p>${escapeHtml(nowLabel)} · Week ending ${escapeHtml(formatDate(ending))}</p></div>`;
  app.appendChild(hero);

  const tiles = document.createElement('div');
  tiles.className = 'ov-tiles';
  const tileDefs = [
    ['', active.length, 'Active topics', ''],
    ['red', counts.Red, 'Red', 'Red'],
    ['amber', counts.Amber, 'Amber', 'Amber'],
    ['green', counts.Green, 'Green', 'Green'],
    ['blue', counts.Blue, 'Complete', 'Blue'],
    ['', counts.none, 'No report', 'none']
  ];
  for (const [cls, n, label, filter] of tileDefs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ov-tile ' + cls;
    b.innerHTML = `<b>${n}</b><span>${escapeHtml(label)}</span>`;
    b.addEventListener('click', () => { pendingTopicFilter = filter; showHome(); });
    tiles.appendChild(b);
  }
  app.appendChild(tiles);

  function topicRow(t, sub) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ov-row';
    btn.innerHTML = `
      <span class="ov-row-name">${escapeHtml(t.name)}</span>
      ${statusUnit(t.latest_report && t.latest_report.rag, t.latest_report && t.latest_report.trend)}
      <span class="ov-row-sub">${escapeHtml(sub)}</span>`;
    btn.addEventListener('click', () => showTopic(t.id));
    li.appendChild(btn);
    return li;
  }
  function card(title, note, cls) {
    const c = document.createElement('section');
    c.className = 'ov-card' + (cls ? ' ' + cls : '');
    c.innerHTML = `<h2>${escapeHtml(title)}<small>${escapeHtml(note)}</small></h2>`;
    return c;
  }
  function fill(c, items, emptyMsg) {
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'ov-empty';
      p.textContent = emptyMsg;
      c.appendChild(p);
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'ov-list';
    items.forEach((li) => ul.appendChild(li));
    c.appendChild(ul);
  }

  const grid = document.createElement('div');
  grid.className = 'ov-grid';

  const attCard = card('Red / Amber topics', String(attention.length));
  fill(attCard, attention.map((t) => {
    const plan = plainTextSnippet(t.latest_report.gtg_plan || t.latest_report.exec_summary || '', 110);
    return topicRow(t, plan || `${t.owner || 'No owner'}`);
  }), 'Nothing is Red or Amber.');
  grid.appendChild(attCard);

  const dueCard = card('Due for an update', `${due.length} topic${due.length === 1 ? '' : 's'}`);
  fill(dueCard, due.map((t) => topicRow(t, t.latest_report
    ? `Last update: ${formatDate(t.latest_report.period_end)} · ${t.owner || 'No owner'}`
    : `No updates yet · ${t.owner || 'No owner'}`)), 'Every topic is up to date.');
  grid.appendChild(dueCard);

  const recentCard = card('Recent updates', 'Latest submitted', 'wide');
  fill(recentCard, recent.map((t) => topicRow(t,
    `${t.owner || 'No owner'} · ${formatDate(t.latest_report.period_end)} · ${plainTextSnippet(t.latest_report.exec_summary || '', 90)}`)),
  'No updates yet.');
  grid.appendChild(recentCard);

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
        <option value="priority-asc" selected>Priority</option>
        <option value="name-asc">Name A–Z</option>
        <option value="name-desc">Name Z–A</option>
        <option value="rag-asc">RAG (worst first)</option>
        <option value="rag-desc">RAG (best first)</option>
        <option value="period-desc">Last period (newest)</option>
        <option value="period-asc">Last period (oldest)</option>
        <option value="owner-asc">Owner A–Z</option>
        <option value="cadence-asc">Cadence</option>
      </select>
    </div>
  `;
  app.appendChild(toolbar);

  const meta = document.createElement('div');
  meta.className = 'list-meta';
  app.appendChild(meta);

  const list = document.createElement('div');
  list.className = 'topic-list';
  list.setAttribute('role', 'table');
  list.setAttribute('aria-label', 'Topics');
  app.appendChild(list);

  const qInput = toolbar.querySelector('#topic-filter-q');
  const ragFilter = toolbar.querySelector('#topic-filter-rag');
  if (pendingTopicFilter) {
    ragFilter.value = pendingTopicFilter;
    pendingTopicFilter = null;
  }
  const cadenceFilter = toolbar.querySelector('#topic-filter-cadence');
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

    const sort = sortSelect.value;
    rows.sort((a, b) => {
      const la = a.latest_report;
      const lb = b.latest_report;
      if (sort === 'priority-asc') {
        return ((a.sort_order || 0) - (b.sort_order || 0)) || (a.name || '').localeCompare(b.name || '');
      }
      if (sort === 'name-asc') return (a.name || '').localeCompare(b.name || '');
      if (sort === 'name-desc') return (b.name || '').localeCompare(a.name || '');
      if (sort === 'owner-asc') return (a.owner || '').localeCompare(b.owner || '') || (a.name || '').localeCompare(b.name || '');
      if (sort === 'cadence-asc') {
        const order = { weekly: 0, fortnightly: 1, monthly: 2 };
        return (order[a.cadence] ?? 9) - (order[b.cadence] ?? 9) || (a.name || '').localeCompare(b.name || '');
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
    header.innerHTML = `
      <div role="columnheader">Topic</div>
      <div role="columnheader">Owner</div>
      <div role="columnheader">Cadence</div>
      <div role="columnheader">Status</div>
      <div role="columnheader">Last period</div>
      <div role="columnheader"><span class="sr-only">Actions</span></div>
    `;
    list.appendChild(header);

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
      row.className = 'topic-list-row';
      row.setAttribute('role', 'row');
      row.tabIndex = 0;
      const open = () => showTopic(t.id);
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        open();
      });
      row.addEventListener('keydown', (e) => {
        if (e.target.closest('button')) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });

      row.innerHTML = `
        <div class="topic-list-topic" role="cell">
          <div class="topic-list-name">${escapeHtml(t.name)}</div>
          ${snippet ? `<div class="topic-list-snippet">${escapeHtml(snippet)}</div>` : ''}
        </div>
        <div class="topic-list-owner" role="cell">
          ${t.owner ? escapeHtml(t.owner) : '—'}
          ${t.business_unit ? `<span class="topic-list-bu">${escapeHtml(t.business_unit)}</span>` : ''}
        </div>
        <div class="topic-list-cadence" role="cell">${cadenceText(t.cadence)}</div>
        <div class="topic-list-status" role="cell">${latest
          ? statusUnit(latest.rag, latest.trend)
          : statusUnit(null, null)}</div>
        <div class="topic-list-period" role="cell">${escapeHtml(period)}</div>
        <div class="topic-list-actions" role="cell">
          <button type="button" class="btn btn-ghost btn-sm" data-edit>Edit</button>
        </div>
      `;
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

  let workingKeyDates = [];
  if (editing && existing && existing.id) {
    try {
      workingKeyDates = await api('/api/topics/' + encodeURIComponent(existing.id) + '/key-dates');
    } catch {
      workingKeyDates = Array.isArray(existing.key_dates) ? existing.key_dates.slice() : [];
    }
  }
  // Local staging: { id?, date, description, _local?, _deleted? }
  workingKeyDates = workingKeyDates.map((k) => ({
    id: k.id,
    date: k.date,
    description: k.description,
    _local: false
  }));

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const cadence = (existing && existing.cadence) || 'weekly';
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
          <label for="topic-priority">Priority</label>
          <input id="topic-priority" type="number" min="1" step="1" placeholder="e.g. 1" value="${priorityVal === '' || Number.isNaN(priorityVal) ? '' : escapeHtml(String(priorityVal))}" />
          <p class="field-hint">Lower number appears first in the list and weekly pack.</p>
        </div>
      </div>
      <div class="field key-dates-field">
        <label>Key dates</label>
        <p class="field-hint">Shown as short text in the weekly 8-week grid.</p>
        <div class="key-dates-editor" id="key-dates-editor"></div>
        <div class="key-dates-add">
          <input id="kd-date" type="date" aria-label="Key date" />
          <input id="kd-desc" type="text" maxlength="120" placeholder="Short description" aria-label="Key date description" />
          <button type="button" class="btn btn-ghost btn-sm" id="kd-add">Add</button>
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

  const editor = backdrop.querySelector('#key-dates-editor');
  const removedIds = [];

  function paintKeyDates() {
    editor.innerHTML = '';
    const active = workingKeyDates.filter((k) => !k._deleted);
    if (!active.length) {
      const empty = document.createElement('div');
      empty.className = 'key-dates-empty';
      empty.textContent = 'No key dates yet.';
      editor.appendChild(empty);
      return;
    }
    active.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    for (const kd of active) {
      const row = document.createElement('div');
      row.className = 'key-dates-editor-row';
      row.innerHTML =
        '<input type="date" class="kd-edit-date" value="' + escapeHtml(kd.date || '') + '" aria-label="Date" />' +
        '<input type="text" class="kd-edit-desc" maxlength="120" value="' + escapeHtml(kd.description || '') + '" aria-label="Description" />' +
        '<button type="button" class="btn btn-ghost btn-sm kd-remove" title="Remove">Remove</button>';
      const dateInput = row.querySelector('.kd-edit-date');
      const descInput = row.querySelector('.kd-edit-desc');
      dateInput.addEventListener('change', () => { kd.date = dateInput.value; });
      descInput.addEventListener('input', () => { kd.description = descInput.value; });
      row.querySelector('.kd-remove').addEventListener('click', () => {
        if (kd.id && !kd._local) removedIds.push(kd.id);
        kd._deleted = true;
        paintKeyDates();
      });
      editor.appendChild(row);
    }
  }
  paintKeyDates();

  backdrop.querySelector('#kd-add').addEventListener('click', () => {
    const date = backdrop.querySelector('#kd-date').value;
    const description = backdrop.querySelector('#kd-desc').value.trim();
    if (!date) {
      toast('Pick a date', 'error');
      return;
    }
    if (!description) {
      toast('Add a short description', 'error');
      return;
    }
    workingKeyDates.push({
      id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      date,
      description,
      _local: true
    });
    backdrop.querySelector('#kd-date').value = '';
    backdrop.querySelector('#kd-desc').value = '';
    paintKeyDates();
  });

  async function syncKeyDates(topicId) {
    const base = 'api/topics/' + encodeURIComponent(topicId) + '/key-dates';
    for (const id of removedIds) {
      await api(base + '/' + encodeURIComponent(id), { method: 'DELETE' });
    }
    const active = workingKeyDates.filter((k) => !k._deleted);
    for (const kd of active) {
      const date = (kd.date || '').trim();
      const description = (kd.description || '').trim();
      if (!date || !description) continue;
      if (kd._local || !kd.id || String(kd.id).startsWith('local-')) {
        await api(base, {
          method: 'POST',
          body: JSON.stringify({ date, description })
        });
      } else {
        await api(base + '/' + encodeURIComponent(kd.id), {
          method: 'PATCH',
          body: JSON.stringify({ date, description })
        });
      }
    }
  }

  backdrop.querySelector('[data-save]').addEventListener('click', async () => {
    const name = backdrop.querySelector('#topic-name').value.trim();
    const description = backdrop.querySelector('#topic-description').value.trim();
    const cadenceVal = backdrop.querySelector('#topic-cadence').value;
    const owner = backdrop.querySelector('#topic-owner').value.trim();
    const business_unit = backdrop.querySelector('#topic-bu').value.trim();
    const priorityRaw = backdrop.querySelector('#topic-priority').value.trim();
    if (!name) {
      toast('Title is required', 'error');
      return;
    }
    const incomplete = workingKeyDates.some((k) => !k._deleted && (!(k.date || '').trim() || !(k.description || '').trim()));
    if (incomplete) {
      toast('Each key date needs a date and description', 'error');
      return;
    }
    const payload = { name, description, cadence: cadenceVal, owner, business_unit };
    if (priorityRaw !== '') {
      const n = Number(priorityRaw);
      if (!Number.isFinite(n) || n < 1) {
        toast('Priority must be a number ≥ 1', 'error');
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
        await syncKeyDates(existing.id);
        toast('Topic updated');
        close();
        if (afterSave === 'home') showHome();
        else showTopic(existing.id);
      } else {
        const created = await api('/api/topics', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        if (created && created.id) await syncKeyDates(created.id);
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


async function showTopic(topicId) {
  setNav('topics');
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
    const previous = history[0] || topic.latest_report || null;
    renderTopicUpdate(topic, previous, history);
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

function renderTopicUpdate(topic, previous, history) {
  app.innerHTML = '';


  const head = document.createElement('div');
  head.className = 'page-head';
  const topicDesc = (topic.description || '').replace(/\s+/g, ' ').trim();
  head.innerHTML = `
    <div>
      <h1>${escapeHtml(topic.name)}</h1>
      ${topicDesc ? `<p class="topic-page-desc">${escapeHtml(topicDesc)}</p>` : ''}
      <p>
        ${cadenceText(topic.cadence)}
        ${topic.owner ? `<span class="topic-owner"> · ${escapeHtml(topic.owner)}</span>` : ''}
        ${topic.business_unit ? `<span class="topic-owner"> · ${escapeHtml(topic.business_unit)}</span>` : ''}
      </p>
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
  formPanel.innerHTML = `<h2><span class="panel-label">New update</span></h2>`;

  const period = inferPeriod(topic.cadence, previous);
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
  cancelBtn.addEventListener('click', () => showHome());
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save update';
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
      await api(`/api/topics/${topic.id}/reports`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      toast('Update saved');
      showTopic(topic.id);
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

/* ── Management follow-up comments / questions ─────────────────────────── */


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

/** Follow-up thread + composer for one topic in one reporting week. */
function buildFollowUps(item, weekEnding, onChange) {
  const topic = item.topic || {};
  if (!Array.isArray(item.comments)) item.comments = [];
  const wrap = document.createElement('div');
  wrap.className = 'followups';

  const head = document.createElement('div');
  head.className = 'followups-head';
  const title = document.createElement('div');
  title.className = 'panel-label';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-sm followups-add';
  addBtn.setAttribute('data-png-skip', '');
  addBtn.textContent = '+ Comment';
  addBtn.title = 'Add a comment for the topic owner';
  head.appendChild(title);
  head.appendChild(addBtn);
  wrap.appendChild(head);

  const list = document.createElement('ul');
  list.className = 'followups-list';
  wrap.appendChild(list);

  const form = document.createElement('form');
  form.className = 'followups-form';
  form.setAttribute('data-png-skip', '');
  form.hidden = true;
  form.innerHTML =
    '<textarea class="followups-body" rows="3" maxlength="2000" placeholder="Add a comment…" aria-label="Comment"></textarea>' +
    '<div class="followups-form-actions">' +
      '<span class="followups-as">Commenting as <b class="followups-as-name"></b></span>' +
      '<button type="button" class="btn btn-ghost btn-sm followups-cancel">Cancel</button>' +
      '<button type="submit" class="btn btn-primary btn-sm">Post</button>' +
    '</div>';
  wrap.appendChild(form);

  const asName = form.querySelector('.followups-as-name');
  const bodyIn = form.querySelector('.followups-body');

  bodyIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
    if (e.key === 'Escape') closeForm();
  });

  function render() {
    const open = item.comments.filter((c) => !c.resolved).length;
    title.textContent = 'Comments' +
      (item.comments.length ? ' · ' + item.comments.length + (open ? ' (' + open + ' open)' : ' (all resolved)') : '');
    wrap.classList.toggle('is-empty', !item.comments.length);
    if (item.comments.length) wrap.removeAttribute('data-png-skip'); else wrap.setAttribute('data-png-skip', '');
    list.innerHTML = '';
    for (const c of item.comments) {
      const li = document.createElement('li');
      li.className = 'followup' + (c.resolved ? ' is-resolved' : '');
      const meta = document.createElement('div');
      meta.className = 'followup-meta';
      meta.innerHTML =
        '<span class="followup-author">' + escapeHtml(c.author) + '</span>' +
        '<span class="followup-time">' + escapeHtml(formatStamp(c.created_at)) + '</span>' +
        (c.resolved ? '<span class="followup-resolved-tag">Resolved</span>' : '');
      const tools = document.createElement('span');
      tools.className = 'followup-tools';
      tools.setAttribute('data-png-skip', '');
      const resolveBtn = document.createElement('button');
      resolveBtn.type = 'button';
      resolveBtn.className = 'btn btn-ghost btn-sm';
      resolveBtn.textContent = c.resolved ? 'Reopen' : 'Resolve';
      resolveBtn.addEventListener('click', async () => {
        resolveBtn.disabled = true;
        try {
          const updated = await api('/api/comments/' + encodeURIComponent(c.id), {
            method: 'PATCH', body: JSON.stringify({ resolved: !c.resolved })
          });
          c.resolved = updated.resolved === true || updated.resolved === 'true';
          render(); onChange();
        } catch (err) { toast(err.message, 'error'); resolveBtn.disabled = false; }
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-ghost btn-sm';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        if (!window.confirm('Delete this comment?')) return;
        try {
          await api('/api/comments/' + encodeURIComponent(c.id), { method: 'DELETE' });
          item.comments = item.comments.filter((x) => x.id !== c.id);
          render(); onChange();
        } catch (err) { toast(err.message, 'error'); }
      });
      tools.appendChild(resolveBtn);
      tools.appendChild(delBtn);
      meta.appendChild(tools);
      const text = document.createElement('div');
      text.className = 'followup-body';
      text.textContent = c.body;
      li.appendChild(meta);
      li.appendChild(text);
      list.appendChild(li);
    }
    onChange();
  }

  function openForm() {
    form.hidden = false;
    addBtn.hidden = true;
    getCurrentUser().then((n) => { asName.textContent = n; });
    bodyIn.focus();
  }
  function closeForm() {
    form.hidden = true;
    addBtn.hidden = false;
    bodyIn.value = '';
  }
  addBtn.addEventListener('click', openForm);
  form.querySelector('.followups-cancel').addEventListener('click', closeForm);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = bodyIn.value.trim();
    if (!text) { toast('Enter your comment', 'error'); bodyIn.focus(); return; }
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const row = await api('/api/topics/' + encodeURIComponent(topic.id) + '/comments', {
        method: 'POST',
        body: JSON.stringify({ week_ending: weekEnding, kind: 'comment', body: text })
      });
      row.resolved = row.resolved === true || row.resolved === 'true';
      item.comments.push(row);
      closeForm();
      render();
      toast('Comment posted');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });

  render();
  return wrap;
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
    headActions.appendChild(dateField);
    headActions.appendChild(pngBtn);
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
        '<span class="weekly-cover-stat weekly-cover-followups" data-png-skip hidden></span>' +
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
        /* items already priority / sort_order — preserve that within same RAG */
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

    function updateFollowUpCount() {
      const el = cover.querySelector('.weekly-cover-followups');
      if (!el) return;
      const open = items.reduce((n, it) => n + (it.comments || []).filter((c) => !c.resolved).length, 0);
      el.hidden = !open;
      el.innerHTML = '<b>' + open + '</b> open comment' + (open === 1 ? '' : 's');
    }

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

    /* Win D — topic jump rail (priority / sort_order — same as cards) */
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
        '<span class="jump-rail-label">' + escapeHtml(topic.name || 'Untitled') + '</span>';
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
      if (topic.cadence) metaBits.push('<span class="cadence-text">' + escapeHtml(topic.cadence) + '</span>');

      const headEl = document.createElement('header');
      headEl.className = 'weekly-section-head';
      const identity = document.createElement('div');
      identity.className = 'weekly-section-identity';
      identity.innerHTML =
        '<p class="weekly-report-eyebrow">Key Topics Reporting<span class="weekly-sep"> · </span>' + escapeHtml(periodLabel) + '</p>' +
        '<h2 class="weekly-topic-title">' + escapeHtml(topic.name || 'Untitled') + '</h2>' +
        '<p class="weekly-topic-meta">' + metaBits.join('<span class="weekly-sep"> · </span>') + '</p>';
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
      if (kdGrid) {
        const kdWrap = document.createElement('div');
        kdWrap.className = 'weekly-kd';
        kdWrap.appendChild(kdGrid);
        mainRow.appendChild(kdWrap);
        mainRow.classList.add('has-key-dates');
      } else {
        mainRow.classList.add('no-key-dates');
      }

      section.appendChild(mainRow);
      section.appendChild(buildFollowUps(item, data.week_ending, updateFollowUpCount));
      pack.appendChild(section);
    }

    layout.appendChild(pack);
    exportWrap.appendChild(layout);

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



function route() {
  const h = location.hash;
  if (h.startsWith('#weekly')) {
    const raw = h.startsWith('#weekly=') ? h.slice('#weekly='.length) : '';
    showWeekly(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined);
  } else if (h === '#topics') {
    showHome();
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
route();

