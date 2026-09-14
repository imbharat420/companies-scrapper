/**
 * SHEET MAIL ENGINE v2 — Gmail bulk sender + scheduler + follow-up sequencer
 * ---------------------------------------------------------------------------
 * One trigger (`tick`, every minute) does everything within a strict time budget:
 *   1. recover rows stuck in SENDING            (crash-safe, no duplicate sends)
 *   2. check replies (bounce / auto-reply / sentiment)   [every REPLY_CHECK_MINUTES]
 *   3. send due follow-ups                       (in-thread when Gmail API enabled)
 *   4. send due first emails                     (validated, rate-limited, windowed)
 *
 * Sheets (created by  Mail Engine ▸ Setup / Repair Sheets):
 *   Recipients   one row per person; ANY column becomes a {{Variable}}
 *   Config       Key | Value | Notes  — settings AND global variables ({{Your Full Name}} …)
 *   Sequence     Step | Draft Subject | Delay Days | Delay Hours | Active | Notes
 *   Unsubscribed Email | Reason | Added At   — suppression list, always honoured
 *   Logs         append-only, auto-trimmed
 *
 * Templates = Gmail Drafts, matched by exact subject. Use {{Column}} or {{Column|fallback}}
 * in subject or body. Type a whole {{token}} without changing formatting inside it.
 *
 * Nothing below the CONFIG block needs editing. Everything is overridable in the Config sheet.
 */

/* ============================================================================
   CONFIG  (defaults — Config sheet wins)
   ============================================================================ */
const DEFAULTS = {
  // Sheets
  RECIPIENTS_SHEET: 'Recipients',
  CONFIG_SHEET: 'Config',
  SEQUENCE_SHEET: 'Sequence',
  SUPPRESSION_SHEET: 'Unsubscribed',
  LOG_SHEET: 'Logs',

  // Time
  TIMEZONE: 'Asia/Kolkata',
  TICK_MINUTES: 1,
  REPLY_CHECK_MINUTES: 5,
  MAX_RUNTIME_SECONDS: 270,          // Apps Script hard limit is 360s; keep margin

  // Kill switch & throughput
  PAUSED: 'FALSE',                   // TRUE = nothing is sent (replies still tracked)
  BATCH_SIZE: 20,                    // max sends per tick
  MAX_PER_HOUR: 40,
  MAX_PER_DAY: 300,                  // keep under your Gmail quota (100 consumer / 1500 Workspace)
  SEND_WINDOW_START: '09:00',
  SEND_WINDOW_END: '18:00',
  SEND_DAYS: 'Mon,Tue,Wed,Thu,Fri',
  DEFAULT_SPACING_MINUTES: 3,        // Auto-Schedule spacing
  SCHEDULE_JITTER_SECONDS: 90,

  // Safety & quality
  VALIDATE_BEFORE_SEND: 'TRUE',      // syntax + MX + disposable + role checks
  ALLOW_RISKY: 'FALSE',              // TRUE = also send to role addresses (info@, hr@, careers@)
  STRICT_VARIABLES: 'TRUE',          // TRUE = row errors if a {{var}} has no value & no fallback
  STALE_SENDING_MINUTES: 10,
  FOLLOW_UP_IN_THREAD: 'TRUE',       // needs Gmail advanced service; falls back to new email
  OOO_DELAY_DAYS: 3,                 // push next follow-up when an auto-reply is detected
  DRAFT_SUBJECT: '',                 // used only if Sequence sheet is empty

  // Sender identity (also available as variables)
  'Sender Name': '',
  'Reply To': '',
  'Your Full Name': '',
  'Your Email': '',
  'Your Phone Number': '',
  'Your LinkedIn Profile': '',

  // Logging
  LOG_LEVEL: 'INFO',                 // DEBUG | INFO | WARN | ERROR
  MAX_LOG_ROWS: 5000
};

/* Tracking columns. Missing ones are appended automatically. */
const COL = {
  RECIPIENT: 'Recipient',
  GROUP: 'Group',
  SCHEDULED: 'Scheduled Date',
  STATUS: 'Status',
  STEP: 'Step',
  SENT_AT: 'Sent At',
  NEXT_AT: 'Next Follow-Up At',
  THREAD: 'Thread ID',
  REPLY_STATUS: 'Reply Status',
  REPLY_AT: 'Reply At',
  SENTIMENT: 'Sentiment',
  VALIDATION: 'Validation',
  UPDATED: 'Updated At',
  ERROR: 'Error'
};
const REQUIRED_COLS = [COL.RECIPIENT, COL.SCHEDULED];
const TRACKING_COLS = [COL.GROUP, COL.STATUS, COL.STEP, COL.SENT_AT, COL.NEXT_AT, COL.THREAD,
  COL.REPLY_STATUS, COL.REPLY_AT, COL.SENTIMENT, COL.VALIDATION, COL.UPDATED, COL.ERROR];

const STATUS = {
  SCHEDULED: 'SCHEDULED',
  SENDING: 'SENDING',
  SENT: 'SENT',            // sequence active, awaiting reply / next step
  COMPLETED: 'COMPLETED',  // all steps sent, no reply
  REPLIED: 'REPLIED',
  INTERESTED: 'INTERESTED',
  NOT_INTERESTED: 'NOT_INTERESTED',
  UNSUBSCRIBED: 'UNSUBSCRIBED',
  BOUNCED: 'BOUNCED',
  INVALID: 'INVALID',
  ERROR: 'ERROR',
  PAUSE: 'PAUSE',          // user-set: skip this row
  SKIP: 'SKIP'             // user-set: never send
};
const TERMINAL = new Set([STATUS.COMPLETED, STATUS.REPLIED, STATUS.INTERESTED, STATUS.NOT_INTERESTED,
  STATUS.UNSUBSCRIBED, STATUS.BOUNCED, STATUS.INVALID, STATUS.SKIP]);

const REPLY = { WAITING: 'WAITING', REPLIED: 'REPLIED', OOO: 'AUTO_REPLY', BOUNCED: 'BOUNCED' };
const SENTIMENT = { POS: 'POSITIVE', NEG: 'NEGATIVE', NEU: 'NEUTRAL', OOO: 'AUTO_REPLY', BOUNCE: 'BOUNCE' };

const PROP = { LAST_REPLY_CHECK: 'LAST_REPLY_CHECK', REPLY_CURSOR: 'REPLY_CURSOR', SEND_HISTORY: 'SEND_HISTORY' };

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

/* ============================================================================
   LOGGING  (buffered; one sheet write per execution)
   ============================================================================ */
const Log = (() => {
  let buffer = [];
  let threshold = LEVELS.INFO;
  let tz = DEFAULTS.TIMEZONE;
  let execId = '';

  function line(level, event, details, row, recipient) {
    if (LEVELS[level] < threshold) return;
    const ts = new Date();
    const detailStr = details === undefined ? '' :
      (typeof details === 'string' ? details : safeJson_(details));
    buffer.push([ts, level, execId, row || '', recipient || '', event, detailStr]);
    console.log(`[${Utilities.formatDate(ts, tz, 'HH:mm:ss.SSS')}] ${level} ${event}${detailStr ? ' | ' + detailStr : ''}`);
  }

  return {
    init(cfg, id) {
      threshold = LEVELS[String(cfg.LOG_LEVEL || 'INFO').toUpperCase()] || LEVELS.INFO;
      tz = cfg.TIMEZONE; execId = id; buffer = [];
    },
    debug: (e, d, r, rc) => line('DEBUG', e, d, r, rc),
    info: (e, d, r, rc) => line('INFO', e, d, r, rc),
    warn: (e, d, r, rc) => line('WARN', e, d, r, rc),
    error(e, err, r, rc) {
      line('ERROR', e, { message: errMsg_(err), stack: err && err.stack ? String(err.stack).slice(0, 500) : '' }, r, rc);
    },
    flush(ss, cfg) {
      if (!buffer.length) return;
      try {
        const sheet = ss.getSheetByName(cfg.LOG_SHEET) || createLogSheet_(ss, cfg.LOG_SHEET);
        sheet.getRange(sheet.getLastRow() + 1, 1, buffer.length, 7).setValues(buffer);
        const excess = sheet.getLastRow() - 1 - Number(cfg.MAX_LOG_ROWS);
        if (excess > 0) sheet.deleteRows(2, excess);
      } catch (e) {
        console.error('Log flush failed: ' + errMsg_(e));
      }
      buffer = [];
    }
  };
})();

