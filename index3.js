const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const readline = require('readline');

puppeteer.use(StealthPlugin());

const CONFIG = {
    MAX_PAGES: 10,
    DELAY_MIN: 4000,
    DELAY_MAX: 8000,
    HEADLESS: false, // Must be false so you can log in
    COOKIES_FILE: 'cookies.json',
    OUTPUT_FILE: 'results.json'
};

const searches = [
    { company: "Capgemini", domain: "capgemini.com" },
    { company: "Infosys", domain: "infosys.com" },
    { company: "Wipro", domain: "wipro.com" },
    { company: "CashKaro", domain: "cashkaro.com" }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => sleep(CONFIG.DELAY_MIN + Math.random() * (CONFIG.DELAY_MAX - CONFIG.DELAY_MIN));

const askQuestion = (query) => new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, ans => { rl.close(); resolve(ans); });
});

function extractEmails(text, targetDomain) {
    const regex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi;
    const blacklist = ['example.com', 'linkedin.com', '.png', '.jpg', 'domain.com', 'email.com', 'test.com'];
    const found = (text.match(regex) || []).map(e => e.toLowerCase()).filter(e => !blacklist.some(b => e.includes(e)));
    const unique = [...new Set(found)];
    return {
        domain: unique.filter(e => e.includes(targetDomain)),
        other: unique.filter(e => !e.includes(targetDomain))
    };
}

class ManualLoginScraper {
    constructor() {
        this.browser = null;
        this.page = null;
        this.results = [];
    }

    async init() {
        console.log('🚀 Launching browser...\n');
        this.browser = await puppeteer.launch({
            headless: CONFIG.HEADLESS,
            args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1920,1080']
        });
        this.page = await this.browser.newPage();
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    }

    async saveCookies() {
        const cookies = await this.page.cookies();
        fs.writeFileSync(CONFIG.COOKIES_FILE, JSON.stringify(cookies, null, 2));
        console.log('💾 Fresh cookies saved for future runs.');
    }

