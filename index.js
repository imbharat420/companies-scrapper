const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const readline = require('readline');

puppeteer.use(StealthPlugin());

const CONFIG = {
    MAX_PAGES: 10,
    DELAY_MIN: 5000, // Slower = safer
    DELAY_MAX: 10000,
    HEADLESS: false, // MUST BE FALSE to solve captchas
    COOKIES_FILE: 'cookies.json',
    OUTPUT_FILE: 'results.json'
};

const searches = [
    {
        "company": "Cognizant",
        "domain": "cognizant.com"
    },
    {
        "company": "LTIMindtree",
        "domain": "ltimindtree.com"
    },
    {
        "company": "Tata Consultancy Services",
        "domain": "tcs.com"
    },
    {
        "company": "DXC Technology",
        "domain": "dxc.com"
    },
    {
        "company": "HCLTech",
        "domain": "hcltech.com"
    },
    {
        "company": "HashedIn by Deloitte",
        "domain": "hashedin.com"
    },
    {
        "company": "Hexaware Technologies",
        "domain": "hexaware.com"
    },
    {
        "company": "Revature",
        "domain": "revature.com"
    },
    {
        "company": "IBM",
        "domain": "ibm.com"
    },
    {
        "company": "Nagarro",
        "domain": "nagarro.com"
    },
    {
        "company": "Virtusa",
        "domain": "virtusa.com"
    },
    {
        "company": "Zoho",
        "domain": "zohocorp.com"
    },
    {
        "company": "CGI",
        "domain": "cgi.com"
    },
    {
        "company": "Finastra",
        "domain": "finastra.com"
    },
    {
        "company": "FIS",
        "domain": "fisglobal.com"
    },
    {
        "company": "Fiserv",
        "domain": "fiserv.com"
    },
    {
        "company": "IQVIA",
        "domain": "iqvia.com"
    },
    {
        "company": "Jio",
        "domain": "jio.com"
    },
    {
        "company": "MAQ Software",
        "domain": "maqsoftware.com"
    },
    {
        "company": "Optum",
        "domain": "optum.com"
    },
    {
        "company": "Publicis Sapient",
        "domain": "publicissapient.com"
    },
    {
        "company": "GeekyAnts",
        "domain": "geekyants.com"
    },
    {
        "company": "Accolite Digital",
        "domain": "accolite.com"
    },
    {
        "company": "Airtel",
        "domain": "airtel.com"
    },
    {
        "company": "Electronic Arts",
        "domain": "ea.com"
    },
    {
        "company": "Gartner",
        "domain": "gartner.com"
    },
    {
        "company": "HARMAN",
        "domain": "harman.com"
    },
    {
        "company": "Yellow.ai",
        "domain": "yellow.ai"
    },
    {
        "company": "Siemens",
        "domain": "siemens.com"
    },
    {
        "company": "Samsung",
        "domain": "samsung.com"
    },
    {
        "company": "VMware",
        "domain": "vmware.com"
    },
    {
        "company": "Adobe",
        "domain": "adobe.com"
    },
    {
        "company": "Amazon",
        "domain": "amazon.com"
    },
    {
        "company": "Cadence",
        "domain": "cadence.com"
    },
    {
        "company": "CleverTap",
        "domain": "clevertap.com"
    },
    {
        "company": "Cisco",
        "domain": "cisco.com"
    },
    {
        "company": "Dunzo",
        "domain": "dunzo.com"
    },
    {
        "company": "FamPay",
        "domain": "fampay.in"
    },
    {
        "company": "Flipkart",
        "domain": "flipkart.com"
    },
    {
        "company": "Google",
        "domain": "google.com"
    },
    {
        "company": "HackerEarth",
        "domain": "hackerearth.com"
    },
    {
        "company": "Morgan Stanley",
        "domain": "morganstanley.com"
    },
    {
        "company": "EY",
        "domain": "ey.com"
    },
    {
        "company": "MyGate",
        "domain": "mygate.com"
    },
    {
        "company": "McAfee",
        "domain": "mcafee.com"
    },
    {
        "company": "Oracle",
        "domain": "oracle.com"
    },
    {
        "company": "Microsoft",
        "domain": "microsoft.com"
    },
    {
        "company": "PhonePe",
        "domain": "phonepe.com"
    },
    {
        "company": "PwC",
        "domain": "pwc.com"
    },
    {
        "company": "Rakuten",
        "domain": "rakuten.com"
    },
    {
        "company": "Razorpay",
        "domain": "razorpay.com"
    },
    {
        "company": "SAP",
        "domain": "sap.com"
    },
    {
        "company": "Media.net",
        "domain": "media.net"
    },
    {
        "company": "Twilio",
        "domain": "twilio.com"
    },
    {
        "company": "IKEA",
        "domain": "ikea.com"
    },
    {
        "company": "Accenture",
        "domain": "accenture.com"
    },
]

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => sleep(CONFIG.DELAY_MIN + Math.random() * (CONFIG.DELAY_MAX - CONFIG.DELAY_MIN));