function safeJson_(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }
function errMsg_(e) { return e && e.message ? e.message : String(e); }
function bool_(v) { return String(v).trim().toUpperCase() === 'TRUE'; }
function num_(v, d) { const n = Number(v); return isNaN(n) ? d : n; }

function createLogSheet_(ss, name) {
  const sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, 7).setValues([['Timestamp', 'Level', 'Execution', 'Row', 'Recipient', 'Event', 'Details']])
    .setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

/* ============================================================================
   CONTEXT  (everything an execution needs, loaded once)
   ============================================================================ */
function buildContext_(opts) {
  opts = opts || {};
  const start = new Date();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = loadConfig_(ss);
  Log.init(cfg, Utilities.getUuid().slice(0, 8));

  const sheet = getRecipientsSheet_(ss, cfg);
  const cols = ensureColumns_(sheet);
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h || '').trim());

  return {
    ss, cfg, sheet, cols, headers, data,
    now: start,
    deadline: start.getTime() + num_(cfg.MAX_RUNTIME_SECONDS, 270) * 1000,
    sequence: opts.skipSequence ? [] : loadSequence_(ss, cfg),
    suppression: opts.skipSuppression ? new Set() : loadSuppression_(ss, cfg),
    drafts: null,          // lazy
    me: Session.getEffectiveUser().getEmail().toLowerCase(),
    stats: { sent: 0, followUps: 0, skipped: 0, errors: 0, replies: 0 }
  };
}

function timeLeft_(ctx) { return ctx.deadline - Date.now(); }
function outOfTime_(ctx, needMs) { return timeLeft_(ctx) < (needMs || 15000); }

function loadConfig_(ss) {
  const cfg = Object.assign({}, DEFAULTS);
  const sheet = ss.getSheetByName(DEFAULTS.CONFIG_SHEET);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(([k, v]) => {
      const key = String(k || '').trim();
      if (key) cfg[key] = v instanceof Date ? v : String(v === null || v === undefined ? '' : v).trim();
    });
  }
  return cfg;
}

function getRecipientsSheet_(ss, cfg) {
  let sheet = ss.getSheetByName(cfg.RECIPIENTS_SHEET);
  if (!sheet) {
    // fall back to the first sheet that has a Recipient header
    sheet = ss.getSheets().find(s => s.getLastColumn() > 0 &&
      s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(h => String(h).trim()).includes(COL.RECIPIENT));
    if (!sheet) throw new Error(`Recipients sheet "${cfg.RECIPIENTS_SHEET}" not found and no sheet has a "${COL.RECIPIENT}" header.`);
    Log.warn('Using fallback recipients sheet', sheet.getName());
  }
  return sheet;
}

/** Validates required headers, appends missing tracking headers, returns {name: index}. */
function ensureColumns_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  let headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());

  const seen = {}; const dups = [];
  headers.forEach(h => { if (h) { if (seen[h]) dups.push(h); seen[h] = true; } });
  if (dups.length) throw new Error('Duplicate headers: ' + dups.join(', '));

  REQUIRED_COLS.forEach(c => { if (!headers.includes(c)) throw new Error(`Required column missing: "${c}"`); });

  const missing = TRACKING_COLS.filter(c => !headers.includes(c));
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    headers = headers.concat(missing);
    Log.info('Added tracking columns', missing);
  }
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i; });
  return map;
}

function loadSequence_(ss, cfg) {
  const sheet = ss.getSheetByName(cfg.SEQUENCE_SHEET);
  let steps = [];
  if (sheet && sheet.getLastRow() > 1) {
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
    steps = rows
      .filter(r => String(r[1] || '').trim())
      .filter(r => r[4] === '' || r[4] === null || bool_(r[4]) || r[4] === true)
      .map(r => ({
        step: num_(r[0], 0), subject: String(r[1]).trim(),
        delayMs: (num_(r[2], 0) * 24 + num_(r[3], 0)) * 3600 * 1000
      }))
      .sort((a, b) => a.step - b.step);
  }
  if (!steps.length && cfg.DRAFT_SUBJECT) steps = [{ step: 1, subject: cfg.DRAFT_SUBJECT, delayMs: 0 }];
  if (!steps.length) throw new Error('No sequence: fill the Sequence sheet or Config ▸ DRAFT_SUBJECT.');
  steps.forEach((s, i) => s.step = i + 1); // normalise to 1..n
  return steps;
}

function loadSuppression_(ss, cfg) {
  const set = new Set();
  const sheet = ss.getSheetByName(cfg.SUPPRESSION_SHEET);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
      .forEach(([e]) => { const v = String(e || '').trim().toLowerCase(); if (v) set.add(v); });
  }
  return set;
}

function addToSuppression_(ctx, email, reason) {
  email = String(email).trim().toLowerCase();
  if (!email || ctx.suppression.has(email)) return;
  ctx.suppression.add(email);
  const sheet = ctx.ss.getSheetByName(ctx.cfg.SUPPRESSION_SHEET) || createSuppressionSheet_(ctx.ss, ctx.cfg.SUPPRESSION_SHEET);
  sheet.appendRow([email, reason, new Date()]);
  Log.info('Added to suppression list', { email, reason });
}

function createSuppressionSheet_(ss, name) {
  const sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, 3).setValues([['Email', 'Reason', 'Added At']]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

/* ============================================================================
   ROW ACCESS  (in-memory row + immediate cell write for state that must survive a crash)
   ============================================================================ */
function rowObj_(ctx, i) {
  const values = ctx.data[i];
  const get = name => ctx.cols[name] === undefined ? '' : values[ctx.cols[name]];
  return {
    i, sheetRow: i + 1, values,
    recipient: String(get(COL.RECIPIENT) || '').trim().toLowerCase(),
    status: String(get(COL.STATUS) || '').trim().toUpperCase(),
    step: num_(get(COL.STEP), 0),
    threads: String(get(COL.THREAD) || '').split(',').map(s => s.trim()).filter(Boolean),
    replyStatus: String(get(COL.REPLY_STATUS) || '').trim().toUpperCase(),
    validation: String(get(COL.VALIDATION) || '').trim().toUpperCase(),
    scheduledRaw: get(COL.SCHEDULED),
    sentAt: toDate_(get(COL.SENT_AT)),
    nextAt: toDate_(get(COL.NEXT_AT)),
    updatedAt: toDate_(get(COL.UPDATED)),
    get
  };
}

/** Writes several cells of one row now (survives a later crash) and mirrors them in memory. */
function setRow_(ctx, row, patch, flush) {
  patch[COL.UPDATED] = new Date();
  Object.keys(patch).forEach(name => {
    const c = ctx.cols[name];
    if (c === undefined) return;
    const v = patch[name] === undefined ? '' : patch[name];
    ctx.sheet.getRange(row.sheetRow, c + 1).setValue(v);
    row.values[c] = v;
  });
  if (flush) SpreadsheetApp.flush();
}

function toDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/* ============================================================================
   DATES, SEND WINDOW, RATE LIMITS
   ============================================================================ */
/** Accepts Date, serial number, "DD/MM/YYYY HH:mm[:ss]", "YYYY-MM-DD HH:mm", ISO. */
function parseScheduledDate_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? null : d;
  }
  const text = String(value).trim();
  let m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return makeDate_(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return makeDate_(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const d = new Date(text);
  return isNaN(d.getTime()) ? null : d;
}

function makeDate_(y, mo, d, h, mi, s) {
  const dt = new Date(y, mo, d, h, mi, s, 0);
  const ok = dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d &&
    dt.getHours() === h && dt.getMinutes() === mi;
  return ok ? dt : null;
}

function fmt_(date, tz, pattern) {
  if (!date || isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, tz, pattern || 'yyyy-MM-dd HH:mm');
}

function hm_(s) { const m = String(s).match(/^(\d{1,2}):(\d{2})$/); return m ? (+m[1]) * 60 + (+m[2]) : null; }

function inSendWindow_(date, cfg) {
  const days = String(cfg.SEND_DAYS).split(',').map(s => s.trim().slice(0, 3).toLowerCase()).filter(Boolean);
  const day = Utilities.formatDate(date, cfg.TIMEZONE, 'EEE').toLowerCase();
  if (days.length && !days.includes(day)) return false;
  const start = hm_(cfg.SEND_WINDOW_START), end = hm_(cfg.SEND_WINDOW_END);
  if (start === null || end === null) return true;
  const cur = hm_(Utilities.formatDate(date, cfg.TIMEZONE, 'HH:mm'));
  return start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
}

/** Next datetime >= date that falls inside the send window (day + time). */
function nextWindowSlot_(date, cfg) {
  let d = new Date(date.getTime());
  for (let guard = 0; guard < 14 * 24 * 4; guard++) {
    if (inSendWindow_(d, cfg)) return d;
    // jump to next quarter hour
    d = new Date(Math.floor(d.getTime() / 900000) * 900000 + 900000);
  }
  return date;
}

/** Sliding-window counters kept in ScriptProperties (timestamps of sends in last 24h). */
function sendHistory_() {
  const p = PropertiesService.getScriptProperties();
  let list = [];
  try { list = JSON.parse(p.getProperty(PROP.SEND_HISTORY) || '[]'); } catch (e) { list = []; }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  list = list.filter(t => t > cutoff);
  return {
    list,
    lastHour: list.filter(t => t > Date.now() - 3600 * 1000).length,
    lastDay: list.length,
    record() { list.push(Date.now()); p.setProperty(PROP.SEND_HISTORY, JSON.stringify(list)); }
  };
}

function rateLimitReason_(ctx, hist) {
  if (bool_(ctx.cfg.PAUSED)) return 'PAUSED (Config)';
  if (!inSendWindow_(new Date(), ctx.cfg)) return 'outside send window';
  if (hist.lastHour >= num_(ctx.cfg.MAX_PER_HOUR, 40)) return 'MAX_PER_HOUR reached';
  if (hist.lastDay >= num_(ctx.cfg.MAX_PER_DAY, 300)) return 'MAX_PER_DAY reached';
  if (MailApp.getRemainingDailyQuota() <= 0) return 'Gmail daily quota exhausted';
  return null;
}

/* ============================================================================
   EMAIL VALIDATION  (best available without SMTP access)
   syntax → disposable domain → role address → MX record via DNS-over-HTTPS (cached 6h)
   Bounces are caught later by the reply checker and suppress the address.
   ============================================================================ */
const DISPOSABLE_DOMAINS = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com',
  'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'getnada.com', 'dispostable.com', 'fakeinbox.com',
  'sharklasers.com', 'maildrop.cc', 'throwawaymail.com', 'mohmal.com', 'emailondeck.com', 'mintemail.com']);
