'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT) || 3080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const TOPICS_FILE = path.join(DATA_DIR, 'topics.csv');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.csv');
const KEY_DATES_FILE = path.join(DATA_DIR, 'key_dates.csv');
const COMMENTS_FILE = path.join(DATA_DIR, 'comments.csv');

const TOPIC_HEADERS = [
  'id', 'name', 'description', 'owner', 'business_unit', 'category', 'cadence',
  'active', 'sort_order', 'created_at', 'updated_at'
];
const REPORT_HEADERS = [
  'id', 'topic_id', 'period_start', 'period_end', 'exec_summary', 'achievements',
  'next_steps', 'rag', 'trend', 'gtg_plan', 'created_at', 'updated_at'
];
const KEY_DATE_HEADERS = [
  'id', 'topic_id', 'date', 'description', 'created_at', 'updated_at'
];

const COMMENT_HEADERS = [
  'id', 'topic_id', 'week_ending', 'kind', 'author', 'body', 'resolved',
  'created_at', 'updated_at'
];
const VALID_COMMENT_KINDS = new Set(['comment', 'question']);

// What kind of work a topic is. Existing topics saved before this was added have none (shown as
// Uncategorised) until they're next edited.
const VALID_CATEGORIES = new Set(['Project', 'POC', 'AI use case']);

// Report calendar: a report covers the Mon-Fri week ending on a Friday and is due on that Friday
// (weekly), every other Friday (fortnightly) or the last Friday of the month (monthly). Prep starts
// PREP_LEAD_DAYS working days earlier.
const PREP_LEAD_DAYS = Number(process.env.REPORT_PREP_DAYS) || 2;

const VALID_CADENCES = new Set(['weekly', 'fortnightly', 'monthly']);
const VALID_RAG = new Set(['Red', 'Amber', 'Green', 'Blue']);
const VALID_TREND = new Set(['Improving', 'Stable', 'Declining']);

// ── CSV helpers (RFC 4180-ish, multiline-safe) ──────────────────────────────

function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function serializeCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsvField(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

function parseCsv(text) {
  const rows = [];
  let i = 0;
  const len = text.length;

  function readField() {
    if (i >= len) return '';
    if (text[i] === '"') {
      i++; // opening quote
      let out = '';
      while (i < len) {
        if (text[i] === '"') {
          if (i + 1 < len && text[i + 1] === '"') {
            out += '"';
            i += 2;
          } else {
            i++; // closing quote
            break;
          }
        } else {
          out += text[i++];
        }
      }
      return out;
    }
    let out = '';
    while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
      out += text[i++];
    }
    return out;
  }

  function readRow() {
    if (i >= len) return null;
    // skip blank lines
    while (i < len && (text[i] === '\r' || text[i] === '\n')) i++;
    if (i >= len) return null;
    const fields = [];
    while (true) {
      fields.push(readField());
      if (i < len && text[i] === ',') {
        i++;
        continue;
      }
      if (i < len && text[i] === '\r') i++;
      if (i < len && text[i] === '\n') i++;
      break;
    }
    return fields;
  }

  const headerRow = readRow();
  if (!headerRow) return [];
  const headers = headerRow.map((h) => h.trim());

  let row;
  while ((row = readRow()) !== null) {
    if (row.length === 1 && row[0] === '') continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = row[c] !== undefined ? row[c] : '';
    }
    rows.push(obj);
  }
  return rows;
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const buf = fs.readFileSync(filePath);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = buf.toString('latin1'); }
  text = text.replace(/^\ufeff/, '');
  if (!text.trim()) return [];
  return parseCsv(text);
}