// Ask for user input in terminal
const askQuestion = (query) => new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, ans => { rl.close(); resolve(ans); });
});

function extractEmails(text, targetDomain) {
    const regex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi;
    const blacklist = ['example.com', 'linkedin.com', '.png', '.jpg', 'domain.com', 'email.com'];
    const found = (text.match(regex) || []).map(e => e.toLowerCase()).filter(e => !blacklist.some(b => e.includes(b)));
    const unique = [...new Set(found)];
    return {
        domain: unique.filter(e => e.includes(targetDomain)),
        other: unique.filter(e => !e.includes(targetDomain))
    };
}

class SafeLinkedInScraper {
    constructor() {
        this.browser = null;
        this.page = null;
        this.results = [];
        this.isBlocked = false;
    }

    async init() {
        console.log('🚀 Initializing safe browser...\n');
        const cookies = this.cleanCookies(JSON.parse(fs.readFileSync(CONFIG.COOKIES_FILE, 'utf8')));

        this.browser = await puppeteer.launch({
            headless: CONFIG.HEADLESS,
            args: [
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1920,1080'
            ]
        });

        this.page = await this.browser.newPage();
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await this.page.setCookie(...cookies);
        console.log('✅ Cookies applied\n');
    }

    cleanCookies(raw) {
        return raw.map(c => ({
            name: c.name, value: String(c.value).replace(/\s+/g, ''),
            domain: c.domain, path: c.path || '/', secure: c.secure || false,
            httpOnly: c.httpOnly || false, sameSite: 'None', expires: c.expirationDate || -1
        }));
    }

    // ✅ FIX: Detects security checkpoints, logins, and captchas
    async detectSecurityChallenge() {
        const url = this.page.url();
        if (url.includes('/login') || url.includes('/uas/login') || url.includes('/checkpoint')) {
            return true;
        }

        // Check page text for hidden challenges
        const bodyText = await this.page.evaluate(() => document.body?.innerText || '').catch(() => '');
        const challengeKeywords = [
            'security verification', 'let\'s do a quick check', 'unusual activity',
            'automated access', 'verify your identity', 'checkpoint', 'suspicious activity'
        ];

        if (challengeKeywords.some(kw => bodyText.toLowerCase().includes(kw))) {
            return true;
        }

        return false;
    }

    // ✅ FIX: Pause script and wait for manual captcha solve
    async handleChallengeAndWait() {
        console.log('\n' + '='.repeat(60));
        console.log('🚨 SECURITY CHALLENGE DETECTED!');
        console.log('LinkedIn wants you to verify your identity.');
        console.log('👉 Please complete the puzzle/CAPTCHA in the browser window.');
        console.log('='.repeat(60));
        
        await askQuestion('\n⏳ Press ENTER once you have solved the challenge and see the LinkedIn feed...');

        // Re-check after user presses enter
        if (await this.detectSecurityChallenge()) {
            console.log('❌ Still on security page. Aborting to protect account.');
            this.isBlocked = true;
            return false;
        }
        
        console.log('✅ Challenge bypassed! Resuming...\n');
        return true;
    }