const ROLE_PREFIXES = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster', 'abuse',
  'info', 'admin', 'support', 'sales', 'contact', 'hello', 'careers', 'jobs', 'hr', 'recruiting', 'webmaster'];

function validateEmail_(email, cfg) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.includes('..')) return { code: 'INVALID_SYNTAX', ok: false };
  const [local, domain] = email.split('@');
  const extraDisposable = String(cfg.DISPOSABLE_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (DISPOSABLE_DOMAINS.has(domain) || extraDisposable.includes(domain)) return { code: 'DISPOSABLE', ok: false };
  const mx = hasMx_(domain);
  if (mx === false) return { code: 'NO_MX', ok: false };
  const allowRisky = bool_(cfg.ALLOW_RISKY);
  if (ROLE_PREFIXES.some(p => local === p || local.startsWith(p + '.') || local.startsWith(p + '-'))) return { code: 'ROLE_ADDRESS', ok: allowRisky };
  if (mx === null) return { code: 'MX_UNKNOWN', ok: true };
  return { code: 'VALID', ok: true };
}

/** true = has MX (or A fallback), false = no DNS records, null = lookup failed. */
function hasMx_(domain) {
  const cache = CacheService.getScriptCache();
  const key = 'mx:' + domain;
  const cached = cache.get(key);
  if (cached !== null) return cached === '1' ? true : cached === '0' ? false : null;
  let result = null;
  try {
    const q = type => {
      const r = UrlFetchApp.fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`,
        { muteHttpExceptions: true, followRedirects: true });
      if (r.getResponseCode() !== 200) return null;
      const j = JSON.parse(r.getContentText());
      if (j.Status === 3) return false;                        // NXDOMAIN
      if (j.Status !== 0) return null;
      return Array.isArray(j.Answer) && j.Answer.length > 0;
    };
    const mx = q('MX');
    result = mx === true ? true : mx === false ? q('A') : null;
    if (result === undefined) result = null;
  } catch (e) { result = null; }
  cache.put(key, result === true ? '1' : result === false ? '0' : '?', result === null ? 600 : 21600);
  return result;
}

/* ============================================================================
   TEMPLATES  (Gmail Drafts, loaded once per execution)
   ============================================================================ */
function loadDrafts_(ctx) {
  if (ctx.drafts) return ctx.drafts;
  const wanted = new Set(ctx.sequence.map(s => s.subject));
  const map = {};
  GmailApp.getDrafts().forEach(d => {
    const msg = d.getMessage();
    const subject = msg.getSubject();
    if (!wanted.has(subject) || map[subject]) return;
    const html = msg.getBody();
    const attachments = msg.getAttachments({ includeInlineImages: false });
    const inline = msg.getAttachments({ includeInlineImages: true, includeAttachments: false });
    const byName = {};
    inline.forEach(img => { byName[img.getName()] = img; });
    const inlineImages = {};
    [...html.matchAll(/<img[^>]*?src="cid:([^"]+)"[^>]*?alt="([^"]*)"[^>]*>/g)]
      .forEach(m => { if (byName[m[2]]) inlineImages[m[1]] = byName[m[2]]; });
    map[subject] = { subject, html, text: msg.getPlainBody(), attachments, inlineImages };
  });
  const missing = [...wanted].filter(s => !map[s]);
  if (missing.length) Log.warn('Draft(s) not found for Sequence subjects', missing);
  ctx.drafts = map;
  return map;
}

/* ============================================================================
   VARIABLES  {{Column}} | {{Column|fallback}}  — row → Config → system
   ============================================================================ */
function buildVars_(ctx, row) {
  const vars = {};
  ctx.headers.forEach((h, i) => { if (h) vars[normKey_(h)] = row.values[i]; });
  Object.keys(ctx.cfg).forEach(k => { if (vars[normKey_(k)] === undefined) vars[normKey_(k)] = ctx.cfg[k]; });
  const nameCol = ['name', 'full name', 'fullname', 'candidate name', 'recipient name'].find(k => vars[k]);
  if (vars['first name'] === undefined && nameCol) vars['first name'] = String(vars[nameCol]).trim().split(/\s+/)[0];
  vars['today'] = fmt_(new Date(), ctx.cfg.TIMEZONE, 'dd MMM yyyy');
  vars['recipient'] = row.recipient;
  return vars;
}

function normKey_(k) { return String(k).trim().replace(/\s+/g, ' ').toLowerCase(); }

/** Replaces {{tokens}}. Returns {text, missing[]}. Values are HTML-escaped when html=true. */
function render_(template, vars, tz, html) {
  const missing = [];
  const text = String(template || '').replace(/{{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?)\s*)?}}/g, (m, key, fallback) => {
    let v = vars[normKey_(key)];
    if (v instanceof Date) v = fmt_(v, tz, 'dd MMM yyyy');
    v = v === undefined || v === null ? '' : String(v).trim();
    if (!v) {
      if (fallback !== undefined) v = fallback;
      else { missing.push(key.trim()); return ''; }
    }
    return html ? escapeHtml_(v).replace(/\r?\n/g, '<br>') : v;
  });
  return { text, missing: [...new Set(missing)] };
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Personalises a draft for a row. Throws in STRICT mode when variables are missing. */
function personalise_(ctx, tpl, row) {
  const vars = buildVars_(ctx, row);
  const subject = render_(tpl.subject, vars, ctx.cfg.TIMEZONE, false);
  const html = render_(tpl.html, vars, ctx.cfg.TIMEZONE, true);
  const text = render_(tpl.text, vars, ctx.cfg.TIMEZONE, false);
  const missing = [...new Set([...subject.missing, ...html.missing, ...text.missing])];
  if (missing.length) {
    if (bool_(ctx.cfg.STRICT_VARIABLES)) throw new Error('Missing variable value(s): ' + missing.join(', '));
    Log.warn('Missing variables rendered as empty', missing, row.sheetRow, row.recipient);
  }
  return { subject: subject.text, html: html.text, text: text.text, attachments: tpl.attachments, inlineImages: tpl.inlineImages };
}

/* ============================================================================
   SENDING
   ============================================================================ */
function sendOptions_(ctx, msg) {
  const o = { htmlBody: msg.html, attachments: msg.attachments, inlineImages: msg.inlineImages };
  if (ctx.cfg['Sender Name']) o.name = ctx.cfg['Sender Name'];
  if (ctx.cfg['Reply To']) o.replyTo = ctx.cfg['Reply To'];
  return o;
}

function findSentThread_(recipient, subject, sinceMs) {
  const safe = String(subject).replace(/["()]/g, ' ').trim();
  const query = `in:sent to:${recipient} subject:"${safe}" newer_than:1d`;
  const threads = GmailApp.search(query, 0, 10)
    .filter(t => !sinceMs || t.getLastMessageDate().getTime() >= sinceMs - 60000)
    .sort((a, b) => b.getLastMessageDate().getTime() - a.getLastMessageDate().getTime());
  return threads[0] || null;
}

function gmailApiAvailable_() { return typeof Gmail !== 'undefined' && Gmail && Gmail.Users; }

/** RFC-2047 encode a header value when non-ASCII. */
function encHeader_(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Utilities.base64Encode(s, Utilities.Charset.UTF_8) + '?=';
}

/** Sends a follow-up inside an existing thread via the Gmail advanced service. Returns threadId. */
function sendInThread_(ctx, thread, recipient, msg) {
  const first = thread.getMessages()[0];
  const msgId = first.getHeader('Message-ID') || '';
  let subject = thread.getFirstMessageSubject() || msg.subject;
  if (!/^re:/i.test(subject)) subject = 'Re: ' + subject;
  const from = ctx.cfg['Sender Name'] ? `${encHeader_(ctx.cfg['Sender Name'])} <${ctx.me}>` : ctx.me;
  const boundary = 'b_' + Utilities.getUuid().replace(/-/g, '');
  const b64 = s => Utilities.base64Encode(s, Utilities.Charset.UTF_8).replace(/(.{76})/g, '$1\r\n');
  const headers = [
    `From: ${from}`, `To: ${recipient}`, `Subject: ${encHeader_(subject)}`,
    msgId ? `In-Reply-To: ${msgId}` : '', msgId ? `References: ${msgId}` : '',
    ctx.cfg['Reply To'] ? `Reply-To: ${ctx.cfg['Reply To']}` : '',
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`
  ].filter(Boolean).join('\r\n');
  const mime = headers + '\r\n\r\n' +
    `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(msg.text)}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(msg.html)}\r\n` +
    `--${boundary}--`;
  const raw = Utilities.base64EncodeWebSafe(mime, Utilities.Charset.UTF_8);
  const res = Gmail.Users.Messages.send({ raw, threadId: thread.getId() }, 'me');
  return res.threadId || thread.getId();
}

/**
 * Sends step N of the sequence to a row. Handles validation, suppression, template,
 * crash-safe status marking, thread capture and next-step scheduling.
 */
function sendStep_(ctx, row, stepDef, hist) {
  const isFirst = stepDef.step === 1;
  const drafts = loadDrafts_(ctx);
  const tpl = drafts[stepDef.subject];
  if (!tpl) throw new Error(`Gmail Draft not found: "${stepDef.subject}"`);

  if (ctx.suppression.has(row.recipient)) {
    setRow_(ctx, row, { [COL.STATUS]: STATUS.UNSUBSCRIBED, [COL.NEXT_AT]: '', [COL.ERROR]: 'On suppression list' });
    Log.info('Skipped: suppressed', undefined, row.sheetRow, row.recipient);
    ctx.stats.skipped++; return false;
  }

  if (isFirst && bool_(ctx.cfg.VALIDATE_BEFORE_SEND) && row.validation !== 'VALID') {
    const v = validateEmail_(row.recipient, ctx.cfg);
    setRow_(ctx, row, { [COL.VALIDATION]: v.code });
    if (!v.ok) {
      setRow_(ctx, row, { [COL.STATUS]: STATUS.INVALID, [COL.ERROR]: 'Validation failed: ' + v.code });
      Log.warn('Invalid recipient', v.code, row.sheetRow, row.recipient);
      ctx.stats.skipped++; return false;
    }
  }

  const msg = personalise_(ctx, tpl, row);
  setRow_(ctx, row, { [COL.STATUS]: STATUS.SENDING, [COL.ERROR]: '' }, true);   // crash marker
  const sentAt = new Date();
  let threadIds = row.threads.slice();

  if (isFirst || !row.threads.length) {
    GmailApp.sendEmail(row.recipient, msg.subject, msg.text, sendOptions_(ctx, msg));
    Utilities.sleep(1500);
    const t = findSentThread_(row.recipient, msg.subject, sentAt.getTime());
    if (t) threadIds.push(t.getId()); else Log.warn('Sent, but thread not indexed yet', msg.subject, row.sheetRow, row.recipient);
  } else {
    let done = false;
    if (bool_(ctx.cfg.FOLLOW_UP_IN_THREAD) && gmailApiAvailable_()) {
      try {
        const thread = GmailApp.getThreadById(row.threads[row.threads.length - 1]);
        if (thread) {
          if (msg.attachments.length || Object.keys(msg.inlineImages).length)
            Log.warn('Attachments/inline images are dropped for in-thread follow-ups', undefined, row.sheetRow, row.recipient);
          sendInThread_(ctx, thread, row.recipient, msg);
          done = true;
        }
      } catch (e) { Log.warn('In-thread follow-up failed, falling back to new email', errMsg_(e), row.sheetRow, row.recipient); }
    }
    if (!done) {
      GmailApp.sendEmail(row.recipient, msg.subject, msg.text, sendOptions_(ctx, msg));
      Utilities.sleep(1500);
      const t = findSentThread_(row.recipient, msg.subject, sentAt.getTime());
      if (t && !threadIds.includes(t.getId())) threadIds.push(t.getId());
    }
  }
  hist.record();

  const next = ctx.sequence.find(s => s.step === stepDef.step + 1);
  const nextAt = next ? nextWindowSlot_(new Date(sentAt.getTime() + next.delayMs), ctx.cfg) : '';
  setRow_(ctx, row, {
    [COL.STATUS]: next ? STATUS.SENT : STATUS.COMPLETED,
    [COL.STEP]: stepDef.step,
    [COL.SENT_AT]: sentAt,
    [COL.NEXT_AT]: nextAt,
    [COL.THREAD]: threadIds.join(','),
    [COL.REPLY_STATUS]: row.replyStatus === REPLY.OOO ? REPLY.OOO : REPLY.WAITING,
    [COL.ERROR]: ''
  }, true);
  Log.info(isFirst ? 'EMAIL SENT' : 'FOLLOW-UP SENT', { step: stepDef.step, subject: msg.subject, nextAt: fmt_(nextAt, ctx.cfg.TIMEZONE) }, row.sheetRow, row.recipient);
  if (isFirst) ctx.stats.sent++; else ctx.stats.followUps++;
  return true;
}

/** A row left in SENDING (script died mid-send). Decide from Gmail whether it went out. */
function recoverStale_(ctx, row) {
  const ageMin = row.updatedAt ? (Date.now() - row.updatedAt.getTime()) / 60000 : 999;
  if (ageMin < num_(ctx.cfg.STALE_SENDING_MINUTES, 10)) return;
  const stepDef = ctx.sequence.find(s => s.step === row.step + 1) || ctx.sequence[0];
  const tpl = loadDrafts_(ctx)[stepDef.subject];
  let subject = stepDef.subject;
  try { if (tpl) subject = personalise_(ctx, tpl, row).subject; } catch (e) { /* keep raw */ }
  const t = findSentThread_(row.recipient, subject.replace(/^re:\s*/i, ''), row.updatedAt ? row.updatedAt.getTime() : 0);
  if (t) {
    const threads = row.threads.includes(t.getId()) ? row.threads : row.threads.concat(t.getId());
    const next = ctx.sequence.find(s => s.step === stepDef.step + 1);
    setRow_(ctx, row, {
      [COL.STATUS]: next ? STATUS.SENT : STATUS.COMPLETED, [COL.STEP]: stepDef.step,
      [COL.SENT_AT]: t.getLastMessageDate(), [COL.THREAD]: threads.join(','),
      [COL.NEXT_AT]: next ? nextWindowSlot_(new Date(t.getLastMessageDate().getTime() + next.delayMs), ctx.cfg) : '',
      [COL.REPLY_STATUS]: REPLY.WAITING, [COL.ERROR]: 'Recovered: send confirmed in Gmail'
    });
    Log.warn('Stale SENDING recovered as SENT', undefined, row.sheetRow, row.recipient);
  } else {
    setRow_(ctx, row, { [COL.STATUS]: row.step > 0 ? STATUS.SENT : STATUS.SCHEDULED, [COL.ERROR]: 'Recovered: send not found, re-queued' });
    Log.warn('Stale SENDING re-queued', undefined, row.sheetRow, row.recipient);
  }
}

/* ============================================================================
   MAIN TRIGGER
   ============================================================================ */
function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('tick: another execution holds the lock; exiting'); return; }
  let ctx;
  try {
    ctx = buildContext_();
    Log.info('TICK START', { rows: ctx.data.length - 1, steps: ctx.sequence.length, paused: bool_(ctx.cfg.PAUSED) });

    // 1. crash recovery
    for (let i = 1; i < ctx.data.length && !outOfTime_(ctx); i++) {
      const row = rowObj_(ctx, i);
      if (row.status === STATUS.SENDING && row.recipient) {
        try { recoverStale_(ctx, row); } catch (e) { Log.error('Recovery failed', e, row.sheetRow, row.recipient); }
      }
    }

    // 2. replies (before follow-ups, so nobody who answered gets chased)
    const props = PropertiesService.getScriptProperties();
    const lastCheck = num_(props.getProperty(PROP.LAST_REPLY_CHECK), 0);
    const cursor = num_(props.getProperty(PROP.REPLY_CURSOR), 0);
    if (cursor > 0 || Date.now() - lastCheck >= num_(ctx.cfg.REPLY_CHECK_MINUTES, 5) * 60000) {
      checkRepliesInternal_(ctx, Math.min(timeLeft_(ctx) * 0.4, 120000));
    }

    // 3 + 4. sends
    const hist = sendHistory_();
    const blocked = rateLimitReason_(ctx, hist);
    if (blocked) {
      Log.info('Sending blocked this tick', blocked);
    } else {
      processSends_(ctx, hist);
    }

    Log.info('TICK END', Object.assign({ msLeft: timeLeft_(ctx) }, ctx.stats));
  } catch (e) {
    Log.error('TICK FAILED', e);
    throw e;
  } finally {
    if (ctx) Log.flush(ctx.ss, ctx.cfg);
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

function processSends_(ctx, hist) {
  const batch = num_(ctx.cfg.BATCH_SIZE, 20);
  const now = Date.now();
  const due = [];
  for (let i = 1; i < ctx.data.length; i++) {
    const row = rowObj_(ctx, i);
    if (!row.recipient || TERMINAL.has(row.status) || row.status === STATUS.PAUSE ||
        row.status === STATUS.SENDING || row.status === STATUS.ERROR) continue;

    if (row.step === 0) {                                     // first email
      if (!row.scheduledRaw) continue;
      const when = parseScheduledDate_(row.scheduledRaw);
      if (!when) {
        setRow_(ctx, row, { [COL.STATUS]: STATUS.ERROR, [COL.ERROR]: 'Invalid Scheduled Date: ' + row.scheduledRaw });
        Log.warn('Invalid Scheduled Date', String(row.scheduledRaw), row.sheetRow, row.recipient); ctx.stats.errors++; continue;
      }
      if (when.getTime() > now) { if (row.status !== STATUS.SCHEDULED) setRow_(ctx, row, { [COL.STATUS]: STATUS.SCHEDULED }); continue; }
      due.push({ row, stepDef: ctx.sequence[0], at: when.getTime() });
    } else if (row.status === STATUS.SENT) {                  // follow-up
      if (row.replyStatus === REPLY.REPLIED || row.replyStatus === REPLY.BOUNCED) continue;
      const next = ctx.sequence.find(s => s.step === row.step + 1);
      if (!next) { setRow_(ctx, row, { [COL.STATUS]: STATUS.COMPLETED, [COL.NEXT_AT]: '' }); continue; }
      const at = row.nextAt ? row.nextAt.getTime() : (row.sentAt ? row.sentAt.getTime() + next.delayMs : null);
      if (at === null || at > now) continue;
      due.push({ row, stepDef: next, at });
    }
  }
  due.sort((a, b) => a.at - b.at);                            // oldest first: follow-ups and first sends interleave fairly
  let count = 0;
  for (const job of due) {
    if (count >= batch) { Log.info('BATCH_SIZE reached; remaining due rows wait for next tick', due.length - count); break; }
    if (outOfTime_(ctx, 25000)) { Log.warn('Time budget exhausted; remaining due rows wait for next tick', due.length - count); break; }
    const limit = rateLimitReason_(ctx, hist);
    if (limit) { Log.info('Stopped sending', limit); break; }
    try {
      if (sendStep_(ctx, job.row, job.stepDef, hist)) count++;
    } catch (e) {
      ctx.stats.errors++;
      setRow_(ctx, job.row, { [COL.STATUS]: STATUS.ERROR, [COL.ERROR]: errMsg_(e) }, true);
      Log.error('SEND FAILED', e, job.row.sheetRow, job.row.recipient);
    }
  }
}

/* ============================================================================
   REPLY INTELLIGENCE  — bounce → auto-reply → sentiment (rule-based, quoted text stripped)
   ============================================================================ */
const KW = {
  unsubscribe: ['unsubscribe', 'remove me', 'take me off', 'stop emailing', 'stop contacting', 'do not contact', "don't contact", 'opt out', 'opt-out', 'please stop'],
  negative: ['not interested', 'no longer', 'not hiring', 'no openings', 'no open positions', 'position has been filled', 'position is filled', 'already filled', 'no thanks', 'no thank you', 'not looking', 'not a fit', 'not the right fit', 'not a good fit', 'decline', 'pass on this', 'pass at this time', 'wrong person', 'not relevant', 'spam', 'not at this time', 'no budget', 'we are not'],
  positive: ['interested', "let's schedule", 'lets schedule', "let's talk", 'lets talk', 'happy to chat', 'love to chat', 'would love to', 'sounds great', 'sounds good', 'schedule a call', 'set up a call', 'set up a time', 'book a time', 'calendar', 'availability', 'available on', 'when are you free', 'when are you available', 'send your resume', 'send over', 'share your', 'tell me more', 'more details', "let's connect", 'lets connect', 'connect you with', 'forward your', 'portfolio', 'next steps', 'looking forward', 'great fit', 'good fit', 'yes,', 'yes.', 'sure', 'absolutely', 'definitely', 'please send', 'can you share', 'could you share'],
  bounceSubject: ['delivery status notification', 'undeliverable', 'undelivered', 'returned mail', 'delivery failure', 'failure notice', 'mail delivery failed', 'could not be delivered', 'address not found'],
  oooSubject: ['automatic reply', 'auto reply', 'auto-reply', 'autoreply', 'out of office', 'out of the office', 'ooo', 'away from', 'on leave', 'vacation', 'auto response', 'autoresponder']
};

function stripQuoted_(body) {
  const lines = String(body || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^On .{5,120} wrote:\s*$/.test(l)) break;
    if (/^-{3,}\s*(Original|Forwarded) Message/i.test(l)) break;
    if (/^From:\s.+/.test(l) && out.length > 2) break;
    out.push(l);
  }
  return out.join('\n').toLowerCase();
}

