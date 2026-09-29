'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT) || 3080;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const TOPICS_FILE = path.join(DATA_DIR, 'topics.csv');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.csv');

const TOPIC_HEADERS = [
  'id', 'name', 'cadence', 'owner', 'active', 'sort_order', 'created_at', 'updated_at'
];
const REPORT_HEADERS = [
  'id', 'topic_id', 'period_start', 'period_end', 'exec_summary', 'achievements',
  'next_steps', 'rag', 'trend', 'gtg_plan', 'created_at', 'updated_at'
];

const VALID_CADENCES = new Set(['weekly', 'fortnightly', 'monthly']);
const VALID_RAG = new Set(['Red', 'Amber', 'Green']);
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
  const text = fs.readFileSync(filePath, 'utf8');
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

function reportsForTopic(topicId) {
  return loadReports()
    .filter((r) => r.topic_id === topicId)
    .sort((a, b) => {
      const pe = (b.period_end || '').localeCompare(a.period_end || '');
      if (pe !== 0) return pe;
      return (b.created_at || '').localeCompare(a.created_at || '');
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

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  if (rel.includes('..')) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendError(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function isEmptyRich(html) {
  return !stripHtml(html);
}

// ── API handlers ────────────────────────────────────────────────────────────

async function handleApi(req, res, pathname) {
  const method = req.method;

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, service: 'reporter', time: nowIso() });
  }

  if (pathname === '/api/topics' && method === 'GET') {
    return sendJson(res, 200, topicsWithLatest());
  }

  if (pathname === '/api/topics' && method === 'POST') {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    const cadence = (body.cadence || '').trim();
    const owner = (body.owner || '').trim();
    if (!name) return sendError(res, 400, 'name is required');
    if (!VALID_CADENCES.has(cadence)) {
      return sendError(res, 400, 'cadence must be weekly, fortnightly, or monthly');
    }
    const topics = loadTopics();
    const maxSort = topics.reduce((m, t) => Math.max(m, t.sort_order || 0), 0);
    const ts = nowIso();
    const topic = {
      id: randomUUID(),
      name,
      cadence,
      owner,
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
    if (body.owner !== undefined) t.owner = String(body.owner).trim();
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
    if (!VALID_RAG.has(rag)) return sendError(res, 400, 'rag must be Red, Amber, or Green');
    if (!VALID_TREND.has(trend)) {
      return sendError(res, 400, 'trend must be Improving, Stable, or Declining');
    }
    if (isEmptyRich(exec_summary)) return sendError(res, 400, 'exec_summary is required');
    if (rag !== 'Green' && isEmptyRich(gtg_plan)) {
      return sendError(res, 400, 'gtg_plan is required when RAG is not Green');
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
      gtg_plan: rag === 'Green' ? '' : gtg_plan,
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

  sendError(res, 404, 'Not found');
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url || '/', `http://${host}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, pathname);
      return;
    }

    sendError(res, 405, 'Method not allowed');
  } catch (err) {
    const status = err.status || 500;
    sendError(res, status, err.message || 'Internal server error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`reporter listening on http://${HOST}:${PORT}`);
});
