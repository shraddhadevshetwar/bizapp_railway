const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Data Directory ───────────────────────────────────────────────────────────
// On Railway: set DATA_DIR=/data and attach a persistent volume at /data
// Locally:    falls back to app folder — nothing changes for local use
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
console.log(`[Storage] Data directory: ${DATA_DIR}`);

// ─── Auth helpers ────────────────────────────────────────────────────────────
function getPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  try {
    const f = path.join(DATA_DIR, 'config.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8')).adminPassword || 'admin123';
  } catch(e) {}
  try { return JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8')).adminPassword||'admin123'; }
  catch(e){ return 'admin123'; }
}
function requireAuth(req,res,next){
  if(req.headers['x-admin-password']!==getPassword()) return res.status(401).json({error:'Incorrect password.'});
  next();
}
app.post('/api/auth/verify',(req,res)=>{
  req.body.password===getPassword()?res.json({success:true}):res.status(401).json({error:'Incorrect password.'});
});

// ─── Database ─────────────────────────────────────────────────────────────────
const DB_PATH = path.join(DATA_DIR, 'data.db');
console.log(`[Storage] Database path: ${DB_PATH}`);

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS parties(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,opening_balance REAL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS invoices(
    id INTEGER PRIMARY KEY AUTOINCREMENT,seq INTEGER,
    inv_date TEXT NOT NULL,party_id INTEGER NOT NULL,
    gross_total REAL DEFAULT 0,cess_pct REAL DEFAULT 0,cess_amount REAL DEFAULT 0,
    extra_charge_label TEXT DEFAULT '',extra_charge_amount REAL DEFAULT 0,
    net_total REAL DEFAULT 0,note TEXT DEFAULT '',verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),FOREIGN KEY(party_id)REFERENCES parties(id));
  CREATE TABLE IF NOT EXISTS invoice_items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,invoice_id INTEGER NOT NULL,
    sr INTEGER,item_name TEXT,qty REAL DEFAULT 0,rate REAL DEFAULT 0,total REAL DEFAULT 0,
    FOREIGN KEY(invoice_id)REFERENCES invoices(id)ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS credit_notes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,seq INTEGER,
    cn_date TEXT NOT NULL,party_id INTEGER NOT NULL,invoice_id INTEGER,
    amount REAL DEFAULT 0,note TEXT DEFAULT '',verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(party_id)REFERENCES parties(id),
    FOREIGN KEY(invoice_id)REFERENCES invoices(id)ON DELETE SET NULL);
  CREATE TABLE IF NOT EXISTS receipts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,seq INTEGER,
    rec_date TEXT NOT NULL,party_id INTEGER NOT NULL,
    amount REAL DEFAULT 0,remarks TEXT DEFAULT '',verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),FOREIGN KEY(party_id)REFERENCES parties(id));
  CREATE TABLE IF NOT EXISTS payments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,seq INTEGER,
    pay_date TEXT NOT NULL,party_id INTEGER NOT NULL,
    amount REAL DEFAULT 0,remarks TEXT DEFAULT '',verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),FOREIGN KEY(party_id)REFERENCES parties(id));
`);

function nextSeq(table){ const r=db.prepare(`SELECT COALESCE(MAX(seq),0)+1 as n FROM ${table}`).get(); return r.n; }
function getParty(name){ return db.prepare('SELECT * FROM parties WHERE name=?').get(name.trim()); }
function createParty(name,ob=0){ const r=db.prepare('INSERT INTO parties(name,opening_balance)VALUES(?,?)').run(name.trim(),ob); return db.prepare('SELECT * FROM parties WHERE id=?').get(r.lastInsertRowid); }
function ensureParty(name,ob=0){ return getParty(name)||createParty(name,ob); }

// ─── Google Drive Backup ──────────────────────────────────────────────────────
const GDRIVE_FOLDER_ID = '1PY8PtLXRVX0QSRnmEl6p7nw1cGefOVjM';
const TOKENS_FILE = path.join(DATA_DIR, 'gdrive_tokens.json');
const BACKUP_LOG_FILE = path.join(DATA_DIR, 'backup_log.json');

let oauth2Client = null;

function getAppUrl() {
  return process.env.APP_URL || `http://localhost:${PORT}`;
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
      if (data.client_id && data.client_secret) {
        oauth2Client = new google.auth.OAuth2(
          data.client_id,
          data.client_secret,
          getAppUrl() + '/api/backup/oauth2callback'
        );
        if (data.tokens) oauth2Client.setCredentials(data.tokens);
        return true;
      }
    }
  } catch(e) { /* ignore */ }
  return false;
}

