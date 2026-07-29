const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const readline = require('readline');

puppeteer.use(StealthPlugin());

const sleep = ms => new Promise(r => setTimeout(r, ms));
const askQuestion = (query) => new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, ans => { rl.close(); resolve(ans); });
});

class JobPosterScraper {
    constructor() {
        this.browser = null;
        this.page = null;
        this.leads = [];
        this.scrapedJobIds = new Set(); // Prevent duplicates across keywords
    }

    async init() {
        this.browser = await puppeteer.launch({
            headless: false,
            args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1920,1080']
        });
        this.page = await this.browser.newPage();
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    }

    async performLogin() {
        console.log('🔗 Navigating to LinkedIn login page...');
        await this.page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
        
        console.log('\n' + '='.repeat(60));
        console.log('✋ MANUAL LOGIN REQUIRED (HITL)');
        console.log('👉 Please log into LinkedIn in the browser window.');
        console.log('👉 Solve any CAPTCHA or 2FA if prompted.');
        console.log('👉 Wait until you see your LinkedIn Feed/Home page.');
        console.log('='.repeat(60));
        
        await askQuestion('\n⏳ Press ENTER ONLY AFTER you are fully logged in and see your feed...');
        
        // Verify login by checking if the feed URL is reached
        await this.page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await sleep(2000);
        
        if (this.page.url().includes('/login') || this.page.url().includes('/checkpoint')) {
            console.log('❌ Login verification failed. Please try running the script again and ensure you log in properly.');
            await askQuestion('⏳ If you are logged in now, press ENTER to continue...');
        } else {
            console.log('✅ Login verified! Taking over automation...\n');
        }
    }

