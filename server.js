require("dotenv").config();
const express=require("express"), http=require("http"), path=require("path"), fs=require("fs");
const Database=require("better-sqlite3");
const nodemailer=require("nodemailer"), puppeteer=require("puppeteer"), {WebSocketServer}=require("ws");
const {ImapFlow}=require("imapflow");

const app=express(), server=http.createServer(app), wss=new WebSocketServer({server});
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));

const dbPath=process.env.DB_PATH||"./data/leadpilot.sqlite";
fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const db=new Database(dbPath);
db.pragma("journal_mode=WAL");
db.exec(`CREATE TABLE IF NOT EXISTS leads(
 id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,website TEXT,email TEXT UNIQUE,
 phone TEXT,location TEXT,status TEXT DEFAULT 'New',pitched_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages(
 id INTEGER PRIMARY KEY AUTOINCREMENT,lead_id INTEGER,direction TEXT,subject TEXT,body TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(lead_id) REFERENCES leads(id)
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,level TEXT,message TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);

const log=(level,message)=>{db.prepare("INSERT INTO logs(level,message) VALUES(?,?)").run(level,message); broadcast({type:"log",level,message});};
const broadcast=o=>wss.clients.forEach(c=>{if(c.readyState===1)c.send(JSON.stringify(o))});
const state=()=>({autoPitch:(db.prepare("SELECT value FROM settings WHERE key='autoPitch'").get()?.value||"false")==="true",
 leads:db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 100").all(),
 messages:db.prepare("SELECT m.*,l.name FROM messages m LEFT JOIN leads l ON l.id=m.lead_id ORDER BY m.id DESC LIMIT 100").all(),
 logs:db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 100").all()});

app.get("/api/state",(req,res)=>res.json(state()));
app.post("/api/settings/auto-pitch",(req,res)=>{const on=!!req.body.enabled;db.prepare("INSERT INTO settings(key,value) VALUES('autoPitch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(on));log("info",`Auto-Pitch ${on?"enabled":"disabled"}`);res.json({ok:true,enabled:on})});

function intent(text){return /\b(payment|pay|price|pricing|invoice|how to pay|payment link|checkout|buy|purchase|cost|link)\b/i.test(text||"");}
async function extractEmails(page,website){
 const urls=[page,website].filter(Boolean); const found=new Set();
 for(const u of urls){try{const html=await (await fetch(u,{redirect:"follow"})).text();(html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[]).forEach(e=>found.add(e.toLowerCase()))}catch{}}
 return [...found].filter(e=>!/\.(png|jpg|jpeg|webp)$/i.test(e))[0]||"";
}
async function scrapeMaps(query,location){
 const browser=await puppeteer.launch({headless:"new",args:["--no-sandbox","--disable-setuid-sandbox"]});
 try{
  const page=await browser.newPage(); await page.setViewport({width:1400,height:900});
  const url="https://www.google.com/maps/search/"+encodeURIComponent(query+" "+location);
  await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000}); await new Promise(r=>setTimeout(r,3500));
  const cards=await page.$$('[role="feed"] a[href*="/maps/place/"]');
  const out=[];
  for(let i=0;i<Math.min(cards.length,30);i++){
   try{
    const a=cards[i], name=(await a.getAttribute("aria-label"))||"";
    const href=await a.getAttribute("href"); if(!name||!href)continue;
    const parent=await a.evaluate(el=>el.parentElement?.parentElement?.innerText||"");
    const website=(parent.match(/https?:\/\/[^\s]+/i)||[""])[0];
    out.push({name:name.trim(),website:website.replace(/[),.]+$/,""),location});
   }catch{}
  }
  return out;
 }finally{await browser.close()}
}
app.post("/api/scrape",async(req,res)=>{
 const {query,location}=req.body||{}; if(!query||!location)return res.status(400).json({error:"query and location required"});
 try{
  log("info",`Scraping started: ${query} / ${location}`); const items=await scrapeMaps(query,location); let saved=0;
  for(const x of items){let email=""; if(x.website)email=await extractEmails("https://www.google.com/maps/search/"+encodeURIComponent(x.name),x.website);
   const info=db.prepare("INSERT INTO leads(name,website,email,location) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET website=excluded.website").run(x.name,x.website,email,location);
   if(info.changes)saved++;
  }
  log("success",`Scraping finished: ${items.length} found, ${saved} new leads`); broadcast({type:"state",state:state()});
  res.json({ok:true,found:items.length,saved});
 }catch(e){log("error",e.message);res.status(500).json({error:e.message})}
});

let transporter=null;
function mailer(){if(!process.env.GMAIL_USER||!process.env.GMAIL_APP_PASSWORD)throw Error("Gmail credentials missing in .env");
 if(!transporter)transporter=nodemailer.createTransport({service:"gmail",auth:{user:process.env.GMAIL_USER,pass:process.env.GMAIL_APP_PASSWORD}});return transporter}
async function pitch(lead){if(!process.env.OPENROUTER_API_KEY)throw Error("OPENROUTER_API_KEY missing");
 const resp=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",
  headers:{"Content-Type":"application/json","Authorization":`Bearer ${process.env.OPENROUTER_API_KEY}`},
  body:JSON.stringify({model:process.env.OPENROUTER_MODEL||"z-ai/glm-5.2:free",max_tokens:180,
  messages:[{role:"user",content:`Write a natural cold email under 70 words for this business: ${lead.name}. Offer a $300/month service that helps them get more customers. No fake claims. Include a simple CTA. Return subject on first line, then email body.`}]})});
 if(!resp.ok)throw Error(`OpenRouter error: ${resp.status} ${await resp.text()}`);
 const r=await resp.json();
 const t=r.choices?.[0]?.message?.content||""; const [subject,...body]=t.split("\n"); return {subject:subject.replace(/^subject:\s*/i,"").trim(),body:body.join("\n").trim()};
}
app.post("/api/pitch/:id",async(req,res)=>{
 try{const lead=db.prepare("SELECT * FROM leads WHERE id=?").get(req.params.id);if(!lead?.email)return res.status(400).json({error:"Lead has no email"});
 const p=await pitch(lead); await mailer().sendMail({from:process.env.SMTP_FROM||process.env.GMAIL_USER,to:lead.email,subject:p.subject,text:p.body});
 db.prepare("UPDATE leads SET status='Pitched',pitched_at=CURRENT_TIMESTAMP WHERE id=?").run(lead.id);
 db.prepare("INSERT INTO messages(lead_id,direction,subject,body) VALUES(?,?,?,?)").run(lead.id,"out",p.subject,p.body);
 log("success",`Pitch sent to ${lead.name}`);broadcast({type:"state",state:state()});res.json({ok:true,p});
 }catch(e){log("error",e.message);res.status(500).json({error:e.message})}
});
app.post("/api/send/:id",async(req,res)=>{
 try{const lead=db.prepare("SELECT * FROM leads WHERE id=?").get(req.params.id);if(!lead?.email)return res.status(400).json({error:"Lead has no email"});
 const {subject,body}=req.body;if(!body)return res.status(400).json({error:"Message required"});
 await mailer().sendMail({from:process.env.SMTP_FROM||process.env.GMAIL_USER,to:lead.email,subject:subject||"Re: your enquiry",text:body});
 db.prepare("INSERT INTO messages(lead_id,direction,subject,body) VALUES(?,?,?,?)").run(lead.id,"out",subject||"Re: your enquiry",body);
 db.prepare("UPDATE leads SET status='Contacted' WHERE id=?").run(lead.id);broadcast({type:"state",state:state()});res.json({ok:true});
 }catch(e){res.status(500).json({error:e.message})}
});
app.post("/api/resume/:id",(req,res)=>{db.prepare("UPDATE leads SET status='Pitched' WHERE id=?").run(req.params.id);res.json({ok:true})});

async function imapLoop(){
 if(!process.env.GMAIL_USER||!process.env.GMAIL_APP_PASSWORD)return;
 while(true){let c;
  try{
   c=new ImapFlow({host:"imap.gmail.com",port:993,secure:true,auth:{user:process.env.GMAIL_USER,pass:process.env.GMAIL_APP_PASSWORD},logger:false});
   await c.connect(); log("success","Gmail listener connected");
   let last=0;
   const mb=await c.mailboxOpen("INBOX"); last=mb.uidNext-1;
   for await(const m of c.fetch(`${Math.max(1,last)}:*`,{uid:true,envelope:true,source:true})){if(m.uid<=last)continue;
    const from=m.envelope?.from?.[0]?.address||""; const lead=db.prepare("SELECT * FROM leads WHERE lower(email)=lower(?)").get(from); if(!lead)continue;
    const source=m.source?.toString()||""; const body=source.split(/\r?\n\r?\n/).slice(1).join("\n\n").trim();
    db.prepare("INSERT INTO messages(lead_id,direction,subject,body) VALUES(?,?,?,?)").run(lead.id,"in",m.envelope.subject||"",body);
    const high=intent(body); db.prepare("UPDATE leads SET status=? WHERE id=?").run(high?"HANDOFF REQUIRED":"Replied",lead.id);
    log(high?"warn":"info",`${high?"Handoff required":"Reply received"}: ${lead.name}`);broadcast({type:"state",state:state()});
   }
   await c.logout();
  }catch(e){log("error",`IMAP: ${e.message}`);try{await c?.logout()}catch{} await new Promise(r=>setTimeout(r,10000))}
 }
}
imapLoop();

setInterval(async()=>{
 const on=(db.prepare("SELECT value FROM settings WHERE key='autoPitch'").get()?.value||"false")==="true"; if(!on)return;
 const leads=db.prepare("SELECT * FROM leads WHERE status='New' AND email IS NOT NULL AND email<>'' ORDER BY id ASC LIMIT 2").all();
 for(const l of leads){try{await new Promise(r=>setTimeout(r,Number(process.env.SCRAPE_DELAY_MS||1800))); await fetch(`http://127.0.0.1:${process.env.PORT||3000}/api/pitch/${l.id}`,{method:"POST"});}catch(e){log("error",e.message)}}
},30000);

wss.on("connection",ws=>ws.send(JSON.stringify({type:"state",state:state()})));
app.use((req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
const port=process.env.PORT||3000;server.listen(port,()=>log("success",`LeadPilot running on port ${port}`));