function saveTokens(extra = {}) {
  const existing = fs.existsSync(TOKENS_FILE) ? JSON.parse(fs.readFileSync(TOKENS_FILE,'utf8')) : {};
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({...existing, ...extra}, null, 2));
}

function readBackupLog() {
  try {
    if (fs.existsSync(BACKUP_LOG_FILE)) return JSON.parse(fs.readFileSync(BACKUP_LOG_FILE, 'utf8'));
  } catch(e) {}
  return { history: [], lastStatus: null, lastTime: null };
}

function writeBackupLog(entry) {
  const log = readBackupLog();
  log.lastStatus = entry.status;
  log.lastTime = entry.time;
  log.history = [entry, ...(log.history||[])].slice(0, 30);
  fs.writeFileSync(BACKUP_LOG_FILE, JSON.stringify(log, null, 2));
}

async function performBackup(manual = false) {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g,'-').slice(0,19);
  const fileName = `bizapp-backup-${ts}.db`;
  const tag = manual ? 'Manual' : 'Auto';
  console.log(`[Backup] ${tag} backup starting: ${fileName}`);

  if (!oauth2Client) loadTokens();
  if (!oauth2Client) {
    const msg = 'Google Drive not connected. Please add credentials first.';
    writeBackupLog({ status:'error', time: now.toISOString(), file: fileName, message: msg, manual });
    return { success: false, message: msg };
  }
  const creds = oauth2Client.credentials;
  if (!creds || !creds.access_token) {
    const msg = 'Google Drive not authorized. Please complete the Google login step.';
    writeBackupLog({ status:'error', time: now.toISOString(), file: fileName, message: msg, manual });
    return { success: false, message: msg };
  }

  try {
    db.pragma('wal_checkpoint(FULL)');
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    await drive.files.get({ fileId: GDRIVE_FOLDER_ID, fields: 'id,name' });
    const fileStream = fs.createReadStream(DB_PATH);
    const response = await drive.files.create({
      requestBody: { name: fileName, parents: [GDRIVE_FOLDER_ID],
        description: `BizApp backup — ${tag} — ${now.toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})} IST` },
      media: { mimeType: 'application/x-sqlite3', body: fileStream },
      fields: 'id,name,size,webViewLink'
    });
    const msg = `Backup successful: ${response.data.name} (${Math.round((response.data.size||0)/1024)} KB)`;
    console.log('[Backup]', msg);
    writeBackupLog({ status:'success', time: now.toISOString(), file: response.data.name,
      fileId: response.data.id, link: response.data.webViewLink, size: response.data.size, message: msg, manual });
    try {
      const list = await drive.files.list({
        q: `'${GDRIVE_FOLDER_ID}' in parents and name contains 'bizapp-backup-' and trashed=false`,
        orderBy: 'createdTime desc', fields: 'files(id,name)', pageSize: 100 });
      const old = (list.data.files||[]).slice(30);
      for (const f of old) { await drive.files.delete({ fileId: f.id }); }
    } catch(e) { /* non-fatal */ }
    return { success: true, message: msg, link: response.data.webViewLink };
  } catch(e) {
    const msg = e.message || 'Unknown error during backup';
    console.error('[Backup] Error:', msg);
    writeBackupLog({ status:'error', time: now.toISOString(), file: fileName, message: msg, manual });
    return { success: false, message: msg };
  }
}