    async safeGoto(url) {
        try {
            await Promise.race([
                this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }),
                sleep(45000)
            ]);
            await sleep(3000); // Wait for React render
        } catch (e) {
            console.log('   ⏱️ Slow load, continuing...');
        }

        // Critical check: Did we hit a security wall?
        if (await this.detectSecurityChallenge()) {
            const resolved = await this.handleChallengeAndWait();
            if (!resolved) throw new Error('Account blocked by security challenge');
        }
    }

    async validateSession() {
        console.log('🔍 Validating session...');
        await this.safeGoto('https://www.linkedin.com/feed/');

        // Double check we are actually logged in
        const hasFeed = await this.page.evaluate(() => {
            return !!(document.querySelector('.feed-identity-module') || document.querySelector('.scaffold-layout__main'));
        }).catch(() => false);

        if (!hasFeed && !this.isBlocked) {
            console.log('❌ Could not find feed. Session may be invalid.');
            return false;
        }

        return !this.isBlocked;
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
        } catch (e) {
            // Ignore detached frame errors during scroll
        }
    }

    async processCompany(searchItem) {
        if (this.isBlocked) return null;

        console.log('\n' + '='.repeat(60));
        console.log(`🏢 ${searchItem.company} (${searchItem.domain})`);
        console.log('='.repeat(60));

        const result = { company: searchItem.company, domain: searchItem.domain, emails: { domain: [], other: [] } };
        const baseUrl = `https://www.linkedin.com/search/results/content/?keywords=@${searchItem.company}&origin=FACETED_SEARCH`;

        for (let i = 1; i <= CONFIG.MAX_PAGES; i++) {
            if (this.isBlocked) break;
            
            const url = i === 1 ? baseUrl : `${baseUrl}&page=${i}`;
            console.log(`\n📄 Page ${i}`);

            try {
                await this.safeGoto(url);
                await this.humanScroll();

                // Safely extract content (wrapped in try/catch to prevent detached frame crashes)
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
                }).catch(() => ({ cards: [], bodyText: '' })); // Fail gracefully on detached frame

                if (!content.cards.length) {
                    console.log('   ⚠️ No results found.');
                    break;
                }

                // Extract emails
                const pageEmails = extractEmails(content.bodyText, searchItem.domain);
                result.emails.domain.push(...pageEmails.domain);
                result.emails.other.push(...pageEmails.other);

                content.cards.forEach(card => {
                    const cardEmails = extractEmails(card.fullText, searchItem.domain);
                    result.emails.domain.push(...cardEmails.domain);
                    result.emails.other.push(...cardEmails.other);
                });

                // Deduplicate
                result.emails.domain = [...new Set(result.emails.domain)];
                result.emails.other = [...new Set(result.emails.other)];

                console.log(`   📧 Found: ${result.emails.domain.length} domain, ${result.emails.other.length} other`);

                // Next page
                const hasNext = await this.page.$('button[aria-label="Next"]:not([disabled])').catch(() => null);
                if (!hasNext) break;
                await hasNext.click().catch(() => {});
                await randomDelay();

            } catch (error) {
                console.log(`   ❌ Stopping: ${error.message}`);
                break;
            }
        }

        return result;
    }

    async run() {
        try {
            await this.init();
            
            if (!(await this.validateSession())) {
                throw new Error('Invalid session. Please re-export cookies from a normal browser.');
            }

            for (const search of searches) {
                const res = await this.processCompany(search);
                if (res) this.results.push(res);
                fs.writeFileSync(CONFIG.OUTPUT_FILE, JSON.stringify(this.results, null, 2));
                await sleep(10000); // Long delay between companies
            }

            this.printSummary();

        } catch (error) {
            console.error(`\n❌ FATAL: ${error.message}`);
        } finally {
            // Keep browser open if blocked so user can see why
            if (this.isBlocked) {
                console.log('\n🔒 Browser left open for you to inspect. Press CTRL+C to close.');
            } else if (this.browser) {
                await this.browser.close();
            }
        }
    }

    printSummary() {
        console.log('\n' + '='.repeat(60));
        console.log('📊 FINAL SUMMARY');
        console.log('='.repeat(60));
        this.results.forEach(r => {
            console.log(`\n🏢 ${r.company}: ${r.emails.domain.length} domain, ${r.emails.other.length} other`);
            r.emails.domain.forEach(e => console.log(`   ✉️  ${e}`));
        });
    }
}

new SafeLinkedInScraper().run();