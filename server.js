'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const reportExport = require('./export');

const PORT = Number(process.env.PORT) || 3080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const TOPICS_FILE = path.join(DATA_DIR, 'topics.csv');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.csv');
const KEY_DATES_FILE = path.join(DATA_DIR, 'key_dates.csv');
const COMMENTS_FILE = path.join(DATA_DIR, 'comments.csv');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.csv');
const ROLES_FILE = path.join(DATA_DIR, 'roles.csv');
const POD_FILE = path.join(DATA_DIR, 'pod_members.csv');

const TOPIC_HEADERS = [
  'id', 'name', 'description', 'owner', 'business_unit', 'category', 'cadence', 'due_day',
  'active', 'sort_order', 'created_at', 'updated_at'
];
const REPORT_HEADERS = [
  'id', 'topic_id', 'period_start', 'period_end', 'exec_summary', 'achievements',
  'next_steps', 'rag', 'trend', 'gtg_plan', 'created_at', 'updated_at'
];
const TOPIC_IMPORT_HEADERS = ['id', 'name', 'description', 'owner', 'business_unit', 'category', 'cadence', 'due_day', 'active', 'pod'];
const REPORT_IMPORT_HEADERS = [
  'id', 'topic', 'period_start', 'period_end', 'rag', 'trend', 'exec_summary', 'achievements',
  'next_steps', 'gtg_plan', 'created_at'
];
const KEY_DATE_IMPORT_HEADERS = ['id', 'topic', 'date', 'description'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const KEY_DATE_HEADERS = [
  'id', 'topic_id', 'date', 'description', 'created_at', 'updated_at'
];

const COMMENT_HEADERS = [
  'id', 'topic_id', 'week_ending', 'kind', 'author', 'body', 'resolved',
  'created_at', 'updated_at', 'parent_id'
];
const VALID_COMMENT_KINDS = new Set(['comment', 'question']);

// What kind of work a topic is. Categories are data (data/categories.csv, managed on the Settings
// page); this seeds the file the first time. Topics with no (or a removed) category show as Uncategorised.
const CATEGORY_HEADERS = ['id', 'name', 'sort_order'];
const DEFAULT_CATEGORIES = ['Project', 'POC', 'AI use case'];

// Every topic is delivered by a POD: one or more members, each with a role. Roles are central data
// (data/roles.csv, managed on the Settings page); members live in data/pod_members.csv and point at a
// role by id, so renaming a role carries through everywhere.
const ROLE_HEADERS = ['id', 'name', 'sort_order'];
const DEFAULT_ROLES = ['Owner', 'Product owner', 'Delivery lead', 'Tech lead', 'Engineer', 'Data scientist', 'Business analyst', 'Sponsor'];
const POD_HEADERS = ['id', 'topic_id', 'name', 'role_id', 'sort_order'];

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

function loadCategories() {
  if (!fs.existsSync(CATEGORIES_FILE)) {
    saveCategories(DEFAULT_CATEGORIES.map((name, i) => ({ id: randomUUID(), name, sort_order: i + 1 })));
  }
  return readCsv(CATEGORIES_FILE)
    .map((c) => ({ id: c.id, name: String(c.name || '').trim(), sort_order: Number(c.sort_order) || 0 }))
    .filter((c) => c.name)
    .sort((a, b) => a.sort_order - b.sort_order);
}

function saveCategories(list) {
  writeCsv(CATEGORIES_FILE, CATEGORY_HEADERS, list.map((c, i) => ({ id: c.id, name: c.name, sort_order: String(i + 1) })));
}

function categoryNames() {
  return loadCategories().map((c) => c.name);
}

function loadRoles() {
  if (!fs.existsSync(ROLES_FILE)) {
    saveRoles(DEFAULT_ROLES.map((name, i) => ({ id: randomUUID(), name, sort_order: i + 1 })));
  }
  return readCsv(ROLES_FILE)
    .map((r) => ({ id: r.id, name: String(r.name || '').trim(), sort_order: Number(r.sort_order) || 0 }))
    .filter((r) => r.name)
    .sort((a, b) => a.sort_order - b.sort_order);
}

function saveRoles(list) {
  writeCsv(ROLES_FILE, ROLE_HEADERS, list.map((r, i) => ({ id: r.id, name: r.name, sort_order: String(i + 1) })));
}

function loadPodRows() {
  if (!fs.existsSync(POD_FILE)) {
    // First run: give every existing topic a POD seeded from its owner, so nothing is left without one.
    const roles = loadRoles();
    const ownerRole = roles.find((r) => r.name === 'Owner') || roles[0];
    const rows = [];
    for (const t of readCsv(TOPICS_FILE)) {
      const owner = String(t.owner || '').trim();
      if (owner && ownerRole) rows.push({ id: randomUUID(), topic_id: t.id, name: owner, role_id: ownerRole.id, sort_order: '1' });
    }
    writeCsv(POD_FILE, POD_HEADERS, rows);
  }
  return readCsv(POD_FILE);
}

function savePodRows(rows) {
  writeCsv(POD_FILE, POD_HEADERS, rows);
}

// Replace a topic's POD. members: [{name, role_id}] (already validated).
function setPod(topicId, members) {
  const rows = loadPodRows().filter((r) => r.topic_id !== topicId);
  members.forEach((m, i) => rows.push({ id: randomUUID(), topic_id: topicId, name: m.name, role_id: m.role_id, sort_order: String(i + 1) }));
  savePodRows(rows);
}

// Validate a POD payload: at least one member, each with a name and a known role.
function parsePod(input) {
  const roles = loadRoles();
  const list = Array.isArray(input) ? input : [];
  const members = [];
  for (const m of list) {
    const name = String((m && m.name) || '').trim().slice(0, 80);
    if (!name && !(m && m.role_id)) continue; // blank row
    const role = roles.find((r) => r.id === (m && m.role_id));
    if (!name) return { error: 'Every POD member needs a name' };
    if (!role) return { error: `Choose a role for ${name}` };
    members.push({ name, role_id: role.id });
  }
  if (!members.length) return { error: 'A topic needs a POD with at least one member' };
  return { members };
}

/** Weekday a topic's update is due: 1 (Mon) … 5 (Fri, the default). */
function validDueDay(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 5;
}

function loadTopics() {
  const known = new Set(categoryNames());
  const roleName = new Map(loadRoles().map((r) => [r.id, r.name]));
  const pods = new Map();
  for (const r of loadPodRows().sort((a, b) => Number(a.sort_order) - Number(b.sort_order))) {
    if (!roleName.has(r.role_id)) continue;
    if (!pods.has(r.topic_id)) pods.set(r.topic_id, []);
    pods.get(r.topic_id).push({ id: r.id, name: r.name, role_id: r.role_id, role: roleName.get(r.role_id) });
  }
  return readCsv(TOPICS_FILE).map((t) => ({
    pod: pods.get(t.id) || [],
    ...t,
    description: t.description != null ? String(t.description) : '',
    business_unit: t.business_unit != null ? String(t.business_unit) : '',
    owner: t.owner != null ? String(t.owner) : '',
    category: known.has(t.category) ? t.category : '',
    due_day: validDueDay(t.due_day),
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
  return readCsv(COMMENTS_FILE).map((c) => ({ ...c, parent_id: c.parent_id || '', resolved: c.resolved === 'true' }));
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

function sendCsv(res, filename, text) {
  const body = Buffer.from('\ufeff' + text, 'utf8'); // BOM so Excel reads UTF-8
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
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
    const rag_history = [-49, -42, -35, -28, -21, -14, -7, 0].map((d) => {
      const wk = addDaysIso(friday, d);
      const r = allReports
        .filter((x) => x.topic_id === topic.id && x.period_end && weekEndingFridayContaining(x.period_end) === wk)
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
      return { week: wk, rag: r ? r.rag : '' };
    });
    items.push({ topic, report: matches[0], key_dates, comments, rag_history });
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
    for (let due of dueDatesFor(topic, reports, gridFrom, addDaysIso(gridTo, 7))) {
      if (completedWeek && due > completedWeek) continue;
      // `friday` identifies the reporting week; the topic's due weekday falls in that same Mon–Fri week.
      const friday = due;
      due = addDaysIso(friday, validDueDay(topic.due_day) - 5);
      const prep = subWorkingDays(due, PREP_LEAD_DAYS);
      const status = submittedFor.has(friday) ? 'submitted' : (due < today ? 'overdue' : 'open');
      const base = { topic_id: topic.id, topic_name: topic.name, category: topic.category, cadence: topic.cadence, due_day: validDueDay(topic.due_day), owner: topic.owner, status, due_date: due, prep_date: prep };
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
  for (const c of [...categoryNames(), '']) categories[c || 'Uncategorised'] = { Red: 0, Amber: 0, Green: 0, Blue: 0, none: 0 };
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

  // Per-topic heatmap: the RAG filed for each of the last 8 weeks. "carried" = no report that
  // week, so the previous status still stands.
  const weeks = trend.map((w) => w.week_ending);
  const heatmap = topics.map((t) => {
    const reps = byTopic.get(t.id);
    const cells = weeks.map((friday) => {
      if (droppedBefore(reps, friday)) return { week_ending: friday, rag: '' };
      const asOf = reps.find((r) => reportWeek(r) <= friday);
      if (!asOf) return { week_ending: friday, rag: '' };
      return { week_ending: friday, rag: asOf.rag, carried: reportWeek(asOf) !== friday };
    });
    return { topic_id: t.id, topic_name: t.name, owner: t.owner, cadence: t.cadence, cells };
  });

  // Business-unit breakdown, same shape as categories.
  const units = {};
  for (const t of topics) {
    const cur = byTopic.get(t.id)[0];
    const key = t.business_unit || 'Unassigned';
    units[key] = units[key] || { Red: 0, Amber: 0, Green: 0, Blue: 0, none: 0 };
    units[key][cur && units[key][cur.rag] !== undefined ? cur.rag : 'none'] += 1;
  }

  // This week's pack: topics due this Friday vs. those already reported.
  let dueThisWeek = 0;
  let inThisWeek = 0;
  for (const t of topics) {
    const reps = allReports.filter((r) => r.topic_id === t.id);
    if (!dueDatesFor(t, reps, thisFriday, thisFriday).length) continue;
    const latest = byTopic.get(t.id)[0];
    if (latest && latest.rag === 'Blue' && reportWeek(latest) < thisFriday) continue;
    dueThisWeek += 1;
    if (reps.some((r) => reportWeek(r) === thisFriday)) inThisWeek += 1;
  }

  // Open review comments (unresolved top-level threads), grouped by topic.
  const openByTopic = new Map();
  for (const c of loadComments()) {
    if (c.parent_id || c.resolved || !topicIds.has(c.topic_id)) continue;
    const o = openByTopic.get(c.topic_id) || { open: 0, week_ending: '' };
    o.open += 1;
    if (c.week_ending > o.week_ending) o.week_ending = c.week_ending;
    openByTopic.set(c.topic_id, o);
  }
  const comments = topics.filter((t) => openByTopic.has(t.id))
    .map((t) => ({ topic_id: t.id, topic_name: t.name, ...openByTopic.get(t.id) }))
    .sort((a, b) => b.open - a.open || b.week_ending.localeCompare(a.week_ending));

  // Key dates (milestones) coming up in the next 30 days.
  const msHorizon = addDaysIso(today, 30);
  const nameById = new Map(topics.map((t) => [t.id, t]));
  const milestones = loadKeyDates()
    .filter((k) => nameById.has(k.topic_id) && k.date >= today && k.date <= msHorizon)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8)
    .map((k) => ({ topic_id: k.topic_id, topic_name: nameById.get(k.topic_id).name, date: k.date, description: k.description, days: Math.round((Date.parse(k.date) - Date.parse(today)) / 86400000) }));

  return {
    today, week_ending: thisFriday, trend, categories, units, heatmap, movements: movements.slice(0, 8), overdue, upcoming,
    this_week: { due: dueThisWeek, in: inThisWeek }, comments, milestones, prep_lead_days: PREP_LEAD_DAYS
  };
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function isEmptyRich(html) {
  return !stripHtml(html);
}

/** Validate a report payload (create or edit). Returns the cleaned fields or { error }. */
function parseReportBody(body) {
  const period_start = (body.period_start || '').trim();
  const period_end = (body.period_end || '').trim();
  const exec_summary = body.exec_summary || '';
  const achievements = body.achievements || '';
  const next_steps = body.next_steps || '';
  const rag = (body.rag || '').trim();
  const trend = (body.trend || '').trim();
  const gtg_plan = body.gtg_plan || '';
  if (!period_start || !period_end) return { error: 'period_start and period_end are required' };
  if (!VALID_RAG.has(rag)) return { error: 'rag must be Red, Amber, Green, or Blue' };
  if (!VALID_TREND.has(trend)) return { error: 'trend must be Improving, Stable, or Declining' };
  if (isEmptyRich(exec_summary)) return { error: 'exec_summary is required' };
  if (rag !== 'Green' && rag !== 'Blue' && isEmptyRich(gtg_plan)) return { error: 'gtg_plan is required when RAG is Red or Amber' };
  return { period_start, period_end, exec_summary, achievements, next_steps, rag, trend, gtg_plan: (rag === 'Green' || rag === 'Blue') ? '' : gtg_plan };
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

  if ((pathname === '/api/weekly.pdf' || pathname === '/api/weekly.pptx') && method === 'GET') {
    const ending = (url.searchParams.get('ending') || '').trim() || todayUTC();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ending)) {
      return sendError(res, 400, 'ending must be YYYY-MM-DD');
    }
    const bundle = weeklyBundle(ending);
    const isPdf = pathname.endsWith('.pdf');
    const body = isPdf ? reportExport.buildPdf(bundle) : reportExport.buildPptx(bundle);
    res.writeHead(200, {
      'Content-Type': isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="weekly-report-${bundle.week_ending}.${isPdf ? 'pdf' : 'pptx'}"`,
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    });
    return res.end(body);
  }

  if (pathname === '/api/categories' && method === 'GET') {
    const used = {};
    for (const t of loadTopics()) if (t.category) used[t.category] = (used[t.category] || 0) + 1;
    return sendJson(res, 200, loadCategories().map((c) => ({ ...c, topic_count: used[c.name] || 0 })));
  }

  if (pathname === '/api/categories' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return sendError(res, 400, 'name is required');
    const list = loadCategories();
    if (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) return sendError(res, 409, 'That category already exists');
    list.push({ id: randomUUID(), name });
    saveCategories(list);
    return sendJson(res, 201, { ok: true });
  }

  if (pathname === '/api/categories/order' && method === 'POST') {
    const body = await readBody(req);
    const list = loadCategories();
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const sorted = ids.map((id) => list.find((c) => c.id === id)).filter(Boolean);
    for (const c of list) if (!sorted.includes(c)) sorted.push(c);
    saveCategories(sorted);
    return sendJson(res, 200, { ok: true });
  }

  const catMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
  if (catMatch && (method === 'PATCH' || method === 'DELETE')) {
    const id = decodeURIComponent(catMatch[1]);
    const list = loadCategories();
    const cat = list.find((c) => c.id === id);
    if (!cat) return sendError(res, 404, 'Category not found');
    // Topics are rewritten from the raw file so the rename/removal carries through to them.
    const rawTopics = readCsv(TOPICS_FILE);
    if (method === 'PATCH') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return sendError(res, 400, 'name is required');
      if (list.some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) return sendError(res, 409, 'That category already exists');
      for (const t of rawTopics) if (t.category === cat.name) t.category = name;
      cat.name = name;
    } else {
      const to = (url.searchParams.get('reassign') || '').trim();
      if (to && !list.some((c) => c.id !== id && c.name === to)) return sendError(res, 400, 'reassign target not found');
      for (const t of rawTopics) if (t.category === cat.name) t.category = to;
      list.splice(list.indexOf(cat), 1);
    }
    writeCsv(TOPICS_FILE, TOPIC_HEADERS, rawTopics);
    saveCategories(list);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/roles' && method === 'GET') {
    const used = {};
    for (const r of loadPodRows()) used[r.role_id] = (used[r.role_id] || 0) + 1;
    return sendJson(res, 200, loadRoles().map((r) => ({ ...r, member_count: used[r.id] || 0 })));
  }

  if (pathname === '/api/roles' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return sendError(res, 400, 'name is required');
    const list = loadRoles();
    if (list.some((r) => r.name.toLowerCase() === name.toLowerCase())) return sendError(res, 409, 'That role already exists');
    list.push({ id: randomUUID(), name });
    saveRoles(list);
    return sendJson(res, 201, { ok: true });
  }

  if (pathname === '/api/roles/order' && method === 'POST') {
    const body = await readBody(req);
    const list = loadRoles();
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const sorted = ids.map((id) => list.find((r) => r.id === id)).filter(Boolean);
    for (const r of list) if (!sorted.includes(r)) sorted.push(r);
    saveRoles(sorted);
    return sendJson(res, 200, { ok: true });
  }

  const roleMatch = pathname.match(/^\/api\/roles\/([^/]+)$/);
  if (roleMatch && (method === 'PATCH' || method === 'DELETE')) {
    const id = decodeURIComponent(roleMatch[1]);
    const list = loadRoles();
    const role = list.find((r) => r.id === id);
    if (!role) return sendError(res, 404, 'Role not found');
    if (method === 'PATCH') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return sendError(res, 400, 'name is required');
      if (list.some((r) => r.id !== id && r.name.toLowerCase() === name.toLowerCase())) return sendError(res, 409, 'That role already exists');
      role.name = name;
    } else {
      const rows = loadPodRows();
      const inUse = rows.filter((r) => r.role_id === id);
      if (inUse.length) {
        const to = (url.searchParams.get('reassign') || '').trim();
        if (!to || !list.some((r) => r.id !== id && r.id === to)) return sendError(res, 409, 'Choose a role to move the members to');
        for (const r of inUse) r.role_id = to;
        savePodRows(rows);
      }
      list.splice(list.indexOf(role), 1);
    }
    saveRoles(list);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/dashboard' && method === 'GET') {
    return sendJson(res, 200, dashboardBundle((url.searchParams.get('category') || '').trim()));
  }

  if (pathname === '/api/calendar' && method === 'GET') {
    const month = (url.searchParams.get('month') || '').trim() || todayUTC().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return sendError(res, 400, 'month must be YYYY-MM');
    return sendJson(res, 200, calendarBundle(month));
  }


  // ── Key dates: CSV export / import / templates ──
  if (pathname === '/api/key-dates.csv' && method === 'GET') {
    const names = new Map(loadTopics().map((t) => [t.id, t.name]));
    const rows = loadKeyDates()
      .filter((k) => names.has(k.topic_id))
      .map((k) => ({ ...k, topic: names.get(k.topic_id) }))
      .sort((a, b) => a.topic.localeCompare(b.topic) || a.date.localeCompare(b.date));
    return sendCsv(res, 'key_dates.csv', serializeCsv(KEY_DATE_IMPORT_HEADERS, rows));
  }

  if (pathname === '/api/key-dates/import' && method === 'POST') {
    const body = await readBody(req);
    const text = String(body.csv || '').replace(/^﻿/, '');
    if (!text.trim()) return sendError(res, 400, 'The CSV is empty');
    const rows = parseCsv(text);
    if (!rows.length) return sendError(res, 400, 'No data rows found');
    const topics = loadTopics();
    const defaultTopic = body.topic_id ? topics.find((t) => t.id === String(body.topic_id)) : null;
    if (body.topic_id && !defaultTopic) return sendError(res, 404, 'Topic not found');
    if (!('date' in rows[0]) || !('description' in rows[0]) || !(defaultTopic || 'topic' in rows[0] || 'topic_id' in rows[0])) return sendError(res, 400, defaultTopic ? 'The CSV needs "date" and "description" columns' : 'The CSV needs "topic" (name), "date" and "description" columns');
    const result = { created: 0, updated: 0, errors: [] };
    const all = loadKeyDates();
    rows.forEach((r, i) => {
      const line = i + 2;
      const get = (k) => String(r[k] == null ? '' : r[k]).trim();
      const err = (message) => result.errors.push({ line, message });
      const topic = defaultTopic || topics.find((t) => t.id === get('topic_id')) || topics.find((t) => t.name.toLowerCase() === get('topic').toLowerCase());
      if (!topic) return err(`unknown topic "${get('topic') || get('topic_id')}" (create it first)`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(get('date')) || Number.isNaN(Date.parse(get('date')))) return err('date must be YYYY-MM-DD');
      if (!get('description')) return err('description is required');
      const ts = nowIso();
      const existing = (get('id') && all.find((k) => k.id === get('id'))) ||
        all.find((k) => k.topic_id === topic.id && k.date === get('date') && k.description.toLowerCase() === get('description').toLowerCase());
      if (existing) { Object.assign(existing, { topic_id: topic.id, date: get('date'), description: get('description'), updated_at: ts }); result.updated++; }
      else { all.push({ id: randomUUID(), topic_id: topic.id, date: get('date'), description: get('description'), created_at: ts, updated_at: ts }); result.created++; }
    });
    if (result.created || result.updated) saveKeyDates(all);
    return sendJson(res, 200, result);
  }

  // Blank CSV templates with one example row.
  const tplMatch = pathname.match(/^\/api\/templates\/(topics|reports|key-dates)\.csv$/);
  if (tplMatch && method === 'GET') {
    const kind = tplMatch[1];
    const cat = categoryNames()[0] || 'AI use case';
    const role = (loadRoles()[0] || {}).name || 'Owner';
    const spec = {
      topics: [TOPIC_IMPORT_HEADERS, { name: 'Example topic', description: 'What it is', owner: 'A. Chen', business_unit: 'Claims', category: cat, cadence: 'weekly', due_day: 'Friday', active: 'true', pod: `A. Chen (${role})` }],
      reports: [REPORT_IMPORT_HEADERS, { topic: 'Example topic', period_start: '2026-01-05', period_end: '2026-01-09', rag: 'Green', trend: 'Stable', exec_summary: 'On track.', achievements: 'Shipped X', next_steps: 'Do Y', gtg_plan: '' }],
      'key-dates': [KEY_DATE_IMPORT_HEADERS, { topic: 'Example topic', date: '2026-03-31', description: 'Go live' }]
    }[kind];
    return sendCsv(res, kind.replace('-', '_') + '_template.csv', serializeCsv(spec[0], [spec[1]]));
  }

  // ── Full backup (JSON): everything needed to rebuild or merge into another instance ──
  if (pathname === '/api/backup.json' && method === 'GET') {
    const roleName = new Map(loadRoles().map((r) => [r.id, r.name]));
    const topics = loadTopics().map((t) => ({
      id: t.id, name: t.name, description: t.description, owner: t.owner, business_unit: t.business_unit,
      category: t.category, cadence: t.cadence, due_day: validDueDay(t.due_day), active: t.active, sort_order: t.sort_order,
      created_at: t.created_at, updated_at: t.updated_at,
      pod: t.pod.map((m) => ({ name: m.name, role: roleName.get(m.role_id) || m.role }))
    }));
    const payload = {
      app: 'reporter', version: 1, exported_at: nowIso(),
      categories: loadCategories().map((c) => c.name), roles: loadRoles().map((r) => r.name),
      topics, reports: loadReports(), key_dates: loadKeyDates(), comments: loadComments()
    };
    const out = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="reporter-backup-${todayUTC()}.json"`,
      'Content-Length': out.length, 'Cache-Control': 'no-store'
    });
    return res.end(out);
  }

  // Restore/merge: body { backup } (object or JSON string). Everything is matched by id (topics also by
  // name, categories/roles by name) and upserted, so it is safe to re-run and never deletes anything.
  if (pathname === '/api/backup/import' && method === 'POST') {
    const body = await readBody(req);
    let b = body.backup;
    if (typeof b === 'string') { try { b = JSON.parse(b.replace(/^﻿/, '')); } catch { return sendError(res, 400, 'That file is not valid JSON'); } }
    if (!b || b.app !== 'reporter' || !Array.isArray(b.topics)) return sendError(res, 400, 'That is not a Reporter backup file');
    const counts = () => ({ created: 0, updated: 0, skipped: 0 });
    const result = { categories: counts(), roles: counts(), topics: counts(), reports: counts(), key_dates: counts(), comments: counts(), errors: [] };
    const err = (m) => result.errors.push({ message: m });
    const isId = (v) => typeof v === 'string' && v.length >= 8 && v.length <= 64;
    const str = (v) => (v == null ? '' : String(v));
    const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);

    const cats = loadCategories();
    for (const n of (b.categories || []).map((x) => str(x).trim()).filter(Boolean)) {
      if (cats.some((c) => c.name.toLowerCase() === n.toLowerCase())) { result.categories.skipped++; continue; }
      cats.push({ id: randomUUID(), name: n, sort_order: cats.length + 1 }); result.categories.created++;
    }
    if (result.categories.created) saveCategories(cats);
    const roles = loadRoles();
    for (const n of (b.roles || []).map((x) => str(x).trim()).filter(Boolean)) {
      if (roles.some((r) => r.name.toLowerCase() === n.toLowerCase())) { result.roles.skipped++; continue; }
      roles.push({ id: randomUUID(), name: n, sort_order: roles.length + 1 }); result.roles.created++;
    }
    if (result.roles.created) saveRoles(roles);

    const topics = loadTopics();
    const idMap = new Map(); // backup topic id -> local topic id
    const podUpdates = [];
    let maxSort = topics.reduce((m, t) => Math.max(m, t.sort_order || 0), 0);
    for (const bt of b.topics) {
      const name = str(bt && bt.name).trim();
      if (!name) { result.topics.skipped++; err('A topic without a name was skipped'); continue; }
      const cadence = str(bt.cadence).toLowerCase();
      if (!VALID_CADENCES.has(cadence)) { result.topics.skipped++; err(`Topic "${name}": invalid cadence "${bt.cadence}"`); continue; }
      const category = cats.find((c) => c.name.toLowerCase() === str(bt.category).toLowerCase());
      const podIn = Array.isArray(bt.pod) ? bt.pod : [];
      const members = podIn.map((m) => ({ name: str(m && m.name).trim(), role: roles.find((r) => r.name.toLowerCase() === str(m && m.role).trim().toLowerCase()) })).filter((m) => m.name && m.role).map((m) => ({ name: m.name, role_id: m.role.id }));
      const existing = topics.find((t) => t.id === bt.id) || topics.find((t) => t.name.toLowerCase() === name.toLowerCase());
      const ts = nowIso();
      const fields = { name, description: str(bt.description), owner: str(bt.owner), business_unit: str(bt.business_unit), cadence, due_day: validDueDay(bt.due_day), active: bt.active !== false && bt.active !== 'false' };
      if (existing) {
        Object.assign(existing, fields, { updated_at: ts });
        if (category) existing.category = category.name;
        if (members.length) podUpdates.push([existing.id, members]);
        idMap.set(bt.id, existing.id); result.topics.updated++;
      } else {
        if (!category) { result.topics.skipped++; err(`Topic "${name}": unknown category "${bt.category}"`); continue; }
        if (!members.length) { result.topics.skipped++; err(`Topic "${name}": needs a POD with at least one member`); continue; }
        const id = isId(bt.id) && !topics.some((t) => t.id === bt.id) ? bt.id : randomUUID();
        topics.push({ id, ...fields, category: category.name, sort_order: ++maxSort, created_at: str(bt.created_at) || ts, updated_at: ts });
        podUpdates.push([id, members]);
        idMap.set(bt.id, id); result.topics.created++;
      }
    }
    if (result.topics.created || result.topics.updated) { saveTopics(topics); for (const [tid, m] of podUpdates) setPod(tid, m); }

    const reports = loadReports();
    for (const br of Array.isArray(b.reports) ? b.reports : []) {
      const topic_id = idMap.get(br && br.topic_id);
      if (!topic_id || !isDate(str(br.period_end)) || !VALID_RAG.has(br.rag) || !VALID_TREND.has(br.trend)) { result.reports.skipped++; continue; }
      const existing = reports.find((r) => r.id === br.id) || reports.find((r) => r.topic_id === topic_id && r.period_end === br.period_end);
      const fields = { period_start: isDate(str(br.period_start)) ? br.period_start : addDaysIso(br.period_end, -4), period_end: br.period_end, exec_summary: str(br.exec_summary), achievements: str(br.achievements), next_steps: str(br.next_steps), rag: br.rag, trend: br.trend, gtg_plan: str(br.gtg_plan) };
      if (existing) { Object.assign(existing, fields, { topic_id, updated_at: str(br.updated_at) || nowIso() }); result.reports.updated++; }
      else { reports.push({ id: isId(br.id) && !reports.some((r) => r.id === br.id) ? br.id : randomUUID(), topic_id, ...fields, created_at: str(br.created_at) || br.period_end + 'T12:00:00.000Z', updated_at: str(br.updated_at) || nowIso() }); result.reports.created++; }
    }
    if (result.reports.created || result.reports.updated) saveReports(reports);

    const kds = loadKeyDates();
    for (const bk of Array.isArray(b.key_dates) ? b.key_dates : []) {
      const topic_id = idMap.get(bk && bk.topic_id);
      if (!topic_id || !isDate(str(bk.date)) || !str(bk.description).trim()) { result.key_dates.skipped++; continue; }
      const existing = kds.find((k) => k.id === bk.id) || kds.find((k) => k.topic_id === topic_id && k.date === bk.date && k.description.toLowerCase() === str(bk.description).trim().toLowerCase());
      const ts = nowIso();
      if (existing) { Object.assign(existing, { topic_id, date: bk.date, description: str(bk.description).trim(), updated_at: ts }); result.key_dates.updated++; }
      else { kds.push({ id: isId(bk.id) && !kds.some((k) => k.id === bk.id) ? bk.id : randomUUID(), topic_id, date: bk.date, description: str(bk.description).trim(), created_at: str(bk.created_at) || ts, updated_at: ts }); result.key_dates.created++; }
    }
    if (result.key_dates.created || result.key_dates.updated) saveKeyDates(kds);

    const comments = loadComments();
    for (const bc of Array.isArray(b.comments) ? b.comments : []) {
      const topic_id = idMap.get(bc && bc.topic_id);
      if (!topic_id || !isId(bc.id)) { result.comments.skipped++; continue; }
      const existing = comments.find((c) => c.id === bc.id);
      const row = { ...bc, topic_id };
      if (existing) { Object.assign(existing, row); result.comments.updated++; } else { comments.push(row); result.comments.created++; }
    }
    if (result.comments.created || result.comments.updated) saveComments(comments);
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/topics' && method === 'GET') {
    return sendJson(res, 200, topicsWithLatest());
  }

  if (pathname === '/api/topics.csv' && method === 'GET') {
    const rows = loadTopics()
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      .map((t) => ({ ...t, due_day: DAY_NAMES[validDueDay(t.due_day) - 1], active: t.active ? 'true' : 'false', pod: t.pod.map((m) => `${m.name} (${m.role})`).join('; ') }));
    // BOM so Excel reads UTF-8 correctly.
    const body = Buffer.from('﻿' + serializeCsv(TOPIC_IMPORT_HEADERS, rows), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="topics.csv"',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    });
    return res.end(body);
  }

  // Bulk import: body { csv }. Rows match an existing topic by id, else by name (case-insensitive);
  // matched rows are updated (blank cells are left unchanged), others are created. Invalid rows are
  // skipped and reported; valid rows are still applied.
  if (pathname === '/api/topics/import' && method === 'POST') {
    const body = await readBody(req);
    const text = String(body.csv || '').replace(/^﻿/, '');
    if (!text.trim()) return sendError(res, 400, 'The CSV is empty');
    const rows = parseCsv(text);
    if (!rows.length) return sendError(res, 400, 'No data rows found');
    if (!('name' in rows[0])) return sendError(res, 400, 'The CSV needs a "name" column');
    const cats = categoryNames();
    const roles = loadRoles();
    const topics = loadTopics();
    const podUpdates = []; // [topicId, members]
    const byId = new Map(topics.map((t) => [t.id, t]));
    const byName = new Map(topics.map((t) => [t.name.toLowerCase(), t]));
    let maxSort = topics.reduce((m, t) => Math.max(m, t.sort_order || 0), 0);
    const result = { created: 0, updated: 0, errors: [] };
    rows.forEach((r, i) => {
      const line = i + 2;
      const get = (k) => String(r[k] == null ? '' : r[k]).trim();
      const name = get('name');
      const id = get('id');
      const existing = (id && byId.get(id)) || (name && byName.get(name.toLowerCase())) || null;
      const cadence = get('cadence').toLowerCase();
      const category = cats.find((c) => c.toLowerCase() === get('category').toLowerCase()) || '';
      const activeRaw = get('active').toLowerCase();
      const dueRaw = get('due_day').toLowerCase();
      const dueDay = dueRaw ? (DAY_NAMES.findIndex((d) => d.toLowerCase() === dueRaw || d.slice(0, 3).toLowerCase() === dueRaw) + 1 || (/^[1-5]$/.test(dueRaw) ? Number(dueRaw) : 0)) : 0;
      if (dueRaw && !dueDay) return result.errors.push({ line, message: `due_day "${get('due_day')}" must be Monday to Friday` });
      if (!name && !existing) return result.errors.push({ line, message: 'name is required' });
      if (cadence && !VALID_CADENCES.has(cadence)) return result.errors.push({ line, message: `cadence "${cadence}" must be weekly, fortnightly or monthly` });
      if (get('category') && !category) return result.errors.push({ line, message: `unknown category "${get('category')}"` });
      if (activeRaw && !['true', 'false', 'yes', 'no', '1', '0'].includes(activeRaw)) return result.errors.push({ line, message: 'active must be true or false' });
      if (!existing && !cadence) return result.errors.push({ line, message: 'cadence is required for new topics' });
      if (!existing && !category) return result.errors.push({ line, message: 'category is required for new topics' });
      // pod: "Name (Role); Name (Role)". Replaces the POD when given; required for new topics.
      let podMembers = null;
      if (get('pod')) {
        podMembers = [];
        for (const part of get('pod').split(/[;\n]/).map((x) => x.trim()).filter(Boolean)) {
          const m = part.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
          const role = m && roles.find((x) => x.name.toLowerCase() === m[2].trim().toLowerCase());
          if (!m || !m[1].trim()) { podMembers = null; return result.errors.push({ line, message: `pod entry "${part}" must look like Name (Role)` }); }
          if (!role) { podMembers = null; return result.errors.push({ line, message: `unknown role "${m[2].trim()}" in pod` }); }
          podMembers.push({ name: m[1].trim(), role_id: role.id });
        }
      }
      if (!existing && !podMembers) return result.errors.push({ line, message: 'pod is required for new topics, e.g. "A. Chen (Owner); B. Lee (Engineer)"' });
      const active = ['true', 'yes', '1'].includes(activeRaw);
      const ts = nowIso();
      if (existing) {
        if (name) { byName.delete(existing.name.toLowerCase()); existing.name = name; byName.set(name.toLowerCase(), existing); }
        for (const k of ['description', 'owner', 'business_unit']) if (get(k)) existing[k] = get(k);
        if (cadence) existing.cadence = cadence;
        if (dueDay) existing.due_day = dueDay;
        if (category) existing.category = category;
        if (activeRaw) existing.active = active;
        existing.updated_at = ts;
        if (podMembers) podUpdates.push([existing.id, podMembers]);
        result.updated++;
      } else {
        const topic = {
          id: randomUUID(), name, description: get('description'), owner: get('owner'),
          business_unit: get('business_unit'), category, cadence, due_day: dueDay || 5, active: activeRaw ? active : true,
          sort_order: ++maxSort, created_at: ts, updated_at: ts
        };
        topics.push(topic);
        byId.set(topic.id, topic);
        byName.set(name.toLowerCase(), topic);
        podUpdates.push([topic.id, podMembers]);
        result.created++;
      }
    });
    if (result.created || result.updated) {
      saveTopics(topics);
      for (const [tid, members] of podUpdates) setPod(tid, members);
    }
    return sendJson(res, 200, result);
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
    if (!categoryNames().includes(category)) return sendError(res, 400, 'Choose a valid category');
    if (!VALID_CADENCES.has(cadence)) {
      return sendError(res, 400, 'cadence must be weekly, fortnightly, or monthly');
    }
    const pod = parsePod(body.pod);
    if (pod.error) return sendError(res, 400, pod.error);
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
      due_day: validDueDay(body.due_day),
      active: true,
      sort_order: maxSort + 1,
      created_at: ts,
      updated_at: ts
    };
    topics.push(topic);
    saveTopics(topics);
    setPod(topic.id, pod.members);
    return sendJson(res, 201, { ...loadTopics().find((x) => x.id === topic.id), latest_report: null });
  }

  const topicMatch = pathname.match(/^\/api\/topics\/([^/]+)$/);
  // Delete a topic and everything attached to it: reports, key dates, review comments and POD.
  if (topicMatch && method === 'DELETE') {
    const id = decodeURIComponent(topicMatch[1]);
    const topics = loadTopics();
    if (!topics.find((t) => t.id === id)) return sendError(res, 404, 'Topic not found');
    const reports = loadReports();
    const kds = loadKeyDates();
    const comments = loadComments();
    const removed = {
      reports: reports.filter((r) => r.topic_id === id).length,
      key_dates: kds.filter((k) => k.topic_id === id).length,
      comments: comments.filter((c) => c.topic_id === id).length
    };
    saveReports(reports.filter((r) => r.topic_id !== id));
    saveKeyDates(kds.filter((k) => k.topic_id !== id));
    saveComments(comments.filter((c) => c.topic_id !== id));
    savePodRows(loadPodRows().filter((r) => r.topic_id !== id));
    saveTopics(topics.filter((t) => t.id !== id));
    return sendJson(res, 200, { ok: true, removed });
  }

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
    if (body.due_day !== undefined) {
      const n = Number(body.due_day);
      if (!Number.isInteger(n) || n < 1 || n > 5) return sendError(res, 400, 'due_day must be 1 (Monday) to 5 (Friday)');
      t.due_day = n;
    }
    if (body.category !== undefined) {
      if (!categoryNames().includes(body.category)) return sendError(res, 400, 'Choose a valid category');
      t.category = body.category;
    }
    if (body.pod !== undefined) {
      const pod = parsePod(body.pod);
      if (pod.error) return sendError(res, 400, pod.error);
      setPod(id, pod.members);
    }
    if (body.owner !== undefined) t.owner = String(body.owner).trim();
    if (body.description !== undefined) t.description = String(body.description).trim();
    if (body.business_unit !== undefined) t.business_unit = String(body.business_unit).trim();
    if (body.active !== undefined) t.active = Boolean(body.active);
    if (body.sort_order !== undefined) t.sort_order = Number(body.sort_order) || 0;
    t.updated_at = nowIso();
    topics[idx] = t;
    saveTopics(topics);
    return sendJson(res, 200, { ...loadTopics().find((x) => x.id === id), latest_report: latestReport(t.id) });
  }

  if (pathname === '/api/reports.csv' && method === 'GET') {
    const names = new Map(loadTopics().map((t) => [t.id, t.name]));
    const rows = loadReports()
      .filter((r) => names.has(r.topic_id))
      .map((r) => ({ ...r, topic: names.get(r.topic_id) }))
      .sort((a, b) => a.topic.localeCompare(b.topic) || (a.period_end || '').localeCompare(b.period_end || ''));
    const body = Buffer.from('﻿' + serializeCsv(REPORT_IMPORT_HEADERS, rows), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="reports.csv"',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    });
    return res.end(body);
  }

  // Bulk import of reports (historic data). Body { csv }. The topic is matched by name (or topic_id);
  // a row updates an existing report with the same id, else the same topic + period_end, else is created.
  // Imported reports are dated by their period (created_at defaults to period_end) so history never
  // displaces a newer report as the topic's "latest".
  if (pathname === '/api/reports/import' && method === 'POST') {
    const body = await readBody(req);
    const text = String(body.csv || '').replace(/^﻿/, '');
    if (!text.trim()) return sendError(res, 400, 'The CSV is empty');
    const rows = parseCsv(text);
    if (!rows.length) return sendError(res, 400, 'No data rows found');
    if (!('period_end' in rows[0]) || !('topic' in rows[0] || 'topic_id' in rows[0])) {
      return sendError(res, 400, 'The CSV needs "topic" (name) and "period_end" columns');
    }
    const topics = loadTopics();
    const topicById = new Map(topics.map((t) => [t.id, t]));
    const topicByName = new Map(topics.map((t) => [t.name.toLowerCase(), t]));
    const reports = loadReports();
    const byId = new Map(reports.map((r) => [r.id, r]));
    const byKey = new Map(reports.map((r) => [r.topic_id + '|' + r.period_end, r]));
    const rich = (v) => {
      v = String(v == null ? '' : v);
      if (!v.trim() || /<[a-z][\s\S]*>/i.test(v)) return v;
      const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => '<p>' + esc(l) + '</p>').join('');
    };
    const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
    const result = { created: 0, updated: 0, errors: [] };
    rows.forEach((r, i) => {
      const line = i + 2;
      const get = (k) => String(r[k] == null ? '' : r[k]).trim();
      const err = (message) => result.errors.push({ line, message });
      const topic = topicById.get(get('topic_id')) || topicByName.get(get('topic').toLowerCase());
      if (!topic) return err(`unknown topic "${get('topic') || get('topic_id')}" (create it first)`);
      const period_end = get('period_end');
      if (!isDate(period_end)) return err('period_end must be YYYY-MM-DD');
      const period_start = get('period_start') || addDaysIso(period_end, -4);
      if (!isDate(period_start)) return err('period_start must be YYYY-MM-DD');
      const existing = (get('id') && byId.get(get('id'))) || byKey.get(topic.id + '|' + period_end) || null;
      const rag = VALID_RAG.has(get('rag')) ? get('rag') : [...VALID_RAG].find((v) => v.toLowerCase() === get('rag').toLowerCase()) || '';
      const trend = [...VALID_TREND].find((v) => v.toLowerCase() === get('trend').toLowerCase()) || '';
      if (get('rag') && !rag) return err('rag must be Red, Amber, Green or Blue');
      if (get('trend') && !trend) return err('trend must be Improving, Stable or Declining');
      const created = get('created_at');
      if (created && Number.isNaN(Date.parse(created))) return err('created_at is not a valid date');
      const merged = {
        rag: rag || (existing && existing.rag) || '',
        trend: trend || (existing && existing.trend) || '',
        exec_summary: get('exec_summary') ? rich(r.exec_summary) : (existing ? existing.exec_summary : ''),
        gtg_plan: get('gtg_plan') ? rich(r.gtg_plan) : (existing ? existing.gtg_plan : '')
      };
      if (!merged.rag) return err('rag is required');
      if (!merged.trend) return err('trend is required');
      if (isEmptyRich(merged.exec_summary)) return err('exec_summary is required');
      if (merged.rag !== 'Green' && merged.rag !== 'Blue' && isEmptyRich(merged.gtg_plan)) return err('gtg_plan is required when rag is Red or Amber');
      if (merged.rag === 'Green' || merged.rag === 'Blue') merged.gtg_plan = '';
      const ts = nowIso();
      if (existing) {
        Object.assign(existing, merged, { period_start, period_end, updated_at: ts });
        if (get('achievements')) existing.achievements = rich(r.achievements);
        if (get('next_steps')) existing.next_steps = rich(r.next_steps);
        if (created) existing.created_at = created;
        result.updated++;
      } else {
        const report = {
          id: randomUUID(), topic_id: topic.id, period_start, period_end, ...merged,
          achievements: rich(r.achievements), next_steps: rich(r.next_steps),
          created_at: created || period_end + 'T12:00:00.000Z', updated_at: ts
        };
        reports.push(report);
        byId.set(report.id, report);
        byKey.set(topic.id + '|' + period_end, report);
        result.created++;
      }
    });
    if (result.created || result.updated) saveReports(reports);
    return sendJson(res, 200, result);
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
    const v = parseReportBody(body);
    if (v.error) return sendError(res, 400, v.error);
    const { period_start, period_end, exec_summary, achievements, next_steps, rag, trend, gtg_plan } = v;

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
      gtg_plan,
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

  const reportItemMatch = pathname.match(/^\/api\/reports\/([^/]+)$/);
  if (reportItemMatch && method === 'PATCH') {
    const id = decodeURIComponent(reportItemMatch[1]);
    const reports = loadReports();
    const idx = reports.findIndex((r) => r.id === id);
    if (idx === -1) return sendError(res, 404, 'Report not found');
    const v = parseReportBody({ ...reports[idx], ...(await readBody(req)) });
    if (v.error) return sendError(res, 400, v.error);
    const ts = nowIso();
    reports[idx] = { ...reports[idx], ...v, updated_at: ts };
    saveReports(reports);
    const topics = loadTopics();
    const topic = topics.find((t) => t.id === reports[idx].topic_id);
    if (topic) { topic.updated_at = ts; saveTopics(topics); }
    return sendJson(res, 200, reports[idx]);
  }
  if (reportItemMatch && method === 'DELETE') {
    const id = decodeURIComponent(reportItemMatch[1]);
    const reports = loadReports();
    const target = reports.find((r) => r.id === id);
    if (!target) return sendError(res, 404, 'Report not found');
    saveReports(reports.filter((r) => r.id !== id));
    const topics = loadTopics();
    const topic = topics.find((t) => t.id === target.topic_id);
    if (topic) { topic.updated_at = nowIso(); saveTopics(topics); }
    return sendJson(res, 200, { ok: true });
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
    const rows = loadComments();
    // A reply joins the thread of its root comment (threads are one level deep, like PowerPoint)
    let parentId = String(body.parent_id || '').trim();
    let weekEnding = weekEndingFridayContaining(week);
    if (parentId) {
      const parent = rows.find((c) => c.id === parentId && c.topic_id === topicId);
      if (!parent) return sendError(res, 404, 'Comment to reply to not found');
      parentId = parent.parent_id || parent.id;
      weekEnding = parent.week_ending;
    }
    const ts = nowIso();
    const row = {
      id: randomUUID(),
      topic_id: topicId,
      week_ending: weekEnding,
      kind,
      author,
      body: text,
      resolved: false,
      created_at: ts,
      updated_at: ts,
      parent_id: parentId
    };
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
    const row = rows[idx];
    if (body.body !== undefined) {
      if (row.author !== currentUser(req)) return sendError(res, 403, 'You can only edit your own comments');
      const text = String(body.body).trim();
      if (!text) return sendError(res, 400, 'Comment text is required');
      if (text.length > 2000) return sendError(res, 400, 'Comment is too long (max 2000 characters)');
      row.body = text;
    }
    if (body.resolved !== undefined) {
      // Resolving applies to the whole thread, so always store it on the root comment
      const resolved = body.resolved === true || body.resolved === 'true';
      const rootId = row.parent_id || row.id;
      for (const c of rows) if (c.id === rootId) { c.resolved = resolved; c.updated_at = nowIso(); }
    }
    row.updated_at = nowIso();
    saveComments(rows);
    return sendJson(res, 200, rows.find((c) => c.id === id));
  }
  if (commentItemMatch && method === 'DELETE') {
    const id = decodeURIComponent(commentItemMatch[1]);
    const rows = loadComments();
    const target = rows.find((c) => c.id === id);
    if (!target) return sendError(res, 404, 'Comment not found');
    if (target.author !== currentUser(req)) return sendError(res, 403, 'You can only delete your own comments');
    // Deleting a thread's first comment removes its replies too
    const next = rows.filter((c) => c.id !== id && c.parent_id !== id);
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
