const fs = require('fs');
const axios = require('axios');
const XLSX = require('xlsx');

// --- Configuration ---
const PINCHTAB_URL = process.env.PINCHTAB_URL || 'http://localhost:9867';
const PINCHTAB_TOKEN = process.env.PINCHTAB_TOKEN || 'your_super_secret_osint_token';
const INPUT_CSV = process.env.INPUT_CSV || 'master-data-gmaps.csv';
const OUTPUT_XLSX = process.env.OUTPUT_XLSX || 'master-data-enriched.xlsx';

// LIMIT=5 processes only the first 5 rows -- use this to smoke-test before a full run.
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 0;
// Resume is on by default: rows already present in OUTPUT_XLSX are skipped.
// Set RESUME=0 to ignore the existing output and re-scrape everything.
const RESUME = process.env.RESUME !== '0';

// Parallel workers. Each worker owns ONE tab for the whole run and only ever uses
// tab-scoped routes (/tabs/{id}/...), which are genuinely per-tab. Never mix in the
// unscoped /text or /evaluate here: those read whichever tab was touched last and
// would silently return another site's content under concurrency.
//
// Tuning: config.json must satisfy instanceDefaults.maxTabs > CONCURRENCY (or LRU
// eviction can close an idle worker's tab) and maxParallelTabs >= CONCURRENCY.
// Budget ~250MB of the container's mem_limit per worker.
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 4));

const RENDER_WAIT_MS = 4000;   // settle time after nav for client-rendered pages
const MAX_ATTEMPTS = 3;        // per-URL retries
const SAVE_EVERY = 25;         // flush partial results this often

const api = axios.create({
    baseURL: PINCHTAB_URL,
    timeout: 130000, // above the server's 110s navigateSec so the server error wins
    headers: {
        'Authorization': `Bearer ${PINCHTAB_TOKEN}`,
        'Content-Type': 'application/json'
    }
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// innerText carries no href attributes, so social profiles (icon-only links) and
// mailto: addresses are invisible to a text-only scrape. Harvesting the anchor
// hrefs is what actually recovers LinkedIn/Facebook/Instagram and obfuscated mail.
const HREF_EXPRESSION =
    "JSON.stringify([...document.querySelectorAll('a[href]')].map(a => a.href).slice(0, 600))";

// --- Run state (module scope so the signal handler can flush it) ---
let allRows = [];              // every CSV row, in file order
let resultsByKey = new Map();  // rowKey -> enriched row
let hits = 0;
let completed = 0;
let saving = false;
let shuttingDown = false;

// --- Regex Patterns ---
const patterns = {
    emails: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    whatsapp: /(?:https?:\/\/)?(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\d{6,15})/g,
    linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[a-zA-Z0-9_-]+\/?/g,
    facebook: /https?:\/\/(?:www\.)?facebook\.com\/[a-zA-Z0-9_.-]+\/?/g,
    instagram: /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9_.-]+\/?/g
};

// Vendor/tracking noise that shows up on almost every CMS-built site.
const EMAIL_NOISE = [
    'sentry.io', 'wixpress.com', 'example.com', 'example.org', 'domain.com',
    'yourdomain', 'youremail', 'email.com', 'schema.org', 'w3.org', 'sentry-next',
    'godaddy.com', 'squarespace.com', 'shopify.com', 'test.com', 'abc.com'
];

// Share widgets and tracking pixels sit on nearly every page and match the social
// regexes; they are not the business's own profile.
const SOCIAL_NOISE = /\/(sharer|share|share\.php|tr|plugins|dialog|p|explore|reel|hashtag|login|help|policies|profile\.php)(\/|\?|$)/i;

function isRealEmail(email) {
    if (EMAIL_NOISE.some(noise => email.includes(noise))) return false;
    // Retina asset filenames ("logo@2x.png") and sprite refs match the email regex.
    if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$/i.test(email)) return false;
    if (/^[0-9]+@/.test(email)) return false;
    return true;
}

