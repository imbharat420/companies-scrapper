const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const readline = require('readline');

puppeteer.use(StealthPlugin());

const CONFIG = {
    MAX_PAGES: 10,
    DELAY_MIN: 4000,
    DELAY_MAX: 8000,
    HEADLESS: false,
    OUTPUT_FILE: 'results.json'
};

// const searches = [
//     {
//         "company": "Cognizant",
//         "domain": "cognizant.com"
//     },
//     {
//         "company": "LTIMindtree",
//         "domain": "ltimindtree.com"
//     },
//     {
//         "company": "Tata Consultancy Services",
//         "domain": "tcs.com"
//     },
//     {
//         "company": "DXC Technology",
//         "domain": "dxc.com"
//     },
//     {
//         "company": "HCLTech",
//         "domain": "hcltech.com"
//     },
//     {
//         "company": "HashedIn by Deloitte",
//         "domain": "hashedin.com"
//     },
//     {
//         "company": "Hexaware Technologies",
//         "domain": "hexaware.com"
//     },
//     {
//         "company": "Revature",
//         "domain": "revature.com"
//     },
//     {
//         "company": "IBM",
//         "domain": "ibm.com"
//     },
//     {
//         "company": "Nagarro",
//         "domain": "nagarro.com"
//     },
//     {
//         "company": "Virtusa",
//         "domain": "virtusa.com"
//     },
//     {
//         "company": "Zoho",
//         "domain": "zohocorp.com"
//     },
//     {
//         "company": "CGI",
//         "domain": "cgi.com"
//     },
//     {
//         "company": "Finastra",
//         "domain": "finastra.com"
//     },
//     {
//         "company": "FIS",
//         "domain": "fisglobal.com"
//     },
//     {
//         "company": "Fiserv",
//         "domain": "fiserv.com"
//     },
//     {
//         "company": "IQVIA",
//         "domain": "iqvia.com"
//     },
//     {
//         "company": "Jio",
//         "domain": "jio.com"
//     },
//     {
//         "company": "MAQ Software",
//         "domain": "maqsoftware.com"
//     },
//     {
//         "company": "Optum",
//         "domain": "optum.com"
//     },
//     {
//         "company": "Publicis Sapient",
//         "domain": "publicissapient.com"
//     },
//     {
//         "company": "GeekyAnts",
//         "domain": "geekyants.com"
//     },
//     {
//         "company": "Accolite Digital",
//         "domain": "accolite.com"
//     },
//     {
//         "company": "Airtel",
//         "domain": "airtel.com"
//     },
//     {
//         "company": "Electronic Arts",
//         "domain": "ea.com"
//     },
//     {
//         "company": "Gartner",
//         "domain": "gartner.com"
//     },
//     {
//         "company": "HARMAN",
//         "domain": "harman.com"
//     },
//     {
//         "company": "Yellow.ai",
//         "domain": "yellow.ai"
//     },
//     {
//         "company": "Siemens",
//         "domain": "siemens.com"
//     },
//     {
//         "company": "Samsung",
//         "domain": "samsung.com"
//     },
//     {
//         "company": "VMware",
//         "domain": "vmware.com"
//     },
//     {
//         "company": "Adobe",
//         "domain": "adobe.com"
//     },
//     {
//         "company": "Amazon",
//         "domain": "amazon.com"
//     },
//     {
//         "company": "Cadence",
//         "domain": "cadence.com"
//     },
//     {
//         "company": "CleverTap",
//         "domain": "clevertap.com"
//     },
//     {
//         "company": "Cisco",
//         "domain": "cisco.com"
//     },
//     {
//         "company": "Dunzo",
//         "domain": "dunzo.com"
//     },
//     {
//         "company": "FamPay",
//         "domain": "fampay.in"
//     },
//     {
//         "company": "Flipkart",
//         "domain": "flipkart.com"
//     },
//     {
//         "company": "Google",
//         "domain": "google.com"
//     },
//     {
//         "company": "HackerEarth",
//         "domain": "hackerearth.com"
//     },
//     {
//         "company": "Morgan Stanley",
//         "domain": "morganstanley.com"
//     },
//     {
//         "company": "EY",
//         "domain": "ey.com"
//     },
//     {
//         "company": "MyGate",
//         "domain": "mygate.com"
//     },
//     {
//         "company": "McAfee",
//         "domain": "mcafee.com"
//     },
//     {
//         "company": "Oracle",
//         "domain": "oracle.com"
//     },
//     {
//         "company": "Microsoft",
//         "domain": "microsoft.com"
//     },
//     {
//         "company": "PhonePe",
//         "domain": "phonepe.com"
//     },
//     {
//         "company": "PwC",
//         "domain": "pwc.com"
//     },
//     {
//         "company": "Rakuten",
//         "domain": "rakuten.com"
//     },
//     {
//         "company": "Razorpay",
//         "domain": "razorpay.com"
//     },
//     {
//         "company": "SAP",
//         "domain": "sap.com"
//     },
//     {
//         "company": "Media.net",
//         "domain": "media.net"
//     },
//     {
//         "company": "Twilio",
//         "domain": "twilio.com"
//     },
//     {
//         "company": "IKEA",
//         "domain": "ikea.com"
//     },
//     {
//         "company": "Accenture",
//         "domain": "accenture.com"
//     },
// ]