function isBounce_(msg) {
  const from = String(msg.getFrom() || '').toLowerCase();
  const subj = String(msg.getSubject() || '').toLowerCase();
  return /mailer-daemon|postmaster|mail delivery/.test(from) || KW.bounceSubject.some(k => subj.includes(k));
}

function isAutoReply_(msg) {
  const subj = String(msg.getSubject() || '').toLowerCase();
  if (KW.oooSubject.some(k => subj.includes(k))) return true;
  try {
    const auto = String(msg.getHeader('Auto-Submitted') || '').toLowerCase();
    if (auto && auto !== 'no') return true;
    if (msg.getHeader('X-Autoreply') || msg.getHeader('X-Autorespond') || msg.getHeader('X-Auto-Response-Suppress')) return true;
  } catch (e) { /* header API unavailable */ }
  const body = stripQuoted_(msg.getPlainBody()).slice(0, 400);
  return /i am (currently )?(out of|away from) the office|automatic reply|auto-?reply|will (respond|reply|get back) (to you )?(when|upon|on) (i|my) return/.test(body);
}

/** Returns {sentiment, unsubscribe}. Extend here (e.g. swap in an LLM) — single point of change. */
function classifyReply_(msg) {
  const body = stripQuoted_(msg.getPlainBody()).slice(0, 3000);
  const count = list => list.reduce((n, k) => n + (body.includes(k) ? 1 : 0), 0);
  const unsub = count(KW.unsubscribe) > 0;
  const neg = count(KW.negative) + (unsub ? 3 : 0);
  const pos = count(KW.positive) + (body.includes('?') ? 0.5 : 0);
  let sentiment = SENTIMENT.NEU;
  if (unsub || neg > pos) sentiment = SENTIMENT.NEG;
  else if (pos > 0 && pos >= neg) sentiment = SENTIMENT.POS;
  return { sentiment, unsubscribe: unsub, pos, neg };
}