function firstProfile(matches) {
    if (!matches) return '';
    return matches.find(url => {
        const path = url.replace(/^https?:\/\/[^/]+/i, '') || '/';
        return !SOCIAL_NOISE.test(`${path}?`);
    }) || '';
}

// --- Extraction Logic ---
function extractData(text) {
    const data = {
        scraped_emails: [],
        whatsapp_numbers: [],
        linkedin: '',
        facebook: '',
        instagram: ''
    };

    const emailsFound = text.match(patterns.emails) || [];
    data.scraped_emails = [...new Set(emailsFound.map(e => e.toLowerCase()))].filter(isRealEmail);

    const waFound = text.match(patterns.whatsapp) || [];
    data.whatsapp_numbers = [...new Set(waFound.map(w => w.replace(/[^0-9]/g, '')))];

    data.linkedin = firstProfile(text.match(patterns.linkedin));
    data.facebook = firstProfile(text.match(patterns.facebook));
    data.instagram = firstProfile(text.match(patterns.instagram));

    return data;
}

// --- Readiness ---
// /health answers 200 as soon as the process binds, but Chrome is lazily started.
// Calling a nav/text route before defaultInstance.status == "running" returns 503.
async function waitForBrowser(timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = 'unknown';

    while (Date.now() < deadline) {
        try {
            const res = await api.get('/health');
            const inst = res.data?.defaultInstance;
            lastStatus = inst?.status || 'no-instance';

            if (inst?.id && lastStatus === 'running') {
                console.log(`[*] PinchTab instance ready: ${inst.id}`);
                return inst.id;
            }
            console.log(`[*] Waiting for Chrome... status=${lastStatus}`);
        } catch (error) {
            console.log(`[*] Waiting for PinchTab server... (${error.code || error.message})`);
        }
        await sleep(3000);
    }

    console.error(`[-] Browser not ready after ${timeoutMs / 1000}s (last status: ${lastStatus})`);
    process.exit(1);
}

// --- Tab lifecycle ---
// Each worker keeps one long-lived tab and navigates it repeatedly, because:
//   1. There is no DELETE /tabs/{id} route, so a tab per row leaks tabs until
//      maxTabs eviction kicks in.
//   2. Upstream #621: opening a new tab per navigation returns a deterministic
//      "503 new tab did not load in time" on ad/consent-heavy pages, since the
//      readiness poll latches onto a permanently-loading ad frame. Reusing a tab
//      goes through Page.navigate instead and completes in ~1.5s.
// `holder` is a mutable box so a dead/evicted tab can be transparently replaced.
async function ensureTab(instanceId, holder, slot) {
    if (holder.id) return holder.id;

    const res = await api.post(`/instances/${instanceId}/tabs/open`, { url: 'about:blank' });
    holder.id = res.data.tabId;
    console.log(`[*] worker ${slot}: tab ${holder.id.slice(0, 8)}`);
    return holder.id;
}

// Requires security.allowEvaluate = true. Degrades to text-only if eval is denied
// rather than failing the row outright.
async function getLinks(tabId) {
    try {
        const res = await api.post(`/tabs/${tabId}/evaluate`, { expression: HREF_EXPRESSION });
        const raw = res.data?.result;
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(list) ? [...new Set(list)] : [];
    } catch (error) {
        return [];
    }
}