const searches = [
    {
        "company": "ASMUTEK",
        "domain": "asmutek.com"
    },
    {
        "company": "Hired",
        "domain": "hired.com"
    },
    {
        "company": "RytHirings",
        "domain": "rythirings.com"
    },
    {
        "company": "Wake Up Whistle",
        "domain": "wakeupwhistle.com"
    },
    {
        "company": "Zenithbyte",
        "domain": "zenithbyte.com"
    },
    {
        "company": "Flexiple",
        "domain": "flexiple.com"
    },
    {
        "company": "Jobs Ai",
        "domain": "jobs.ai"
    },
    {
        "company": "internmo",
        "domain": "internmo.com"
    },
    {
        "company": "Adobe",
        "domain": "adobe.com"
    },
    {
        "company": "WebBoost Solutions by UM",
        "domain": "webboostsolutions.com"
    },
    {
        "company": "Dexter's Tech",
        "domain": "dexterstech.com"
    },
    {
        "company": "Web Nova Crew Technologies",
        "domain": "webnovacrew.com"
    },
    {
        "company": "MediNex Workforce",
        "domain": "medinexworkforce.com"
    },
    {
        "company": "ReraTracker",
        "domain": "reratracker.com"
    },
    {
        "company": "DigitalXNode",
        "domain": "digitalxnode.com"
    },
    {
        "company": "Scoutit",
        "domain": "scoutit.com"
    },
    {
        "company": "SWAKIO",
        "domain": "swakio.com"
    },
    {
        "company": "DataLunix",
        "domain": "datalunix.com"
    },
    {
        "company": "Deloitte",
        "domain": "deloitte.com"
    },
    {
        "company": "EPAM Systems",
        "domain": "epam.com"
    },
    {
        "company": "Capgemini",
        "domain": "capgemini.com"
    },
    {
        "company": "Qualcomm",
        "domain": "qualcomm.com"
    },
    {
        "company": "avua",
        "domain": "avua.com"
    },
    {
        "company": "ZeroNotice",
        "domain": "zeronotice.com"
    },
    {
        "company": "Flipkart",
        "domain": "flipkart.com"
    },
    {
        "company": "Infoplus Technologies UK Limited",
        "domain": "infoplussolutions.co.uk"
    },
    {
        "company": "SNB Innovations",
        "domain": "snbinnovations.com"
    },
    {
        "company": "Tesco Technology",
        "domain": "tesco.com"
    },
    {
        "company": "Microsoft",
        "domain": "microsoft.com"
    },
    {
        "company": "Light & Wonder",
        "domain": "lnw.com"
    },
    {
        "company": "Google",
        "domain": "google.com"
    },
    {
        "company": "HARP",
        "domain": "harp.com"
    },
    {
        "company": "Future Transformation",
        "domain": "futuretransformation.com"
    },
    {
        "company": "Anginat Learning",
        "domain": "anginat.com"
    },
    {
        "company": "Carelon Global Solutions India",
        "domain": "carelon.com"
    },
    {
        "company": "Duruper",
        "domain": "duruper.com"
    },
    {
        "company": "Payoneer",
        "domain": "payoneer.com"
    },
    {
        "company": "KAAPRO",
        "domain": "kaapro.com"
    },
    {
        "company": "GoodSpace AI",
        "domain": "goodspace.ai"
    },
    {
        "company": "Swiggy",
        "domain": "swiggy.com"
    },
    {
        "company": "Policybazaar.com",
        "domain": "policybazaar.com"
    },
    {
        "company": "Clearwater Analytics",
        "domain": "clearwateranalytics.com"
    },
    {
        "company": "Crossing Hurdles",
        "domain": "crossinghurdles.com"
    },
    {
        "company": "CareerXperts Consulting",
        "domain": "careerxperts.com"
    },
    {
        "company": "SentinelOne",
        "domain": "sentinelone.com"
    },
    {
        "company": "Apple",
        "domain": "apple.com"
    },
    {
        "company": "DIGIIQ IT SOLUTION PRIVATE LIMITED",
        "domain": "digiiq.com"
    },
    {
        "company": "HRM Counsel",
        "domain": "hrmcounsel.com"
    },
    {
        "company": "DigitalOcean",
        "domain": "digitalocean.com"
    },
    {
        "company": "Seismic",
        "domain": "seismic.com"
    },
    {
        "company": "Recro",
        "domain": "recro.io"
    },
    {
        "company": "Career Sync",
        "domain": "careersync.com"
    },
    {
        "company": "Infosys",
        "domain": "infosys.com"
    },
    {
        "company": "IDX",
        "domain": "idx.com"
    },
    {
        "company": "NTT DATA North America",
        "domain": "nttdata.com"
    },
    {
        "company": "StudyECart Technologies Pvt Ltd",
        "domain": "studyecart.com"
    },
    {
        "company": "KAKAPO Systems India Pvt. Ltd.",
        "domain": "kakaposystems.com"
    },
    {
        "company": "AlgoSec",
        "domain": "algosec.com"
    },
    {
        "company": "BJAK",
        "domain": "bjak.id"
    },
    {
        "company": "Janitri",
        "domain": "janitri.in"
    },
    {
        "company": "SMEC (an SJ Group company)",
        "domain": "smec.com"
    },
    {
        "company": "WrkTalk DigiSec AI Pvt Ltd",
        "domain": "wrktalk.com"
    },
    {
        "company": "InfiVR",
        "domain": "infivr.com"
    },
    {
        "company": "Quest Global",
        "domain": "quest-global.com"
    },
    {
        "company": "UST",
        "domain": "ust.com"
    },
    {
        "company": "SimCorp",
        "domain": "simcorp.com"
    },
    {
        "company": "FirstCron",
        "domain": "firstcron.com"
    },
    {
        "company": "Epicor",
        "domain": "epicor.com"
    },
    {
        "company": "AtiSunya Microsoft Solution Provider",
        "domain": "atisunya.com"
    },
    {
        "company": "SourcingXPress",
        "domain": "sourcingxpress.com"
    },
    {
        "company": "Just Move In",
        "domain": "justmovein.com"
    },
    {
        "company": "Rocksync",
        "domain": "rocksync.com"
    },
    {
        "company": "Accenture in India",
        "domain": "accenture.com"
    },
    {
        "company": "Mindrift",
        "domain": "mindrift.com"
    },
    {
        "company": "Wipro",
        "domain": "wipro.com"
    },
    {
        "company": "ArGo Intern",
        "domain": "argointern.com"
    },
    {
        "company": "Talentd",
        "domain": "talentd.com"
    },
    {
        "company": "Emburse",
        "domain": "emburse.com"
    },
    {
        "company": "GlobalLogic",
        "domain": "globallogic.com"
    },
    {
        "company": "Cibronix Software Pvt Ltd",
        "domain": "cibronix.com"
    },
    {
        "company": "CodeRound AI",
        "domain": "coderound.ai"
    },
    {
        "company": "Cognizant",
        "domain": "cognizant.com"
    },
    {
        "company": "Siemens",
        "domain": "siemens.com"
    },
    {
        "company": "IBM",
        "domain": "ibm.com"
    },
    {
        "company": "Tata Consultancy Services",
        "domain": "tcs.com"
    },
    {
        "company": "United Airlines India Knowledge Center",
        "domain": "united.com"
    },
    {
        "company": "SIFRIA",
        "domain": "sifria.com"
    },
    {
        "company": "Techmagnate - A Digital Marketing Agency",
        "domain": "techmagnate.com"
    },
    {
        "company": "Shunya Ekai Technologies",
        "domain": "shunyaekai.in"
    },
    {
        "company": "Macquarie Group",
        "domain": "macquarie.com"
    },
    {
        "company": "MongoDB",
        "domain": "mongodb.com"
    },
    {
        "company": "TechBliss Digital Solution Pvt. Ltd.",
        "domain": "techblissdigital.com"
    },
    {
        "company": "IQVIA",
        "domain": "iqvia.com"
    },
    {
        "company": "Valerie Group",
        "domain": "valeriegroup.com"
    },
    {
        "company": "Geojit Technologies",
        "domain": "geojit.com"
    },
    {
        "company": "OrbiTouch HR",
        "domain": "orbitouchhr.com"
    },
    {
        "company": "S2Integrators",
        "domain": "s2integrators.com"
    },
    {
        "company": "Webs IT Solution",
        "domain": "websitsolution.com"
    },
    {
        "company": "Revlytic",
        "domain": "revlytic.com"
    },
    {
        "company": "Growtechie",
        "domain": "growtechie.com"
    },
    {
        "company": "Genpact",
        "domain": "genpact.com"
    },
    {
        "company": "HuntingCube",
        "domain": "huntingcube.com"
    },
    {
        "company": "ProSapiens HR",
        "domain": "prosapienshr.com"
    },
    {
        "company": "Policy.Online Insurance Brokers Pvt. Ltd.",
        "domain": "policy.online"
    },
    {
        "company": "Voitekk Softsol Pvt Ltd",
        "domain": "voitekk.com"
    },
    {
        "company": "Cisco",
        "domain": "cisco.com"
    },
    {
        "company": "Cloudera",
        "domain": "cloudera.com"
    },
    {
        "company": "Docusign",
        "domain": "docusign.com"
    },
    {
        "company": "Netomi",
        "domain": "netomi.com"
    },
    {
        "company": "OnHires",
        "domain": "onhires.com"
    },
    {
        "company": "Tecnots",
        "domain": "tecnots.com"
    },
    {
        "company": "Accenture services Pvt Ltd",
        "domain": "accenture.com"
    },
    {
        "company": "Cyfuture",
        "domain": "cyfuture.com"
    },
    {
        "company": "InvarSys",
        "domain": "invarsys.com"
    },
    {
        "company": "American Express",
        "domain": "aexp.com"
    },
    {
        "company": "RytLoop",
        "domain": "rytloop.com"
    },
    {
        "company": "eBay",
        "domain": "ebay.com"
    },
    {
        "company": "WEBBOOST SOLUTION IT SERVICES",
        "domain": "webboostsolution.com"
    },
    {
        "company": "Nexal IIT",
        "domain": "nexaliit.com"
    },
    {
        "company": "MedTourEasy Analytics Department",
        "domain": "medtoureasy.com"
    },
    {
        "company": "RytHiring",
        "domain": "rythiring.com"
    },
    {
        "company": "PwC India",
        "domain": "pwc.in"
    },
    {
        "company": "Hewlett Packard Enterprise",
        "domain": "hpe.com"
    },
    {
        "company": "SKOOLLAGE",
        "domain": "skoollage.com"
    },
    {
        "company": "Citi",
        "domain": "citi.com"
    },
    {
        "company": "FedEx",
        "domain": "fedex.com"
    },
    {
        "company": "Aera Technology",
        "domain": "aeratechnology.com"
    },
    {
        "company": "Omnipresent Robot Tech",
        "domain": "omnipresentrobotics.com"
    },
    {
        "company": "Oracle",
        "domain": "oracle.com"
    },
    {
        "company": "Zetheta Algorithms Private Limited",
        "domain": "zetheta.com"
    },
    {
        "company": "LEARN CONFIDENT",
        "domain": "learnconfident.com"
    },
    {
        "company": "Ravan.AI",
        "domain": "ravan.ai"
    },
    {
        "company": "Amazure Technologies Pvt Ltd",
        "domain": "amazuretech.com"
    },
    {
        "company": "Crossover",
        "domain": "crossover.com"
    },
    {
        "company": "YES BANK",
        "domain": "yesbank.in"
    },
    {
        "company": "ZettaMine Labs Pvt. Ltd.",
        "domain": "zettamine.com"
    },
    {
        "company": "Infinite Computer Solutions",
        "domain": "infics.com"
    },
    {
        "company": "Xapsol Xtramile People Solution Private Limited",
        "domain": "xapsol.com"
    },
    {
        "company": "TrendAI",
        "domain": "trendai.io"
    },
    {
        "company": "UPS",
        "domain": "ups.com"
    },
    {
        "company": "Airbnb",
        "domain": "airbnb.com"
    },
    {
        "company": "New Growth Games",
        "domain": "newgrowthgames.com"
    },
    {
        "company": "Broccoli AI",
        "domain": "broccoli.ai"
    },
    {
        "company": "Jobgether",
        "domain": "jobgether.com"
    },
    {
        "company": "Delphie Consulting services",
        "domain": "delphieconsulting.com"
    },
    {
        "company": "HARMAN India",
        "domain": "harman.com"
    },
    {
        "company": "OREBiT",
        "domain": "orebit.io"
    },
    {
        "company": "Media.net",
        "domain": "media.net"
    },
    {
        "company": "LoansJagat",
        "domain": "loansjagat.com"
    },
    {
        "company": "Kira",
        "domain": "kira.ai"
    }
]

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => sleep(CONFIG.DELAY_MIN + Math.random() * (CONFIG.DELAY_MAX - CONFIG.DELAY_MIN));

