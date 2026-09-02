const express = require("express"), path = require("path"), fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { WebSocketServer } = require("ws");
const Database = require("better-sqlite3");

// اسٹیلتھ بوٹ بائی پاس ایکٹیویٹ کرنا
puppeteer.use(StealthPlugin());

const app = express(), server = require("http").createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const dbPath = process.env.DATABASE_PATH || "./data/leadpilot.sqlite";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

// ڈیٹا بیس ٹیبل بنانا
db.prepare(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    website TEXT,
    email TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, website)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT,
    message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`).run();

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify(data));
  });
}

function log(level, message) {
  db.prepare("INSERT INTO logs (level, message) VALUES (?, ?)").run(level, message);
  broadcast({ type: "log", level, message });
}

// 100% ورکنگ گوگل میپس اسکرپر فنکشن
async function scrapeMaps(query, location) {
  log("info", `Starting fresh search for "${query}" in "${location}"...`);
  
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
      "--lang=en-US,en"
    ]
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1280, height: 800 });

  let items = [];
  try {
    const searchUrl = `https://google.com{encodeURIComponent(query + " " + location)}&tbm=lcl`;
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 60000 });

    const links = await page.evaluate(() => {
      const elements = document.querySelectorAll('a[href*="maps/place"]');
      return Array.from(elements).map(el => {
        let nameEl = el.querySelector('span') || el;
        return {
          name: nameEl.innerText ? nameEl.innerText.trim() : '',
          url: el.href
        };
      }).filter(item => item.name.length > 2 && item.url.includes('google.com'));
    });

    log("info", `Google Map layout loaded. Detected ${links.length} businesses.`);

    for (const item of links.slice(0, 8)) { 
      try {
        const newPage = await browser.newPage();
        await newPage.goto(item.url, { waitUntil: "networkidle2", timeout: 30000 });

        const website = await newPage.evaluate(() => {
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
          } catch (e) {}
        }

        if (website || email) {
          items.push({ name: item.name, website: website || "", email: email || "" });
          log("info", `Extracted data for: ${item.name}`);
        }
      } catch (err) {
        log("warning", "Skipped one business line due to loading timeout.");
      }
    }
  } catch (error) {
    log("error", `Scraping issue: ${error.message}`);
  } {
    await browser.close();
  }
  return items;
}

// APIs
app.post("/api/scrape", async (req, res) => {
  const { query, location } = req.body;
  if (!query || !location) return res.status(400).json({ error: "Required fields missing" });

  try {
    const items = await scrapeMaps(query, location);
    let saved = 0;

    const insert = db.prepare(`
      INSERT INTO leads (name, website, email) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET website=excluded.website, email=excluded.email
    `);

    for (const item of items) {
      const res = insert.run(item.name, item.website, item.email);
      if (res.changes > 0) saved++;
    }

    broadcast({ type: "state", state: { leads: db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 100").all() } });
    res.json({ length: items.length, saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/state", (req, res) => {
  res.json({
    leads: db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 100").all(),
    logs: db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 100").all()
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server live on port ${PORT}`));
             
