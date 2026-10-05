'use strict';
/* Weekly report exports — PDF and PPTX, built with no dependencies.
   PDF: hand-written writer using the standard Helvetica fonts.
   PPTX: hand-written OOXML packaged with a minimal ZIP writer (zlib deflate + CRC32).
   Layout rules mirror the web view: key dates sit to the right of the commentary, next steps
   below achievements, and trend is shown as an arrow only (never as wording). */

const zlib = require('zlib');

// ── Shared helpers ──────────────────────────────────────────────────────────

const RAG = {
  Red: { rgb: [0xe6, 0x00, 0x00], label: 'Red' },
  Amber: { rgb: [0xf5, 0x9e, 0x0b], label: 'Amber' },
  Green: { rgb: [0x2e, 0x9e, 0x4f], label: 'Green' },
  Blue: { rgb: [0x25, 0x63, 0xeb], label: 'Complete' }
};
const INK = [0x22, 0x22, 0x22];
const MUTED = [0x6b, 0x66, 0x60];
const RULE = [0xdd, 0xd9, 0xd3];
const PANEL = [0xf5, 0xf3, 0xf0];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(iso || '');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] != null ? ENTITIES[e.toLowerCase()] : m;
  });
}

/** Rich-text HTML → [{ bullet: bool, level: n, text }] paragraphs. */
function htmlBlocks(html) {
  const out = [];
  let depth = 0;
  let cur = '';
  let curBullet = false;
  const flush = () => {
    const text = decode(cur).replace(/\s+/g, ' ').trim();
    if (text) out.push({ bullet: curBullet, level: Math.max(0, depth - 1), text });
    cur = '';
  };
  const parts = String(html || '').split(/(<[^>]+>)/);
  for (const part of parts) {
    if (part[0] === '<') {
      const m = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(part);
      if (!m) continue;
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      if (tag === 'ul' || tag === 'ol') { flush(); depth += closing ? -1 : 1; if (depth < 0) depth = 0; curBullet = false; }
      else if (tag === 'li') { flush(); curBullet = !closing; }
      else if (tag === 'br') { flush(); }
      else if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'blockquote'].includes(tag)) { flush(); curBullet = depth > 0; }
    } else {
      cur += part;
    }
  }
  flush();
  return out;
}

/** Arrow-only trend: returns the angle in degrees (counter-clockwise positive), or null. */
function trendAngle(trend) {
  if (trend === 'Improving') return 45;
  if (trend === 'Declining') return -45;
  if (trend === 'Stable') return 0;
  return null;
}

function countRag(items) {
  const c = { Red: 0, Amber: 0, Green: 0, Blue: 0 };
  for (const it of items) { const r = it.report && it.report.rag; if (c[r] != null) c[r] += 1; }
  return c;
}

function topicMeta(topic) {
  return [topic.category, topic.owner, topic.business_unit].filter(Boolean).join('  ·  ');
}

// ── PDF ─────────────────────────────────────────────────────────────────────

// Helvetica / Helvetica-Bold advance widths for ASCII 32..126 (1/1000 em).
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Unicode → WinAnsi (cp1252) for characters outside Latin-1.
const WIN = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
const WIDE = { 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 1000 };

const ASCII_FALLBACK = { '≤': '<=', '≥': '>=', '→': '->', '←': '<-', '↑': '^', '↓': 'v', '≈': '~', '≠': '!=', '✓': 'v', '✔': 'v', '×': 'x', '−': '-', '\u2022': '*' };

function toWin(str) {
  const codes = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (WIN[ch] != null) codes.push(WIN[ch]);
    else if (ASCII_FALLBACK[ch] != null) for (const c of ASCII_FALLBACK[ch]) codes.push(c.charCodeAt(0));
    else if (cp === 0x2009 || cp === 0x202f || cp === 0xa0) codes.push(0x20);
    else if (cp >= 32 && cp < 127) codes.push(cp);
    else if (cp >= 0xa1 && cp <= 0xff) codes.push(cp);
    else codes.push(0x3f);
  }
  return codes;
}

function textWidth(str, size, bold) {
  const t = bold ? W_BOLD : W_REG;
  let w = 0;
  for (const c of toWin(str)) w += c >= 32 && c < 127 ? t[c - 32] : (WIDE[c] || 556);
  return (w * size) / 1000;
}

