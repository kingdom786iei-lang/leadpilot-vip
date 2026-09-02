const express = require("express"), path = require("path"), fs = require("fs");
const nodemailer = require("nodemailer"), puppeteer = require("puppeteer");
const { WebSocketServer } = require("ws"), ImapFlow = require("imapflow");
const Database = require("better-sqlite3");

const app = express(), server = require("http").createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const dbPath = process.env.DATABASE_PATH || "./data/leadpilot.sqlite";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

// ڈیٹا بیس ٹیبلز کا سیٹ اپ
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

// گوگل میپس سے ڈیٹا نکالنے کا بالکل نیا اور بائی پاس طریقہ
async function scrapeMaps(query, location) {
  log("info", `Searching for "${query}" in "${location}"...`);
  // ریلوے کے انوائرمنٹ پاتھ کے مطابق کرومیم لانچ کرنا
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled" // بوٹ ڈیٹیکشن کو بائی پاس کرنے کے لیے
    ]
  });

  const page = await browser.newPage();
  // عام براؤزر جیسا ظاہر ہونے کے لیے یوزر ایجنٹ سیٹ کرنا
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1280, height: 800 });

  let items = [];
  try {
    const searchUrl = `https://google.com{encodeURIComponent(query + " " + location)}`;
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 60000 });

    // پیج لوڈ ہونے کا انتظار اور نیچے اسکرولنگ کرنا تاکہ ڈیٹا لوڈ ہو جائے
    await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 15000 }).catch(() => {});
    
    // لسٹ کو نیچے اسکرول کرنے کا لاجک
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await new Promise(r => setTimeout(r, 1000));
    }

    // بزنس کے نام اور لنکس نکالنا
    const links = await page.evaluate(() => {
      const elements = document.querySelectorAll('a[href*="/maps/place/"]');
      return Array.from(elements).map(el => ({
        name: el.getAttribute('aria-label') || el.innerText,
        url: el.href
      })).filter(item => item.name);
    });

    log("info", `Found ${links.length} potential businesses on Maps.`);

    // ہر بزنس کی پروفائل اوپن کر کے اس کی ویب سائٹ نکالنا
    for (const item of links.slice(0, 10)) { // پہلے 10 رزلٹس پروسیس کریں
      try {
        const newPage = await browser.newPage();
        await newPage.goto(item.url, { waitUntil: "networkidle2", timeout: 30000 });

        // ویب سائٹ کا لنک ڈھونڈنا (گوگل میپس کے نئے ڈیزائن کے مطابق)
        const website = await newPage.evaluate(() => {
          const webEl = document.querySelector('a[data-item-id="authority"]');
          return webEl ? webEl.href : null;
        });

        await newPage.close();

        let email = null;
        if (website) {
          // اگر ویب سائٹ مل جائے تو ہوم پیج سے ای میل نکالنے کی کوشش کرنا
          try {
            const webPage = await browser.newPage();
            await webPage.goto(website, { waitUntil: "domcontentloaded", timeout: 20000 });
            const html = await webPage.content();
            const emailMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (emailMatch) email = emailMatch[0];
            await webPage.close();
          } catch (e) {
            log("warning", `Could not scan website ${website} for emails.`);
          }
        }

        if (website || email) {
          items.push({ name: item.name, website: website || "", email: email || "" });
        }
      } catch (err) {
        log("error", `Error processing details for ${item.name}`);
      }
    }
  } catch (error) {
    log("error", `Scraping failed: ${error.message}`);
  } finally {
    await browser.close();
  }
  return items;
}

// فرنٹ اینڈ کے لیے API روٹس
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

    // فرنٹ اینڈ کو ڈیٹا واپس بھیجنا اور لائیو اپڈیٹ کرنا
    broadcast({ type: "state", state: { leads: db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 100").all() } });
    res.json({ length: items.length, saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// باقی تمام ای میل اور میسج روٹس
app.get("/api/state", (req, res) => {
  res.json({
    leads: db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 100").all(),
    logs: db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 100").all()
  });
});

// سرور سٹارٹ کرنا
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
         
