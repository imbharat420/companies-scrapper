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
  MAX_LOG_ROWS: 5000,

  // Replies & responses
  RESPONSES_SHEET: 'Responses',
  AUTO_RESPOND_POSITIVE: 'FALSE',    // TRUE = auto-create a reply from Responses when a POSITIVE reply lands
  AUTO_RESPOND_MODE: 'DRAFT',        // DRAFT (you review in Gmail) | SEND
  TEST_MODE_SELF_REPLIES: 'FALSE',   // TRUE = replies you write yourself inside a thread count as replies (testing with your own +tag addresses)

  // Panel ▸ Schedule defaults
  SCHEDULE_BATCH_SIZE: 10,           // emails per batch before a longer pause
  SCHEDULE_BATCH_PAUSE_MINUTES: 30
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
  RESPONSE: 'Response',
  ERROR: 'Error'
};
const REQUIRED_COLS = [COL.RECIPIENT, COL.SCHEDULED];
const TRACKING_COLS = [COL.GROUP, COL.STATUS, COL.STEP, COL.SENT_AT, COL.NEXT_AT, COL.THREAD,
  COL.REPLY_STATUS, COL.REPLY_AT, COL.SENTIMENT, COL.VALIDATION, COL.RESPONSE, COL.UPDATED, COL.ERROR];

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
  SKIP: 'SKIP',            // user-set: never send
  MANUAL: 'MANUAL'         // you handle this thread by hand; replies still tracked, no auto follow-ups
};
const TERMINAL = new Set([STATUS.COMPLETED, STATUS.REPLIED, STATUS.INTERESTED, STATUS.NOT_INTERESTED,
  STATUS.UNSUBSCRIBED, STATUS.BOUNCED, STATUS.INVALID, STATUS.SKIP]);

const REPLY = { WAITING: 'WAITING', REPLIED: 'REPLIED', OOO: 'AUTO_REPLY', BOUNCED: 'BOUNCED' };
const SENTIMENT = { POS: 'POSITIVE', NEG: 'NEGATIVE', NEU: 'NEUTRAL', OOO: 'AUTO_REPLY', BOUNCE: 'BOUNCE' };

const PROP = { LAST_REPLY_CHECK: 'LAST_REPLY_CHECK', REPLY_CURSOR: 'REPLY_CURSOR', SEND_HISTORY: 'SEND_HISTORY', LAST_TICK: 'LAST_TICK', LAST_TICK_STATS: 'LAST_TICK_STATS' };

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
    aliases: myAddresses_(),
    responses: opts.skipSequence ? [] : loadResponses_(ss, cfg),
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
      if (!key) return;
      if (v instanceof Date) {           // Sheets auto-converts "09:00" → time, "2026-01-01" → date
        const tz = Session.getScriptTimeZone();
        v = v.getFullYear() < 1901 ? Utilities.formatDate(v, tz, 'HH:mm') : Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm');
      }
      cfg[key] = String(v === null || v === undefined ? '' : v).trim();
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