async function scrapeWebsite(url, instanceId, holder, slot) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (shuttingDown) return null;

        try {
            const tabId = await ensureTab(instanceId, holder, slot);

            // Navigate this worker's own tab (NOT a new tab -- see ensureTab).
            await api.post(`/tabs/${tabId}/navigate`, { url });

            // Let client-side rendering and any AutoSolver challenge settle.
            await sleep(RENDER_WAIT_MS);

            // Tab-scoped read. mode=raw returns document.body.innerText; the default
            // (Readability) strips headers/footers -- exactly where contacts live.
            const textRes = await api.get(`/tabs/${tabId}/text`, {
                params: { mode: 'raw', maxChars: 400000 }
            });

            const pageText = textRes.data?.text || '';
            const links = await getLinks(tabId);

            if (!pageText.trim() && !links.length) throw new Error('empty page');

            // Feed visible text AND hrefs through the same regex pass.
            return extractData(`${pageText}\n${links.join('\n')}`);
        } catch (error) {
            const status = error.response?.status;
            const detail = error.response?.data?.error || error.message;

            // 404 means this worker's tab is gone (LRU-evicted or crashed).
            // Drop it so the next attempt opens a fresh one.
            if (status === 404) holder.id = null;

            if (attempt === MAX_ATTEMPTS) {
                console.error(`    [-] Failed ${url} after ${MAX_ATTEMPTS} attempts: ${status || ''} ${detail}`);
                return null;
            }

            // 503 = Chrome busy/restarting; back off longer before retrying.
            const backoff = status === 503 ? 8000 * attempt : 2000 * attempt;
            console.warn(`    [!] w${slot} attempt ${attempt} failed (${status || 'net'}: ${detail}) - retry in ${backoff}ms`);
            await sleep(backoff);
        }
    }
    return null;
}

// --- Output ---
// Emitted in original CSV order regardless of the order workers finish in, so the
// spreadsheet stays diffable and resume-stable.
function orderedRows() {
    const emitted = new Set();
    const rows = allRows.map(row => {
        const key = rowKey(row);
        emitted.add(key);
        return resultsByKey.get(key) || row;
    });

    // Anything carried over from a previous, longer run (e.g. after using LIMIT).
    for (const [key, row] of resultsByKey) {
        if (!emitted.has(key)) rows.push(row);
    }
    return rows;
}

// Written via a temp file + rename so a Ctrl+C landing mid-write can never leave a
// truncated workbook -- the resume path depends on this file staying readable.
function saveWorkbook() {
    const ws = XLSX.utils.json_to_sheet(orderedRows());
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Enriched Data');

    // bookType is explicit: XLSX infers the format from the extension, and the
    // temp file's ".tmp" suffix would otherwise throw "Unrecognized bookType".
    const tmp = `${OUTPUT_XLSX}.tmp`;
    XLSX.writeFile(wb, tmp, { bookType: 'xlsx' });
    fs.renameSync(tmp, OUTPUT_XLSX); // atomic, and overwrites on Windows
}

// Guarded because several workers can cross a checkpoint boundary at once and
// XLSX.writeFile is synchronous and expensive.
function checkpoint() {
    if (saving || shuttingDown) return;
    saving = true;
    try {
        saveWorkbook();
        console.log(`    [*] Checkpoint: ${completed} done, ${hits} with emails`);
    } catch (error) {
        console.error(`    [-] Checkpoint failed: ${error.message}`);
    } finally {
        saving = false;
    }
}

// --- Resume ---
// Website is the natural key; rows without one fall back to name+address so that
// skipped/invalid entries aren't re-appended on every resume.
function rowKey(row) {
    const site = (row['Website'] || '').trim().toLowerCase().replace(/\/+$/, '');
    if (site) return site;
    return `${row['Name'] || ''}|${row['Address'] || ''}`;
}

// A row counts as done only if it carries enrichment columns, so rows left bare by
// an earlier failure get retried on the next run instead of being skipped forever.
function isEnriched(row) {
    return 'Scraped Emails' in row;
}

function loadPrevious() {
    if (!RESUME || !fs.existsSync(OUTPUT_XLSX)) return;

    try {
        const wb = XLSX.readFile(OUTPUT_XLSX);
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        for (const row of rows) {
            if (isEnriched(row)) resultsByKey.set(rowKey(row), row);
        }
    } catch (error) {
        console.warn(`[!] Could not read ${OUTPUT_XLSX} for resume (${error.message}) - starting fresh`);
        resultsByKey = new Map();
    }
}