function pdfEscape(codes) {
  let s = '';
  for (const c of codes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) s += '\\' + c.toString(8).padStart(3, '0');
    else s += String.fromCharCode(c);
  }
  return s;
}

function wrap(text, size, bold, maxW) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    const test = line ? line + ' ' + word : word;
    if (line && textWidth(test, size, bold) > maxW) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const n2 = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (c) => c.map((v) => n2(v / 255)).join(' ');

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

class PdfDoc {
  constructor(footerLabel) {
    this.pages = [];
    this.footerLabel = footerLabel;
    this.newPage();
  }
  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = PAGE_H - MARGIN; // cursor measured from the bottom edge
  }
  room(h) { return this.y - h >= MARGIN + 14; }
  ensure(h) { if (!this.room(h)) this.newPage(); }
  rect(x, yTop, w, h, color) {
    this.ops.push(`${rgb(color)} rg ${n2(x)} ${n2(yTop - h)} ${n2(w)} ${n2(h)} re f`);
  }
  line(x1, y1, x2, y2, color, width) {
    this.ops.push(`${rgb(color)} RG ${n2(width || 0.6)} w ${n2(x1)} ${n2(y1)} m ${n2(x2)} ${n2(y2)} l S`);
  }
  text(str, x, baseline, size, color, bold) {
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${n2(size)} Tf ${rgb(color)} rg ${n2(x)} ${n2(baseline)} Td (${pdfEscape(toWin(str))}) Tj ET`);
  }
  /** Arrow (trend) centred at (cx, cy), pointing at `deg` degrees counter-clockwise from east. */
  arrow(cx, cy, size, deg, color) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r), s = Math.sin(r);
    const pts = [[-0.5, 0.11], [0.12, 0.11], [0.12, 0.3], [0.5, 0], [0.12, -0.3], [0.12, -0.11], [-0.5, -0.11]];
    const path = pts.map(([px, py], i) => `${n2(cx + (px * c - py * s) * size)} ${n2(cy + (px * s + py * c) * size)} ${i ? 'l' : 'm'}`).join(' ');
    this.ops.push(`${rgb(color)} rg ${path} h f`);
  }
  /** Rounded-ish status pill with centred label; returns its width. */
  pill(x, yTop, label, color, size) {
    const w = textWidth(label, size, true) + 14;
    const h = size + 7;
    this.rect(x, yTop, w, h, color);
    this.text(label, x + 7, yTop - h + 3.8, size, [255, 255, 255], true);
    return w;
  }
  /** Wrapped paragraphs (with bullets) in a column; page-breaks when `breakable`. */
  paragraphs(blocks, x, w, size, opts) {
    const lead = size * 1.38;
    for (const b of blocks) {
      const indent = b.bullet ? 11 + b.level * 11 : 0;
      const lines = wrap(b.text, size, false, w - indent);
      lines.forEach((ln, i) => {
        if (opts && opts.breakable) this.ensure(lead);
        this.y -= lead;
        if (b.bullet && i === 0) this.text('•', x + indent - 9, this.y, size, MUTED, false);
        this.text(ln, x + indent, this.y, size, INK, false);
      });
      this.y -= size * 0.35;
    }
  }
  height(blocks, w, size) {
    const lead = size * 1.38;
    let h = 0;
    for (const b of blocks) h += wrap(b.text, size, false, w - (b.bullet ? 11 + b.level * 11 : 0)).length * lead + size * 0.35;
    return h;
  }
  finish() {
    const total = this.pages.length;
    this.pages.forEach((ops, i) => {
      const footer = [];
      footer.push(`${rgb(RULE)} RG 0.5 w ${MARGIN} ${MARGIN - 2} m ${n2(PAGE_W - MARGIN)} ${MARGIN - 2} l S`);
      const label = `Page ${i + 1} of ${total}`;
      footer.push(`BT /F1 8 Tf ${rgb(MUTED)} rg ${MARGIN} ${MARGIN - 14} Td (${pdfEscape(toWin(this.footerLabel))}) Tj ET`);
      footer.push(`BT /F1 8 Tf ${rgb(MUTED)} rg ${n2(PAGE_W - MARGIN - textWidth(label, 8, false))} ${MARGIN - 14} Td (${pdfEscape(toWin(label))}) Tj ET`);
      ops.push(...footer);
    });
    // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, then [page, content] pairs.
    const objs = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    const kids = this.pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
    objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`;
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    this.pages.forEach((ops, i) => {
      const stream = zlib.deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
      objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(PAGE_W)} ${n2(PAGE_H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
      objs[6 + i * 2] = { stream, dict: '/Filter /FlateDecode' };
    });
    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const offsets = [];
    let pos = chunks[0].length;
    for (let i = 1; i < objs.length; i++) {
      offsets[i] = pos;
      const o = objs[i];
      const buf = typeof o === 'string'
        ? Buffer.from(`${i} 0 obj\n${o}\nendobj\n`, 'latin1')
        : Buffer.concat([Buffer.from(`${i} 0 obj\n<< ${o.dict} /Length ${o.stream.length} >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      chunks.push(buf);
      pos += buf.length;
    }
    let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}

function buildPdf(bundle) {
  const items = bundle.items || [];
  const doc = new PdfDoc(`Key Topics Reporting — week ending ${fmtDate(bundle.week_ending)}`);

  // Cover band
  doc.rect(0, PAGE_H, PAGE_W, 96, [0x2b, 0x2b, 0x2b]);
  doc.rect(0, PAGE_H, 8, 96, RAG.Red.rgb);
  doc.text('Weekly status report', MARGIN, PAGE_H - 46, 24, [255, 255, 255], true);
  doc.text(`Week ending ${fmtDate(bundle.week_ending)}   (${fmtDate(bundle.period_start)} – ${fmtDate(bundle.period_end)})`, MARGIN, PAGE_H - 68, 11, [0xd8, 0xd4, 0xce], false);
  doc.y = PAGE_H - 96 - 22;

  // Stat tiles
  const counts = countRag(items);
  const tiles = [['Topics', items.length, INK], ['Red', counts.Red, RAG.Red.rgb], ['Amber', counts.Amber, RAG.Amber.rgb], ['Green', counts.Green, RAG.Green.rgb], ['Complete', counts.Blue, RAG.Blue.rgb]];
  const gap = 8;
  const tw = (CONTENT_W - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach(([label, n, color], i) => {
    const x = MARGIN + i * (tw + gap);
    doc.rect(x, doc.y, tw, 46, PANEL);
    doc.rect(x, doc.y, 3, 46, color);
    doc.text(String(n), x + 12, doc.y - 28, 20, color, true);
    doc.text(label, x + 12, doc.y - 40, 8.5, MUTED, false);
  });
  doc.y -= 46 + 22;

  // Overview table
  if (!items.length) {
    doc.text('No reports were submitted for this week.', MARGIN, doc.y, 11, MUTED, false);
    return doc.finish();
  }
  doc.text('Overview', MARGIN, doc.y, 12, INK, true);
  doc.y -= 8;
  doc.line(MARGIN, doc.y, PAGE_W - MARGIN, doc.y, INK, 0.8);
  for (const it of items) {
    const rowH = 22;
    doc.ensure(rowH);
    const rag = RAG[it.report.rag];
    const yTop = doc.y;
    doc.rect(MARGIN, yTop, 6, rowH, rag ? rag.rgb : MUTED);
    const nameMax = CONTENT_W - 190;
    let name = it.topic.name || '';
    while (name.length > 4 && textWidth(name, 10, true) > nameMax) name = name.slice(0, -2);
    if (name !== it.topic.name) name = name.trimEnd() + '…';
    doc.text(name, MARGIN + 14, yTop - 14.5, 10, INK, true);
    doc.text(rag ? rag.label : '', MARGIN + CONTENT_W - 170, yTop - 14.5, 9.5, rag ? rag.rgb : MUTED, true);
    const ang = trendAngle(it.report.trend);
    if (ang != null) doc.arrow(MARGIN + CONTENT_W - 118, yTop - 11, 11, ang, MUTED);
    let owner = it.topic.owner || '';
    while (owner.length > 4 && textWidth(owner, 9, false) > 100) owner = owner.slice(0, -2);
    if (owner !== (it.topic.owner || '')) owner = owner.trimEnd() + '…';
    doc.text(owner, MARGIN + CONTENT_W - 100, yTop - 14.5, 9, MUTED, false);
    doc.y -= rowH;
    doc.line(MARGIN, doc.y, PAGE_W - MARGIN, doc.y, RULE, 0.5);
  }

  // One section per topic
  for (const it of items) {
    const { topic, report } = it;
    const rag = RAG[report.rag];
    const keyDates = (it.key_dates || []).filter((k) => k.date || k.description);
    const dateW = keyDates.length ? 150 : 0;
    const colGap = keyDates.length ? 18 : 0;
    const mainW = CONTENT_W - dateW - colGap;
    const blocks = {
      exec: htmlBlocks(report.exec_summary),
      ach: htmlBlocks(report.achievements),
      next: htmlBlocks(report.next_steps),
      gtg: report.rag !== 'Green' && report.rag !== 'Blue' ? htmlBlocks(report.gtg_plan) : []
    };

    doc.newPage();
    // Header band
    const headH = 44;
    doc.rect(MARGIN, doc.y, CONTENT_W, headH, PANEL);
    doc.rect(MARGIN, doc.y, 6, headH, rag ? rag.rgb : MUTED);
    let name = topic.name || '';
    while (name.length > 4 && textWidth(name, 16, true) > CONTENT_W - 190) name = name.slice(0, -2);
    if (name !== topic.name) name = name.trimEnd() + '…';
    doc.text(name, MARGIN + 16, doc.y - 20, 16, INK, true);
    doc.text(topicMeta(topic), MARGIN + 16, doc.y - 35, 9, MUTED, false);
    const pw = doc.pill(MARGIN + CONTENT_W - 100, doc.y - 12, rag ? rag.label : String(report.rag || ''), rag ? rag.rgb : MUTED, 10);
    const ang = trendAngle(report.trend);
    if (ang != null) doc.arrow(MARGIN + CONTENT_W - 100 + pw + 14, doc.y - 12 - 8.5, 14, ang, INK);
    doc.y -= headH + 14;

    const sectionTop = doc.y;
    const section = (label, blocksArr, size) => {
      if (!blocksArr.length) return;
      doc.ensure(40);
      doc.y -= 10;
      doc.text(label.toUpperCase(), MARGIN, doc.y, 8, rag && label === 'Plan to get to Green' ? rag.rgb : MUTED, true);
      doc.y -= 3;
      doc.paragraphs(blocksArr, MARGIN, mainW, size, { breakable: true });
      doc.y -= 4;
    };
    section('Executive summary', blocks.exec, 10.5);
    section('Achievements', blocks.ach, 10);
    section('Next steps', blocks.next, 10); // always below achievements
    section('Plan to get to Green', blocks.gtg, 10);

    // Key dates timeline to the right of the commentary (first page of the topic only)
    if (keyDates.length) {
      const x = MARGIN + mainW + colGap;
      let y = sectionTop - 10;
      doc.text('KEY DATES', x, y, 8, MUTED, true);
      y -= 8;
      const startY = y;
      let need = 0;
      for (const k of keyDates) {
        const h = 12 + wrap(k.description || '', 9, false, dateW - 18).length * 11.5 + 8;
        if (startY - need - h < MARGIN + 14) break;
        need += h;
      }
      doc.ops.push(`${rgb(RULE)} RG 1 w ${n2(x + 4.5)} ${n2(startY - 2)} m ${n2(x + 4.5)} ${n2(startY - need + 6)} l S`);
      for (const k of keyDates) {
        const desc = wrap(k.description || '', 9, false, dateW - 18);
        const h = 12 + desc.length * 11.5 + 8;
        if (y - h < MARGIN + 14) break;
        doc.rect(x + 1.5, y - 1, 6, 6, rag ? rag.rgb : MUTED);
        doc.text(fmtDate(k.date), x + 16, y - 7, 8.5, MUTED, true);
        desc.forEach((ln, i) => doc.text(ln, x + 16, y - 19 - i * 11.5, 9, INK, false));
        y -= h;
      }
    }
  }
  return doc.finish();
}

// ── ZIP + PPTX ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

const xmlEsc = (s) => String(s == null ? '' : s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex = (c) => c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const EMU = 12700; // per point
const SLIDE_W = 960; // pt (13.333in)
const SLIDE_H = 540; // pt (7.5in)
const emu = (pt) => Math.round(pt * EMU);

class Slide {
  constructor() { this.shapes = []; this.id = 2; }
  nextId() { return this.id++; }
  rect(x, y, w, h, color, opts) {
    const o = opts || {};
    const geom = o.geom || 'rect';
    const rot = o.rot ? ` rot="${Math.round(o.rot * 60000)}"` : '';
    this.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${this.nextId()}" name="Shape ${this.id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm${rot}><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm>` +
      `<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody></p:sp>`);
  }
  /** paras: [{ text, size, bold, color, bullet, level, after }] */
  text(x, y, w, h, paras, opts) {
    const o = opts || {};
    const anchor = o.anchor || 't';
    const fill = o.fill ? `<a:solidFill><a:srgbClr val="${hex(o.fill)}"/></a:solidFill>` : '<a:noFill/>';
    const geom = o.geom || 'rect';
    const ins = o.inset != null ? o.inset : 0;
    const body = paras.map((p) => {
      const size = Math.round((p.size || 14) * 100);
      const color = hex(p.color || INK);
      const lvl = p.level || 0;
      const marL = p.bullet ? emu(14 + lvl * 14) : 0;
      const pPr = p.bullet
        ? `<a:pPr marL="${marL}" indent="${-emu(14)}"><a:spcAft><a:spcPts val="${Math.round((p.after != null ? p.after : 4) * 100)}"/></a:spcAft><a:buClr><a:srgbClr val="${hex(o.bulletColor || MUTED)}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>`
        : `<a:pPr algn="${o.align || 'l'}"><a:spcAft><a:spcPts val="${Math.round((p.after != null ? p.after : 4) * 100)}"/></a:spcAft><a:buNone/></a:pPr>`;
      return `<a:p>${pPr}<a:r><a:rPr lang="en-GB" sz="${size}" b="${p.bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${xmlEsc(p.text)}</a:t></a:r></a:p>`;
    }).join('') || '<a:p><a:endParaRPr lang="en-GB"/></a:p>';
    this.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${this.nextId()}" name="Text ${this.id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill}<a:ln><a:noFill/></a:ln></p:spPr>` +
      `<p:txBody><a:bodyPr wrap="square" lIns="${emu(ins)}" tIns="${emu(ins)}" rIns="${emu(ins)}" bIns="${emu(ins)}" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`);
  }
  arrow(cx, cy, size, deg, color) {
    // Right-pointing arrow rotated; PowerPoint rotation is clockwise-positive, so negate.
    this.rect(cx - size / 2, cy - size * 0.3, size, size * 0.6, color, { geom: 'rightArrow', rot: ((-deg % 360) + 360) % 360 });
  }
  xml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      this.shapes.join('') + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
  }
}

function fitSize(blocks, w, h, max, min) {
  for (let s = max; s >= min; s -= 0.5) {
    const chars = Math.max(1, Math.floor(w / (s * 0.5)));
    let lines = 0;
    for (const b of blocks) lines += Math.max(1, Math.ceil(b.text.length / (chars - (b.bullet ? 3 : 0))));
    if (lines * s * 1.3 + blocks.length * 4 <= h) return s;
  }
  return min;
}

const toParas = (blocks, size) => blocks.map((b) => ({ text: b.text, size, bullet: b.bullet, level: b.level, after: 4 }));

function buildPptxSlides(bundle) {
  const items = bundle.items || [];
  const slides = [];
  const foot = (s, label) => {
    s.text(40, 510, 600, 18, [{ text: `Key Topics Reporting — week ending ${fmtDate(bundle.week_ending)}`, size: 9, color: MUTED }]);
    if (label) s.text(820, 510, 100, 18, [{ text: label, size: 9, color: MUTED }], { align: 'r' });
  };

  // Title slide
  const t = new Slide();
  t.rect(0, 0, SLIDE_W, SLIDE_H, [0x2b, 0x2b, 0x2b]);
  t.rect(0, 0, 14, SLIDE_H, RAG.Red.rgb);
  t.text(70, 150, 800, 70, [{ text: 'Weekly status report', size: 44, bold: true, color: [255, 255, 255] }], { anchor: 'b' });
  t.text(70, 228, 800, 40, [{ text: `Week ending ${fmtDate(bundle.week_ending)}`, size: 22, color: [0xd8, 0xd4, 0xce] }]);
  const counts = countRag(items);
  const tiles = [['Topics', items.length, [255, 255, 255]], ['Red', counts.Red, RAG.Red.rgb], ['Amber', counts.Amber, RAG.Amber.rgb], ['Green', counts.Green, RAG.Green.rgb], ['Complete', counts.Blue, [0x6b, 0x9b, 0xff]]];
  tiles.forEach(([label, n, color], i) => {
    const x = 70 + i * 160;
    t.rect(x, 320, 144, 90, [0x3a, 0x3a, 0x3a]);
    t.rect(x, 320, 5, 90, color);
    t.text(x + 20, 326, 120, 50, [{ text: String(n), size: 34, bold: true, color }], { anchor: 'ctr' });
    t.text(x + 20, 376, 120, 26, [{ text: label, size: 12, color: [0xd8, 0xd4, 0xce] }]);
  });
  slides.push(t);

  // Overview slides (up to 9 topics per slide)
  const PER = 9;
  for (let start = 0; start < items.length; start += PER) {
    const s = new Slide();
    s.text(40, 26, 800, 44, [{ text: 'Overview', size: 28, bold: true }], { anchor: 'ctr' });
    s.rect(40, 74, 880, 2, INK);
    items.slice(start, start + PER).forEach((it, i) => {
      const y = 90 + i * 45;
      const rag = RAG[it.report.rag];
      s.rect(40, y, 6, 38, rag ? rag.rgb : MUTED);
      s.text(58, y, 480, 38, [{ text: it.topic.name || '', size: 16, bold: true }], { anchor: 'ctr' });
      s.text(540, y, 150, 38, [{ text: it.topic.owner || '', size: 12, color: MUTED }], { anchor: 'ctr' });
      s.text(700, y, 100, 38, [{ text: rag ? rag.label : '', size: 14, bold: true, color: rag ? rag.rgb : MUTED }], { anchor: 'ctr' });
      const ang = trendAngle(it.report.trend);
      if (ang != null) s.arrow(850, y + 19, 22, ang, MUTED);
      s.rect(40, y + 41, 880, 0.75, RULE);
    });
    foot(s);
    slides.push(s);
  }

  // One slide per topic
  for (const it of items) {
    const { topic, report } = it;
    const rag = RAG[report.rag];
    const keyDates = (it.key_dates || []).filter((k) => k.date || k.description);
    const s = new Slide();
    s.rect(0, 0, SLIDE_W, 84, PANEL);
    s.rect(0, 0, 10, 84, rag ? rag.rgb : MUTED);
    s.text(36, 10, 700, 42, [{ text: topic.name || '', size: 26, bold: true }], { anchor: 'ctr' });
    s.text(36, 52, 700, 24, [{ text: topicMeta(topic), size: 12, color: MUTED }], { anchor: 'ctr' });
    s.text(770, 26, 100, 32, [{ text: rag ? rag.label : String(report.rag || ''), size: 14, bold: true, color: [255, 255, 255] }],
      { fill: rag ? rag.rgb : MUTED, anchor: 'ctr', align: 'ctr', geom: 'roundRect' });
    const ang = trendAngle(report.trend);
    if (ang != null) s.arrow(893, 42, 30, ang, INK);

    const dateW = keyDates.length ? 210 : 0;
    const mainW = 880 - dateW - (keyDates.length ? 24 : 0);
    const gtg = report.rag !== 'Green' && report.rag !== 'Blue' ? htmlBlocks(report.gtg_plan) : [];
    const exec = htmlBlocks(report.exec_summary);
    const ach = htmlBlocks(report.achievements);
    const next = htmlBlocks(report.next_steps);

    // Vertical stack: summary, achievements, next steps (below achievements), then plan.
    const label = (y, text, color) => s.text(40, y, mainW, 16, [{ text: text.toUpperCase(), size: 10, bold: true, color: color || MUTED }]);
    const total = 520 - 98 - 20;
    const secs = [['Executive summary', exec, 14], ['Achievements', ach, 13], ['Next steps', next, 13]];
    if (gtg.length) secs.push(['Plan to get to Green', gtg, 13]);
    const weights = secs.map(([, b]) => Math.max(1, b.reduce((n, x) => n + Math.ceil(x.text.length / 90), 0)));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const avail = total - secs.length * 20;
    let y = 98;
    secs.forEach(([name, blocks], i) => {
      if (!blocks.length) return;
      const h = Math.max(46, Math.round((avail * weights[i]) / sum));
      const size = fitSize(blocks, mainW, h, i === 0 ? 14 : 13, 9);
      label(y, name, name === 'Plan to get to Green' && rag ? rag.rgb : MUTED);
      s.text(40, y + 17, mainW, h, toParas(blocks, size));
      y += h + 20;
    });

    if (keyDates.length) {
      const x = 40 + mainW + 24;
      s.rect(x - 12, 98, 0.75, 400, RULE);
      s.text(x, 98, dateW, 16, [{ text: 'KEY DATES', size: 10, bold: true, color: MUTED }]);
      const maxN = Math.min(keyDates.length, 8);
      const step = Math.min(50, 380 / maxN);
      keyDates.slice(0, maxN).forEach((k, i) => {
        const yy = 122 + i * step;
        s.rect(x, yy + 3, 9, 9, rag ? rag.rgb : MUTED, { geom: 'ellipse' });
        s.text(x + 18, yy - 1, dateW - 18, step, [
          { text: fmtDate(k.date), size: 10, bold: true, color: MUTED, after: 1 },
          { text: k.description || '', size: 11, after: 0 }
        ]);
      });
    }
    foot(s, `${slides.length + 1}`);
    slides.push(s);
  }
  return slides;
}

const THEME = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Reporter"><a:themeElements>' +
  '<a:clrScheme name="Reporter"><a:dk1><a:srgbClr val="222222"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2B2B2B"/></a:dk2><a:lt2><a:srgbClr val="F5F3F0"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="E60000"/></a:accent1><a:accent2><a:srgbClr val="F59E0B"/></a:accent2><a:accent3><a:srgbClr val="2E9E4F"/></a:accent3><a:accent4><a:srgbClr val="2563EB"/></a:accent4><a:accent5><a:srgbClr val="6B6660"/></a:accent5><a:accent6><a:srgbClr val="DDD9D3"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="6B6660"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Reporter"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="Reporter"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
  '</a:themeElements></a:theme>';

const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = (id, type, target) => `<Relationship Id="${id}" Type="${NS_R}/${type}" Target="${target}"/>`;
const RELS = (inner) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;

function buildPptx(bundle) {
  const slides = buildPptxSlides(bundle);
  const n = slides.length;
  const files = [];
  files.push(['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>']);
  files.push(['_rels/.rels', RELS(REL('rId1', 'officeDocument', 'ppt/presentation.xml') +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    REL('rId3', 'extended-properties', 'docProps/app.xml'))]);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  files.push(['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Weekly status report — week ending ${xmlEsc(fmtDate(bundle.week_ending))}</dc:title><dc:creator>Key Topics Reporting</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`]);
  files.push(['docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Key Topics Reporting</Application><Slides>${n}</Slides></Properties>`]);
  files.push(['ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_R}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst>` +
    `<p:sldSz cx="${emu(SLIDE_W)}" cy="${emu(SLIDE_H)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`]);
  files.push(['ppt/_rels/presentation.xml.rels', RELS(REL('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml') +
    slides.map((_, i) => REL(`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`)).join('') + REL(`rId${n + 2}`, 'theme', 'theme/theme1.xml'))]);
  files.push(['ppt/theme/theme1.xml', THEME]);
  const grp = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  const nsAll = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_R}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
  files.push(['ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${nsAll}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${grp}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>']);
  files.push(['ppt/slideMasters/_rels/slideMaster1.xml.rels', RELS(REL('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml') + REL('rId2', 'theme', '../theme/theme1.xml'))]);
  files.push(['ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${nsAll} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${grp}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`]);
  files.push(['ppt/slideLayouts/_rels/slideLayout1.xml.rels', RELS(REL('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'))]);
  slides.forEach((s, i) => {
    files.push([`ppt/slides/slide${i + 1}.xml`, s.xml()]);
    files.push([`ppt/slides/_rels/slide${i + 1}.xml.rels`, RELS(REL('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'))]);
  });
  return zip(files);
}

module.exports = { buildPdf, buildPptx };