function rateLimitReason_(ctx, hist, ignoreWindow) {
  if (bool_(ctx.cfg.PAUSED)) return 'PAUSED (Config)';
  if (!ignoreWindow && !inSendWindow_(new Date(), ctx.cfg)) return 'outside send window';
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
  const wanted = new Set(ctx.sequence.map(s => s.subject).concat((ctx.responses || []).map(r => r.subject)));
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

/** Builds a base64url MIME reply (text + HTML) that Gmail threads under `thread`. */
function buildReplyMime_(ctx, thread, recipient, msg) {
  const msgs = thread.getMessages();
  const firstId = msgs[0].getHeader('Message-ID') || '';
  const lastId = msgs[msgs.length - 1].getHeader('Message-ID') || firstId;
  let subject = thread.getFirstMessageSubject() || msg.subject;
  if (!/^re:/i.test(subject)) subject = 'Re: ' + subject;
  const from = ctx.cfg['Sender Name'] ? `${encHeader_(ctx.cfg['Sender Name'])} <${ctx.me}>` : ctx.me;
  const boundary = 'b_' + Utilities.getUuid().replace(/-/g, '');
  const b64 = str => Utilities.base64Encode(str, Utilities.Charset.UTF_8).replace(/(.{76})/g, '$1\r\n');
  const headers = [
    `From: ${from}`, `To: ${recipient}`, `Subject: ${encHeader_(subject)}`,
    lastId ? `In-Reply-To: ${lastId}` : '', firstId ? `References: ${[...new Set([firstId, lastId])].join(' ')}` : '',
    ctx.cfg['Reply To'] ? `Reply-To: ${ctx.cfg['Reply To']}` : '',
    'X-Mail-Engine: 1', 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`
  ].filter(Boolean).join('\r\n');
  const mime = headers + '\r\n\r\n' +
    `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(msg.text)}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(msg.html)}\r\n` +
    `--${boundary}--`;
  return { raw: Utilities.base64EncodeWebSafe(mime, Utilities.Charset.UTF_8), subject };
}

/** Sends a follow-up inside an existing thread via the Gmail advanced service. Returns threadId. */
function sendInThread_(ctx, thread, recipient, msg) {
  const { raw } = buildReplyMime_(ctx, thread, recipient, msg);
  const res = Gmail.Users.Messages.send({ raw, threadId: thread.getId() }, 'me');
  return res.threadId || thread.getId();
}

/** Creates a Gmail draft reply in the thread (API) or a stand-alone draft (fallback). Returns 'in-thread' | 'new'. */
function createThreadDraft_(ctx, thread, recipient, msg) {
  if (thread && gmailApiAvailable_()) {
    const { raw } = buildReplyMime_(ctx, thread, recipient, msg);
    Gmail.Users.Drafts.create({ message: { raw, threadId: thread.getId() } }, 'me');
    return 'in-thread';
  }
  const subject = thread ? 'Re: ' + String(thread.getFirstMessageSubject()).replace(/^re:\s*/i, '') : msg.subject;
  GmailApp.createDraft(recipient, subject, msg.text, sendOptions_(ctx, msg));
  return 'new';
}

/** "Is this message from me?" — GmailMessage has no isFromMe(); compare against my address + aliases. */
function myAddresses_() {
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  let aliases = [];
  try { aliases = GmailApp.getAliases().map(a => String(a).toLowerCase()); } catch (e) { /* ignore */ }
  return [me].concat(aliases).filter(Boolean);
}
function isMine_(ctx, m, idx) {
  const from = String(m.getFrom() || '').toLowerCase();
  const mine = ctx.aliases.some(a => from.includes(a));
  if (!mine) return false;
  // Test mode: a message I typed by hand inside the thread (no X-Mail-Engine header) counts as a reply.
  if (idx > 0 && bool_(ctx.cfg.TEST_MODE_SELF_REPLIES)) {
    let tag = ''; try { tag = m.getHeader('X-Mail-Engine') || ''; } catch (e) { /* ignore */ }
    if (!tag) return false;
  }
  return true;
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
    PropertiesService.getScriptProperties().setProperties({ [PROP.LAST_TICK]: String(Date.now()), [PROP.LAST_TICK_STATS]: safeJson_(ctx.stats) });
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
        row.status === STATUS.SENDING || row.status === STATUS.ERROR || row.status === STATUS.MANUAL) continue;

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
    try {
      inspectThreads_(ctx, row);
      const err = String(row.get(COL.ERROR) || '');
      if (/^Reply check/i.test(err)) setRow_(ctx, row, { [COL.ERROR]: '' });   // clear errors left by an older version
    }
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
    thread.getMessages().forEach((m, idx) => {
      if (isMine_(ctx, m, idx)) return;
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
  if (status === STATUS.INTERESTED && bool_(ctx.cfg.AUTO_RESPOND_POSITIVE)) {
    try { respond_(ctx, row, null, String(ctx.cfg.AUTO_RESPOND_MODE).toUpperCase() === 'SEND'); }
    catch (e) { Log.error('Auto-respond failed', e, row.sheetRow, row.recipient); }
  }
  ctx.stats.replies++;
}

/* ============================================================================
   MENU
   ============================================================================ */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Mail Engine')
    .addItem('🚀  Open Panel (dashboard · schedule · send · replies)', 'openPanel')
    .addSeparator()
    .addItem('⚙️  Setup / Repair Sheets', 'setupSheets')
    .addItem('🧪  Run Deployment Test', 'runDeploymentTest')
    .addSeparator()
    .addItem('👁  Preview Email (active row)', 'previewRow')
    .addItem('✉️  Send Test To Me (active row)', 'sendTestToMe')
    .addItem('✅  Validate Emails (all unvalidated)', 'validateAll')
    .addItem('🗓  Schedule…', 'openPanelSchedule')
    .addItem('⚡  Force Send Now…', 'openPanelSend')
    .addItem('💬  Replies & Follow-ups…', 'openPanelReplies')
    .addSeparator()
    .addItem('▶️  Run Tick Now', 'tick')
    .addItem('🔁  Check Replies Now', 'checkRepliesNow')
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
  if (!ss.getSheetByName(DEFAULTS.RESPONSES_SHEET)) { createResponsesSheet_(ss, DEFAULTS.RESPONSES_SHEET); created.push(DEFAULTS.RESPONSES_SHEET); }

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
  repairConfigSheet_(ss);
  const cfg = loadConfig_(ss); Log.init(cfg, 'setup');
  ensureColumns_(rec);
  rec.getRange(1, 1, 1, rec.getLastColumn()).setFontWeight('bold'); rec.setFrozenRows(1);
  Log.flush(ss, cfg);
  ui_().alert('Setup complete.' + (created.length ? '\n\nCreated: ' + created.join(', ') : '\n\nAll sheets already existed; tracking columns verified.') +
    '\n\nNext: fill Config (Your Full Name…), create Gmail Drafts matching the Sequence subjects, add recipients, then Install Trigger.');
}

/* ---------- deployment test (no email is sent) ---------- */
function runDeploymentTest() {
  const r = deploymentReport_();
  ui_().alert((r.ok ? 'DEPLOYMENT TEST\n\n' : 'DEPLOYMENT TEST FAILED\n\n') + r.lines.join('\n'));
}

function deploymentReport_() {
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
    return { ok: !report.some(l => l.startsWith('⚠')), lines: report };
  } catch (e) {
    report.push('✖ ' + errMsg_(e));
    return { ok: false, lines: report };
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

/* ---------- dashboard / replies / control ---------- */
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

/* ============================================================================
   RESPONSES  (reply templates: thanks / acknowledge / graceful close)
   ============================================================================ */
function loadResponses_(ss, cfg) {
  const sheet = ss.getSheetByName(cfg.RESPONSES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues()
    .filter(r => String(r[0] || '').trim() && String(r[1] || '').trim())
    .map(r => ({ key: String(r[0]).trim().toUpperCase(), subject: String(r[1]).trim(), sentiment: String(r[2] || '').trim().toUpperCase() }));
}

function createResponsesSheet_(ss, name) {
  const sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 4, 4).setValues([
    ['Key', 'Draft Subject', 'For Sentiment', 'Notes'],
    ['THANKS_POSITIVE', 'Thank you – next steps', 'POSITIVE', 'Used when a reply is classified INTERESTED. Create a Gmail Draft with this exact subject.'],
    ['ACK_NEUTRAL', 'Thanks for getting back to me', 'NEUTRAL', 'Acknowledge and promise details shortly.'],
    ['CLOSE_NEGATIVE', 'Thank you for letting me know', 'NEGATIVE', 'Graceful close; keeps the door open.']
  ]);
  sheet.getRange(1, 1, 1, 4).setFontWeight('bold'); sheet.setFrozenRows(1); sheet.autoResizeColumns(1, 4);
  return sheet;
}

function pickResponse_(ctx, row, key) {
  if (key) return ctx.responses.find(r => r.key === String(key).toUpperCase()) || null;
  const sentiment = String(row.get(COL.SENTIMENT) || '').toUpperCase() || 'NEUTRAL';
  return ctx.responses.find(r => r.sentiment === sentiment) || ctx.responses.find(r => r.sentiment === 'NEUTRAL') || ctx.responses[0] || null;
}

/** Draft (default) or send a response template into the recipient's thread. */
function respond_(ctx, row, key, sendNow) {
  const tplDef = pickResponse_(ctx, row, key);
  if (!tplDef) throw new Error('No response template. Fill the Responses sheet and create matching Gmail Drafts.');
  const tpl = loadDrafts_(ctx)[tplDef.subject];
  if (!tpl) throw new Error(`Gmail Draft not found: "${tplDef.subject}"`);
  const msg = personalise_(ctx, tpl, row);
  const thread = row.threads.length ? GmailApp.getThreadById(row.threads[row.threads.length - 1]) : null;
  let how;
  if (sendNow) {
    if (thread && gmailApiAvailable_()) { sendInThread_(ctx, thread, row.recipient, msg); how = 'SENT'; }
    else { GmailApp.sendEmail(row.recipient, (thread ? 'Re: ' : '') + msg.subject, msg.text, sendOptions_(ctx, msg)); how = 'SENT (new thread)'; }
  } else {
    how = createThreadDraft_(ctx, thread, row.recipient, msg) === 'in-thread' ? 'DRAFT' : 'DRAFT (new thread)';
  }
  const note = `${how} ${tplDef.key} ${fmt_(new Date(), ctx.cfg.TIMEZONE)}`;
  setRow_(ctx, row, { [COL.RESPONSE]: note, [COL.NEXT_AT]: '' });
  Log.info('Response ' + how, tplDef.key, row.sheetRow, row.recipient);
  return note;
}

/** Draft the next Sequence step in the thread for manual editing; row becomes MANUAL (no auto follow-ups). */
function draftFollowUp_(ctx, row) {
  const next = ctx.sequence.find(st => st.step === row.step + 1);
  if (!next) throw new Error('No further Sequence step to draft.');
  const tpl = loadDrafts_(ctx)[next.subject];
  if (!tpl) throw new Error(`Gmail Draft not found: "${next.subject}"`);
  const msg = personalise_(ctx, tpl, row);
  const thread = row.threads.length ? GmailApp.getThreadById(row.threads[row.threads.length - 1]) : null;
  const how = createThreadDraft_(ctx, thread, row.recipient, msg);
  const note = `FOLLOW-UP DRAFT step ${next.step} (${how}) ${fmt_(new Date(), ctx.cfg.TIMEZONE)}`;
  setRow_(ctx, row, { [COL.STATUS]: STATUS.MANUAL, [COL.NEXT_AT]: '', [COL.RESPONSE]: note });
  Log.info('Follow-up drafted for manual send', next.subject, row.sheetRow, row.recipient);
  return note;
}

/* ============================================================================
   SCHEDULING ENGINE  (used by the Panel)
   ============================================================================ */
/** scope: {type:'selected'|'group'|'all'|'unscheduled', group} → array of data indexes. */
function resolveScope_(ctx, scope) {
  scope = scope || { type: 'unscheduled' };
  const idxs = [];
  if (scope.type === 'rows') {
    return [...new Set((scope.rows || []).map(Number))].filter(k => k >= 2 && k <= ctx.data.length).sort((a, b) => a - b).map(k => k - 1);
  }
  if (scope.type === 'selected') {
    const rl = ctx.sheet.getActiveRangeList();
    const ranges = rl ? rl.getRanges() : [];
    if (!ranges.length) throw new Error('Select one or more recipient rows first, then reopen the panel.');
    const set = new Set();
    ranges.forEach(r => { for (let k = r.getRow(); k < r.getRow() + r.getNumRows(); k++) if (k >= 2 && k <= ctx.data.length) set.add(k - 1); });
    return [...set].sort((a, b) => a - b);
  }
  const g = String(scope.group || '').trim().toLowerCase();
  for (let i = 1; i < ctx.data.length; i++) {
    const row = rowObj_(ctx, i);
    if (!row.recipient) continue;
    if (scope.type === 'group' && String(row.get(COL.GROUP) || '').trim().toLowerCase() !== g) continue;
    if (scope.type === 'unscheduled' && row.scheduledRaw) continue;
    idxs.push(i);
  }
  return idxs;
}

/** Turns a preset into a start Date (server side, so the script timezone is used). */
function resolveStart_(ctx, start) {
  start = start || { preset: 'now' };
  const now = new Date();
  const at = (d, hhmm) => { const [h, m] = String(hhmm || ctx.cfg.SEND_WINDOW_START || '09:00').split(':').map(Number); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0); };
  const plusDays = n => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, now.getHours(), now.getMinutes(), 0, 0);
  switch (start.preset) {
    case 'now': return new Date(now.getTime() + 60000);
    case 'in_1h': return new Date(now.getTime() + 3600000);
    case 'in_3h': return new Date(now.getTime() + 3 * 3600000);
    case 'tomorrow_same': return plusDays(1);
    case 'tomorrow_window': return at(plusDays(1), ctx.cfg.SEND_WINDOW_START);
    case 'next_monday': { const d = plusDays(((8 - now.getDay()) % 7) || 7); return at(d, ctx.cfg.SEND_WINDOW_START); }
    case 'next_week_same': return plusDays(7);
    case 'custom': {
      const d = parseScheduledDate_(start.value);
      if (!d) throw new Error('Unparseable start time: ' + start.value);
      return d;
    }
    default: return new Date(now.getTime() + 60000);
  }
}

/**
 * Assigns Scheduled Date to rows. opts: {gapMin, batchSize, batchPauseMin, perDayCap, respectWindow, overwrite, dryRun}
 * Returns {count, first, last, skipped, days}.
 */
function scheduleRows_(ctx, idxs, startDate, opts) {
  const o = Object.assign({ gapMin: num_(ctx.cfg.DEFAULT_SPACING_MINUTES, 3), batchSize: 0, batchPauseMin: 0, perDayCap: num_(ctx.cfg.MAX_PER_DAY, 300),
    respectWindow: true, overwrite: false, dryRun: false }, opts || {});
  o.gapMin = Math.max(num_(o.gapMin, 1), 60 / num_(ctx.cfg.MAX_PER_HOUR, 40));
  const jitter = num_(ctx.cfg.SCHEDULE_JITTER_SECONDS, 0) * 1000;
  const dayKey = d => fmt_(d, ctx.cfg.TIMEZONE, 'yyyy-MM-dd');
  const nextDayStart = d => { const [h, m] = String(ctx.cfg.SEND_WINDOW_START || '00:00').split(':').map(Number); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h || 0, m || 0, 0, 0); };
  let cursor = new Date(startDate.getTime());
  const perDay = {}; let inBatch = 0; let skipped = 0; const out = [];
  idxs.forEach(i => {
    const row = rowObj_(ctx, i);
    if (!row.recipient || row.step > 0 || TERMINAL.has(row.status) || row.status === STATUS.SENDING || row.status === STATUS.MANUAL) { skipped++; return; }
    if (row.scheduledRaw && !o.overwrite) { skipped++; return; }
    if (o.respectWindow) cursor = nextWindowSlot_(cursor, ctx.cfg);
    let day = dayKey(cursor); let guard = 0;
    while (o.perDayCap > 0 && (perDay[day] || 0) >= o.perDayCap && guard++ < 60) {
      cursor = nextDayStart(cursor); if (o.respectWindow) cursor = nextWindowSlot_(cursor, ctx.cfg); day = dayKey(cursor); inBatch = 0;
    }
    const at = new Date(cursor.getTime() + Math.round((Math.random() - 0.5) * 2 * jitter));
    out.push({ row, at: at < startDate ? startDate : at });
    perDay[day] = (perDay[day] || 0) + 1; inBatch++;
    if (o.batchSize > 0 && inBatch >= o.batchSize) { cursor = new Date(cursor.getTime() + Math.max(o.batchPauseMin, o.gapMin) * 60000); inBatch = 0; }
    else cursor = new Date(cursor.getTime() + o.gapMin * 60000);
  });
  if (!o.dryRun && out.length) {
    const n = ctx.data.length - 1;
    const schedCol = ctx.data.slice(1).map(r => [r[ctx.cols[COL.SCHEDULED]]]);
    const statusCol = ctx.data.slice(1).map(r => [r[ctx.cols[COL.STATUS]]]);
    const updCol = ctx.data.slice(1).map(r => [r[ctx.cols[COL.UPDATED]]]);
    const now = new Date();
    out.forEach(({ row, at }) => { schedCol[row.i - 1][0] = at; statusCol[row.i - 1][0] = STATUS.SCHEDULED; updCol[row.i - 1][0] = now; });
    ctx.sheet.getRange(2, ctx.cols[COL.SCHEDULED] + 1, n, 1).setValues(schedCol).setNumberFormat('yyyy-mm-dd hh:mm');
    ctx.sheet.getRange(2, ctx.cols[COL.STATUS] + 1, n, 1).setValues(statusCol);
    ctx.sheet.getRange(2, ctx.cols[COL.UPDATED] + 1, n, 1).setValues(updCol).setNumberFormat('yyyy-mm-dd hh:mm');
    SpreadsheetApp.flush();
    Log.info('Scheduled rows', { count: out.length, first: fmt_(out[0].at, ctx.cfg.TIMEZONE), last: fmt_(out[out.length - 1].at, ctx.cfg.TIMEZONE), opts: o });
  }
  return {
    count: out.length, skipped,
    first: out.length ? fmt_(out[0].at, ctx.cfg.TIMEZONE, 'EEE dd MMM HH:mm') : '',
    last: out.length ? fmt_(out[out.length - 1].at, ctx.cfg.TIMEZONE, 'EEE dd MMM HH:mm') : '',
    days: Object.keys(perDay).sort().map(d => `${d}: ${perDay[d]}`)
  };
}

/** Sends rows immediately, ignoring Scheduled Date. Remaining rows (time budget) are queued for the next tick. */
function forceSend_(ctx, idxs, opts) {
  const o = Object.assign({ ignoreWindow: true, includeFollowUps: true }, opts || {});
  const hist = sendHistory_();
  const res = { sent: 0, followUps: 0, queued: 0, skipped: 0, errors: 0, blocked: '' };
  const jobs = [];
  idxs.forEach(i => {
    const row = rowObj_(ctx, i);
    if (!row.recipient || TERMINAL.has(row.status) || [STATUS.SENDING, STATUS.PAUSE, STATUS.MANUAL].includes(row.status)) { res.skipped++; return; }
    if (row.step === 0) jobs.push({ row, stepDef: ctx.sequence[0] });
    else if (o.includeFollowUps && row.status === STATUS.SENT && ![REPLY.REPLIED, REPLY.BOUNCED].includes(row.replyStatus)) {
      const next = ctx.sequence.find(st => st.step === row.step + 1);
      if (next) jobs.push({ row, stepDef: next }); else res.skipped++;
    } else res.skipped++;
  });
  for (const job of jobs) {
    const limit = rateLimitReason_(ctx, hist, o.ignoreWindow);
    if (limit) { res.blocked = limit; }
    if (limit || outOfTime_(ctx, 25000)) {
      // queue for the trigger: due immediately
      if (job.row.step === 0) setRow_(ctx, job.row, { [COL.SCHEDULED]: new Date(), [COL.STATUS]: STATUS.SCHEDULED });
      else setRow_(ctx, job.row, { [COL.NEXT_AT]: new Date() });
      res.queued++; continue;
    }
    try { if (sendStep_(ctx, job.row, job.stepDef, hist)) { if (job.stepDef.step === 1) res.sent++; else res.followUps++; } else res.skipped++; }
    catch (e) { res.errors++; setRow_(ctx, job.row, { [COL.STATUS]: STATUS.ERROR, [COL.ERROR]: errMsg_(e) }, true); Log.error('FORCE SEND FAILED', e, job.row.sheetRow, job.row.recipient); }
  }
  Log.info('Force send finished', res);
  return res;
}

/* ============================================================================
   PANEL  (HtmlService dialog: dashboard · schedule · send now · replies)
   ============================================================================ */
function openPanel(tab) {
  const t = HtmlService.createTemplateFromFile('Panel');
  t.tab = typeof tab === 'string' ? tab : 'dashboard';
  t.mode = 'dialog';
  ui_().showModalDialog(t.evaluate().setWidth(1400).setHeight(860), 'Mail Engine');
}
function openPanelSchedule() { openPanel('schedule'); }
function openPanelSend() { openPanel('send'); }
function openPanelReplies() { openPanel('replies'); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('The scheduler is running right now. Try again in a few seconds.');
  try { return fn(); } finally { try { lock.releaseLock(); } catch (e) { /* ignore */ } }
}

/* ---- read APIs ---- */
function api_dashboard_impl() {
  const ctx = buildContext_({ skipSuppression: true });
  const props = PropertiesService.getScriptProperties();
  const hist = sendHistory_();
  const now = Date.now();
  const byStatus = {}, byGroup = {}, bySentiment = {}, byStep = {};
  const nextSends = [], nextFollowUps = [];
  const funnel = { total: 0, unscheduled: 0, scheduled: 0, sent: 0, awaiting: 0, replied: 0, interested: 0, notInterested: 0, bounced: 0, invalid: 0, drafted: 0, paused: 0, error: 0, completed: 0 };
  const dayKey = d => fmt_(d, ctx.cfg.TIMEZONE, 'MM-dd');
  const days = []; for (let k = 13; k >= 0; k--) days.push(dayKey(new Date(now - k * 86400000)));
  const sentByDay = {}, replyByDay = {}, schedByDay = {};
  let dueNow = 0, awaiting = 0;
  for (let i = 1; i < ctx.data.length; i++) {
    const r = rowObj_(ctx, i); if (!r.recipient) continue;
    const st = r.status || 'NEW';
    funnel.total++;
    if (r.step === 0 && !TERMINAL.has(st) && st !== STATUS.PAUSE && st !== STATUS.ERROR) { if (r.scheduledRaw) funnel.scheduled++; else funnel.unscheduled++; }
    if (r.step > 0) funnel.sent++;
    if (st === STATUS.SENT) funnel.awaiting++;
    if ([STATUS.REPLIED, STATUS.INTERESTED, STATUS.NOT_INTERESTED, STATUS.UNSUBSCRIBED].includes(st)) funnel.replied++;
    if (st === STATUS.INTERESTED) funnel.interested++;
    if (st === STATUS.NOT_INTERESTED || st === STATUS.UNSUBSCRIBED) funnel.notInterested++;
    if (st === STATUS.BOUNCED) funnel.bounced++;
    if (st === STATUS.INVALID) funnel.invalid++;
    if (st === STATUS.COMPLETED) funnel.completed++;
    if (st === STATUS.PAUSE || st === STATUS.SKIP) funnel.paused++;
    if (st === STATUS.ERROR) funnel.error++;
    if (String(r.get(COL.RESPONSE) || '').trim() || st === STATUS.MANUAL) funnel.drafted++;
    if (r.sentAt) { const k = dayKey(r.sentAt); sentByDay[k] = (sentByDay[k] || 0) + 1; }
    const ra = toDate_(r.get(COL.REPLY_AT)); if (ra) { const k = dayKey(ra); replyByDay[k] = (replyByDay[k] || 0) + 1; }
    if (r.step === 0 && r.scheduledRaw) { const sd = parseScheduledDate_(r.scheduledRaw); if (sd) { const k = dayKey(sd); schedByDay[k] = (schedByDay[k] || 0) + 1; } }
    byStatus[st] = (byStatus[st] || 0) + 1;
    const g = String(r.get(COL.GROUP) || '').trim() || '(none)';
    byGroup[g] = byGroup[g] || { total: 0, scheduled: 0, sent: 0, replied: 0, other: 0 };
    byGroup[g].total++;
    if (r.step === 0 && !TERMINAL.has(st)) byGroup[g].scheduled++;
    else if (r.step > 0 && [STATUS.SENT, STATUS.COMPLETED, STATUS.MANUAL].includes(st)) byGroup[g].sent++;
    else if ([STATUS.REPLIED, STATUS.INTERESTED, STATUS.NOT_INTERESTED, STATUS.UNSUBSCRIBED].includes(st)) byGroup[g].replied++;
    else byGroup[g].other++;
    const sen = String(r.get(COL.SENTIMENT) || '').trim(); if (sen) bySentiment[sen] = (bySentiment[sen] || 0) + 1;
    if (r.step > 0) byStep[r.step] = (byStep[r.step] || 0) + 1;
    if (r.step === 0 && !TERMINAL.has(st) && st !== STATUS.PAUSE && r.scheduledRaw) {
      const d = parseScheduledDate_(r.scheduledRaw);
      if (d) { if (d.getTime() <= now) dueNow++; nextSends.push({ row: r.sheetRow, to: r.recipient, at: d.getTime(), group: g }); }
    }
    if (st === STATUS.SENT) { awaiting++; if (r.nextAt) nextFollowUps.push({ row: r.sheetRow, to: r.recipient, at: r.nextAt.getTime(), step: r.step + 1 }); }
  }
  nextSends.sort((a, b) => a.at - b.at); nextFollowUps.sort((a, b) => a.at - b.at);
  const f = ms => fmt_(new Date(ms), ctx.cfg.TIMEZONE, 'EEE dd MMM HH:mm');
  const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'tick').length;
  const lastTick = num_(props.getProperty(PROP.LAST_TICK), 0);
  let logs = [];
  try {
    const ls = ctx.ss.getSheetByName(ctx.cfg.LOG_SHEET);
    if (ls && ls.getLastRow() > 1) {
      const n = Math.min(20, ls.getLastRow() - 1);
      logs = ls.getRange(ls.getLastRow() - n + 1, 1, n, 7).getValues().reverse()
        .map(r => ({ ts: fmt_(toDate_(r[0]), ctx.cfg.TIMEZONE, 'dd MMM HH:mm:ss'), level: r[1], row: r[3], to: r[4], event: r[5], details: String(r[6] || '').slice(0, 160) }));
    }
  } catch (e) { /* ignore */ }
  const drafts = loadDrafts_(ctx);
  return {
    me: ctx.me, tz: ctx.cfg.TIMEZONE, now: f(now),
    paused: bool_(ctx.cfg.PAUSED), windowOpen: inSendWindow_(new Date(), ctx.cfg), window: `${ctx.cfg.SEND_DAYS} ${ctx.cfg.SEND_WINDOW_START}–${ctx.cfg.SEND_WINDOW_END}`,
    triggers, lastTick: lastTick ? f(lastTick) : 'never', lastTickStats: props.getProperty(PROP.LAST_TICK_STATS) || '',
    gmailApi: gmailApiAvailable_(),
    quota: MailApp.getRemainingDailyQuota(), sentHour: hist.lastHour, maxHour: num_(ctx.cfg.MAX_PER_HOUR, 0), sentDay: hist.lastDay, maxDay: num_(ctx.cfg.MAX_PER_DAY, 0),
    rows: ctx.data.length - 1, dueNow, awaiting, suppression: loadSuppression_(ctx.ss, ctx.cfg).size,
    byStatus, byGroup, bySentiment, byStep,
    sequence: ctx.sequence.map(st => ({ step: st.step, subject: st.subject, delay: st.delayMs / 3600000, draftOk: !!drafts[st.subject], sentCount: byStep[st.step] || 0 })),
    responses: ctx.responses.map(r => ({ key: r.key, subject: r.subject, sentiment: r.sentiment, draftOk: !!drafts[r.subject] })),
    funnel,
    timeline: { days, sent: days.map(d => sentByDay[d] || 0), replies: days.map(d => replyByDay[d] || 0), scheduled: days.map(d => schedByDay[d] || 0) },
    nextSends: nextSends.slice(0, 8).map(x => Object.assign(x, { at: f(x.at) })),
    nextFollowUps: nextFollowUps.slice(0, 8).map(x => Object.assign(x, { at: f(x.at) })),
    logs
  };
}

function api_groups_impl() {
  const ctx = buildContext_({ skipSequence: true, skipSuppression: true });
  const groups = {};
  let selected = 0;
  try { const rl = ctx.sheet.getActiveRangeList(); if (rl) rl.getRanges().forEach(r => { selected += r.getNumRows(); }); } catch (e) { /* ignore */ }
  for (let i = 1; i < ctx.data.length; i++) {
    const r = rowObj_(ctx, i); if (!r.recipient) continue;
    const g = String(r.get(COL.GROUP) || '').trim() || '(none)';
    groups[g] = groups[g] || { total: 0, unscheduled: 0 };
    groups[g].total++; if (r.step === 0 && !r.scheduledRaw && !TERMINAL.has(r.status)) groups[g].unscheduled++;
  }
  return {
    groups, selected, tz: ctx.cfg.TIMEZONE, windowStart: ctx.cfg.SEND_WINDOW_START,
    defaults: { gapMin: num_(ctx.cfg.DEFAULT_SPACING_MINUTES, 3), batchSize: num_(ctx.cfg.SCHEDULE_BATCH_SIZE, 10), batchPauseMin: num_(ctx.cfg.SCHEDULE_BATCH_PAUSE_MINUTES, 30), perDayCap: num_(ctx.cfg.MAX_PER_DAY, 300) },
    sequence: readSequenceRaw_(ctx.ss, ctx.cfg)
  };
}

function readSequenceRaw_(ss, cfg) {
  const sheet = ss.getSheetByName(cfg.SEQUENCE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues().filter(r => String(r[1] || '').trim())
    .map(r => ({ step: r[0], subject: String(r[1]), days: num_(r[2], 0), hours: num_(r[3], 0), active: r[4] === '' || bool_(r[4]) || r[4] === true, notes: String(r[5] || '') }));
}

function api_saveSequence_impl(steps) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = loadConfig_(ss);
  const sheet = ss.getSheetByName(cfg.SEQUENCE_SHEET) || ss.insertSheet(cfg.SEQUENCE_SHEET);
  const rows = [['Step', 'Draft Subject', 'Delay Days', 'Delay Hours', 'Active', 'Notes']]
    .concat((steps || []).filter(st => String(st.subject || '').trim()).map((st, i) => [i + 1, st.subject, num_(st.days, 0), num_(st.hours, 0), st.active ? 'TRUE' : 'FALSE', st.notes || '']));
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, 6).setValues(rows); sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
  return rows.length - 1;
}

function api_replies_impl() {
  const ctx = buildContext_({ skipSuppression: true });
  const replied = [], awaiting = [];
  const f = d => fmt_(d, ctx.cfg.TIMEZONE, 'dd MMM HH:mm');
  for (let i = 1; i < ctx.data.length && !outOfTime_(ctx, 20000); i++) {
    const r = rowObj_(ctx, i); if (!r.recipient || r.step === 0) continue;
    const base = { row: r.sheetRow, to: r.recipient, name: String(r.get('name') || r.get('Name') || ''), company: String(r.get('company') || r.get('Company') || ''),
      status: r.status, step: r.step, sentAt: f(r.sentAt), threadUrl: r.threads.length ? 'https://mail.google.com/mail/u/0/#all/' + r.threads[r.threads.length - 1] : '', response: String(r.get(COL.RESPONSE) || '') };
    if ([REPLY.REPLIED, REPLY.OOO, REPLY.BOUNCED].includes(r.replyStatus)) {
      let snippet = '';
      if (replied.length < 40 && r.threads.length && r.replyStatus !== REPLY.BOUNCED) {
        try {
          const th = GmailApp.getThreadById(r.threads[r.threads.length - 1]);
          const inc = th ? th.getMessages().filter((m, idx) => !isMine_(ctx, m, idx)) : [];
          if (inc.length) snippet = stripQuoted_(inc[inc.length - 1].getPlainBody()).replace(/\s+/g, ' ').trim().slice(0, 220);
        } catch (e) { snippet = ''; }
      }
      replied.push(Object.assign(base, { sentiment: String(r.get(COL.SENTIMENT) || ''), replyStatus: r.replyStatus, replyAt: f(toDate_(r.get(COL.REPLY_AT))), snippet }));
    } else if (r.status === STATUS.SENT || r.status === STATUS.COMPLETED || r.status === STATUS.MANUAL) {
      const next = ctx.sequence.find(st => st.step === r.step + 1);
      awaiting.push(Object.assign(base, { nextAt: r.nextAt ? f(r.nextAt) : '', nextStep: next ? next.step : null,
        daysSince: r.sentAt ? Math.floor((Date.now() - r.sentAt.getTime()) / 86400000) : null }));
    }
  }
  replied.sort((a, b) => (a.sentiment === 'POSITIVE' ? -1 : 1) - (b.sentiment === 'POSITIVE' ? -1 : 1));
  return { replied, awaiting, responses: ctx.responses.map(r => ({ key: r.key, sentiment: r.sentiment, subject: r.subject })), gmailApi: gmailApiAvailable_() };
}

/* ---- write APIs ---- */
function api_schedule_impl(payload) {
  return withLock_(() => {
    const ctx = buildContext_({ skipSuppression: true });
    const idxs = resolveScope_(ctx, payload.scope);
    const start = resolveStart_(ctx, payload.start);
    const res = scheduleRows_(ctx, idxs, start, payload.opts || {});
    Log.flush(ctx.ss, ctx.cfg);
    res.start = fmt_(start, ctx.cfg.TIMEZONE, 'EEE dd MMM HH:mm'); res.candidates = idxs.length;
    return res;
  });
}

function api_forceSend_impl(payload) {
  return withLock_(() => {
    const ctx = buildContext_();
    const idxs = resolveScope_(ctx, payload.scope);
    const res = forceSend_(ctx, idxs, payload.opts || {});
    Log.flush(ctx.ss, ctx.cfg);
    res.candidates = idxs.length;
    return res;
  });
}

function api_respond_impl(sheetRow, key, sendNow) {
  return withLock_(() => {
    const ctx = buildContext_({ skipSuppression: true });
    const note = respond_(ctx, rowObj_(ctx, sheetRow - 1), key || null, !!sendNow);
    Log.flush(ctx.ss, ctx.cfg); return note;
  });
}

function api_draftFollowUp_impl(sheetRow) {
  return withLock_(() => {
    const ctx = buildContext_({ skipSuppression: true });
    const note = draftFollowUp_(ctx, rowObj_(ctx, sheetRow - 1));
    Log.flush(ctx.ss, ctx.cfg); return note;
  });
}

function api_setStatus_impl(sheetRow, status) {
  const ctx = buildContext_({ skipSequence: true, skipSuppression: true });
  const allowed = [STATUS.MANUAL, STATUS.SKIP, STATUS.PAUSE, STATUS.SENT, STATUS.COMPLETED, ''];
  if (!allowed.includes(status)) throw new Error('Status not allowed here: ' + status);
  setRow_(ctx, rowObj_(ctx, sheetRow - 1), { [COL.STATUS]: status, [COL.ERROR]: '' });
  return status || '(cleared)';
}

function api_control_impl(action) {
  switch (action) {
    case 'pause': setConfig_('PAUSED', 'TRUE'); return 'Paused';
    case 'resume': setConfig_('PAUSED', 'FALSE'); return 'Resumed';
    case 'tick': tick(); return 'Tick finished';
    case 'replies': { PropertiesService.getScriptProperties().deleteProperty(PROP.REPLY_CURSOR);
      return withLock_(() => { const ctx = buildContext_(); checkRepliesInternal_(ctx, timeLeft_(ctx) - 20000); Log.flush(ctx.ss, ctx.cfg); return `Reply check done (${ctx.stats.replies} new)`; }); }
    case 'install': removeTrigger_(); { const cfg = loadConfig_(SpreadsheetApp.getActiveSpreadsheet()); ScriptApp.newTrigger('tick').timeBased().everyMinutes(Math.max(1, num_(cfg.TICK_MINUTES, 1))).create(); } return 'Trigger installed';
    case 'remove': return removeTrigger_() + ' trigger(s) removed';
    case 'setup': setupSheetsSilent_(); return 'Sheets verified/repaired';
    case 'webapp': { try { return ScriptApp.getService().getUrl() || 'Not deployed yet: Deploy ▸ New deployment ▸ Web app'; } catch (e) { return 'Not deployed yet'; } }
    default: throw new Error('Unknown action ' + action);
  }
}


/* ============================================================================
   CONFIG SCHEMA  (drives the Settings UI; unknown keys are shown as custom variables)
   ============================================================================ */
const CONFIG_SCHEMA = [
  { group: 'Sending limits', fields: [
    { k: 'BATCH_SIZE', t: 'number', label: 'Max sends per tick', help: 'Upper bound per scheduler run (every minute).' },
    { k: 'MAX_PER_HOUR', t: 'number', label: 'Max per hour', help: 'Rolling 60-minute cap.' },
    { k: 'MAX_PER_DAY', t: 'number', label: 'Max per day', help: 'Rolling 24-hour cap. Consumer Gmail ≈ 100/day, Workspace ≈ 1500/day.' },
    { k: 'PAUSED', t: 'bool', label: 'Paused', help: 'Stops all sending. Replies are still tracked.' } ] },
  { group: 'Send window', fields: [
    { k: 'SEND_WINDOW_START', t: 'time', label: 'Window start' },
    { k: 'SEND_WINDOW_END', t: 'time', label: 'Window end' },
    { k: 'SEND_DAYS', t: 'days', label: 'Send on days' },
    { k: 'TIMEZONE', t: 'text', label: 'Timezone', help: 'Must equal the sheet AND Apps Script project timezone.' } ] },
  { group: 'Scheduling defaults', fields: [
    { k: 'DEFAULT_SPACING_MINUTES', t: 'number', label: 'Gap between emails (min)' },
    { k: 'SCHEDULE_BATCH_SIZE', t: 'number', label: 'Emails per batch' },
    { k: 'SCHEDULE_BATCH_PAUSE_MINUTES', t: 'number', label: 'Pause between batches (min)' },
    { k: 'SCHEDULE_JITTER_SECONDS', t: 'number', label: 'Random jitter (± seconds)' } ] },
  { group: 'Safety & quality', fields: [
    { k: 'VALIDATE_BEFORE_SEND', t: 'bool', label: 'Validate address before first send', help: 'Syntax, disposable domain, role address, MX record.' },
    { k: 'ALLOW_RISKY', t: 'bool', label: 'Allow role addresses (info@, hr@, careers@)' },
    { k: 'STRICT_VARIABLES', t: 'bool', label: 'Strict variables', help: 'Row → ERROR if a {{variable}} is empty and has no |fallback.' },
    { k: 'DISPOSABLE_DOMAINS', t: 'text', label: 'Extra disposable domains', help: 'Comma-separated.' },
    { k: 'STALE_SENDING_MINUTES', t: 'number', label: 'Stale SENDING recovery (min)' } ] },
  { group: 'Follow-ups & replies', fields: [
    { k: 'FOLLOW_UP_IN_THREAD', t: 'bool', label: 'Follow-ups inside the original thread', help: 'Requires Services ▸ Gmail API in Apps Script.' },
    { k: 'OOO_DELAY_DAYS', t: 'number', label: 'Delay after an out-of-office reply (days)' },
    { k: 'REPLY_CHECK_MINUTES', t: 'number', label: 'Reply check interval (min)' },
    { k: 'AUTO_RESPOND_POSITIVE', t: 'bool', label: 'Auto-respond to INTERESTED replies' },
    { k: 'AUTO_RESPOND_MODE', t: 'select', options: ['DRAFT', 'SEND'], label: 'Auto-respond mode' },
    { k: 'TEST_MODE_SELF_REPLIES', t: 'bool', label: 'Test mode: my own replies count as replies', help: 'Only while testing with your own +tag addresses.' } ] },
  { group: 'Identity (also {{variables}})', fields: [
    { k: 'Sender Name', t: 'text', label: 'Sender display name' },
    { k: 'Reply To', t: 'text', label: 'Reply-To address' },
    { k: 'Your Full Name', t: 'text', label: '{{Your Full Name}}' },
    { k: 'Your Email', t: 'text', label: '{{Your Email}}' },
    { k: 'Your Phone Number', t: 'text', label: '{{Your Phone Number}}' },
    { k: 'Your LinkedIn Profile', t: 'text', label: '{{Your LinkedIn Profile}}' } ] },
  { group: 'System', fields: [
    { k: 'TICK_MINUTES', t: 'number', label: 'Trigger interval (min)', help: 'Re-install the trigger after changing.' },
    { k: 'MAX_RUNTIME_SECONDS', t: 'number', label: 'Time budget per run (s)', help: 'Keep ≤ 300.' },
    { k: 'LOG_LEVEL', t: 'select', options: ['DEBUG', 'INFO', 'WARN', 'ERROR'], label: 'Log level' },
    { k: 'MAX_LOG_ROWS', t: 'number', label: 'Log retention (rows)' },
    { k: 'DRAFT_SUBJECT', t: 'text', label: 'Fallback draft subject', help: 'Only used when the Sequence is empty.' },
    { k: 'RECIPIENTS_SHEET', t: 'text', label: 'Recipients sheet name' } ] }
];
const SCHEMA_KEYS = new Set(CONFIG_SCHEMA.flatMap(g => g.fields.map(f => f.k)).concat(['CONFIG_SHEET', 'SEQUENCE_SHEET', 'SUPPRESSION_SHEET', 'LOG_SHEET', 'RESPONSES_SHEET']));

function repairConfigSheet_(ss) {
  const sheet = ss.getSheetByName(DEFAULTS.CONFIG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return;
  const rng = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1);
  const tz = Session.getScriptTimeZone();
  const vals = rng.getValues().map(([v]) => [v instanceof Date ? (v.getFullYear() < 1901 ? Utilities.formatDate(v, tz, 'HH:mm') : Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm')) : v]);
  rng.setNumberFormat('@').setValues(vals);
}

function api_config_impl() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = loadConfig_(ss);
  const notes = {};
  const sheet = ss.getSheetByName(cfg.CONFIG_SHEET);
  if (sheet && sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().forEach(([k, , n]) => { if (k) notes[String(k).trim()] = String(n || ''); });
  const groups = CONFIG_SCHEMA.map(g => ({ group: g.group, fields: g.fields.map(f => Object.assign({}, f, { value: cfg[f.k] === undefined ? '' : String(cfg[f.k]), def: String(DEFAULTS[f.k] === undefined ? '' : DEFAULTS[f.k]) })) }));
  const custom = Object.keys(cfg).filter(k => !SCHEMA_KEYS.has(k)).map(k => ({ key: k, value: String(cfg[k]), notes: notes[k] || '' }));
  return { groups, custom, scriptTz: Session.getScriptTimeZone(), sheetTz: ss.getSpreadsheetTimeZone() };
}

/** map: {key: value}. Upserts into the Config sheet. Empty string deletes nothing — value is stored as ''. */
function api_saveConfig_impl(map) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DEFAULTS.CONFIG_SHEET) || (() => { setupSheetsSilent_(); return ss.getSheetByName(DEFAULTS.CONFIG_SHEET); })();
  const last = sheet.getLastRow();
  const keys = last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0]).trim()) : [];
  let n = 0;
  Object.keys(map || {}).forEach(k => {
    const v = map[k] === null || map[k] === undefined ? '' : String(map[k]);
    const idx = keys.indexOf(k);
    if (idx >= 0) sheet.getRange(idx + 2, 2).setNumberFormat('@').setValue(v);
    else { sheet.appendRow([k, v, '']); sheet.getRange(sheet.getLastRow(), 2).setNumberFormat('@').setValue(v); keys.push(k); }
    n++;
  });
  SpreadsheetApp.flush();
  return n;
}

function api_deleteConfigKey_impl(key) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DEFAULTS.CONFIG_SHEET);
  if (!sheet) return false;
  if (SCHEMA_KEYS.has(key)) throw new Error('Built-in keys cannot be deleted.');
  const keys = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().map(r => String(r[0]).trim());
  const idx = keys.indexOf(key); if (idx < 0) return false;
  sheet.deleteRow(idx + 2); return true;
}

/* ============================================================================
   RECIPIENTS API  (the UI replaces the sheet for day-to-day work)
   ============================================================================ */
function api_recipients_impl() {
  const ctx = buildContext_({ skipSequence: true, skipSuppression: true });
  const tracking = new Set(TRACKING_COLS.concat(REQUIRED_COLS));
  const custom = ctx.headers.filter(h => h && !tracking.has(h));
  const f = d => d ? fmt_(d, ctx.cfg.TIMEZONE, 'dd MMM HH:mm') : '';
  const rows = [];
  for (let i = 1; i < ctx.data.length; i++) {
    const r = rowObj_(ctx, i);
    if (!r.recipient && !custom.some(h => r.get(h))) continue;
    const sd = parseScheduledDate_(r.scheduledRaw);
    const data = {}; custom.forEach(h => { const v = r.get(h); data[h] = v instanceof Date ? fmt_(v, ctx.cfg.TIMEZONE, 'yyyy-MM-dd') : String(v === null || v === undefined ? '' : v); });
    rows.push({ row: r.sheetRow, recipient: r.recipient, group: String(r.get(COL.GROUP) || ''), scheduled: f(sd), scheduledMs: sd ? sd.getTime() : 0, scheduledIso: sd ? fmt_(sd, ctx.cfg.TIMEZONE, "yyyy-MM-dd'T'HH:mm") : '',
      status: r.status || (r.recipient ? 'NEW' : ''), step: r.step, sentAt: f(r.sentAt), nextAt: f(r.nextAt), replyStatus: r.replyStatus,
      sentiment: String(r.get(COL.SENTIMENT) || ''), validation: r.validation, response: String(r.get(COL.RESPONSE) || ''), error: String(r.get(COL.ERROR) || ''),
      thread: r.threads.length ? r.threads[r.threads.length - 1] : '', data });
  }
  const groups = [...new Set(rows.map(r => r.group).filter(Boolean))].sort();
  return { rows, custom, groups, tz: ctx.cfg.TIMEZONE, total: rows.length };
}

/** Bulk row actions from the UI. */
function api_recipientAction_impl(rowsList, action, arg) {
  return withLock_(() => {
    const ctx = buildContext_();
    const idxs = resolveScope_(ctx, { type: 'rows', rows: rowsList });
    const out = { action, count: 0, skipped: 0, notes: [] };
    const each = fn => idxs.forEach(i => { const row = rowObj_(ctx, i); try { if (fn(row) !== false) out.count++; else out.skipped++; } catch (e) { out.skipped++; out.notes.push(`row ${row.sheetRow}: ${errMsg_(e)}`); } });
    switch (action) {
      case 'pause': each(row => { if (TERMINAL.has(row.status) || row.step > 0) return false; setRow_(ctx, row, { [COL.STATUS]: STATUS.PAUSE }); }); break;
      case 'skip': each(row => { setRow_(ctx, row, { [COL.STATUS]: STATUS.SKIP, [COL.NEXT_AT]: '' }); }); break;
      case 'manual': each(row => { if (row.step === 0) return false; setRow_(ctx, row, { [COL.STATUS]: STATUS.MANUAL, [COL.NEXT_AT]: '' }); }); break;
      case 'resume': each(row => {
        if (row.step === 0) { setRow_(ctx, row, { [COL.STATUS]: row.scheduledRaw ? STATUS.SCHEDULED : '', [COL.ERROR]: '' }); }
        else { const next = ctx.sequence.find(st => st.step === row.step + 1); setRow_(ctx, row, { [COL.STATUS]: next ? STATUS.SENT : STATUS.COMPLETED, [COL.ERROR]: '', [COL.NEXT_AT]: next && row.sentAt ? nextWindowSlot_(new Date(row.sentAt.getTime() + next.delayMs), ctx.cfg) : '' }); }
      }); break;
      case 'retry': each(row => { if (row.status !== STATUS.ERROR && row.status !== STATUS.INVALID) return false; setRow_(ctx, row, { [COL.STATUS]: row.step > 0 ? STATUS.SENT : (row.scheduledRaw ? STATUS.SCHEDULED : ''), [COL.ERROR]: '', [COL.VALIDATION]: '' }); }); break;
      case 'unschedule': each(row => { if (row.step > 0) return false; setRow_(ctx, row, { [COL.SCHEDULED]: '', [COL.STATUS]: '' }); }); break;
      case 'validate': each(row => { const v = validateEmail_(row.recipient, ctx.cfg); const patch = { [COL.VALIDATION]: v.code }; if (!v.ok && row.step === 0) { patch[COL.STATUS] = STATUS.INVALID; patch[COL.ERROR] = 'Validation failed: ' + v.code; } setRow_(ctx, row, patch); }); break;
      case 'sendNow': { const r = forceSend_(ctx, idxs, { ignoreWindow: true, includeFollowUps: true }); out.count = r.sent + r.followUps; out.skipped = r.skipped; out.notes.push(`queued ${r.queued}, errors ${r.errors}${r.blocked ? ', blocked: ' + r.blocked : ''}`); break; }
      case 'draftFollowUp': each(row => { out.notes.push(`row ${row.sheetRow}: ${draftFollowUp_(ctx, row)}`); }); break;
      case 'respond': each(row => { out.notes.push(`row ${row.sheetRow}: ${respond_(ctx, row, arg && arg.key, !!(arg && arg.send))}`); }); break;
      case 'suppress': each(row => { addToSuppression_(ctx, row.recipient, 'manual'); setRow_(ctx, row, { [COL.STATUS]: STATUS.UNSUBSCRIBED, [COL.NEXT_AT]: '' }); }); break;
      case 'delete': {
        // delete bottom-up so indexes stay valid; only rows never sent
        idxs.slice().sort((a, b) => b - a).forEach(i => { const row = rowObj_(ctx, i); if (row.step > 0) { out.skipped++; return; } ctx.sheet.deleteRow(row.sheetRow); out.count++; });
        break;
      }
      default: throw new Error('Unknown action: ' + action);
    }
    SpreadsheetApp.flush();
    Log.info('Bulk action', out); Log.flush(ctx.ss, ctx.cfg);
    return out;
  });
}

/** obj: {Recipient:'', Group:'', 'Scheduled Date':'', ...custom}. Returns new sheet row. */
function api_addRecipient_impl(obj) {
  const ctx = buildContext_({ skipSequence: true, skipSuppression: true });
  const rowVals = new Array(ctx.headers.length).fill('');
  Object.keys(obj || {}).forEach(k => {
    const c = ctx.cols[k]; if (c === undefined) return;
    let v = obj[k];
    if (k === COL.SCHEDULED && v) { v = parseScheduledDate_(v); if (!v) throw new Error('Unparseable Scheduled Date'); }
    if (k === COL.RECIPIENT) v = String(v).trim().toLowerCase();
    rowVals[c] = v === null || v === undefined ? '' : v;
  });
  if (!rowVals[ctx.cols[COL.RECIPIENT]]) throw new Error('Recipient is required');
  ctx.sheet.appendRow(rowVals);
  const newRow = ctx.sheet.getLastRow();
  if (rowVals[ctx.cols[COL.SCHEDULED]]) ctx.sheet.getRange(newRow, ctx.cols[COL.SCHEDULED] + 1).setNumberFormat('yyyy-mm-dd hh:mm');
  return newRow;
}

function api_updateRecipient_impl(sheetRow, obj) {
  const ctx = buildContext_({ skipSequence: true, skipSuppression: true });
  const row = rowObj_(ctx, sheetRow - 1);
  const patch = {};
  Object.keys(obj || {}).forEach(k => {
    if (ctx.cols[k] === undefined) return;
    if (TRACKING_COLS.includes(k) && k !== COL.GROUP) return;       // tracking columns are engine-owned
    let v = obj[k];
    if (k === COL.SCHEDULED) { if (row.step > 0) return; v = v ? parseScheduledDate_(v) : ''; if (v === null) throw new Error('Unparseable Scheduled Date'); }
    if (k === COL.RECIPIENT) { if (row.step > 0) return; v = String(v).trim().toLowerCase(); }
    patch[k] = v;
  });
  if (patch[COL.SCHEDULED] && row.step === 0) patch[COL.STATUS] = STATUS.SCHEDULED;
  setRow_(ctx, row, patch);
  return Object.keys(patch).length;
}

/** Paste import: first line = headers (tab or comma separated). Unknown headers become new columns. */
function api_importRows_impl(text) {
  const ctx = buildContext_({ skipSequence: true, skipSuppression: true });
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('Need a header line plus at least one data line.');
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const split = l => sep === '\t' ? l.split('\t') : l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')).slice(0, -1);
  const hdr = split(lines[0]).map(h => h.trim());
  // add unknown headers as new custom columns
  const newCols = hdr.filter(h => h && ctx.cols[h] === undefined && normKey_(h) !== 'email');
  if (newCols.length) { ctx.sheet.getRange(1, ctx.headers.length + 1, 1, newCols.length).setValues([newCols]).setFontWeight('bold'); newCols.forEach((h, k) => { ctx.cols[h] = ctx.headers.length + k; }); ctx.headers = ctx.headers.concat(newCols); }
  const width = ctx.headers.length;
  const out = []; let bad = 0;
  lines.slice(1).forEach(l => {
    const cells = split(l); const vals = new Array(width).fill('');
    hdr.forEach((h, k) => {
      let key = h; if (normKey_(h) === 'email') key = COL.RECIPIENT;
      const c = ctx.cols[key]; if (c === undefined) return;
      let v = (cells[k] || '').trim();
      if (key === COL.SCHEDULED && v) { const d = parseScheduledDate_(v); v = d || v; }
      if (key === COL.RECIPIENT) v = v.toLowerCase();
      vals[c] = v;
    });
    if (vals[ctx.cols[COL.RECIPIENT]]) out.push(vals); else bad++;
  });
  if (out.length) ctx.sheet.getRange(ctx.sheet.getLastRow() + 1, 1, out.length, width).setValues(out);
  return { imported: out.length, skipped: bad, newColumns: newCols };
}

/* ============================================================================
   LOGS / PREVIEW / DRAFTS / DEPLOY  (UI helpers)
   ============================================================================ */
function api_logs_impl(opts) {
  opts = opts || {};
  const ss = SpreadsheetApp.getActiveSpreadsheet(); const cfg = loadConfig_(ss);
  const sheet = ss.getSheetByName(cfg.LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { rows: [], total: 0 };
  const total = sheet.getLastRow() - 1;
  const n = Math.min(num_(opts.limit, 500), total, 3000);
  const vals = sheet.getRange(sheet.getLastRow() - n + 1, 1, n, 7).getValues().reverse();
  const lvl = String(opts.level || '').toUpperCase(); const q = String(opts.q || '').toLowerCase();
  const rows = vals.map(r => ({ ts: fmt_(toDate_(r[0]), cfg.TIMEZONE, 'dd MMM HH:mm:ss'), level: String(r[1]), exec: String(r[2]), row: String(r[3]), to: String(r[4]), event: String(r[5]), details: String(r[6] || '') }))
    .filter(r => (!lvl || LEVELS[r.level] >= LEVELS[lvl]) && (!q || (r.event + ' ' + r.details + ' ' + r.to + ' ' + r.row).toLowerCase().includes(q)));
  return { rows, total, scanned: n };
}

function api_clearLogs_impl() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); const cfg = loadConfig_(ss);
  const sheet = ss.getSheetByName(cfg.LOG_SHEET); if (!sheet || sheet.getLastRow() < 2) return 0;
  const n = sheet.getLastRow() - 1; sheet.deleteRows(2, n); return n;
}

function api_preview_impl(sheetRow, stepNo) {
  const ctx = buildContext_({ skipSuppression: true });
  const row = rowObj_(ctx, sheetRow - 1);
  const stepDef = ctx.sequence.find(st => st.step === (stepNo || row.step + 1)) || ctx.sequence[0];
  const tpl = loadDrafts_(ctx)[stepDef.subject];
  if (!tpl) throw new Error('Gmail Draft not found: ' + stepDef.subject);
  const vars = buildVars_(ctx, row);
  const subject = render_(tpl.subject, vars, ctx.cfg.TIMEZONE, false), html = render_(tpl.html, vars, ctx.cfg.TIMEZONE, true);
  const v = row.recipient ? validateEmail_(row.recipient, ctx.cfg) : { code: 'NO_RECIPIENT', ok: false };
  return { to: row.recipient, step: stepDef.step, subject: subject.text, html: html.text, missing: [...new Set(subject.missing.concat(html.missing))], validation: v.code, attachments: tpl.attachments.map(a => a.getName()) };
}

function api_sendTest_impl(sheetRow, stepNo) {
  const ctx = buildContext_({ skipSuppression: true });
  const row = rowObj_(ctx, sheetRow - 1);
  const stepDef = ctx.sequence.find(st => st.step === (stepNo || row.step + 1)) || ctx.sequence[0];
  const tpl = loadDrafts_(ctx)[stepDef.subject]; if (!tpl) throw new Error('Gmail Draft not found: ' + stepDef.subject);
  const msg = personalise_(ctx, tpl, row);
  GmailApp.sendEmail(ctx.me, `[TEST row ${row.sheetRow}] ${msg.subject}`, msg.text, sendOptions_(ctx, msg));
  return 'Test sent to ' + ctx.me;
}

/** Creates a Gmail draft skeleton for a template subject so the user just edits the body. */
function api_createDraft_impl(subject, kind) {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); const cfg = loadConfig_(ss);
  const exists = GmailApp.getDrafts().some(d => d.getMessage().getSubject() === subject);
  if (exists) return 'A draft with this subject already exists.';
  const body = kind === 'response'
    ? 'Hi {{First Name|there}},\n\nThank you for getting back to me.\n\n[write your reply here]\n\nBest regards,\n{{Your Full Name}}'
    : 'Hi {{First Name|there}},\n\n[write your email here — every Recipients column and Config key is a {{variable}}]\n\nBest regards,\n{{Your Full Name}}\n{{Your Email}} · {{Your Phone Number}}\n{{Your LinkedIn Profile}}';
  try { GmailApp.createDraft('', subject, body, { htmlBody: body.replace(/\n/g, '<br>') }); }
  catch (e) { GmailApp.createDraft(Session.getEffectiveUser().getEmail(), subject, body, { htmlBody: body.replace(/\n/g, '<br>') }); }
  return 'Draft created in Gmail — edit the body there. Subject must stay: ' + subject;
}

function api_templates_impl() {
  const ctx = buildContext_({ skipSuppression: true });
  const drafts = loadDrafts_(ctx);
  return {
    sequence: readSequenceRaw_(ctx.ss, ctx.cfg).map(st => Object.assign(st, { draftOk: !!drafts[st.subject] })),
    responses: ctx.responses.map(r => Object.assign({}, r, { draftOk: !!drafts[r.subject] })),
    variables: ctx.headers.filter(Boolean).concat(Object.keys(ctx.cfg).filter(k => !SCHEMA_KEYS.has(k) || /^Your |^Sender|^Reply To$/.test(k))).concat(['First Name', 'Today', 'Recipient']),
    gmailApi: gmailApiAvailable_()
  };
}

function api_saveResponses_impl(list) {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); const cfg = loadConfig_(ss);
  const sheet = ss.getSheetByName(cfg.RESPONSES_SHEET) || createResponsesSheet_(ss, cfg.RESPONSES_SHEET);
  const rows = [['Key', 'Draft Subject', 'For Sentiment', 'Notes']].concat((list || []).filter(r => r.key && r.subject).map(r => [String(r.key).toUpperCase(), r.subject, String(r.sentiment || 'NEUTRAL').toUpperCase(), r.notes || '']));
  sheet.clearContents(); sheet.getRange(1, 1, rows.length, 4).setValues(rows); sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  return rows.length - 1;
}

function api_deployTest_impl() { return deploymentReport_(); }

function setupSheetsSilent_() { try { setupSheets(); } catch (e) { /* UI alert is unavailable in the web app; sheets were still created */ } }

/* ============================================================================
   WEB APP  (Deploy ▸ New deployment ▸ Web app ▸ Execute as me ▸ Only myself)
   ============================================================================ */
function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Panel');
  t.tab = (e && e.parameter && e.parameter.tab) || 'dashboard';
  t.mode = 'web';
  return t.evaluate().setTitle('Mail Engine').addMetaTag('viewport', 'width=device-width, initial-scale=1').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* google.script.run cannot transport Date objects: every api_* result is JSON round-tripped. */
function safe_(o) { return JSON.parse(JSON.stringify(o === undefined ? null : o)); }

/* Backwards-compatible aliases for old triggers/menus. */
function processScheduledEmails() { tick(); }
function checkReplies() { checkRepliesNow(); }
function api_config() { return safe_(api_config_impl.apply(null, arguments)); }
function api_saveConfig() { return safe_(api_saveConfig_impl.apply(null, arguments)); }
function api_deleteConfigKey() { return safe_(api_deleteConfigKey_impl.apply(null, arguments)); }
function api_recipients() { return safe_(api_recipients_impl.apply(null, arguments)); }
function api_recipientAction() { return safe_(api_recipientAction_impl.apply(null, arguments)); }
function api_addRecipient() { return safe_(api_addRecipient_impl.apply(null, arguments)); }
function api_updateRecipient() { return safe_(api_updateRecipient_impl.apply(null, arguments)); }
function api_importRows() { return safe_(api_importRows_impl.apply(null, arguments)); }
function api_logs() { return safe_(api_logs_impl.apply(null, arguments)); }
function api_clearLogs() { return safe_(api_clearLogs_impl.apply(null, arguments)); }
function api_preview() { return safe_(api_preview_impl.apply(null, arguments)); }
function api_sendTest() { return safe_(api_sendTest_impl.apply(null, arguments)); }
function api_createDraft() { return safe_(api_createDraft_impl.apply(null, arguments)); }
function api_templates() { return safe_(api_templates_impl.apply(null, arguments)); }
function api_saveResponses() { return safe_(api_saveResponses_impl.apply(null, arguments)); }
function api_deployTest() { return safe_(api_deployTest_impl.apply(null, arguments)); }
function api_dashboard() { return safe_(api_dashboard_impl.apply(null, arguments)); }
function api_groups() { return safe_(api_groups_impl.apply(null, arguments)); }
function api_saveSequence() { return safe_(api_saveSequence_impl.apply(null, arguments)); }
function api_replies() { return safe_(api_replies_impl.apply(null, arguments)); }
function api_schedule() { return safe_(api_schedule_impl.apply(null, arguments)); }
function api_forceSend() { return safe_(api_forceSend_impl.apply(null, arguments)); }
function api_respond() { return safe_(api_respond_impl.apply(null, arguments)); }
function api_draftFollowUp() { return safe_(api_draftFollowUp_impl.apply(null, arguments)); }
function api_setStatus() { return safe_(api_setStatus_impl.apply(null, arguments)); }
function api_control() { return safe_(api_control_impl.apply(null, arguments)); }