    async scrapeCompanyDetails(companyUrl) {
        if (!companyUrl) return null;

        const aboutUrl = companyUrl.replace(/\/(life|posts|products|jobs|people)\/?$/, '/about/');
        const aboutPage = await this.browser.newPage();
        
        try {
            await aboutPage.goto(aboutUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await sleep(2000);

            const companyData = await aboutPage.evaluate(() => {
                const getText = (sel) => document.querySelector(sel)?.innerText.trim() || null;
                const result = {
                    name: getText('h1.org-top-card-summary__title'),
                    industry: getText('.org-top-card-summary-info-list__info-item'),
                    description: getText('section.org-page-details-module__card-spacing p.break-words') || getText('p.break-words'),
                    companySize: null,
                    headquarters: null,
                    founded: null,
                    specialties: null,
                    website: null,
                    phone: null
                };

                document.querySelectorAll('dl.overflow-hidden dt').forEach(dt => {
                    const label = dt.innerText.trim().toLowerCase();
                    const dd = dt.nextElementSibling?.innerText.trim().split('\n')[0].trim();
                    if (!dd) return;
                    
                    if (label.includes('company size')) result.companySize = dd;
                    else if (label.includes('headquarters')) result.headquarters = dd;
                    else if (label.includes('founded')) result.founded = dd;
                    else if (label.includes('specialties')) result.specialties = dd;
                    else if (label.includes('industry')) result.industry = result.industry || dd;
                    else if (label.includes('website')) {
                        const link = dd.querySelector('a');
                        result.website = link ? link.href : dd;
                    }
                    else if (label.includes('phone')) result.phone = dd;
                });

                return result;
            });

            await aboutPage.close();
            return companyData;
        } catch (error) {
            await aboutPage.close();
            return null;
        }
    }

    async scrapeJobsForKeyword(keyword) {
        const encodedKeyword = encodeURIComponent(keyword);
        const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodedKeyword}&f_TPR=r86400&refresh=true`;

        console.log(`\n🔍 Searching for keyword: "${keyword}"`);
        await this.page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);

        // CHECK FOR LOGOUT / GUEST MODE
        const isGuestMode = await this.page.$('.base-search-card, .job-alert-redirect-section__cta[href*="login"]');
        if (isGuestMode) {
            console.log('\n' + '='.repeat(60));
            console.log('⚠️ GUEST MODE DETECTED: You have been logged out or redirected.');
            console.log('👉 Please log in manually in the browser window to see hiring managers.');
            console.log('='.repeat(60));
            await askQuestion('⏳ Press ENTER once you are logged in and the job results are visible...');
            await sleep(3000); // Wait for page to reload auth state
        }

        let pagesToScrape = 3; 
        let pageCount = 0;

        while (pageCount < pagesToScrape) {
            pageCount++;
            console.log(`   📄 Scraping Page ${pageCount} for "${keyword}"...`);

            // Wait for EITHER Authenticated UI or Guest UI job cards
            try {
                await this.page.waitForSelector('li[data-occludable-job-id], div.base-search-card', { timeout: 10000 });
            } catch (e) {
                console.log('   ⚠️ No job cards found on this page. Moving to next keyword.');
                break;
            }

            await this.autoScrollJobList();
            await sleep(1000);

            // Extract Job IDs from both UI variants
            const jobIds = await this.page.evaluate(() => {
                const ids = [];
                
                // Auth Classic UI
                document.querySelectorAll('li[data-occludable-job-id]').forEach(li => {
                    const id = li.getAttribute('data-occludable-job-id');
                    if (id && li.querySelector(`a[href*="/jobs/view/${id}"]`)) ids.push(id);
                });

                // Guest / Public UI
                document.querySelectorAll('div.base-search-card[data-entity-urn]').forEach(card => {
                    const urn = card.getAttribute('data-entity-urn');
                    const match = urn && urn.match(/urn:li:jobPosting:(\d+)/);
                    if (match) ids.push(match[1]);
                });

                return [...new Set(ids)]; // Deduplicate
            });

            if (jobIds.length === 0) {
                console.log('   ⚠️ No valid job links found. Moving to next page/keyword.');
                break;
            }

            for (let i = 0; i < jobIds.length; i++) {
                const jobId = jobIds[i];

                if (this.scrapedJobIds.has(jobId)) continue;
                this.scrapedJobIds.add(jobId);

                try {
                    // Click the specific job card link directly
                    await this.page.evaluate((targetJobId) => {
                        const authLink = document.querySelector(`a[href*="/jobs/view/${targetJobId}"]`);
                        if (authLink) { authLink.click(); return; }
                        
                        const guestCard = document.querySelector(`div.base-search-card[data-entity-urn="urn:li:jobPosting:${targetJobId}"]`);
                        if (guestCard) {
                            const guestLink = guestCard.querySelector('a.base-card__full-link');
                            if (guestLink) guestLink.click();
                        }
                    }, jobId);
                    
                    await sleep(2500); 

                    // Click "Show more" to expand the Job Description (Guest UI)
                    await this.page.evaluate(() => {
                        const guestShowMore = document.querySelector('button.show-more-less-html__button--more');
                        if (guestShowMore) guestShowMore.click();
                    });
                    await sleep(500);

                    const jobData = await this.page.evaluate((targetJobId) => {
                        const result = {
                            jobId: targetJobId,
                            jobUrl: `https://www.linkedin.com/jobs/view/${targetJobId}/`,
                            title: 'Unknown Title',
                            company: 'Unknown Company',
                            companyUrl: null,
                            location: null,
                            postedAgo: null,
                            applicantCount: null,
                            easyApply: false,
                            jobDescription: null,
                            jobPoster: null,
                        };

                        // --- TITLE ---
                        const authTitle = document.querySelector('h1.t-24 a') || document.querySelector('h1.t-24');
                        const guestTitle = document.querySelector('h2.top-card-layout__title');
                        result.title = (authTitle?.innerText || guestTitle?.innerText || 'Unknown Title').trim();

                        // --- COMPANY ---
                        const authCompany = document.querySelector('.job-details-jobs-unified-top-card__company-name a');
                        const guestCompany = document.querySelector('.topcard__org-name-link');
                        if (authCompany) { result.company = authCompany.innerText.trim(); result.companyUrl = authCompany.href; }
                        else if (guestCompany) { result.company = guestCompany.innerText.trim(); result.companyUrl = guestCompany.href; }

