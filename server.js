const express = require("express"), path = require("path"), fs = require("fs");
const nodemailer = require("nodemailer");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { WebSocketServer } = require("ws"), ImapFlow = require("imapflow");
const Database = require("better-sqlite3");

// پپیٹیر کو بوٹ ڈیٹیکشن بائی پاس کرنے کے لیے اسٹیلتھ موڈ پر سیٹ کرنا
puppeteer.use(StealthPlugin());

const app = express(), server = require("http").createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const dbPath = process.env.DATABASE_PATH || "./data/leadpilot.sqlite";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.prepare(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    website TEXT,
    email TEXT,
    status TEXT DEFAULT 'NEW',
    pitched TEXT DEFAULT 'NO',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, website)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    direction TEXT,
    subject TEXT,
    body TEXT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(lead_id) REFERENCES leads(id)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
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

async function scrapeMaps(query, location) {
  log("info", `Searching with Stealth Mode for "${query}" in "${location}"...`);
  
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process"
    ]
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1280, height: 800 });

  let items = [];
  try {
    const searchUrl = `https://google.com{encodeURIComponent(query + " " + location)}`;
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 60000 });

    await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 20000 }).catch(() => {});
    
    // سکرین اسکرولنگ کرنا تاکہ تمام رزلٹس لسٹ میں لوڈ ہو جائیں
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => {
        const sidePanel = document.querySelector('div[role="feed"]');
        if (sidePanel) sidePanel.scrollBy(0, 1000);
        else window.scrollBy(0, 1000);
      });
      await new Promise(r => setTimeout(r, 1500));
    }

    const links = await page.evaluate(() => {
      const elements = document.querySelectorAll('a[href*="/maps/place/"]');
      return Array.from(elements).map(el => ({
        name: el.getAttribute('aria-label') || el.innerText,
        url: el.href
      })).filter(item => item.name);
    });

    log("info", `Found ${links.length} businesses on map screen. Extracting details...`);

    // صرف ٹاپ 8 رزلٹس کا ڈیٹا نکالنا تاکہ سرور کریش یا بلاک نہ ہو
    for (const item of links.slice(0, 8)) {
      try {
        const newPage = await browser.newPage();
        await newPage.goto(item.url, { waitUntil: "networkidle2", timeout: 30000 });

        const website = await newPage.evaluate(() => {
          const webEl = document.querySelector('a[data-item-id="authority"]');
          return webEl ? webEl.href : null;
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
            // ای میل اسکین فیل ہونے پر خاموشی اختیار کریں
          }
        }

        if (website || email) {
          items.push({ name: item.name, website: website || "", email: email || "" });
          log("info", `Extracted: ${item.name}`);
        }
      } catch (err) {
        log("warning", `Skipped business due to error.`);
      }
    }
  } catch (error) {
    log("error", `Scraping issue: ${error.message}`);
  } finally {
    await browser.close();
  }
  return items;
}

app.post("/api/settings", (req, res) => {
  const { autoPitch } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('autoPitch', ?)")
    .run(autoPitch ? "true" : "false");
  res.json({ status: "ok" });
});

app.post("/api/scrape", async (req, res) => {
  const { query, location } = req.body;
  if (!query || !location) return res.status(400).json({ error: "Query and location required" });

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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
      