/** Resumable pass over rows with Thread IDs, bounded by budgetMs. */
function checkRepliesInternal_(ctx, budgetMs) {
  const props = PropertiesService.getScriptProperties();
  const end = Math.min(Date.now() + budgetMs, ctx.deadline - 15000);
  let i = Math.max(1, num_(props.getProperty(PROP.REPLY_CURSOR), 1));
  Log.info('REPLY CHECK', { fromRow: i + 1, budgetMs: Math.round(budgetMs) });

  for (; i < ctx.data.length; i++) {
    if (Date.now() > end) { props.setProperty(PROP.REPLY_CURSOR, String(i)); Log.info('Reply check paused; resumes next tick', { atRow: i + 1 }); return; }
    const row = rowObj_(ctx, i);
    if (!row.threads.length || row.step === 0) continue;
    if (TERMINAL.has(row.status) && row.status !== STATUS.COMPLETED) continue; // already classified
    if (row.replyStatus === REPLY.REPLIED || row.replyStatus === REPLY.BOUNCED) continue;
    try { inspectThreads_(ctx, row); }
    catch (e) { Log.error('Reply check failed', e, row.sheetRow, row.recipient); setRow_(ctx, row, { [COL.ERROR]: 'Reply check: ' + errMsg_(e) }); }
  }
  props.deleteProperty(PROP.REPLY_CURSOR);
  props.setProperty(PROP.LAST_REPLY_CHECK, String(Date.now()));
}