const askQuestion = (query) => new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, ans => { rl.close(); resolve(ans); });
});

// ✅ FIX 1: Corrected the blacklist filter logic
function extractEmails(text, targetDomain) {
    const regex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi;
    const blacklist = ['example.com', 'linkedin.com', '.png', '.jpg', '.jpeg', '.svg', 'domain.com', 'email.com', 'test.com', 'yourdomain.com'];
    const validTlds = ['com', 'org', 'net', 'io', 'co', 'in', 'uk', 'us', 'de', 'fr', 'au', 'ca', 'tech', 'dev'];
    
    const found = (text.match(regex) || [])
        .map(e => e.toLowerCase().trim())
        // FIX: Changed e.includes(e) to e.includes(b)
        .filter(e => !blacklist.some(b => e.includes(b))) 
        .filter(e => validTlds.includes(e.split('.').pop()));
    
    const unique = [...new Set(found)];
    
    // Prioritize target domain
    return {
        domain: unique.filter(e => e.endsWith(`@${targetDomain}`)), // Strict match for target
        other: unique.filter(e => !e.endsWith(`@${targetDomain}`))
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

    async waitForManualLogin() {
        console.log('🔗 Opening LinkedIn login page...\n');
        await this.page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });

        console.log('='.repeat(60));
        console.log('✋ MANUAL LOGIN REQUIRED');
        console.log('👉 Please log into LinkedIn in the browser window.');
        console.log('='.repeat(60));
        
        await askQuestion('\n⏳ Press ENTER once you are fully logged in and see your feed...');
        console.log('\n✅ Login detected! Taking over automation...\n');
    }

    async safeGoto(url) {
        try {
            await Promise.race([
                this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }),
                sleep(45000)
            ]);
            await sleep(3000); 
        } catch (e) {
            console.log('   ⏱️ Slow page load, continuing...');
        }
    }

    async humanScroll() {
        try {
            const height = await this.page.evaluate(() => document.body.scrollHeight);
            let pos = 0;
            while (pos < height * 0.8) {
                pos += 400 + Math.random() * 300;
                await this.page.evaluate((p) => window.scrollTo({ top: p, behavior: 'smooth' }), pos).catch(() => {});
                await sleep(1500);
            }
            await this.page.evaluate(() => window.scrollTo({ top: 0 })).catch(() => {});
        } catch (e) {}
    }

    async processCompany(searchItem) {
        console.log('\n' + '='.repeat(60));
        console.log(`🏢 ${searchItem.company} (Target: @${searchItem.domain})`);
        console.log('='.repeat(60));

        const result = { 
            company: searchItem.company, 
            domain: searchItem.domain, 
            emails: { domain: [], other: [] },
            pagesScraped: 0
        };
        
        // ✅ FIX 3: Search for "@domain.com" instead of "@CompanyName"
        const baseUrl = `https://www.linkedin.com/search/results/content/?keywords=%22@${searchItem.domain}%22&origin=FACETED_SEARCH`;

        for (let i = 1; i <= CONFIG.MAX_PAGES; i++) {
            const url = i === 1 ? baseUrl : `${baseUrl}&page=${i}`;
            console.log(`\n📄 Scraping Page ${i}...`);

            try {
                await this.safeGoto(url);

                if (this.page.url().includes('/login')) {
                    console.log('❌ Session expired.');
                    break;
                }

                await this.humanScroll();

                // ✅ FIX 2: Grab page text FIRST, don't rely solely on cards
                const content = await this.page.evaluate(() => {
                    const bodyText = document.body.innerText || '';
                    
                    // Try multiple known LinkedIn card selectors
                    const selectors = [
                        '.reusable-search__result-container',
                        '.entity-result',
                        '.search-result__info',
                        'ul.scaffold-layout__list-container > li' // Fallback generic list
                    ];
                    
                    let cards = [];
                    for (const sel of selectors) {
                        const elements = document.querySelectorAll(sel);
                        if (elements.length > 0) {
                            elements.forEach(el => {
                                const titleEl = el.querySelector('a.app-aware-link, a[data-control-name="search_result"]');
                                cards.push({ 
                                    title: titleEl?.textContent?.trim() || '', 
                                    link: titleEl?.href || '', 
                                    fullText: el.innerText || '' 
                                });
                            });
                            break; // Stop if we found elements
                        }
                    }

                    return { cards, bodyText };
                }).catch(() => ({ cards: [], bodyText: '' }));

                // ✅ FIX 4: DO NOT BREAK if cards are empty! Extract from bodyText anyway.
                if (!content.cards.length) {
                    console.log('   ⚠️ Could not isolate individual posts, scanning full page text...');
                }

                // Always extract from the full page text (most reliable for emails)
                const pageEmails = extractEmails(content.bodyText, searchItem.domain);
                result.emails.domain.push(...pageEmails.domain);
                result.emails.other.push(...pageEmails.other);

                // Also extract from isolated cards if found
                content.cards.forEach(card => {
                    const cardEmails = extractEmails(card.fullText, searchItem.domain);
                    result.emails.domain.push(...cardEmails.domain);
                    result.emails.other.push(...cardEmails.other);
                });

                // Remove duplicates
                result.emails.domain = [...new Set(result.emails.domain)];
                result.emails.other = [...new Set(result.emails.other)];
                result.pagesScraped++;

                console.log(`   📧 Found: ${result.emails.domain.length} target (@${searchItem.domain}), ${result.emails.other.length} other`);

                // Check if we actually got search results
                const noResultsMsg = await this.page.$('.search-results__empty-state, .artdeco-empty-state').catch(() => null);
                if (noResultsMsg) {
                    console.log('   🛑 LinkedIn reports "No results" for this query.');
                    break;
                }

                // Try next page
                const nextBtn = await this.page.$('button[aria-label="Next"]:not([disabled])').catch(() => null);
                if (!nextBtn) {
                    console.log('   🛑 Reached last page.');
                    break;
                }
                
                await nextBtn.click().catch(() => {});
                await randomDelay();

            } catch (error) {
                console.log(`   ❌ Error: ${error.message}`);
                break;
            }
        }
        
        return result;
    }

    async run() {
        try {
            await this.init();
            await this.waitForManualLogin(); 

            for (const search of searches) {
                const res = await this.processCompany(search);
                if (res) this.results.push(res);
                
                fs.writeFileSync(CONFIG.OUTPUT_FILE, JSON.stringify(this.results, null, 2));
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
            console.log(`\n🏢 ${r.company} (${r.domain}) - ${r.pagesScraped} pages scraped`);
            if (r.emails.domain.length > 0) {
                console.log(`   ✅ TARGET EMAILS (${r.emails.domain.length}):`);
                r.emails.domain.forEach(e => console.log(`      ✉️  ${e}`));
            } else {
                console.log(`   ❌ No target emails found.`);
            }
            if (r.emails.other.length > 0) {
                console.log(`   🔗 OTHER EMAILS (${r.emails.other.length}):`);
                r.emails.other.forEach(e => console.log(`      ✉️  ${e}`));
            }
        });

        console.log('\n' + '-'.repeat(60));
        console.log(`📈 TOTAL TARGET EMAILS: ${totalDomain}`);
        console.log(`📈 TOTAL OTHER EMAILS: ${totalOther}`);
        console.log('-'.repeat(60));
        console.log(`\n📁 Results saved to: ${CONFIG.OUTPUT_FILE}`);
    }
}

new ManualLoginScraper().run();