                        // --- METADATA (Location, Posted, Applicants) ---
                        const authMeta = document.querySelector('.job-details-jobs-unified-top-card__tertiary-description-container');
                        if (authMeta) {
                            const txt = authMeta.innerText.trim();
                            const parts = txt.split('·').map(s => s.trim());
                            for (const part of parts) {
                                if (part.toLowerCase().includes('ago')) result.postedAgo = part;
                                else if (part.toLowerCase().includes('applicant') || part.toLowerCase().includes('clicked apply')) result.applicantCount = part;
                                else if (part && !result.location && part.length < 100) result.location = part;
                            }
                        } else {
                            // Guest UI Fallbacks
                            const guestLoc = document.querySelector('.topcard__flavor--bullet');
                            if (guestLoc) result.location = guestLoc.innerText.trim();
                            
                            const guestTime = document.querySelector('.posted-time-ago__text');
                            if (guestTime) result.postedAgo = guestTime.innerText.trim();
                            
                            const guestApps = document.querySelector('.num-applicants__caption');
                            if (guestApps) result.applicantCount = guestApps.innerText.trim();
                        }

                        // --- EASY APPLY ---
                        const easyApplyBtn = document.querySelector('button[aria-label*="Easy Apply"]');
                        result.easyApply = !!easyApplyBtn;

                        // --- JOB DESCRIPTION ---
                        const authDesc = document.querySelector('#job-details');
                        const guestDesc = document.querySelector('.description__text');
                        result.jobDescription = (authDesc?.innerText || guestDesc?.innerText || '').trim();

                        // --- JOB POSTER (Authenticated UI Only) ---
                        const jobPosterBadge = document.querySelector('.hirer-card__job-poster');
                        if (jobPosterBadge) {
                            const hirerInfo = jobPosterBadge.closest('.hirer-card__hirer-information');
                            if (hirerInfo) {
                                const profileLink = hirerInfo.querySelector('a[href*="/in/"]');
                                const nameEl = hirerInfo.querySelector('.jobs-poster__name');
                                const headlineEl = hirerInfo.querySelector('.text-body-small');
                                
                                if (profileLink && nameEl) {
                                    result.jobPoster = {
                                        name: nameEl.innerText.trim(),
                                        profileUrl: profileLink.href,
                                        headline: headlineEl ? headlineEl.innerText.trim() : null
                                    };
                                }
                            }
                        }