function inspectThreads_(ctx, row) {
  let incoming = [];
  for (const id of row.threads) {
    const thread = GmailApp.getThreadById(id);
    if (!thread) { Log.debug('Thread not found', id, row.sheetRow, row.recipient); continue; }
    thread.getMessages().forEach(m => {
      const from = String(m.getFrom() || '').toLowerCase();
      if (m.isFromMe() || from.includes(ctx.me)) return;
      incoming.push(m);
    });
  }
  if (!incoming.length) return;
  incoming.sort((a, b) => a.getDate().getTime() - b.getDate().getTime());

  const bounce = incoming.find(isBounce_);
  if (bounce) {
    setRow_(ctx, row, { [COL.STATUS]: STATUS.BOUNCED, [COL.REPLY_STATUS]: REPLY.BOUNCED, [COL.SENTIMENT]: SENTIMENT.BOUNCE,
      [COL.REPLY_AT]: bounce.getDate(), [COL.NEXT_AT]: '', [COL.VALIDATION]: 'BOUNCED' });
    addToSuppression_(ctx, row.recipient, 'bounce');
    Log.warn('BOUNCE detected', bounce.getSubject(), row.sheetRow, row.recipient); ctx.stats.replies++;
    return;
  }

  const human = incoming.filter(m => !isAutoReply_(m));
  if (!human.length) {
    if (row.replyStatus !== REPLY.OOO) {
      const last = incoming[incoming.length - 1];
      const minNext = new Date(last.getDate().getTime() + num_(ctx.cfg.OOO_DELAY_DAYS, 3) * 86400000);
      const patch = { [COL.REPLY_STATUS]: REPLY.OOO, [COL.SENTIMENT]: SENTIMENT.OOO, [COL.REPLY_AT]: last.getDate() };
      if (row.status === STATUS.SENT && (!row.nextAt || row.nextAt < minNext)) patch[COL.NEXT_AT] = nextWindowSlot_(minNext, ctx.cfg);
      setRow_(ctx, row, patch);
      Log.info('Auto-reply detected; sequence continues later', fmt_(patch[COL.NEXT_AT] || row.nextAt, ctx.cfg.TIMEZONE), row.sheetRow, row.recipient);
    }
    return;
  }

  const latest = human[human.length - 1];
  const cls = classifyReply_(latest);
  let status = STATUS.REPLIED;
  if (cls.unsubscribe) { status = STATUS.UNSUBSCRIBED; addToSuppression_(ctx, row.recipient, 'reply asked to stop'); }
  else if (cls.sentiment === SENTIMENT.NEG) status = STATUS.NOT_INTERESTED;
  else if (cls.sentiment === SENTIMENT.POS) status = STATUS.INTERESTED;
  setRow_(ctx, row, { [COL.STATUS]: status, [COL.REPLY_STATUS]: REPLY.REPLIED, [COL.SENTIMENT]: cls.sentiment,
    [COL.REPLY_AT]: latest.getDate(), [COL.NEXT_AT]: '' });
  Log.info('REPLY classified', { status, pos: cls.pos, neg: cls.neg, unread: latest.isUnread() }, row.sheetRow, row.recipient);
  ctx.stats.replies++;
}

/* ============================================================================
   MENU
   ============================================================================ */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Mail Engine')
    .addItem('⚙️  Setup / Repair Sheets', 'setupSheets')
    .addItem('🧪  Run Deployment Test', 'runDeploymentTest')
    .addSeparator()
    .addItem('👁  Preview Email (active row)', 'previewRow')
    .addItem('✉️  Send Test To Me (active row)', 'sendTestToMe')
    .addItem('✅  Validate Emails (all unvalidated)', 'validateAll')
    .addItem('🗓  Auto-Schedule Group…', 'autoScheduleGroup')
    .addSeparator()
    .addItem('▶️  Run Tick Now', 'tick')
    .addItem('🔁  Check Replies Now', 'checkRepliesNow')
    .addItem('📊  Dashboard', 'showDashboard')
    .addSeparator()
    .addItem('⏸  Pause Sending', 'pauseSending')
    .addItem('▶️  Resume Sending', 'resumeSending')
    .addItem('🛑  EMERGENCY STOP (pause + remove triggers)', 'emergencyStop')
    .addSeparator()
    .addItem('⏱  Install Trigger', 'installTrigger')
    .addItem('🧹  Remove Trigger', 'removeTrigger')
    .addToUi();
}

function ui_() { return SpreadsheetApp.getUi(); }