function writeCsv(filePath, headers, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serializeCsv(headers, rows), 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

// ── Data access ─────────────────────────────────────────────────────────────

function loadTopics() {
  return readCsv(TOPICS_FILE).map((t) => ({
    ...t,
    description: t.description != null ? String(t.description) : '',
    business_unit: t.business_unit != null ? String(t.business_unit) : '',
    owner: t.owner != null ? String(t.owner) : '',
    category: VALID_CATEGORIES.has(t.category) ? t.category : '',
    active: t.active === 'true' || t.active === true,
    sort_order: Number(t.sort_order) || 0
  }));
}

function saveTopics(topics) {
  writeCsv(
    TOPICS_FILE,
    TOPIC_HEADERS,
    topics.map((t) => ({
      ...t,
      active: t.active ? 'true' : 'false',
      sort_order: String(t.sort_order)
    }))
  );
}

function loadReports() {
  return readCsv(REPORTS_FILE);
}

function saveReports(reports) {
  writeCsv(REPORTS_FILE, REPORT_HEADERS, reports);
}

function loadComments() {
  return readCsv(COMMENTS_FILE).map((c) => ({ ...c, resolved: c.resolved === 'true' }));
}

function saveComments(comments) {
  writeCsv(
    COMMENTS_FILE,
    COMMENT_HEADERS,
    comments.map((c) => ({ ...c, resolved: c.resolved ? 'true' : 'false' }))
  );
}

function ensureKeyDatesFile() {
  if (!fs.existsSync(KEY_DATES_FILE)) {
    writeCsv(KEY_DATES_FILE, KEY_DATE_HEADERS, []);
  }
}

function loadKeyDates() {
  ensureKeyDatesFile();
  return readCsv(KEY_DATES_FILE).map((k) => ({
    ...k,
    description: k.description != null ? String(k.description) : '',
    date: k.date != null ? String(k.date).trim() : ''
  }));
}

function saveKeyDates(rows) {
  ensureKeyDatesFile();
  writeCsv(KEY_DATES_FILE, KEY_DATE_HEADERS, rows);
}

function keyDatesForTopic(topicId) {
  return loadKeyDates()
    .filter((k) => k.topic_id === topicId)
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.created_at || '').localeCompare(b.created_at || ''));
}

function rollingWeekFridays(endingFriday) {
  return [-28, -21, -14, -7, 0, 7, 14, 21].map((d) => addDaysIso(endingFriday, d));
}

function reportsForTopic(topicId) {
  // Latest = most recently saved (created_at), not farthest period_end —
  // a backdated Amber must not hide a newer Green with an earlier period.
  return loadReports()
    .filter((r) => r.topic_id === topicId)
    .sort((a, b) => {
      const ca = (b.created_at || '').localeCompare(a.created_at || '');
      if (ca !== 0) return ca;
      return (b.period_end || '').localeCompare(a.period_end || '');
    });
}

function latestReport(topicId) {
  const list = reportsForTopic(topicId);
  return list.length ? list[0] : null;
}

function topicsWithLatest() {
  return loadTopics()
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    .map((t) => ({
      ...t,
      latest_report: latestReport(t.id)
    }));
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 5 * 1024 * 1024;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2'
};

function notFound(req, res, why) {
  console.log(`404 ${req.method} ${req.url}${why ? ' - ' + why : ''}`);
  sendError(res, 404, `Not found: ${req.method} ${req.url}${why ? ' - ' + why : ''}`);
}

function serveStatic(req, res, urlPath, searchParams) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  try { rel = decodeURIComponent(rel.split('?')[0]); } catch { rel = '/index.html'; }
  if (rel.includes('..')) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  // Behind a proxy the app may sit under a path prefix that isn't stripped, so a file not found
  // at its full path is looked for by name alone.
  const byName = path.join(PUBLIC_DIR, rel.endsWith('/') || !path.extname(rel) ? 'index.html' : path.basename(rel));
  fs.readFile(filePath, (err0, data0) => {
    if (!err0) return respond(filePath, data0);
    fs.readFile(byName, (err, data) => {
      if (err) return notFound(req, res, `couldn't read ${byName} (${err.code})`);
      respond(byName, data);
    });
  });
  function respond(filePath, data) {
    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(data);
  }
}