                        return result;
                    }, jobId);

                    // Fetch company details from background tab
                    if (jobData && jobData.companyUrl) {
                        jobData.companyDetails = await this.scrapeCompanyDetails(jobData.companyUrl);
                    }

                    if (jobData) {
                        const posterName = jobData.jobPoster?.name || 'No poster listed';
                        const companySize = jobData.companyDetails?.companySize || 'Size N/A';
                        console.log(`      ✅ ${jobData.company} (${companySize}) → ${posterName}`);
                        this.leads.push(jobData);
                    }
                } catch (e) {
                    console.log(`      ⚠️ Error on job ${i + 1}: ${e.message}`);
                }
            }

            // Go to next page (Auth UI uses "View next page", Guest UI uses "Next" or page numbers)
            const nextBtn = await this.page.$('button[aria-label="View next page"], button[aria-label="Next"]:not([disabled])');
            if (nextBtn) {
                await nextBtn.evaluate(el => el.click());
                await sleep(3000);
            } else {
                console.log('   ⏹ No next page button found for this keyword.');
                break;
            }
        }
    }

    async autoScrollJobList() {
        await this.page.evaluate(async () => {
            const list = document.querySelector('.jobs-search-results-list') || 
                         document.querySelector('.scaffold-layout__list') || 
                         document.querySelector('.two-pane-serp-page__results-list') || // Guest UI list
                         document.documentElement;
            if (!list) return;
            for (let i = 0; i < 5; i++) {
                list.scrollBy(0, 600);
                await new Promise(r => setTimeout(r, 600));
            }
        });
    }

    // EXTRACTED SAVE LOGIC
    saveData() {
        if (this.leads.length === 0) {
            console.log('⚠️ No leads scraped, skipping save.');
            return;
        }

        console.log(`\n💾 Saving ${this.leads.length} leads to JSON and CSV...`);
        fs.writeFileSync('active_hiring_managers.json', JSON.stringify(this.leads, null, 2));

        const cleanTextForCsv = (text) => text ? text.replace(/\n/g, ' ').replace(/"/g, '""') : '';
        const csvLines = ['Company,Industry,CompanySize,JobTitle,Location,PostedAgo,PosterName,PosterHeadline,PosterURL,JobDescription,JobURL'];
        for (const l of this.leads) {
            const p = l.jobPoster || {};
            const c = l.companyDetails || {};
            csvLines.push([
                l.company, c.industry || '', c.companySize || '', l.title, l.location, l.postedAgo,
                p.name || '', cleanTextForCsv(p.headline), p.profileUrl || '',
                cleanTextForCsv(l.jobDescription), l.jobUrl
            ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
        }
        fs.writeFileSync('active_hiring_managers.csv', csvLines.join('\n'));
        console.log('✅ Data saved successfully!');
    }

    async run() {
        try {
            await this.init();
            await this.performLogin();

            // 55+ Keywords Array
            const keywords = [
                "MERN Stack", "Gen AI", "React Node", "Full Stack Developer", "Next.js Developer",
                "TypeScript Developer", "AWS Engineer", "GraphQL Developer", "Python Developer", "Django Developer",
                "Flask Developer", "Java Spring Boot", "Go Developer", "Rust Developer", "C# .NET Developer",
                "Angular Developer", "Vue.js Developer", "Svelte Developer", "Redux Developer", "Tailwind CSS Developer",
                "Kubernetes Engineer", "Docker Engineer", "Terraform Engineer", "Jenkins CI CD", "DevOps Engineer",
                "PostgreSQL Developer", "MongoDB Developer", "Redis Developer", "MySQL Developer", "Elasticsearch Engineer",
                "Kafka Engineer", "RabbitMQ Engineer", "Microservices Developer", "REST API Developer", "Serverless Developer",
                "Frontend Developer", "Backend Developer", "Machine Learning Engineer", "Data Scientist", "NLP Engineer",
                "Computer Vision Engineer", "PyTorch Developer", "TensorFlow Developer", "LLM Engineer", "OpenAI Developer",
                "LangChain Developer", "Vector Database Engineer", "Pinecone Developer", "Web3 Developer", "Solidity Developer",
                "Ethereum Developer", "Blockchain Developer", "Smart Contract Developer", "React Native Developer", "Flutter Developer",
                "iOS Swift Developer", "Android Kotlin Developer"
            ];

            for (const keyword of keywords) {
                await this.scrapeJobsForKeyword(keyword);
            }

            this.saveData();
            this.printStrategy();
        } catch (error) {
            console.error('❌ Error:', error.message);
            this.saveData(); // Save on crash
        } finally {
            if (this.browser) await this.browser.close();
        }
    }

    printStrategy() {
        console.log('\n' + '='.repeat(70));
        console.log('🎯 ACTION PLAN — ACTIVE HIRING MANAGERS');
        console.log('='.repeat(70));
        console.log(`Total unique leads captured: ${this.leads.length}`);

        const withPoster = this.leads.filter(l => l.jobPoster);
        console.log(`Leads with job poster identified: ${withPoster.length}\n`);

        console.log('TOP PRIORITY (Has poster):');
        console.log('-'.repeat(70));
        withPoster.slice(0, 15).forEach((l, i) => {
            console.log(`${i + 1}. ${l.company} — ${l.title}`);
            console.log(`   📍 ${l.location} | ⏰ ${l.postedAgo}`);
            if (l.companyDetails) {
                console.log(`   🏢 Industry: ${l.companyDetails.industry} | Size: ${l.companyDetails.companySize}`);
            }
            console.log(`   👤 ${l.jobPoster.name} — ${l.jobPoster.headline || ''}`);
            console.log(`   🔗 ${l.jobPoster.profileUrl}\n`);
        });
    }
}

const scraper = new JobPosterScraper();

// HANDLE CTRL+C GRACEFULLY: If user presses Ctrl+C, save data before exiting
process.on('SIGINT', async () => {
    console.log('\n🛑 Ctrl+C detected! Gracefully shutting down...');
    scraper.saveData(); 
    if (scraper.browser) {
        await scraper.browser.close();
    }
    process.exit(0);
});

scraper.run();