/* ---------- setup ---------- */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const created = [];

  if (!ss.getSheetByName(DEFAULTS.CONFIG_SHEET)) {
    const s = ss.insertSheet(DEFAULTS.CONFIG_SHEET);
    const rows = [['Key', 'Value', 'Notes']];
    const notes = {
      PAUSED: 'TRUE stops all sending (replies still tracked)', BATCH_SIZE: 'Max sends per tick', MAX_PER_HOUR: 'Rolling 60-min cap',
      MAX_PER_DAY: 'Rolling 24-h cap; stay under Gmail quota', SEND_WINDOW_START: 'HH:mm in TIMEZONE', SEND_WINDOW_END: 'HH:mm',
      SEND_DAYS: 'Mon,Tue,… (blank = every day)', VALIDATE_BEFORE_SEND: 'Syntax + MX + disposable checks', ALLOW_RISKY: 'Send to info@/hr@ style addresses',
      STRICT_VARIABLES: 'Row → ERROR when a {{var}} is empty and has no |fallback', FOLLOW_UP_IN_THREAD: 'Needs Gmail advanced service (Services ▸ Gmail)',
      DRAFT_SUBJECT: 'Only used when Sequence sheet is empty', 'Your Full Name': 'Available as {{Your Full Name}}', 'Sender Name': 'Display name on outgoing mail',
      LOG_LEVEL: 'DEBUG | INFO | WARN | ERROR', TIMEZONE: 'Must match File ▸ Settings ▸ Time zone'
    };
    Object.keys(DEFAULTS).forEach(k => rows.push([k, DEFAULTS[k], notes[k] || '']));
    s.getRange(1, 1, rows.length, 3).setValues(rows);
    s.getRange(1, 1, 1, 3).setFontWeight('bold'); s.setFrozenRows(1); s.autoResizeColumns(1, 3);
    created.push(DEFAULTS.CONFIG_SHEET);
  }
  if (!ss.getSheetByName(DEFAULTS.SEQUENCE_SHEET)) {
    const s = ss.insertSheet(DEFAULTS.SEQUENCE_SHEET);
    s.getRange(1, 1, 4, 6).setValues([
      ['Step', 'Draft Subject', 'Delay Days', 'Delay Hours', 'Active', 'Notes'],
      [1, 'AI Developer Opportunity – {{company}}', 0, 0, 'TRUE', 'First email. Subject must match a Gmail Draft exactly.'],
      [2, 'Follow-up 1', 3, 0, 'TRUE', 'Sent 3 days after step 1 if no reply (in the same thread).'],
      [3, 'Follow-up 2', 4, 0, 'FALSE', 'Set Active=TRUE to enable.']
    ]);
    s.getRange(1, 1, 1, 6).setFontWeight('bold'); s.setFrozenRows(1); s.autoResizeColumns(1, 6);
    created.push(DEFAULTS.SEQUENCE_SHEET);
  }
  if (!ss.getSheetByName(DEFAULTS.SUPPRESSION_SHEET)) { createSuppressionSheet_(ss, DEFAULTS.SUPPRESSION_SHEET); created.push(DEFAULTS.SUPPRESSION_SHEET); }
  if (!ss.getSheetByName(DEFAULTS.LOG_SHEET)) { createLogSheet_(ss, DEFAULTS.LOG_SHEET); created.push(DEFAULTS.LOG_SHEET); }

  let rec = ss.getSheetByName(DEFAULTS.RECIPIENTS_SHEET);
  if (!rec) {
    const candidate = ss.getSheets().find(s => s.getLastColumn() > 0 &&
      s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(h => String(h).trim()).includes(COL.RECIPIENT));
    if (candidate) { candidate.setName(DEFAULTS.RECIPIENTS_SHEET); rec = candidate; }
    else {
      rec = ss.insertSheet(DEFAULTS.RECIPIENTS_SHEET, 0);
      rec.getRange(1, 1, 1, 7).setValues([[COL.RECIPIENT, 'name', 'Role', 'skills', 'experience', 'company', COL.SCHEDULED]]);
      created.push(DEFAULTS.RECIPIENTS_SHEET);
    }
  }
  const cfg = loadConfig_(ss); Log.init(cfg, 'setup');
  ensureColumns_(rec);
  rec.getRange(1, 1, 1, rec.getLastColumn()).setFontWeight('bold'); rec.setFrozenRows(1);
  Log.flush(ss, cfg);
  ui_().alert('Setup complete.' + (created.length ? '\n\nCreated: ' + created.join(', ') : '\n\nAll sheets already existed; tracking columns verified.') +
    '\n\nNext: fill Config (Your Full Name…), create Gmail Drafts matching the Sequence subjects, add recipients, then Install Trigger.');
}

/* ---------- deployment test (no email is sent) ---------- */
function runDeploymentTest() {
  const report = [];
  const ok = (label, v) => report.push('✔ ' + label + (v !== undefined ? ': ' + v : ''));
  const warn = label => report.push('⚠ ' + label);
  try {
    const ctx = buildContext_();
    ok('User', ctx.me);
    ok('Spreadsheet', ctx.ss.getName());
    const tz = ctx.ss.getSpreadsheetTimeZone();
    if (tz !== ctx.cfg.TIMEZONE) warn(`Spreadsheet timezone ${tz} ≠ Config TIMEZONE ${ctx.cfg.TIMEZONE}`); else ok('Timezone', tz);
    if (Session.getScriptTimeZone() !== ctx.cfg.TIMEZONE) warn(`Script timezone ${Session.getScriptTimeZone()} ≠ ${ctx.cfg.TIMEZONE} (Project Settings ▸ Time zone)`);
    ok('Recipients sheet', `${ctx.sheet.getName()} (${ctx.data.length - 1} rows)`);
    ok('Sequence steps', ctx.sequence.map(s => `${s.step}:"${s.subject}"`).join(' → '));
    const drafts = loadDrafts_(ctx);
    ctx.sequence.forEach(s => drafts[s.subject] ? ok('Draft found', s.subject) : warn('Draft MISSING: ' + s.subject));
    ok('Gmail quota remaining today', MailApp.getRemainingDailyQuota());
    ok('Gmail advanced service', gmailApiAvailable_() ? 'enabled (in-thread follow-ups on)' : 'not enabled (follow-ups go as new emails)');
    ok('MX lookup test (gmail.com)', String(hasMx_('gmail.com')));
    const trig = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'tick').length;
    trig ? ok('Trigger installed', trig) : warn('No trigger installed — use Mail Engine ▸ Install Trigger');
    if (bool_(ctx.cfg.PAUSED)) warn('PAUSED = TRUE in Config');
    ok('Send window now', inSendWindow_(new Date(), ctx.cfg) ? 'OPEN' : 'CLOSED');
    let due = 0, invalid = 0;
    for (let i = 1; i < ctx.data.length; i++) {
      const r = rowObj_(ctx, i); if (!r.recipient || r.step > 0 || TERMINAL.has(r.status)) continue;
      const d = parseScheduledDate_(r.scheduledRaw); if (r.scheduledRaw && !d) invalid++; else if (d && d <= new Date()) due++;
    }
    ok('First emails due now', due); if (invalid) warn(invalid + ' row(s) have an unparseable Scheduled Date');
    Log.info('Deployment test', report); Log.flush(ctx.ss, ctx.cfg);
    ui_().alert('DEPLOYMENT TEST\n\n' + report.join('\n'));
  } catch (e) {
    ui_().alert('DEPLOYMENT TEST FAILED\n\n' + errMsg_(e) + '\n\n' + report.join('\n'));
    throw e;
  }
}

/* ---------- preview / test ---------- */
function activeRow_(ctx) {
  const r = ctx.sheet.getActiveRange();
  const idx = r ? r.getRow() - 1 : 0;
  if (idx < 1 || idx >= ctx.data.length) throw new Error('Select a recipient row first.');
  return rowObj_(ctx, idx);
}

function previewRow() {
  const ctx = buildContext_({ skipSuppression: true });
  const row = activeRow_(ctx);
  const stepDef = ctx.sequence.find(s => s.step === row.step + 1) || ctx.sequence[0];
  const tpl = loadDrafts_(ctx)[stepDef.subject];
  if (!tpl) throw new Error('Draft not found: ' + stepDef.subject);
  const saveStrict = ctx.cfg.STRICT_VARIABLES; ctx.cfg.STRICT_VARIABLES = 'FALSE';
  const msg = personalise_(ctx, tpl, row); ctx.cfg.STRICT_VARIABLES = saveStrict;
  const vars = buildVars_(ctx, row);
  const missing = render_(tpl.subject + tpl.html, vars, ctx.cfg.TIMEZONE, false).missing;
  const v = validateEmail_(row.recipient, ctx.cfg);
  const html = `<div style="font:13px/1.4 Arial">
    <p><b>To:</b> ${escapeHtml_(row.recipient)} &nbsp; <b>Validation:</b> ${v.code}${v.ok ? '' : ' ✖'} &nbsp; <b>Step:</b> ${stepDef.step}</p>
    <p><b>Subject:</b> ${escapeHtml_(msg.subject)}</p>
    ${missing.length ? '<p style="color:#b00"><b>Missing variables:</b> ' + escapeHtml_(missing.join(', ')) + '</p>' : ''}
    <hr><div style="border:1px solid #ddd;padding:12px">${msg.html}</div></div>`;
  ui_().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(760).setHeight(600), 'Preview — row ' + row.sheetRow);
}

function sendTestToMe() {
  const ctx = buildContext_({ skipSuppression: true });
  const row = activeRow_(ctx);
  const stepDef = ctx.sequence.find(s => s.step === row.step + 1) || ctx.sequence[0];
  const tpl = loadDrafts_(ctx)[stepDef.subject];
  if (!tpl) throw new Error('Draft not found: ' + stepDef.subject);
  const msg = personalise_(ctx, tpl, row);
  GmailApp.sendEmail(ctx.me, '[TEST row ' + row.sheetRow + '] ' + msg.subject, msg.text, sendOptions_(ctx, msg));
  Log.info('Test email sent to self', msg.subject, row.sheetRow, row.recipient); Log.flush(ctx.ss, ctx.cfg);
  ui_().alert('Test email sent to ' + ctx.me + ' (sheet untouched).');
}