app.post('/api/backup/set-credentials', requireAuth, (req, res) => {
  const { client_id, client_secret } = req.body;
  if (!client_id || !client_secret) return res.status(400).json({ error: 'client_id and client_secret required' });
  saveTokens({ client_id, client_secret });
  loadTokens();
  res.json({ success: true });
});
app.get('/api/backup/auth-url', requireAuth, (req, res) => {
  if (!loadTokens()) return res.status(400).json({ error: 'Credentials not set.' });
  const url = oauth2Client.generateAuthUrl({ access_type:'offline', scope:['https://www.googleapis.com/auth/drive.file'], prompt:'consent' });
  res.json({ url });
});
app.get('/api/backup/oauth2callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Authorization failed: ${error}</h2>`);
  if (!code) return res.send('<h2>No code received.</h2>');
  try {
    if (!oauth2Client) loadTokens();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    saveTokens({ tokens });
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;max-width:500px;margin:auto;">
      <h2 style="color:#2d6a0f;">✅ Google Drive Connected!</h2>
      <p>BizApp is now authorized to back up your database to Google Drive every day at <strong>11:45 PM IST</strong>.</p>
      <p>You can close this tab and return to the app.</p></body></html>`);
  } catch(e) { res.send(`<h2>Error: ${e.message}</h2>`); }
});
app.get('/api/backup/status', requireAuth, (req, res) => {
  loadTokens();
  const tokensData = fs.existsSync(TOKENS_FILE) ? JSON.parse(fs.readFileSync(TOKENS_FILE,'utf8')) : {};
  const hasCredentials = !!(tokensData.client_id && tokensData.client_secret);
  const isAuthorized = !!(tokensData.tokens && tokensData.tokens.access_token);
  const log = readBackupLog();
  res.json({ hasCredentials, isAuthorized, folderId: GDRIVE_FOLDER_ID,
    folderUrl: `https://drive.google.com/drive/folders/${GDRIVE_FOLDER_ID}`,
    scheduledTime: '11:45 PM IST daily', ...log });
});
app.post('/api/backup/run', requireAuth, async (req, res) => { res.json(await performBackup(true)); });
app.post('/api/backup/disconnect', requireAuth, (req, res) => {
  try {
    if (fs.existsSync(TOKENS_FILE)) { const d=JSON.parse(fs.readFileSync(TOKENS_FILE,'utf8')); delete d.tokens; fs.writeFileSync(TOKENS_FILE,JSON.stringify(d,null,2)); }
    if (oauth2Client) oauth2Client.setCredentials({});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

loadTokens();
cron.schedule('45 23 * * *', () => { console.log('[Cron] Triggered scheduled backup'); performBackup(false); }, { timezone: 'Asia/Kolkata' });
console.log('[Backup] Daily backup scheduled at 11:45 PM IST');

// ─── Parties ─────────────────────────────────────────────────────────────────
app.get('/api/parties',(req,res)=>res.json(db.prepare('SELECT * FROM parties ORDER BY name').all()));
app.post('/api/parties',(req,res)=>{
  const{name,opening_balance}=req.body;
  if(!name)return res.status(400).json({error:'Name required'});
  try{
    const r=db.prepare('INSERT OR IGNORE INTO parties(name,opening_balance)VALUES(?,?)').run(name.trim(),opening_balance||0);
    res.json(db.prepare('SELECT * FROM parties WHERE id=?').get(r.lastInsertRowid||(db.prepare('SELECT id FROM parties WHERE name=?').get(name.trim())||{}).id));
  }catch(e){res.status(500).json({error:e.message});}
});
app.put('/api/parties/:id',requireAuth,(req,res)=>{
  const{name,opening_balance}=req.body;
  if(name){
    if(db.prepare('SELECT id FROM parties WHERE LOWER(name)=LOWER(?) AND id!=?').get(name.trim(),req.params.id))
      return res.status(400).json({error:'Party name already exists.'});
    db.prepare('UPDATE parties SET name=?,opening_balance=? WHERE id=?').run(name.trim(),opening_balance||0,req.params.id);
  }else{
    db.prepare('UPDATE parties SET opening_balance=? WHERE id=?').run(opening_balance||0,req.params.id);
  }
  res.json({success:true});
});

// ─── Invoices ────────────────────────────────────────────────────────────────
app.get('/api/invoices',(req,res)=>res.json(db.prepare(`SELECT i.*,p.name as party_name FROM invoices i JOIN parties p ON i.party_id=p.id ORDER BY i.seq DESC`).all()));
app.get('/api/invoices/:id',(req,res)=>{
  const inv=db.prepare(`SELECT i.*,p.name as party_name FROM invoices i JOIN parties p ON i.party_id=p.id WHERE i.id=?`).get(req.params.id);
  if(!inv)return res.status(404).json({error:'Not found'});
  res.json({...inv,items:db.prepare('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY sr').all(inv.id)});
});
app.post('/api/invoices',(req,res)=>{
  const{inv_date,party_name,opening_balance,items,gross_total,cess_pct,cess_amount,extra_charge_label,extra_charge_amount,net_total,note}=req.body;
  if(!inv_date||!party_name)return res.status(400).json({error:'Required fields missing'});
  const id=db.transaction(()=>{
    const party=ensureParty(party_name,opening_balance);
    const seq=nextSeq('invoices');
    const r=db.prepare(`INSERT INTO invoices(seq,inv_date,party_id,gross_total,cess_pct,cess_amount,extra_charge_label,extra_charge_amount,net_total,note)VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(seq,inv_date,party.id,gross_total,cess_pct,cess_amount,extra_charge_label||'',extra_charge_amount||0,net_total,note||'');
    (items||[]).forEach((item,idx)=>db.prepare('INSERT INTO invoice_items(invoice_id,sr,item_name,qty,rate,total)VALUES(?,?,?,?,?,?)').run(r.lastInsertRowid,idx+1,item.item_name,item.qty,item.rate,item.total));
    return r.lastInsertRowid;
  })();
  res.json({success:true,id});
});
app.delete('/api/invoices/:id',requireAuth,(req,res)=>{db.prepare('DELETE FROM invoices WHERE id=?').run(req.params.id);res.json({success:true});});
app.put('/api/invoices/:id/verify',requireAuth,(req,res)=>{db.prepare('UPDATE invoices SET verified=? WHERE id=?').run(req.body.verified?1:0,req.params.id);res.json({success:true});});

// ─── Credit Notes ─────────────────────────────────────────────────────────────
app.get('/api/credit-notes',(req,res)=>res.json(db.prepare(`SELECT cn.*,p.name as party_name,i.seq as inv_seq FROM credit_notes cn JOIN parties p ON cn.party_id=p.id LEFT JOIN invoices i ON cn.invoice_id=i.id ORDER BY cn.seq DESC`).all()));
app.post('/api/credit-notes',(req,res)=>{
  const{cn_date,party_name,invoice_id,amount,note}=req.body;
  if(!cn_date||!party_name||!amount)return res.status(400).json({error:'Required fields missing'});
  const id=db.transaction(()=>{
    const party=ensureParty(party_name);
    const seq=nextSeq('credit_notes');
    return db.prepare('INSERT INTO credit_notes(seq,cn_date,party_id,invoice_id,amount,note)VALUES(?,?,?,?,?,?)').run(seq,cn_date,party.id,invoice_id||null,amount,note||'').lastInsertRowid;
  })();
  res.json({success:true,id});
});
app.delete('/api/credit-notes/:id',requireAuth,(req,res)=>{db.prepare('DELETE FROM credit_notes WHERE id=?').run(req.params.id);res.json({success:true});});
app.put('/api/credit-notes/:id/verify',requireAuth,(req,res)=>{db.prepare('UPDATE credit_notes SET verified=? WHERE id=?').run(req.body.verified?1:0,req.params.id);res.json({success:true});});

// ─── Receipts ─────────────────────────────────────────────────────────────────
app.get('/api/receipts',(req,res)=>res.json(db.prepare(`SELECT r.*,p.name as party_name FROM receipts r JOIN parties p ON r.party_id=p.id ORDER BY r.seq DESC`).all()));
app.post('/api/receipts',(req,res)=>{
  const{rec_date,party_name,amount,remarks}=req.body;
  if(!rec_date||!party_name||!amount)return res.status(400).json({error:'Required fields missing'});
  const id=db.transaction(()=>{
    const party=ensureParty(party_name);
    const seq=nextSeq('receipts');
    return db.prepare('INSERT INTO receipts(seq,rec_date,party_id,amount,remarks)VALUES(?,?,?,?,?)').run(seq,rec_date,party.id,amount,remarks||'').lastInsertRowid;
  })();
  res.json({success:true,id});
});
app.delete('/api/receipts/:id',requireAuth,(req,res)=>{db.prepare('DELETE FROM receipts WHERE id=?').run(req.params.id);res.json({success:true});});
app.put('/api/receipts/:id/verify',requireAuth,(req,res)=>{db.prepare('UPDATE receipts SET verified=? WHERE id=?').run(req.body.verified?1:0,req.params.id);res.json({success:true});});

// ─── Payments ─────────────────────────────────────────────────────────────────
app.get('/api/payments',(req,res)=>res.json(db.prepare(`SELECT p.*,pt.name as party_name FROM payments p JOIN parties pt ON p.party_id=pt.id ORDER BY p.seq DESC`).all()));
app.post('/api/payments',(req,res)=>{
  const{pay_date,party_name,amount,remarks}=req.body;
  if(!pay_date||!party_name||!amount)return res.status(400).json({error:'Required fields missing'});
  const id=db.transaction(()=>{
    const party=ensureParty(party_name);
    const seq=nextSeq('payments');
    return db.prepare('INSERT INTO payments(seq,pay_date,party_id,amount,remarks)VALUES(?,?,?,?,?)').run(seq,pay_date,party.id,amount,remarks||'').lastInsertRowid;
  })();
  res.json({success:true,id});
});
app.delete('/api/payments/:id',requireAuth,(req,res)=>{db.prepare('DELETE FROM payments WHERE id=?').run(req.params.id);res.json({success:true});});
app.put('/api/payments/:id/verify',requireAuth,(req,res)=>{db.prepare('UPDATE payments SET verified=? WHERE id=?').run(req.body.verified?1:0,req.params.id);res.json({success:true});});

// ─── Ledger ───────────────────────────────────────────────────────────────────
app.get('/api/ledger',(req,res)=>{
  const{party_id,from_date,to_date}=req.query;
  if(!party_id)return res.status(400).json({error:'party_id required'});
  const party=db.prepare('SELECT * FROM parties WHERE id=?').get(party_id);
  if(!party)return res.status(404).json({error:'Party not found'});
  const df=(col)=>`${col} >= COALESCE(?,'0000-00-00') AND ${col} <= COALESCE(?,'9999-12-31')`;
  const inv=db.prepare(`SELECT id,seq,inv_date as date,seq as ref,net_total as amount,'Estimate' as type,note as remarks FROM invoices WHERE party_id=? AND ${df('inv_date')} ORDER BY inv_date,id`).all(party_id,from_date||null,to_date||null);
  const cn=db.prepare(`SELECT id,seq,cn_date as date,seq as ref,amount,'Credit Note' as type,note as remarks FROM credit_notes WHERE party_id=? AND ${df('cn_date')} ORDER BY cn_date,id`).all(party_id,from_date||null,to_date||null);
  const rec=db.prepare(`SELECT id,seq,rec_date as date,seq as ref,amount,'Receipt' as type,remarks FROM receipts WHERE party_id=? AND ${df('rec_date')} ORDER BY rec_date,id`).all(party_id,from_date||null,to_date||null);
  const pay=db.prepare(`SELECT id,seq,pay_date as date,seq as ref,amount,'Payment' as type,remarks FROM payments WHERE party_id=? AND ${df('pay_date')} ORDER BY pay_date,id`).all(party_id,from_date||null,to_date||null);
  const txns=[...inv,...cn,...rec,...pay].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  let balance=party.opening_balance||0;
  const rows=txns.map(t=>{
    const debit=(t.type==='Estimate'||t.type==='Payment')?t.amount:0;
    const credit=(t.type==='Estimate'||t.type==='Payment')?0:t.amount;
    balance=balance+debit-credit;
    return{...t,debit,credit,balance};
  });
  res.json({party,opening_balance:party.opening_balance||0,transactions:rows,closing_balance:balance});
});

app.get('/api/next-no/:type',(req,res)=>{
  const map={invoice:{tbl:'invoices',col:'inv_no',prefix:'INV-'},credit:{tbl:'credit_notes',col:'cn_no',prefix:'CN-'},receipt:{tbl:'receipts',col:'rec_no',prefix:'REC-'},payment:{tbl:'payments',col:'pay_no',prefix:'PAY-'}};
  const m=map[req.params.type];
  if(!m)return res.status(400).json({error:'Unknown type'});
  const last=db.prepare(`SELECT ${m.col} FROM ${m.tbl} ORDER BY id DESC LIMIT 1`).get();
  let next=m.prefix+'001';
  if(last){const val=last[m.col];const match=val.match(/(\D*)(\d+)$/);if(match)next=match[1]+(parseInt(match[2])+1).toString().padStart(match[2].length,'0');}
  res.json({next});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`App running on http://localhost:${PORT}`));
