'use strict';

const app = document.getElementById('app');
const toastHost = document.getElementById('toast-host');

document.getElementById('btn-home').addEventListener('click', () => showHome());

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
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
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

function formatDate(isoDate) {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });
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

function inferPeriod(cadence, previous) {
  const end = todayUTC();
  let start;
  if (previous && previous.period_end) {
    start = addDays(previous.period_end, 1);
  } else {
    const days = cadence === 'weekly' ? 6 : cadence === 'fortnightly' ? 13 : 29;
    start = addDays(end, -days);
  }
  if (start > end) start = end;
  return { period_start: start, period_end: end };
}

function isEmptyRich(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  return !(tmp.textContent || '').replace(/\u00a0/g, ' ').trim();
}

function ragChip(rag) {
  if (!rag) return '<span class="chip chip-inactive">No report</span>';
  return `<span class="chip chip-rag-${escapeHtml(rag)}">${escapeHtml(rag)}</span>`;
}

function cadenceChip(c) {
  return `<span class="chip chip-cadence">${escapeHtml(c)}</span>`;
}

function trendChip(t) {
  if (!t) return '';
  return `<span class="chip chip-trend">${escapeHtml(t)}</span>`;
}

/* ── Rich text editor ─────────────────────────────────────────────────────── */

function createRte(id, { placeholder = '', value = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'rte';
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

async function showHome() {
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
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-primary';
  addBtn.textContent = 'New topic';
  addBtn.addEventListener('click', () => openNewTopicModal());
  head.appendChild(addBtn);
  app.appendChild(head);

  if (!active.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No topics yet. Create one to get started.';
    app.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'topic-list';
  list.setAttribute('role', 'table');
  list.setAttribute('aria-label', 'Topics');

  const header = document.createElement('div');
  header.className = 'topic-list-row topic-list-head';
  header.setAttribute('role', 'row');
  header.innerHTML = `
    <div role="columnheader">Topic</div>
    <div role="columnheader">Owner</div>
    <div role="columnheader">Cadence</div>
    <div role="columnheader">RAG</div>
    <div role="columnheader">Trend</div>
    <div role="columnheader">Last period</div>
    <div role="columnheader"><span class="sr-only">Actions</span></div>
  `;
  list.appendChild(header);

  for (const t of active) {
    const latest = t.latest_report;
    const period = latest
      ? `${formatDate(latest.period_start)} – ${formatDate(latest.period_end)}`
      : 'No updates yet';
    const summary = latest && latest.exec_summary
      ? String(latest.exec_summary).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    const snippet = summary.length > 120 ? summary.slice(0, 117) + '…' : summary;

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
      <div class="topic-list-owner" role="cell">${t.owner ? escapeHtml(t.owner) : '—'}</div>
      <div role="cell">${cadenceChip(t.cadence)}</div>
      <div role="cell">${ragChip(latest && latest.rag)}</div>
      <div role="cell">${latest ? trendChip(latest.trend) : '<span class="chip chip-muted">—</span>'}</div>
      <div class="topic-list-period" role="cell">${escapeHtml(period)}</div>
      <div class="topic-list-actions" role="cell">
        <button type="button" class="btn btn-primary btn-sm" data-update>Update</button>
        <button type="button" class="btn btn-ghost btn-sm" data-edit>Edit</button>
      </div>
    `;
    row.querySelector('[data-update]').addEventListener('click', (e) => {
      e.stopPropagation();
      open();
    });
    row.querySelector('[data-edit]').addEventListener('click', (e) => {
      e.stopPropagation();
      openTopicModal(t);
    });
    list.appendChild(row);
  }

  app.appendChild(list);
}

function openTopicModal(existing = null) {
  const editing = Boolean(existing);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const cadence = (existing && existing.cadence) || 'weekly';
  backdrop.innerHTML = `
    <div class="modal">
      <h2>${editing ? 'Edit topic' : 'New topic'}</h2>
      <div class="field">
        <label for="topic-name">Name</label>
        <input id="topic-name" type="text" autocomplete="off" required value="${escapeHtml((existing && existing.name) || '')}" />
      </div>
      <div class="field">
        <label for="topic-cadence">Cadence</label>
        <select id="topic-cadence">
          <option value="weekly"${cadence === 'weekly' ? ' selected' : ''}>Weekly</option>
          <option value="fortnightly"${cadence === 'fortnightly' ? ' selected' : ''}>Fortnightly</option>
          <option value="monthly"${cadence === 'monthly' ? ' selected' : ''}>Monthly</option>
        </select>
      </div>
      <div class="field">
        <label for="topic-owner">Owner</label>
        <input id="topic-owner" type="text" autocomplete="off" value="${escapeHtml((existing && existing.owner) || '')}" />
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

  backdrop.querySelector('[data-save]').addEventListener('click', async () => {
    const name = backdrop.querySelector('#topic-name').value.trim();
    const cadenceVal = backdrop.querySelector('#topic-cadence').value;
    const owner = backdrop.querySelector('#topic-owner').value.trim();
    if (!name) {
      toast('Name is required', 'error');
      return;
    }
    try {
      if (editing) {
        await api('/api/topics/' + encodeURIComponent(existing.id), {
          method: 'PATCH',
          body: JSON.stringify({ name, cadence: cadenceVal, owner })
        });
        toast('Topic updated');
        close();
        showTopic(existing.id);
      } else {
        await api('/api/topics', {
          method: 'POST',
          body: JSON.stringify({ name, cadence: cadenceVal, owner })
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

async function showTopic(topicId) {
  app.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const topics = await api('/api/topics');
    const topic = topics.find((t) => t.id === topicId);
    if (!topic) {
      app.innerHTML = '<div class="empty-state">Topic not found.</div>';
      return;
    }
    const previous = topic.latest_report || (await api(`/api/topics/${topicId}/latest`));
    renderTopicUpdate(topic, previous);
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderReportPanel(title, report, emptyMsg) {
  const panel = document.createElement('section');
  panel.className = 'panel previous-panel';

  const h2 = document.createElement('h2');
  h2.innerHTML = `<span class="panel-label">${escapeHtml(title)}</span>`;
  panel.appendChild(h2);

  if (!report) {
    const empty = document.createElement('p');
    empty.className = 'report-empty';
    empty.textContent = emptyMsg || 'No previous update.';
    panel.appendChild(empty);
    return panel;
  }

  const meta = document.createElement('div');
  meta.className = 'report-meta';
  meta.innerHTML = `
    ${ragChip(report.rag)}
    ${trendChip(report.trend)}
    <span class="topic-period">${escapeHtml(formatDate(report.period_start))} – ${escapeHtml(formatDate(report.period_end))}</span>
  `;
  panel.appendChild(meta);

  const sections = [
    ['Exec summary', report.exec_summary],
    ['Achievements', report.achievements],
    ['Next steps', report.next_steps]
  ];
  if (report.rag !== 'Green' && report.gtg_plan) {
    sections.push(['Get-to-green plan', report.gtg_plan]);
  }

  for (const [label, html] of sections) {
    const sec = document.createElement('div');
    sec.className = 'report-section';
    const lab = document.createElement('div');
    lab.className = 'panel-label';
    lab.textContent = label;
    const body = document.createElement('div');
    body.className = 'report-body';
    if (isEmptyRich(html)) {
      body.innerHTML = '<span class="report-empty">—</span>';
    } else {
      body.innerHTML = html;
    }
    sec.appendChild(lab);
    sec.appendChild(body);
    panel.appendChild(sec);
  }

  return panel;
}

function renderTopicUpdate(topic, previous) {
  app.innerHTML = '';

  const back = document.createElement('div');
  back.className = 'back-row';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn btn-ghost btn-sm';
  backBtn.textContent = '← All topics';
  backBtn.addEventListener('click', () => showHome());
  back.appendChild(backBtn);
  app.appendChild(back);

  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = `
    <div>
      <h1>${escapeHtml(topic.name)}</h1>
      <p>
        ${cadenceChip(topic.cadence)}
        ${topic.owner ? `<span class="topic-owner"> · ${escapeHtml(topic.owner)}</span>` : ''}
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

  const periodRow = document.createElement('div');
  periodRow.className = 'field-row';
  periodRow.innerHTML = `
    <div class="field">
      <label for="period-start">Period start</label>
      <input id="period-start" type="date" value="${escapeHtml(period.period_start)}" />
    </div>
    <div class="field">
      <label for="period-end">Period end</label>
      <input id="period-end" type="date" value="${escapeHtml(period.period_end)}" />
    </div>
  `;
  formPanel.appendChild(periodRow);

  const statusRow = document.createElement('div');
  statusRow.className = 'field-row';
  statusRow.innerHTML = `
    <div class="field">
      <label for="rag">RAG status</label>
      <select id="rag">
        <option value="Green">Green</option>
        <option value="Amber" selected>Amber</option>
        <option value="Red">Red</option>
      </select>
    </div>
    <div class="field">
      <label for="trend">Trend</label>
      <select id="trend">
        <option value="Improving">Improving</option>
        <option value="Stable" selected>Stable</option>
        <option value="Declining">Declining</option>
      </select>
    </div>
  `;
  formPanel.appendChild(statusRow);

  const fields = {};

  function addRichField(key, label, placeholder) {
    const field = document.createElement('div');
    field.className = 'field';
    const lab = document.createElement('label');
    lab.textContent = label;
    field.appendChild(lab);
    const rte = createRte(key, { placeholder });
    field.appendChild(rte);
    formPanel.appendChild(field);
    fields[key] = rte;
    return field;
  }

  addRichField('exec_summary', 'Exec summary', 'Brief narrative for leadership…');
  addRichField('achievements', 'Achievements', 'What landed this period…');
  addRichField('next_steps', 'Next steps', 'Priorities for the next period…');

  const gtgField = document.createElement('div');
  gtgField.className = 'field gtg-block';
  const gtgLab = document.createElement('label');
  gtgLab.innerHTML = 'Get-to-green plan <span class="hint">(required when RAG is not Green)</span>';
  gtgField.appendChild(gtgLab);
  const gtgRte = createRte('gtg_plan', { placeholder: 'Actions, owners, and dates to return to Green…' });
  gtgField.appendChild(gtgRte);
  formPanel.appendChild(gtgField);
  fields.gtg_plan = gtgRte;

  const ragSelect = statusRow.querySelector('#rag');
  function syncGtg() {
    const needs = ragSelect.value !== 'Green';
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
      trend: formPanel.querySelector('#trend').value,
      exec_summary: fields.exec_summary.getHtml(),
      achievements: fields.achievements.getHtml(),
      next_steps: fields.next_steps.getHtml(),
      gtg_plan: fields.gtg_plan.getHtml()
    };

    let ok = true;
    fields.exec_summary.setWarn(false);
    fields.gtg_plan.setWarn(false);

    if (!payload.period_start || !payload.period_end) {
      toast('Period start and end are required', 'error');
      ok = false;
    }
    if (isEmptyRich(payload.exec_summary)) {
      fields.exec_summary.setWarn(true);
      toast('Exec summary is required', 'error');
      ok = false;
    }
    if (payload.rag !== 'Green' && isEmptyRich(payload.gtg_plan)) {
      fields.gtg_plan.setWarn(true);
      toast('Get-to-green plan is required when RAG is not Green', 'error');
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
  layout.appendChild(
    renderReportPanel('Previous update', previous, 'No previous update for this topic — this will be the first.')
  );
  app.appendChild(layout);

  fields.exec_summary.focus();
}

/* boot */
showHome();
