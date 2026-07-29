
// Google Map scrape - By google console browser
(async () => {
    // --- CONFIGURATION: 50 PRECISE DORKING LOCATIONS ---
    const searchQueries = [
      // Tier 1 Tech Hubs
      '"Software company" in Hyderabad',
      '"Web development agency" in Bangalore',
      '"Website design company" in Mumbai',
      '"Mobile app development company" in Pune',
      '"Software development firm" in Delhi',
      '"Custom software development" in Chennai',
      '"IT services and solutions" in Kolkata',
      '"Web design and development" in Ahmedabad',
      
      // Tier 2 Emerging Tech Hubs
      '"Software development company" in Jaipur',
      '"App development agency" in Chandigarh',
      '"Enterprise software solutions" in Indore',
      '"IT consulting firm" in Kochi',
      '"Web application development" in Coimbatore',
      '"Software outsourcing company" in Bhubaneswar',
      '"SaaS development company" in Lucknow',
      '"E-commerce development company" in Surat',
      '"Digital transformation services" in Noida',
      '"Full stack development agency" in Gurgaon',
      '"Cloud computing services" in Visakhapatnam',
      '"Software product engineering" in Nagpur',
      '"IT infrastructure services" in Patna',
      '"Custom web development" in Nashik',
      
      // Tier 3 & Rapidly Growing Districts
      '"Software company" in Mangalore',
      '"Web development agency" in Mysore',
      '"Mobile app development" in Thiruvananthapuram',
      '"IT company" in Bhopal',
      '"Software development" in Raipur',
      '"Web design company" in Ranchi',
      '"App development firm" in Guwahati',
      '"Software outsourcing" in Vadodara',
      '"IT services" in Faridabad',
      '"Web development" in Ghaziabad',
      '"Software company" in Amritsar',
      '"Website development" in Ludhiana',
      '"Tech company" in Dehradun',
      '"Software firm" in Mohali',
      '"App developers" in Panchkula',
      '"Software development" in Jamshedpur',
      '"Web development agency" in Cuttack',
      '"IT solutions" in Thrissur',
      '"Software company" in Tirupati',
      '"Web design" in Vijayawada',
      '"App development" in Warangal',
      '"Software firm" in Aurangabad',
      '"IT company" in Solapur',
      '"Web development" in Belgaum',
      '"Software company" in Hubli',
      '"Mobile app development" in Salem',
      '"IT services" in Tirunelveli',
      '"Software development company" in Gwalior'
    ];
    
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  
    console.log("🚀 Starting Advanced Google Maps Dorking Scraper (50 Locations)...");
  
    // --- 1. SEARCH FUNCTION ---
    async function searchLocation(query) {
      const input = document.querySelector('input[role="combobox"]') || document.querySelector('input[name="q"]');
      if (!input) {
        console.error("Search input not found! Make sure you are on google.com/maps");
        return;
      }
  
      input.focus();
      await sleep(500);
      
      // Clear existing text
      const clearBtn = document.querySelector('button[aria-label="Close"]');
      if (clearBtn) clearBtn.click();
      await sleep(500);
  
      input.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, query);
      await sleep(1000);
  
      // Press Enter
      input.dispatchEvent(new KeyboardEvent('keydown', { 
        bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 
      }));
      
      console.log(`🎯 Dorking: ${query}`);
      await sleep(6000); // Wait for results to load
    }
  
    // --- 2. SCROLL FUNCTION (ANTI-STUCK) ---
    async function scrollResults() {
      console.log("⏳ Scrolling to load all results...");
      
      let stableCount = 0;
      let scrollAttempts = 0;
      const maxAttempts = 80; // Safety limit
  
      while (stableCount < 4 && scrollAttempts < maxAttempts) {
        // Re-select feed every loop to avoid detached DOM nodes
        const feed = document.querySelector('div[role="feed"]');
        if (!feed) {
          console.error("Results feed not found!");
          break;
        }
  
        // Check if Google says we reached the end
        const feedText = feed.innerText.toLowerCase();
        if (feedText.includes("end of the list") || feedText.includes("you've reached the end")) {
          console.log("✅ Google confirms end of list reached.");
          break;
        }
  
        // Scroll down
        feed.scrollBy(0, feed.clientHeight);
        await sleep(2500); // Wait for lazy loading
  
        // Check if height changed
        if (feed.scrollHeight === feed.clientHeight + feed.scrollTop) {
          stableCount++;
        } else {
          stableCount = 0;
        }
        scrollAttempts++;
      }
      console.log("✅ Finished scrolling.");
    }
  
    // --- 3. EXTRACTION FUNCTION ---
    function extractData(searchQuery) {
      const articles = document.querySelectorAll('div[role="article"]');
      const businesses = [];
  
      articles.forEach(article => {
        const nameEl = article.querySelector('.qBF1Pd');
        const name = nameEl ? nameEl.innerText.trim() : 'N/A';
  
        const websiteEl = article.querySelector('a[data-value="Website"]');
        const website = websiteEl ? websiteEl.getAttribute('href') : 'N/A';
  
        const phoneEl = article.querySelector('.UsdlK');
        const phone = phoneEl ? phoneEl.innerText.trim() : 'N/A';
  
        const ratingEl = article.querySelector('.MW4etd');
        const rating = ratingEl ? ratingEl.innerText.trim() : 'N/A';
  
        const reviewsEl = article.querySelector('.UY7F9');
        const reviews = reviewsEl ? reviewsEl.innerText.trim() : 'N/A';
  
        let category = 'N/A';
        let address = 'N/A';
        let status = 'N/A';
  
        const detailDivs = article.querySelectorAll('.W4Efsd');
        detailDivs.forEach(div => {
          const text = div.innerText.replace(/\u00a0/g, ' ').trim();
          
          if (text.includes('·')) {
            const parts = text.split('·').map(p => p.trim());
            parts.forEach(part => {
              if (!part) return;
              
              if (/\d/.test(part) && /floor|rd|road|plot|no|apt|block|phase|avenue|lane|nagar|colony|building|tower|survey|opposite|beside|near|street/i.test(part)) {
                if (address === 'N/A') address = part;
              } 
              else if (/open|closed|opens|closes/i.test(part)) {
                if (status === 'N/A') status = part;
              }
              else if (!/\d/.test(part) && part.length < 50) {
                if (category === 'N/A') category = part;
              }
            });
          }
        });
  
        businesses.push({
          SearchQuery: searchQuery,
          Name: name,
          Category: category,
          Rating: rating,
          Reviews: reviews,
          Status: status,
          Address: address,
          Phone: phone,
          Website: website
        });
      });
      
      return businesses;
    }
  
    // --- 4. CSV DOWNLOAD FUNCTION (PER QUERY) ---
    function downloadCSV(data, query) {
      if (!data.length) return;
      
      // Clean filename
      const filename = `GMaps_Leads_${query.replace(/[^a-zA-Z0-9]/g, '_')}.csv`;
      
      const headers = Object.keys(data[0]);
      const csvRows = [
        headers.join(','),
        ...data.map(row => 
          headers.map(fieldName => {
            let val = row[fieldName] || '';
            val = val.toString().replace(/"/g, '""');
            return `"${val}"`;
          }).join(',')
        )
      ];
      const csvData = csvRows.join('\n');
      const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  
    // --- MAIN LOOP ---
    for (let i = 0; i < searchQueries.length; i++) {
      const query = searchQueries[i];
      console.log(`\n--- Processing ${i + 1} of ${searchQueries.length}: ${query} ---`);
      
      await searchLocation(query);
      await scrollResults();
      const queryData = extractData(query);
      
      console.log(`📊 Extracted ${queryData.length} precise leads. Downloading CSV...`);
      downloadCSV(queryData, query);
      
      // Wait a bit before starting the next search to mimic human behavior
      await sleep(4000);
    }
  
    console.log("\n🎉 ALL 50 DORKING QUERIES COMPLETED!");
  })();