function validateAll() {
  const ctx = buildContext_({ skipSequence: true, skipSuppression: true });
  let n = 0, bad = 0;
  for (let i = 1; i < ctx.data.length && !outOfTime_(ctx); i++) {
    const row = rowObj_(ctx, i);
    if (!row.recipient || row.validation) continue;
    const v = validateEmail_(row.recipient, ctx.cfg);
    const patch = { [COL.VALIDATION]: v.code };
    if (!v.ok && row.step === 0) { patch[COL.STATUS] = STATUS.INVALID; patch[COL.ERROR] = 'Validation failed: ' + v.code; bad++; }
    setRow_(ctx, row, patch); n++;
  }
  Log.info('Bulk validation', { checked: n, invalid: bad }); Log.flush(ctx.ss, ctx.cfg);
  ui_().alert(`Validated ${n} address(es); ${bad} marked INVALID.` + (outOfTime_(ctx) ? '\nTime limit hit — run again to continue.' : ''));
}

/* ---------- auto-schedule ---------- */
function autoScheduleGroup() {
  const ctx = buildContext_({ skipSequence: true, skipSuppression: true });
  const res = ui_().prompt('Auto-Schedule',
    'Enter:  Group , Start (yyyy-MM-dd HH:mm) , Spacing minutes\n' +
    'Blank parts use defaults: all unscheduled rows / next open slot / ' + ctx.cfg.DEFAULT_SPACING_MINUTES + ' min.\n' +
    'Example:  JobHunt, 2026-09-15 09:30, 3', ui_().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui_().Button.OK) return;
  const parts = res.getResponseText().split(',').map(s => s.trim());
  const group = (parts[0] || '').toLowerCase();
  let cursor = parts[1] ? parseScheduledDate_(parts[1]) : new Date();
  if (!cursor) throw new Error('Unparseable start time: ' + parts[1]);
  const spacingMin = Math.max(num_(parts[2], num_(ctx.cfg.DEFAULT_SPACING_MINUTES, 3)), 60 / num_(ctx.cfg.MAX_PER_HOUR, 40));
  const jitter = num_(ctx.cfg.SCHEDULE_JITTER_SECONDS, 0) * 1000;
  const perDayCap = num_(ctx.cfg.MAX_PER_DAY, 300);
  const perDay = {};
  let n = 0;
  for (let i = 1; i < ctx.data.length; i++) {
    const row = rowObj_(ctx, i);
    if (!row.recipient || row.step > 0 || row.scheduledRaw || TERMINAL.has(row.status) || row.status === STATUS.SKIP) continue;
    if (group && String(row.get(COL.GROUP) || '').trim().toLowerCase() !== group) continue;
    cursor = nextWindowSlot_(cursor, ctx.cfg);
    let day = fmt_(cursor, ctx.cfg.TIMEZONE, 'yyyy-MM-dd');
    while ((perDay[day] || 0) >= perDayCap) {
      cursor = nextWindowSlot_(new Date(cursor.getTime() + 86400000 - ((hm_(fmt_(cursor, ctx.cfg.TIMEZONE, 'HH:mm')) || 0) - (hm_(ctx.cfg.SEND_WINDOW_START) || 0)) * 60000), ctx.cfg);
      day = fmt_(cursor, ctx.cfg.TIMEZONE, 'yyyy-MM-dd');
    }
    const at = new Date(cursor.getTime() + Math.round((Math.random() - 0.5) * 2 * jitter));
    setRow_(ctx, row, { [COL.SCHEDULED]: at, [COL.STATUS]: STATUS.SCHEDULED });
    perDay[day] = (perDay[day] || 0) + 1; n++;
    cursor = new Date(cursor.getTime() + spacingMin * 60000);
  }
  ctx.sheet.getRange(2, ctx.cols[COL.SCHEDULED] + 1, Math.max(ctx.data.length - 1, 1), 1).setNumberFormat('yyyy-mm-dd hh:mm');
  Log.info('Auto-scheduled', { group: group || '(all)', rows: n, spacingMin, lastAt: fmt_(cursor, ctx.cfg.TIMEZONE) }); Log.flush(ctx.ss, ctx.cfg);
  ui_().alert(`Scheduled ${n} row(s)${group ? ' in group "' + parts[0] + '"' : ''}.\nLast send ≈ ${fmt_(cursor, ctx.cfg.TIMEZONE)}`);
}

/* ---------- dashboard / replies / control ---------- */
function showDashboard() {
  const ctx = buildContext_({ skipSequence: true, skipSuppression: true });
  const counts = {};
  for (let i = 1; i < ctx.data.length; i++) { const r = rowObj_(ctx, i); if (r.recipient) counts[r.status || 'NEW'] = (counts[r.status || 'NEW'] || 0) + 1; }
  const hist = sendHistory_();
  const lines = Object.keys(counts).sort().map(k => `${k.padEnd(16)} ${counts[k]}`);
  ui_().alert('DASHBOARD\n\n' + lines.join('\n') +
    `\n\nSent last hour: ${hist.lastHour}/${ctx.cfg.MAX_PER_HOUR}   last 24h: ${hist.lastDay}/${ctx.cfg.MAX_PER_DAY}` +
    `\nGmail quota left today: ${MailApp.getRemainingDailyQuota()}` +
    `\nPaused: ${bool_(ctx.cfg.PAUSED)}   Window now: ${inSendWindow_(new Date(), ctx.cfg) ? 'OPEN' : 'CLOSED'}` +
    `\nSuppression list: ${loadSuppression_(ctx.ss, ctx.cfg).size}`);
}

function checkRepliesNow() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { ui_().alert('Busy — a tick is running. Try again in a minute.'); return; }
  let ctx;
  try {
    ctx = buildContext_();
    PropertiesService.getScriptProperties().deleteProperty(PROP.REPLY_CURSOR);
    checkRepliesInternal_(ctx, timeLeft_(ctx) - 20000);
    ui_().alert(`Reply check done. New classifications: ${ctx.stats.replies}`);
  } finally { if (ctx) Log.flush(ctx.ss, ctx.cfg); lock.releaseLock(); }
}

function setConfig_(key, value) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s = ss.getSheetByName(DEFAULTS.CONFIG_SHEET) || (setupSheets(), ss.getSheetByName(DEFAULTS.CONFIG_SHEET));
  const keys = s.getRange(1, 1, s.getLastRow(), 1).getValues().map(r => String(r[0]).trim());
  const idx = keys.indexOf(key);
  if (idx >= 0) s.getRange(idx + 1, 2).setValue(value); else s.appendRow([key, value, '']);
  SpreadsheetApp.flush();
}
function pauseSending() { setConfig_('PAUSED', 'TRUE'); ui_().alert('Sending PAUSED. Replies are still tracked. Resume from the menu.'); }
function resumeSending() { setConfig_('PAUSED', 'FALSE'); ui_().alert('Sending RESUMED.'); }
function emergencyStop() { setConfig_('PAUSED', 'TRUE'); const n = removeTrigger_(); ui_().alert(`EMERGENCY STOP\n\nPAUSED = TRUE and ${n} trigger(s) removed. Nothing will run until you Install Trigger and Resume.`); }

function installTrigger() {
  removeTrigger_();
  const cfg = loadConfig_(SpreadsheetApp.getActiveSpreadsheet());
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(Math.max(1, num_(cfg.TICK_MINUTES, 1))).create();
  ui_().alert(`Trigger installed: tick() every ${cfg.TICK_MINUTES} min.\nReplies checked every ${cfg.REPLY_CHECK_MINUTES} min inside the same tick.\nOpen the Logs sheet to watch it work.`);
}
function removeTrigger() { const n = removeTrigger_(); ui_().alert(n + ' trigger(s) removed.'); }
function removeTrigger_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['tick', 'processScheduledEmails', 'checkReplies'].includes(t.getHandlerFunction())) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

/* Backwards-compatible aliases for old triggers/menus. */
function processScheduledEmails() { tick(); }
function checkReplies() { checkRepliesNow(); }