function addDaysIso(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function utcDow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Snap to Friday on or before date (week-ending Friday). */
function fridayOnOrBefore(dateStr) {
  const dow = utcDow(dateStr);
  const back = (dow + 2) % 7;
  return addDaysIso(dateStr, -back);
}

function mondayOfWeekEnding(fridayStr) {
  return addDaysIso(fridayStr, -4);
}

/** Week-ending Friday for the Mon–Fri week that contains dateStr (Sat/Sun → previous Fri). */
function weekEndingFridayContaining(dateStr) {
  const dow = utcDow(dateStr); // 0 Sun … 5 Fri … 6 Sat
  if (dow === 0) return addDaysIso(dateStr, -2);
  if (dow === 6) return addDaysIso(dateStr, -1);
  return addDaysIso(dateStr, 5 - dow);
}

/** Week-ending Friday of a report, or '' if it has no period_end. */
function reportWeek(r) {
  return r && r.period_end ? weekEndingFridayContaining(r.period_end) : '';
}

/** Reports for one topic, newest week first (ties: most recently saved). */
function sortedByWeekDesc(reports) {
  return reports.filter((r) => reportWeek(r)).sort((a, b) =>
    reportWeek(b).localeCompare(reportWeek(a)) || (b.created_at || '').localeCompare(a.created_at || ''));
}

/**
 * A topic that completed (RAG Blue) stays on the weekly report for the week it completed, then
 * drops. If a later report reopens it (any non-Blue RAG), it counts again from that week.
 */
function droppedBefore(topicReports, friday) {
  const prior = sortedByWeekDesc(topicReports).find((r) => reportWeek(r) < friday);
  return Boolean(prior && prior.rag === 'Blue');
}

function weeklyBundle(weekEnding) {
  const friday = weekEndingFridayContaining(weekEnding || todayUTC());
  const monday = mondayOfWeekEnding(friday);
  const week_fridays = rollingWeekFridays(friday);
  const topics = loadTopics()
    .filter((t) => t.active !== false)
    .slice()
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.name || '').localeCompare(b.name || ''));
  const allReports = loadReports();
  const allKeyDates = loadKeyDates();
  const allComments = loadComments();
  const items = [];
  for (const topic of topics) {
    const matches = allReports
      .filter((r) => {
        if (r.topic_id !== topic.id || !r.period_end) return false;
        return weekEndingFridayContaining(r.period_end) === friday;
      })
      .sort((a, b) => {
        const ca = (b.created_at || '').localeCompare(a.created_at || '');
        if (ca !== 0) return ca;
        return (b.period_end || '').localeCompare(a.period_end || '');
      });
    if (!matches.length) continue;
    if (droppedBefore(allReports.filter((r) => r.topic_id === topic.id), friday)) continue;
    const key_dates = allKeyDates
      .filter((k) => k.topic_id === topic.id)
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.created_at || '').localeCompare(b.created_at || ''));
    const comments = allComments
      .filter((c) => c.topic_id === topic.id && c.week_ending === friday)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    items.push({ topic, report: matches[0], key_dates, comments });
  }
  const weekSet = new Set();
  for (const r of allReports) {
    if (!r.period_end) continue;
    weekSet.add(weekEndingFridayContaining(r.period_end));
  }
  const available_weeks = Array.from(weekSet).sort((a, b) => b.localeCompare(a));

  return {
    week_ending: friday,
    period_start: monday,
    period_end: friday,
    week_fridays,
    available_weeks,
    items
  };
}

// ── Report calendar ─────────────────────────────────────────────────────────

/** Subtract n working days (Mon-Fri) from an ISO date. */
function subWorkingDays(dateStr, n) {
  let d = dateStr;
  while (n > 0) {
    d = addDaysIso(d, -1);
    const dow = utcDow(d);
    if (dow !== 0 && dow !== 6) n -= 1;
  }
  return d;
}

function lastFridayOfMonth(year, month) { // month 1-12
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return fridayOnOrBefore(last);
}

/** Due Fridays for one topic within [from, to] (inclusive ISO dates). */
function dueDatesFor(topic, reports, from, to) {
  const out = [];
  if (topic.cadence === 'monthly') {
    let [y, m] = from.split('-').map(Number);
    m -= 1; // include the previous month: its last Friday can fall inside the window's prep range
    if (m < 1) { m = 12; y -= 1; }
    for (let i = 0; i < 14; i++) {
      const d = lastFridayOfMonth(y, m);
      if (d >= from && d <= to) out.push(d);
      m += 1; if (m > 12) { m = 1; y += 1; }
      if (d > to) break;
    }
    return out;
  }
  const step = topic.cadence === 'fortnightly' ? 14 : 7;
  let anchor = null;
  if (step === 14) {
    // Fortnights run from the most recent report (or, failing that, the topic's creation week).
    const latest = reports.filter((r) => r.period_end).map((r) => weekEndingFridayContaining(r.period_end)).sort().pop();
    anchor = latest || weekEndingFridayContaining((topic.created_at || todayUTC()).slice(0, 10));
  } else {
    anchor = fridayOnOrBefore(from);
  }
  let d = anchor;
  const diffDays = Math.round((Date.parse(from) - Date.parse(d)) / 86400000);
  if (diffDays > 0) d = addDaysIso(d, Math.floor(diffDays / step) * step);
  else if (diffDays < 0) d = addDaysIso(d, -Math.ceil(-diffDays / step) * step);
  while (d < from) d = addDaysIso(d, step);
  for (; d <= to; d = addDaysIso(d, step)) out.push(d);
  return out;
}

