const fs = require('fs');
const axios = require('axios');
const XLSX = require('xlsx');
const PQueue = require('p-queue').default;

// --- Configuration ---
const PINCHTAB_URL = process.env.PINCHTAB_URL || 'http://localhost:9867';
const PINCHTAB_TOKEN = process.env.PINCHTAB_TOKEN || 'your_super_secret_osint_token';
const INPUT_CSV = process.env.INPUT_CSV || 'master-data-gmaps.csv';
const OUTPUT_XLSX = process.env.OUTPUT_XLSX || 'master-data-enriched.xlsx';
// LIMIT=5 processes only the first 5 rows -- use this to smoke-test before a full run.
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 0;

// Must stay 1. PinchTab's HTTP API has no per-request tab parameter -- /text reads
// whichever tab is "current", and touching a tab makes it current. Concurrency > 1
// interleaves navigations and silently returns another site's text.
const CONCURRENCY = 1;

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

function isRealEmail(email) {
    if (EMAIL_NOISE.some(noise => email.includes(noise))) return false;
    // Retina asset filenames ("logo@2x.png") and sprite refs match the email regex.
    if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$/i.test(email)) return false;
    if (/^[0-9]+@/.test(email)) return false;
    return true;
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

// Share widgets and tracking pixels sit on nearly every page and match the social
// regexes; they are not the business's own profile.
const SOCIAL_NOISE = /\/(sharer|share|share\.php|tr|plugins|dialog|p|explore|reel|hashtag|login|help|policies|profile\.php)(\/|\?|$)/i;

function firstProfile(matches) {
    if (!matches) return '';
    return matches.find(url => {
        const path = url.replace(/^https?:\/\/[^/]+/i, '') || '/';
        return !SOCIAL_NOISE.test(`${path}?`);
    }) || '';
}

// --- Readiness ---
// /health answers 200 as soon as the process binds, but Chrome is lazily started.
// Calling /navigate or /text before defaultInstance.status == "running" returns 503.
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
// One long-lived tab, reused for every URL. Two reasons:
//   1. There is no DELETE /tabs/{id} route, so opening a tab per row leaks tabs
//      until maxTabs eviction kicks in.
//   2. Upstream #621: opening a new tab per navigation returns a deterministic
//      "503 new tab did not load in time" on ad/consent-heavy pages, because the
//      readiness poll latches onto a permanently-loading ad frame. Reusing a tab
//      goes through Page.navigate instead and completes in ~1.5s.
async function openWorkTab(instanceId) {
    const res = await api.post(`/instances/${instanceId}/tabs/open`, { url: 'about:blank' });
    const tabId = res.data.tabId;
    console.log(`[*] Reusing work tab: ${tabId}`);
    return tabId;
}

// Requires security.allowEvaluate = true. Degrades to text-only if eval is denied
// rather than failing the row outright.
async function getLinks() {
    try {
        const res = await api.post('/evaluate', { expression: HREF_EXPRESSION });
        const raw = res.data?.result;
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(list) ? [...new Set(list)] : [];
    } catch (error) {
        return [];
    }
}

async function scrapeWebsite(url, tabId) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            // Navigate the existing tab (NOT a new tab -- see openWorkTab).
            await api.post(`/tabs/${tabId}/navigate`, { url });

            // Let client-side rendering and any AutoSolver challenge settle.
            await sleep(RENDER_WAIT_MS);

            // mode=raw returns document.body.innerText. The default (Readability)
            // strips headers/footers/nav -- exactly where contact details live.
            const textRes = await api.get('/text', {
                params: { mode: 'raw', maxChars: 400000 }
            });

            const pageText = textRes.data?.text || '';
            const links = await getLinks();

            if (!pageText.trim() && !links.length) throw new Error('empty page');

            // Feed visible text AND hrefs through the same regex pass.
            return extractData(`${pageText}\n${links.join('\n')}`);
        } catch (error) {
            const status = error.response?.status;
            const detail = error.response?.data?.error || error.message;

            if (attempt === MAX_ATTEMPTS) {
                console.error(`    [-] Failed ${url} after ${MAX_ATTEMPTS} attempts: ${status || ''} ${detail}`);
                return null;
            }

            // 503 = Chrome busy/restarting; back off longer before retrying.
            const backoff = status === 503 ? 8000 * attempt : 2000 * attempt;
            console.warn(`    [!] Attempt ${attempt} failed (${status || 'net'}: ${detail}) - retrying in ${backoff}ms`);
            await sleep(backoff);
        }
    }
    return null;
}

// --- Output ---
function saveWorkbook(rows) {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Enriched Data');
    XLSX.writeFile(wb, OUTPUT_XLSX);
}

// --- Main Execution ---
async function main() {
    if (!fs.existsSync(INPUT_CSV)) {
        console.error(`[-] Input file not found: ${INPUT_CSV}`);
        process.exit(1);
    }

    // 1. Wait for Chrome, then grab one reusable tab
    const instanceId = await waitForBrowser();
    const tabId = await openWorkTab(instanceId);

    // 2. Read the CSV
    const wb = XLSX.readFile(INPUT_CSV);
    let ws = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });

    console.log(`[*] Loaded ${ws.length} rows from ${INPUT_CSV}`);
    if (LIMIT > 0) {
        ws = ws.slice(0, LIMIT);
        console.log(`[*] LIMIT set - processing first ${ws.length} rows only`);
    }

    // 3. Setup Concurrency Queue
    const queue = new PQueue({ concurrency: CONCURRENCY });
    const enrichedData = [];
    let processed = 0;
    let hits = 0;

    for (const row of ws) {
        queue.add(async () => {
            const website = (row['Website'] || '').trim();

            if (!/^https?:\/\//i.test(website)) {
                console.log(`[+] Skipping invalid URL: ${website || 'N/A'}`);
                enrichedData.push(row);
                return;
            }

            processed++;
            console.log(`[+] (${processed}/${ws.length}) Scraping: ${website}`);
            const siteData = await scrapeWebsite(website, tabId);

            if (siteData) {
                if (siteData.scraped_emails.length) hits++;
                enrichedData.push({
                    ...row,
                    'Scraped Emails': siteData.scraped_emails.join(', '),
                    'WhatsApp': siteData.whatsapp_numbers.join(', '),
                    'LinkedIn': siteData.linkedin || row['linkedin'],
                    'Facebook': siteData.facebook || row['facebook'],
                    'Instagram': siteData.instagram || row['instagram']
                });
            } else {
                enrichedData.push(row); // Push original row if scraping failed
            }

            // Flush periodically so a crash 3000 rows in doesn't lose everything.
            if (enrichedData.length % SAVE_EVERY === 0) {
                saveWorkbook(enrichedData);
                console.log(`    [*] Checkpoint saved (${enrichedData.length} rows, ${hits} with emails)`);
            }
        });
    }

    await queue.onIdle();
    console.log('[*] Scraping complete. Generating Excel file...');

    saveWorkbook(enrichedData);
    console.log(`[*] Data successfully saved to ${OUTPUT_XLSX} (${hits} sites yielded emails)`);
}

main();