    async waitForManualLogin() {
        console.log('🔗 Opening LinkedIn login page...\n');
        await this.page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });

        console.log('='.repeat(60));
        console.log('✋ MANUAL LOGIN REQUIRED');
        console.log('👉 Please log into LinkedIn in the browser window.');
        console.log('👉 Solve any puzzles/CAPTCHAs if they appear.');
        console.log('='.repeat(60));
        
        await askQuestion('\n⏳ Press ENTER once you are fully logged in and see your feed...');

        // Verify they actually logged in
        const url = this.page.url();
        if (url.includes('/login') || url.includes('/checkpoint')) {
            console.log('❌ You are still on the login/checkpoint page. Exiting.');
            process.exit(1);
        }

        console.log('\n✅ Login detected! Taking over automation...\n');
        await this.saveCookies();
    }

    async safeGoto(url) {
        try {
            // domcontentloaded is crucial to avoid timeouts
            await Promise.race([
                this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }),
                sleep(45000)
            ]);
            await sleep(3000); // Wait for React to render search results
        } catch (e) {
            console.log('   ⏱️ Slow page load, continuing anyway...');
        }
    }

    async humanScroll() {
        try {
            const height = await this.page.evaluate(() => document.body.scrollHeight);
            let pos = 0;
            while (pos < height * 0.7) {
                pos += 400 + Math.random() * 300;
                await this.page.evaluate((p) => window.scrollTo({ top: p, behavior: 'smooth' }), pos).catch(() => {});
                await sleep(1500);
            }
            await this.page.evaluate(() => window.scrollTo({ top: 0 })).catch(() => {});
        } catch (e) {}
    }

    async processCompany(searchItem) {
        console.log('\n' + '='.repeat(60));
        console.log(`🏢 ${searchItem.company} (${searchItem.domain})`);
        console.log('='.repeat(60));

        const result = { 
            company: searchItem.company, 
            domain: searchItem.domain, 
            emails: { domain: [], other: [] } 
        };
        
        const baseUrl = `https://www.linkedin.com/search/results/content/?keywords=@${searchItem.company}&origin=FACETED_SEARCH`;

        for (let i = 1; i <= CONFIG.MAX_PAGES; i++) {
            const url = i === 1 ? baseUrl : `${baseUrl}&page=${i}`;
            console.log(`\n📄 Scraping Page ${i}...`);

            try {
                await this.safeGoto(url);

                // Check if session died during scrape
                if (this.page.url().includes('/login')) {
                    console.log('❌ Session expired during scraping. Stopping.');
                    break;
                }

                await this.humanScroll();

                // Extract data safely (prevents Detached Frame crashes)
                const content = await this.page.evaluate(() => {
                    const cards = [];
                    document.querySelectorAll('.reusable-search__result-container, .entity-result').forEach(el => {
                        const titleEl = el.querySelector('.entity-result__title-text a');
                        cards.push({ 
                            title: titleEl?.textContent?.trim() || '', 
                            link: titleEl?.href || '', 
                            fullText: el.innerText || '' 
                        });
                    });
                    return { cards, bodyText: document.body.innerText };
                }).catch(() => ({ cards: [], bodyText: '' })); // Fail gracefully

                if (!content.cards.length) {
                    console.log('   ⚠️ No results found on this page.');
                    break;
                }

                // Extract emails from entire page text
                const pageEmails = extractEmails(content.bodyText, searchItem.domain);
                result.emails.domain.push(...pageEmails.domain);
                result.emails.other.push(...pageEmails.other);

                // Extract emails from individual cards
                content.cards.forEach(card => {
                    const cardEmails = extractEmails(card.fullText, searchItem.domain);
                    result.emails.domain.push(...cardEmails.domain);
                    result.emails.other.push(...cardEmails.other);
                });

                // Remove duplicates
                result.emails.domain = [...new Set(result.emails.domain)];
                result.emails.other = [...new Set(result.emails.other)];

                console.log(`   📧 Found: ${result.emails.domain.length} domain, ${result.emails.other.length} other`);

                // Try to go to next page
                const nextBtn = await this.page.$('button[aria-label="Next"]:not([disabled])').catch(() => null);
                if (!nextBtn) {
                    console.log('   🛑 No more pages.');
                    break;
                }
                
                await nextBtn.click().catch(() => {});
                await randomDelay();

            } catch (error) {
                console.log(`   ❌ Error on page ${i}: ${error.message}`);
                break;
            }
        }
        
        return result;
    }

    async run() {
        try {
            await this.init();
            await this.waitForManualLogin(); // <-- SCRIPT PAUSES HERE

            // --- FULLY AUTOMATED FROM HERE ---
            for (const search of searches) {
                const res = await this.processCompany(search);
                if (res) this.results.push(res);
                
                // Auto-save after every company
                fs.writeFileSync(CONFIG.OUTPUT_FILE, JSON.stringify(this.results, null, 2));
                
                // Long delay between companies to mimic human behavior
                await sleep(8000 + Math.random() * 7000); 
            }

            this.printSummary();

        } catch (error) {
            console.error(`\n❌ FATAL ERROR: ${error.message}`);
        } finally {
            if (this.browser) await this.browser.close();
            console.log('\n🔒 Browser closed.');
        }
    }

    printSummary() {
        console.log('\n' + '='.repeat(60));
        console.log('📊 FINAL SUMMARY');
        console.log('='.repeat(60));
        let totalDomain = 0;
        let totalOther = 0;

        this.results.forEach(r => {
            totalDomain += r.emails.domain.length;
            totalOther += r.emails.other.length;
            console.log(`\n🏢 ${r.company} (${r.domain})`);
            console.log(`   Target Emails (${r.emails.domain.length}):`);
            r.emails.domain.forEach(e => console.log(`      ✉️  ${e}`));
            console.log(`   Other Emails (${r.emails.other.length}):`);
            r.emails.other.forEach(e => console.log(`      ✉️  ${e}`));
        });

        console.log('\n' + '-'.repeat(60));
        console.log(`📈 TOTAL TARGET EMAILS: ${totalDomain}`);
        console.log(`📈 TOTAL OTHER EMAILS: ${totalOther}`);
        console.log('-'.repeat(60));
        console.log(`\n📁 Results saved to: ${CONFIG.OUTPUT_FILE}`);
    }
}

// Start
new ManualLoginScraper().run();