function calendarBundle(month) { // YYYY-MM
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  // Pad to whole Mon-Sun weeks so the grid is full, and a little beyond so prep for early-next-month dues shows.
  const gridFrom = addDaysIso(first, -((utcDow(first) + 6) % 7));
  const gridTo = addDaysIso(last, (7 - utcDow(last)) % 7);
  const today = todayUTC();
  const allReports = loadReports();
  const events = [];
  for (const topic of loadTopics().filter((t) => t.active !== false)) {
    const reports = allReports.filter((r) => r.topic_id === topic.id);
    const submittedFor = new Set(reports.filter((r) => r.period_end).map((r) => weekEndingFridayContaining(r.period_end)));
    // Look a few days past the grid so prep for a due date just after it is still shown.
    const newest = sortedByWeekDesc(reports)[0];
    const completedWeek = newest && newest.rag === 'Blue' ? reportWeek(newest) : '';
    for (const due of dueDatesFor(topic, reports, gridFrom, addDaysIso(gridTo, 7))) {
      if (completedWeek && due > completedWeek) continue;
      const prep = subWorkingDays(due, PREP_LEAD_DAYS);
      const status = submittedFor.has(due) ? 'submitted' : (due < today ? 'overdue' : 'open');
      const base = { topic_id: topic.id, topic_name: topic.name, category: topic.category, cadence: topic.cadence, owner: topic.owner, status, due_date: due, prep_date: prep };
      if (due >= gridFrom && due <= gridTo) events.push({ ...base, type: 'due', date: due });
      if (prep >= gridFrom && prep <= gridTo) events.push({ ...base, type: 'prep', date: prep });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.type === b.type ? 0 : a.type === 'prep' ? -1 : 1) || a.topic_name.localeCompare(b.topic_name));
  return { month, today, grid_from: gridFrom, grid_to: gridTo, prep_lead_days: PREP_LEAD_DAYS, events };
}

// ── Dashboard ───────────────────────────────────────────────────────────────

