async function scrapeMaps(query, location) {
  log("info", `Searching for "${query}" in "${location}"...`);
  
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
      "--lang=en-US,en" // گوگل کو مجبور کرنا کہ وہ انگلش ورژن ہی لوڈ کرے
    ]
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1280, height: 800 });

  let items = [];
  try {
    // گوگل سرچ کے ذریعے سیدھا رزلٹس پیج پر جانا
    const searchUrl = `https://google.com{encodeURIComponent(query + " " + location)}&tbm=lcl`;
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 60000 });

    // لنکس نکالنے کا بالکل نیا اور بائی پاس طریقہ (گوگل سرچ لوکل لسٹنگ کے لیے)
    const links = await page.evaluate(() => {
      const elements = document.querySelectorAll('a[href*="maps/place"]');
      return Array.from(elements).map(el => {
        // نام تلاش کرنا
        let nameEl = el.querySelector('span') || el;
        return {
          name: nameEl.innerText ? nameEl.innerText.trim() : '',
          url: el.href
        };
      }).filter(item => item.name.length > 2 && item.url.includes('google.com'));
    });

    log("info", `Found ${links.length} businesses on Google Search Maps.`);

    // ہر بزنس کی پروفائل اوپن کر کے ڈیٹا نکالنا
    for (const item of links.slice(0, 5)) { 
      try {
        const newPage = await browser.newPage();
        await newPage.goto(item.url, { waitUntil: "networkidle2", timeout: 30000 });

        // ویب سائٹ کا ڈیٹا نکالنے کا یونیورسل طریقہ
        const website = await newPage.evaluate(() => {
          // تمام لنکس چیک کریں جو آؤٹ گوئنگ ہوں
          const allLinks = Array.from(document.querySelectorAll('a'));
          for (let link of allLinks) {
            const href = link.href;
            if (href && !href.includes('google.com') && !href.includes('javascript') && href.startsWith('http')) {
              return href;
            }
          }
          return null;
        });

        await newPage.close();

        let email = null;
        if (website) {
          try {
            const webPage = await browser.newPage();
            await webPage.goto(website, { waitUntil: "domcontentloaded", timeout: 15000 });
            const html = await webPage.content();
            const emailMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (emailMatch) email = emailMatch[0];
            await webPage.close();
          } catch (e) {
            // ویب سائٹ اسکین ایرر
          }
        }

        if (website || email) {
          items.push({ name: item.name, website: website || "", email: email || "" });
          log("info", `Successfully extracted: ${item.name}`);
        }
      } catch (err) {
        log("warning", `Error loading item details.`);
      }
    }
  } catch (error) {
    log("error", `Scraping issue: ${error.message}`);
  } finally {
    await browser.close();
  }
  return items;
              }