// --- Graceful shutdown ---
function requestShutdown(signal) {
    if (shuttingDown) {
        console.log(`\n[!] Second ${signal} - exiting immediately.`);
        process.exit(130);
    }
    shuttingDown = true;

    console.log(`\n[!] ${signal} received - flushing ${resultsByKey.size} enriched rows to ${OUTPUT_XLSX}...`);
    try {
        saveWorkbook();
        console.log(`[*] Saved (${hits} sites yielded emails). Re-run the same command to resume.`);
    } catch (error) {
        console.error(`[-] Save failed: ${error.message}`);
    }

    // In-flight workers can still be parked on a 130s HTTP timeout, so don't wait
    // for them. unref() lets the process exit sooner if they finish first.
    setTimeout(() => process.exit(130), 2000).unref();
}

// Ctrl+C in a Windows console and `docker stop`/kill on Linux both land here.
// SIGBREAK covers Ctrl+Break, which Windows delivers separately from Ctrl+C.
process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));
process.on('SIGBREAK', () => requestShutdown('SIGBREAK'));

// A crash mid-run would otherwise discard everything since the last checkpoint.
process.on('uncaughtException', (error) => {
    console.error(`[-] Uncaught: ${error.stack || error.message}`);
    requestShutdown('uncaughtException');
});

// --- Worker pool ---
// A shared cursor rather than pre-sharding, so a slow worker can't strand rows.
async function runPool(pending, instanceId) {
    let cursor = 0;

    async function worker(slot) {
        const holder = { id: null };

        // Stagger startup so N tabs don't all cold-start Chrome renderers at once.
        await sleep(slot * 750);

        while (!shuttingDown) {
            const index = cursor++;
            if (index >= pending.length) return;

            const row = pending[index];
            const website = (row['Website'] || '').trim();

            console.log(`[+] (${index + 1}/${pending.length}) w${slot} ${website}`);
            const siteData = await scrapeWebsite(website, instanceId, holder, slot);

            if (siteData) {
                if (siteData.scraped_emails.length) hits++;
                resultsByKey.set(rowKey(row), {
                    ...row,
                    'Scraped Emails': siteData.scraped_emails.join(', '),
                    'WhatsApp': siteData.whatsapp_numbers.join(', '),
                    'LinkedIn': siteData.linkedin || row['linkedin'],
                    'Facebook': siteData.facebook || row['facebook'],
                    'Instagram': siteData.instagram || row['instagram']
                });
            }

            completed++;
            if (completed % SAVE_EVERY === 0) checkpoint();
        }
    }

    await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, slot) => worker(slot))
    );
}

// --- Main Execution ---
async function main() {
    if (!fs.existsSync(INPUT_CSV)) {
        console.error(`[-] Input file not found: ${INPUT_CSV}`);
        process.exit(1);
    }

    // 1. Wait for Chrome
    const instanceId = await waitForBrowser();

    // 2. Read the CSV
    const wb = XLSX.readFile(INPUT_CSV);
    allRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });

    console.log(`[*] Loaded ${allRows.length} rows from ${INPUT_CSV}`);
    if (LIMIT > 0) {
        allRows = allRows.slice(0, LIMIT);
        console.log(`[*] LIMIT set - processing first ${allRows.length} rows only`);
    }

    // 3. Resume, then queue only rows that still need scraping
    loadPrevious();
    if (resultsByKey.size) {
        console.log(`[*] Resuming from ${OUTPUT_XLSX}: ${resultsByKey.size} rows already enriched`);
    }

    const pending = allRows.filter(row => {
        const website = (row['Website'] || '').trim();
        if (!/^https?:\/\//i.test(website)) return false;   // kept as-is in output
        return !resultsByKey.has(rowKey(row));
    });

    console.log(`[*] ${pending.length} rows left to scrape at concurrency ${CONCURRENCY}`);
    if (!pending.length) {
        console.log('[*] Nothing left to do.');
        saveWorkbook();
        return;
    }

    // 4. Scrape in parallel
    const startedAt = Date.now();
    await runPool(pending, instanceId);

    if (shuttingDown) return; // already flushed by the signal handler

    saveWorkbook();
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`[*] Done in ${mins} min. Saved ${OUTPUT_XLSX} (${hits} sites yielded emails)`);
}

main();