function dashboardBundle(category) {
  const today = todayUTC();
  const thisFriday = weekEndingFridayContaining(today);
  const topics = loadTopics().filter((t) => t.active !== false && (!category || (t.category || '') === (category === 'none' ? '' : category)));
  const allReports = loadReports();
  const byTopic = new Map(topics.map((t) => [t.id, sortedByWeekDesc(allReports.filter((r) => r.topic_id === t.id))]));
  const RAGS = ['Red', 'Amber', 'Green', 'Blue'];

  // RAG mix over the last 8 weeks: each topic's latest report as of that week. Completed topics
  // count once, in the week they complete, then drop (as on the weekly report).
  const trend = [];
  for (let i = 7; i >= 0; i--) {
    const friday = addDaysIso(thisFriday, -7 * i);
    const counts = { Red: 0, Amber: 0, Green: 0, Blue: 0 };
    for (const t of topics) {
      const reps = byTopic.get(t.id);
      if (droppedBefore(reps, friday)) continue;
      const asOf = reps.find((r) => reportWeek(r) <= friday);
      if (asOf && counts[asOf.rag] !== undefined) counts[asOf.rag] += 1;
    }
    trend.push({ week_ending: friday, ...counts, total: RAGS.reduce((n, k) => n + counts[k], 0) });
  }

  const categories = {};
  for (const c of [...VALID_CATEGORIES, '']) categories[c || 'Uncategorised'] = { Red: 0, Amber: 0, Green: 0, Blue: 0, none: 0 };
  const movements = [];
  for (const t of topics) {
    const reps = byTopic.get(t.id);
    const cur = reps[0];
    const key = t.category || 'Uncategorised';
    categories[key][cur && categories[key][cur.rag] !== undefined ? cur.rag : 'none'] += 1;
    const prev = reps.find((r) => reportWeek(r) < (cur ? reportWeek(cur) : ''));
    if (cur && prev && cur.rag !== prev.rag) {
      const rank = { Red: 0, Amber: 1, Green: 2, Blue: 3 };
      movements.push({ topic_id: t.id, topic_name: t.name, from: prev.rag, to: cur.rag, week_ending: reportWeek(cur), direction: rank[cur.rag] < rank[prev.rag] ? 'worse' : 'better' });
    }
  }
  movements.sort((a, b) => b.week_ending.localeCompare(a.week_ending) || (a.direction === b.direction ? 0 : a.direction === 'worse' ? -1 : 1));

  // Reporting calendar: overdue, and what's coming in the next 14 days.
  const horizon = addDaysIso(today, 14);
  const cal = calendarBundle(today.slice(0, 7));
  const next = calendarBundle(addDaysIso(`${today.slice(0, 7)}-01`, 32).slice(0, 7));
  const events = [...cal.events, ...next.events].filter((e, i, a) => a.findIndex((x) => x.topic_id === e.topic_id && x.type === e.type && x.date === e.date) === i);
  const topicIds = new Set(topics.map((t) => t.id));
  const overdue = events.filter((e) => topicIds.has(e.topic_id) && e.type === 'due' && e.status === 'overdue');
  const upcoming = events.filter((e) => topicIds.has(e.topic_id) && e.date >= today && e.date <= horizon && e.status !== 'submitted');

  return { today, week_ending: thisFriday, trend, categories, movements: movements.slice(0, 8), overdue, upcoming, prep_lead_days: PREP_LEAD_DAYS };
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function isEmptyRich(html) {
  return !stripHtml(html);
}

// ── API handlers ────────────────────────────────────────────────────────────

/**
 * Identity of the signed-in user. Behind Azure App Service authentication (Entra ID / AD) the
 * platform injects X-MS-CLIENT-PRINCIPAL-NAME (UPN) and, in the encoded principal, a display name.
 * Locally there is no auth, so fall back to REPORTER_USER or a generic label.
 */
function currentUser(req) {
  const h = req.headers;
  let name = '';
  const encoded = h['x-ms-client-principal'];
  if (encoded) {
    try {
      const principal = JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'));
      const claims = Array.isArray(principal.claims) ? principal.claims : [];
      const pick = (t) => (claims.find((c) => c.typ === t) || {}).val;
      name = pick('name') || pick('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name') || '';
    } catch { /* fall through to header */ }
  }
  name = name || String(h['x-ms-client-principal-name'] || '').trim() || process.env.REPORTER_USER || 'Reviewer';
  return name.slice(0, 80);
}

async function handleApi(req, res, pathname, url) {
  let method = req.method;
  const override = String(req.headers['x-http-method-override'] || '').toUpperCase();
  if (method === 'POST' && ['PATCH', 'DELETE', 'PUT'].includes(override)) method = override;

  if (pathname === '/api/me' && method === 'GET') {
    return sendJson(res, 200, { name: currentUser(req) });
  }

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, service: 'reporter', time: nowIso() });
  }

  if (pathname === '/api/weekly' && method === 'GET') {
    const ending = (url.searchParams.get('ending') || '').trim() || todayUTC();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ending)) {
      return sendError(res, 400, 'ending must be YYYY-MM-DD');
    }
    return sendJson(res, 200, weeklyBundle(ending));
  }

  if (pathname === '/api/dashboard' && method === 'GET') {
    return sendJson(res, 200, dashboardBundle((url.searchParams.get('category') || '').trim()));
  }

  if (pathname === '/api/calendar' && method === 'GET') {
    const month = (url.searchParams.get('month') || '').trim() || todayUTC().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return sendError(res, 400, 'month must be YYYY-MM');
    return sendJson(res, 200, calendarBundle(month));
  }

  if (pathname === '/api/topics' && method === 'GET') {
    return sendJson(res, 200, topicsWithLatest());
  }

  if (pathname === '/api/topics' && method === 'POST') {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    const cadence = (body.cadence || '').trim();
    const owner = (body.owner || '').trim();
    const description = (body.description || '').trim();
    const business_unit = (body.business_unit || '').trim();
    const category = (body.category || '').trim();
    if (!name) return sendError(res, 400, 'name is required');
    if (!VALID_CATEGORIES.has(category)) return sendError(res, 400, 'category must be Project, POC, or AI use case');
    if (!VALID_CADENCES.has(cadence)) {
      return sendError(res, 400, 'cadence must be weekly, fortnightly, or monthly');
    }
    const topics = loadTopics();
    const maxSort = topics.reduce((m, t) => Math.max(m, t.sort_order || 0), 0);
    const ts = nowIso();
    const topic = {
      id: randomUUID(),
      name,
      description,
      owner,
      business_unit,
      category,
      cadence,
      active: true,
      sort_order: maxSort + 1,
      created_at: ts,
      updated_at: ts
    };
    topics.push(topic);
    saveTopics(topics);
    return sendJson(res, 201, { ...topic, latest_report: null });
  }

  const topicMatch = pathname.match(/^\/api\/topics\/([^/]+)$/);
  if (topicMatch && method === 'PATCH') {
    const id = decodeURIComponent(topicMatch[1]);
    const body = await readBody(req);
    const topics = loadTopics();
    const idx = topics.findIndex((t) => t.id === id);
    if (idx === -1) return sendError(res, 404, 'Topic not found');
    const t = topics[idx];
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return sendError(res, 400, 'name cannot be empty');
      t.name = name;
    }
    if (body.cadence !== undefined) {
      if (!VALID_CADENCES.has(body.cadence)) {
        return sendError(res, 400, 'cadence must be weekly, fortnightly, or monthly');
      }
      t.cadence = body.cadence;
    }
    if (body.category !== undefined) {
      if (!VALID_CATEGORIES.has(body.category)) return sendError(res, 400, 'category must be Project, POC, or AI use case');
      t.category = body.category;
    }
    if (body.owner !== undefined) t.owner = String(body.owner).trim();
    if (body.description !== undefined) t.description = String(body.description).trim();
    if (body.business_unit !== undefined) t.business_unit = String(body.business_unit).trim();
    if (body.active !== undefined) t.active = Boolean(body.active);
    if (body.sort_order !== undefined) t.sort_order = Number(body.sort_order) || 0;
    t.updated_at = nowIso();
    topics[idx] = t;
    saveTopics(topics);
    return sendJson(res, 200, { ...t, latest_report: latestReport(t.id) });
  }

  const reportsMatch = pathname.match(/^\/api\/topics\/([^/]+)\/reports$/);
  if (reportsMatch && method === 'GET') {
    const id = decodeURIComponent(reportsMatch[1]);
    const topics = loadTopics();
    if (!topics.find((t) => t.id === id)) return sendError(res, 404, 'Topic not found');
    return sendJson(res, 200, reportsForTopic(id));
  }

  if (reportsMatch && method === 'POST') {
    const id = decodeURIComponent(reportsMatch[1]);
    const topics = loadTopics();
    if (!topics.find((t) => t.id === id)) return sendError(res, 404, 'Topic not found');
    const body = await readBody(req);
    const period_start = (body.period_start || '').trim();
    const period_end = (body.period_end || '').trim();
    const exec_summary = body.exec_summary || '';
    const achievements = body.achievements || '';
    const next_steps = body.next_steps || '';
    const rag = (body.rag || '').trim();
    const trend = (body.trend || '').trim();
    const gtg_plan = body.gtg_plan || '';

    if (!period_start || !period_end) {
      return sendError(res, 400, 'period_start and period_end are required');
    }
    if (!VALID_RAG.has(rag)) return sendError(res, 400, 'rag must be Red, Amber, Green, or Blue');
    if (!VALID_TREND.has(trend)) {
      return sendError(res, 400, 'trend must be Improving, Stable, or Declining');
    }
    if (isEmptyRich(exec_summary)) return sendError(res, 400, 'exec_summary is required');
    if (rag !== 'Green' && rag !== 'Blue' && isEmptyRich(gtg_plan)) {
      return sendError(res, 400, 'gtg_plan is required when RAG is Red or Amber');
    }

    const ts = nowIso();
    const report = {
      id: randomUUID(),
      topic_id: id,
      period_start,
      period_end,
      exec_summary,
      achievements,
      next_steps,
      rag,
      trend,
      gtg_plan: (rag === 'Green' || rag === 'Blue') ? '' : gtg_plan,
      created_at: ts,
      updated_at: ts
    };
    const reports = loadReports();
    reports.push(report);
    saveReports(reports);

    const topic = topics.find((t) => t.id === id);
    topic.updated_at = ts;
    saveTopics(topics);

    return sendJson(res, 201, report);
  }

  const latestMatch = pathname.match(/^\/api\/topics\/([^/]+)\/latest$/);
  if (latestMatch && method === 'GET') {
    const id = decodeURIComponent(latestMatch[1]);
    const topics = loadTopics();
    if (!topics.find((t) => t.id === id)) return sendError(res, 404, 'Topic not found');
    const latest = latestReport(id);
    return sendJson(res, 200, latest);
  }

  // GET single topic (with key_dates)
  if (topicMatch && method === 'GET') {
    const id = decodeURIComponent(topicMatch[1]);
    const topics = loadTopics();
    const t = topics.find((x) => x.id === id);
    if (!t) return sendError(res, 404, 'Topic not found');
    return sendJson(res, 200, {
      ...t,
      latest_report: latestReport(t.id),
      key_dates: keyDatesForTopic(t.id)
    });
  }

  const keyDatesListMatch = pathname.match(/^\/api\/topics\/([^/]+)\/key-dates$/);
  if (keyDatesListMatch && method === 'GET') {
    const id = decodeURIComponent(keyDatesListMatch[1]);
    const topics = loadTopics();
    if (!topics.find((t) => t.id === id)) return sendError(res, 404, 'Topic not found');
    return sendJson(res, 200, keyDatesForTopic(id));
  }

  if (keyDatesListMatch && method === 'POST') {
    const id = decodeURIComponent(keyDatesListMatch[1]);
    const topics = loadTopics();
    if (!topics.find((t) => t.id === id)) return sendError(res, 404, 'Topic not found');
    const body = await readBody(req);
    const date = (body.date || '').trim();
    const description = (body.description || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return sendError(res, 400, 'date must be YYYY-MM-DD');
    }
    if (!description) return sendError(res, 400, 'description is required');
    const ts = nowIso();
    const row = {
      id: randomUUID(),
      topic_id: id,
      date,
      description,
      created_at: ts,
      updated_at: ts
    };
    const rows = loadKeyDates();
    rows.push(row);
    saveKeyDates(rows);
    return sendJson(res, 201, row);
  }

  const keyDateItemMatch = pathname.match(/^\/api\/topics\/([^/]+)\/key-dates\/([^/]+)$/);
  if (keyDateItemMatch && method === 'PATCH') {
    const topicId = decodeURIComponent(keyDateItemMatch[1]);
    const kdId = decodeURIComponent(keyDateItemMatch[2]);
    const topics = loadTopics();
    if (!topics.find((t) => t.id === topicId)) return sendError(res, 404, 'Topic not found');
    const body = await readBody(req);
    const rows = loadKeyDates();
    const idx = rows.findIndex((k) => k.id === kdId && k.topic_id === topicId);
    if (idx === -1) return sendError(res, 404, 'Key date not found');
    const row = rows[idx];
    if (body.date !== undefined) {
      const date = String(body.date).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return sendError(res, 400, 'date must be YYYY-MM-DD');
      }
      row.date = date;
    }
    if (body.description !== undefined) {
      const description = String(body.description).trim();
      if (!description) return sendError(res, 400, 'description cannot be empty');
      row.description = description;
    }
    row.updated_at = nowIso();
    rows[idx] = row;
    saveKeyDates(rows);
    return sendJson(res, 200, row);
  }

  if (keyDateItemMatch && method === 'DELETE') {
    const topicId = decodeURIComponent(keyDateItemMatch[1]);
    const kdId = decodeURIComponent(keyDateItemMatch[2]);
    const topics = loadTopics();
    if (!topics.find((t) => t.id === topicId)) return sendError(res, 404, 'Topic not found');
    const rows = loadKeyDates();
    const next = rows.filter((k) => !(k.id === kdId && k.topic_id === topicId));
    if (next.length === rows.length) return sendError(res, 404, 'Key date not found');
    saveKeyDates(next);
    return sendJson(res, 200, { ok: true });
  }

  // Management follow-up comments / questions on a topic within a reporting week
  const commentsMatch = pathname.match(/^\/api\/topics\/([^/]+)\/comments$/);
  if (commentsMatch && method === 'POST') {
    const topicId = decodeURIComponent(commentsMatch[1]);
    if (!loadTopics().find((t) => t.id === topicId)) return sendError(res, 404, 'Topic not found');
    const body = await readBody(req);
    const week = String(body.week_ending || '').trim();
    const kind = String(body.kind || 'comment').trim();
    const author = currentUser(req);
    const text = String(body.body || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return sendError(res, 400, 'week_ending must be YYYY-MM-DD');
    if (!VALID_COMMENT_KINDS.has(kind)) return sendError(res, 400, 'kind must be comment or question');
    if (!text) return sendError(res, 400, 'Comment text is required');
    if (text.length > 2000) return sendError(res, 400, 'Comment is too long (max 2000 characters)');
    const ts = nowIso();
    const row = {
      id: randomUUID(),
      topic_id: topicId,
      week_ending: weekEndingFridayContaining(week),
      kind,
      author,
      body: text,
      resolved: false,
      created_at: ts,
      updated_at: ts
    };
    const rows = loadComments();
    rows.push(row);
    saveComments(rows);
    return sendJson(res, 201, row);
  }

  const commentItemMatch = pathname.match(/^\/api\/comments\/([^/]+)$/);
  if (commentItemMatch && method === 'PATCH') {
    const id = decodeURIComponent(commentItemMatch[1]);
    const body = await readBody(req);
    const rows = loadComments();
    const idx = rows.findIndex((c) => c.id === id);
    if (idx === -1) return sendError(res, 404, 'Comment not found');
    if (body.resolved !== undefined) rows[idx].resolved = body.resolved === true || body.resolved === 'true';
    rows[idx].updated_at = nowIso();
    saveComments(rows);
    return sendJson(res, 200, rows[idx]);
  }
  if (commentItemMatch && method === 'DELETE') {
    const id = decodeURIComponent(commentItemMatch[1]);
    const rows = loadComments();
    const next = rows.filter((c) => c.id !== id);
    if (next.length === rows.length) return sendError(res, 404, 'Comment not found');
    saveComments(next);
    return sendJson(res, 200, { ok: true });
  }

  notFound(req, res);
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url || '/', `http://${host}`);
    let pathname = url.pathname;

    // The API is matched on the end of the path so a proxy path prefix doesn't break it.
    const apiAt = pathname.indexOf('/api/');
    if (apiAt !== -1) {
      await handleApi(req, res, pathname.slice(apiAt), url);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      // A bare app path (e.g. /proxy/3080) must end in a slash, or the browser resolves the
      // page's relative URLs one level too high. Redirect to the slash form.
      if (pathname !== '/' && !pathname.endsWith('/') && !path.extname(pathname)) {
        res.writeHead(301, { Location: pathname + '/' + url.search });
        res.end();
        return;
      }
      serveStatic(req, res, pathname, url.searchParams);
      return;
    }

    sendError(res, 405, 'Method not allowed');
  } catch (err) {
    const status = err.status || 500;
    sendError(res, status, err.message || 'Internal server error');
  }
});

ensureKeyDatesFile();

// No host given, so it listens on both IPv4 and IPv6 (a proxy may reach it as localhost -> ::1).
for (const f of ['index.html', 'app.js', 'styles.css', 'theme.js', 'png.js']) {
  if (!fs.existsSync(path.join(PUBLIC_DIR, f))) console.error(`WARNING: missing ${path.join(PUBLIC_DIR, f)} - copy the whole public folder next to server.js`);
}

server.listen(PORT, () => {
  console.log(`reporter running at http://localhost:${PORT} (serving ${PUBLIC_DIR}, data in ${DATA_DIR})`);
});
