/* Database: schema + first-run seed from seed_data.json (Coach Master File extract). */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'coach.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pw TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','lead','sales','coach')),
  team TEXT, coach_id TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS coaches(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS blocks(
  coach_id TEXT NOT NULL, week TEXT NOT NULL, kind TEXT NOT NULL, label TEXT DEFAULT '',
  PRIMARY KEY(coach_id, week));
CREATE TABLE IF NOT EXISTS visits(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT NOT NULL, program TEXT DEFAULT '', cycle TEXT DEFAULT '',
  due TEXT, completed INTEGER DEFAULT 0, completed_on TEXT,
  team TEXT, coach_hist TEXT DEFAULT '', salesperson TEXT DEFAULT '',
  sold TEXT, source TEXT DEFAULT 'app',
  cal_coach TEXT, cal_week TEXT, sched_hist TEXT);
CREATE INDEX IF NOT EXISTS iv_cal ON visits(cal_coach, cal_week);
CREATE INDEX IF NOT EXISTS iv_due ON visits(due);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, user TEXT NOT NULL, action TEXT NOT NULL, detail TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS password_resets(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created TEXT);

/* ---- Phase 1: system-of-record entities ---- */
/* Canonical client per dealership. Churned clients are never deleted — status changes. */
CREATE TABLE IF NOT EXISTS clients(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                 -- canonical display name
  norm TEXT UNIQUE NOT NULL,          -- normalized match key
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','cancelled')),
  billing_start TEXT,                 -- when they first started paying (earliest sold)
  keap_id TEXT DEFAULT '',            -- Keap company id, for later reconciliation
  notes TEXT DEFAULT '',
  created TEXT);
CREATE INDEX IF NOT EXISTS ic_norm ON clients(norm);
CREATE INDEX IF NOT EXISTS ic_keap ON clients(keap_id);
/* A contract = one Keap subscription. Generates a cycle of due visits. */
CREATE TABLE IF NOT EXISTS contracts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  program TEXT DEFAULT '',
  visits INTEGER DEFAULT 0,           -- number of visits in the cycle
  start_date TEXT,                    -- billing start (= when they started paying for this)
  price REAL,                         -- amount paid; NULL until known (comes from Keap)
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
  source TEXT DEFAULT 'app',          -- 'sheet' = reconstructed from import, 'app' = created in-app, 'keap' = live sync
  created TEXT);
CREATE INDEX IF NOT EXISTS ict_client ON contracts(client_id);

/* ---- Phase 2: live Keap sync ---- */
/* Queue of new Keap subscriptions awaiting a human to assign a team + confirm the
   program/visit-cadence, before a contract + visit cycle is generated. */
CREATE TABLE IF NOT EXISTS pending_clients(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keap_subscription_id TEXT UNIQUE,
  keap_contact_id TEXT,
  keap_company_id TEXT,
  company_name TEXT DEFAULT '',
  contact_name TEXT DEFAULT '',
  product_desc TEXT DEFAULT '',       -- Keap subscription plan name, e.g. "SUB - Chris Collins Signature Coaching Program"
  billing_amount REAL,
  billing_cycle TEXT DEFAULT '',
  billing_frequency INTEGER,
  start_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','assigned','ignored')),
  resolved_client_id INTEGER,         -- set once assigned
  resolved_contract_id INTEGER,
  created TEXT);
CREATE INDEX IF NOT EXISTS ipc_status ON pending_clients(status);
/* Raw log of every webhook Keap sends us — cheap insurance while we're validating
   the integration; safe to prune later. */
CREATE TABLE IF NOT EXISTS keap_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, event_key TEXT, object_id TEXT, raw TEXT, handled TEXT DEFAULT '');

/* ---- Monthly client roster archive ---- */
/* One frozen row per client per calendar month, capturing their status as of
   whenever that month's snapshot ran. This is what lets "how many active clients
   did we have in March" be answered later instead of only ever reflecting today. */
CREATE TABLE IF NOT EXISTS client_month_snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,               -- 'YYYY-MM'
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,                 -- denormalized so renames later don't rewrite history
  status TEXT NOT NULL,
  active_contracts INTEGER NOT NULL DEFAULT 0,
  keap_id TEXT DEFAULT '',
  created TEXT,
  UNIQUE(period, client_id));
CREATE INDEX IF NOT EXISTS icms_period ON client_month_snapshots(period);
`);

/* Add client_id / contract_id links to visits (idempotent). */
function ensureColumn(table, col, decl){
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if(!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
ensureColumn('visits', 'client_id', 'INTEGER');
ensureColumn('visits', 'contract_id', 'INTEGER');
ensureColumn('contracts', 'keap_subscription_id', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS ict_keapsub ON contracts(keap_subscription_id)');
ensureColumn('clients', 'assigned_coach_id', 'TEXT');

/* ---------- client profiles: coach notes ---------- */
/* A running notes history per client, visible/addable by any coach, lead, or
   admin — the idea is this replaces jotting notes in Keap going forward.
   Each note is titled by its own date + type (Coaching Call / LID) rather
   than just when it was typed up, since those can differ. Only admins can
   edit or delete a note, so the history stays trustworthy. */
db.exec(`
CREATE TABLE IF NOT EXISTS client_notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  note_date TEXT NOT NULL,            -- 'YYYY-MM-DD' — the date the call/LID actually happened
  note_type TEXT NOT NULL DEFAULT 'Coaching Call' CHECK(note_type IN ('Coaching Call','LID')),
  author_email TEXT NOT NULL,
  author_name TEXT DEFAULT '',
  body TEXT NOT NULL,
  created TEXT NOT NULL,
  edited TEXT);
CREATE INDEX IF NOT EXISTS icn_client ON client_notes(client_id);
`);
ensureColumn('client_notes', 'note_date', "TEXT NOT NULL DEFAULT ''");
ensureColumn('client_notes', 'note_type', "TEXT NOT NULL DEFAULT 'Coaching Call'");
ensureColumn('client_notes', 'edited', 'TEXT');

/* ---------- helpers ---------- */
function hashPw(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPw(pw, stored){
  const [salt, h] = String(stored).split(':');
  if(!salt || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getMeta(k){ const r = db.prepare('SELECT value FROM meta WHERE key=?').get(k); return r ? r.value : null; }
function setMeta(k, v){ db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v)); }
function log(user, action, detail){
  db.prepare('INSERT INTO audit(ts,user,action,detail) VALUES(?,?,?,?)')
    .run(new Date().toISOString(), user, action, typeof detail==='string'?detail:JSON.stringify(detail));
}

/* ---------- forgot-password tokens ---------- */
function createPasswordReset(userId, ttlMinutes = 30){
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  db.prepare('INSERT INTO password_resets(token,user_id,expires,used,created) VALUES(?,?,?,0,?)')
    .run(token, userId, expires, new Date().toISOString());
  return token;
}
function consumePasswordReset(token, newPw){
  const row = db.prepare('SELECT * FROM password_resets WHERE token=?').get(token);
  if(!row) return { ok:false, error:'Invalid or expired link' };
  if(row.used) return { ok:false, error:'This reset link was already used' };
  if(new Date(row.expires) < new Date()) return { ok:false, error:'This reset link has expired' };
  db.prepare('UPDATE users SET pw=? WHERE id=?').run(hashPw(newPw), row.user_id);
  db.prepare('UPDATE password_resets SET used=1 WHERE token=?').run(token);
  const u = db.prepare('SELECT id,email,name FROM users WHERE id=?').get(row.user_id);
  return { ok:true, user:u };
}

/* ---------- first-run seed ---------- */
function seed(){
  if(getMeta('seeded')) return;
  const seedPath = path.join(__dirname, 'seed_data.json');
  if(!fs.existsSync(seedPath)){ console.log('No seed_data.json — starting empty.'); setMeta('seeded','empty'); bootstrapAdmin(); return; }
  const DATA = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const TODAY = new Date().toISOString().slice(0,10);
  const dayDiff = (a,b) => (new Date(a) - new Date(b)) / 864e5;

  setMeta('teams', JSON.stringify(DATA.teams || ['Hogi','Cliff','Bryan']));

  const insCoach = db.prepare('INSERT INTO coaches(id,name,team) VALUES(?,?,?)');
  for(const c of DATA.coaches) insCoach.run(c.id, c.name.trim(), c.team);

  // cell map with visit linking (same logic the prototype validated)
  const cells = {};
  for(const s of DATA.schedule)
    cells[s.coach + '|' + s.week] = { kind: s.kind, text: s.text || '', visitId: null };
  const gridByClient = {};
  for(const s of DATA.schedule)
    if(s.kind === 'visit' && s.client) (gridByClient[norm(s.client)] ||= []).push(s);

  const coachTeam = Object.fromEntries(DATA.coaches.map(c => [c.id, c.team]));
  const SP = { 'matt eschilman':'matt eschliman', 'josh stuban':'joshua stuban' };
  const teamOfCoachText = txt => {
    for(const part of (txt||'').split(/[,/&]| and /)){
      let n = norm(part); n = SP[n] || n; if(!n) continue;
      for(const c of DATA.coaches){
        const cn = norm(c.name).replace(/\s*\/.*$/,'');
        if(cn.includes(n) || n.includes(cn)) return c.team;
      }
    }
    return null;
  };

  const insVisit = db.prepare(`INSERT INTO visits
    (client,program,cycle,due,completed,team,coach_hist,salesperson,sold,source,cal_coach,cal_week,sched_hist)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(const v of DATA.visits){
    const team = teamOfCoachText(v.coach) ||
      (gridByClient[norm(v.client)] ? coachTeam[gridByClient[norm(v.client)][0].coach] : null);
    let calCoach = null, calWeek = null;
    if(!v.completed && v.due){
      let best = null;
      for(const s of (gridByClient[norm(v.client)] || [])){
        const d = Math.abs(dayDiff(s.week, v.due));
        if(!best || d < best.d) best = { d, s };
      }
      if(best && best.d <= 65 && best.s.week >= TODAY){
        const key = best.s.coach + '|' + best.s.week;
        if(cells[key] && !cells[key].visitId){
          cells[key].visitId = 1; // mark linked
          calCoach = best.s.coach; calWeek = best.s.week;
        }
      }
    }
    insVisit.run(v.client, v.program||'', v.cycle||'', v.due||null, v.completed?1:0,
      team, v.coach||'', v.salesperson||'', v.sold||null, 'sheet', calCoach, calWeek,
      v.scheduled_week||null);
  }

  // remaining non-open cells become blocks (incl. legacy visit cells with no inventory link)
  const insBlock = db.prepare('INSERT INTO blocks(coach_id,week,kind,label) VALUES(?,?,?,?)');
  for(const [key, c] of Object.entries(cells)){
    if(c.kind === 'open') continue;
    if(c.kind === 'visit' && c.visitId) continue;      // covered by visit cal link
    const [coachId, week] = key.split('|');
    insBlock.run(coachId, week, c.kind, c.text);
  }
  setMeta('seeded', new Date().toISOString());
  bootstrapAdmin();
  console.log('Seeded from Coach Master File extract:',
    DATA.coaches.length, 'coaches,', DATA.visits.length, 'visits.');
}
function bootstrapAdmin(){
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if(n > 0) return;
  const pw = 'Bulldog!' + Math.floor(1000 + Math.random()*9000);
  db.prepare('INSERT INTO users(email,name,pw,role) VALUES(?,?,?,?)')
    .run('mike@chriscollinsinc.com', 'Mike', hashPw(pw), 'admin');
  setMeta('bootstrap_pw_notice', pw);
  console.log('\n========================================================');
  console.log('  First run — admin account created:');
  console.log('  email:    mike@chriscollinsinc.com');
  console.log('  password: ' + pw);
  console.log('  (change it after logging in: Admin -> Users)');
  console.log('========================================================\n');
}
/* ---------- shared client helpers ---------- */
const normName = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const minDate = (a,b) => !a ? b : !b ? a : (a < b ? a : b);

/* Find a client by normalized name, or create one. Returns the client row id. */
function resolveClient(name, opts = {}){
  const nm = (name||'').trim();
  const key = normName(nm);
  if(!key) return null;
  let row = db.prepare('SELECT * FROM clients WHERE norm=?').get(key);
  if(!row){
    const r = db.prepare('INSERT INTO clients(name,norm,status,billing_start,keap_id,created) VALUES(?,?,?,?,?,?)')
      .run(nm, key, opts.status || 'active', opts.billing_start || null, opts.keap_id || '', new Date().toISOString());
    return Number(r.lastInsertRowid);
  }
  // keep billing_start as the earliest known
  if(opts.billing_start){
    const bs = minDate(row.billing_start, opts.billing_start);
    if(bs !== row.billing_start) db.prepare('UPDATE clients SET billing_start=? WHERE id=?').run(bs, row.id);
  }
  if(opts.keap_id && !row.keap_id) db.prepare('UPDATE clients SET keap_id=? WHERE id=?').run(opts.keap_id, row.id);
  return row.id;
}
/* Find a client already linked to a Keap company id. */
function findClientByKeapId(keapCompanyId){
  if(!keapCompanyId) return null;
  return db.prepare('SELECT * FROM clients WHERE keap_id=?').get(String(keapCompanyId));
}

/* ---------- Phase 1 one-time backfill ---------- */
/* Turns the flat visit rows (string client, no persisted contract) into the
   client + contract entities. Idempotent: guarded by a meta flag, and only
   touches rows that aren't linked yet, so it's safe to re-run. */
function migratePhase1(){
  if(getMeta('phase1_migrated')) return;
  const parseCycle = c => { const m = /^(\d+)\s*of\s*(\d+)/i.exec(c||''); return m ? { k:+m[1], n:+m[2] } : null; };

  const tx = () => {
    // 1 & 2 — clients from distinct visit strings, link visits.client_id
    const visitsForClients = db.prepare('SELECT id, client, sold FROM visits WHERE client_id IS NULL').all();
    for(const v of visitsForClients){
      const cid = resolveClient(v.client, { billing_start: v.sold || null });
      if(cid) db.prepare('UPDATE visits SET client_id=? WHERE id=?').run(cid, v.id);
    }

    // 3 — reconstruct contracts per client from the visit sequence.
    // A new contract begins when the cycle resets to "1 of N" or the program changes.
    const clients = db.prepare('SELECT id FROM clients').all();
    const insContract = db.prepare(`INSERT INTO contracts(client_id,program,visits,start_date,price,status,source,created)
      VALUES(?,?,?,?,?,?,?,?)`);
    const now = new Date().toISOString();
    for(const cl of clients){
      const vs = db.prepare('SELECT * FROM visits WHERE client_id=? AND contract_id IS NULL ORDER BY id').all(cl.id);
      let run = [];
      const flush = () => {
        if(!run.length) return;
        const first = run[0];
        const pc = parseCycle(first.cycle);
        const count = pc ? pc.n : run.length;
        let start = null; for(const r of run) start = minDate(start, r.sold);
        const anyOpen = run.some(r => !r.completed);
        const cr = insContract.run(cl.id, first.program || '', count, start, null,
          anyOpen ? 'active' : 'completed', 'sheet', now);
        const contractId = Number(cr.lastInsertRowid);
        const upd = db.prepare('UPDATE visits SET contract_id=? WHERE id=?');
        for(const r of run) upd.run(contractId, r.id);
        run = [];
      };
      let prevProg = null;
      for(const v of vs){
        const pc = parseCycle(v.cycle);
        const resets = pc && pc.k === 1;
        const progChanged = prevProg !== null && v.program !== prevProg;
        if(run.length && (resets || progChanged)) flush();
        run.push(v);
        prevProg = v.program;
      }
      flush();

      // 4 — client status heuristic (pre-Keap): active if any incomplete visit, else inactive.
      const openCount = db.prepare('SELECT COUNT(*) c FROM visits WHERE client_id=? AND completed=0').get(cl.id).c;
      db.prepare('UPDATE clients SET status=? WHERE id=?').run(openCount > 0 ? 'active' : 'inactive', cl.id);
    }
  };

  db.exec('BEGIN');
  try{ tx(); db.exec('COMMIT'); }
  catch(e){ db.exec('ROLLBACK'); console.error('Phase 1 migration failed:', e); return; }

  const nc = db.prepare('SELECT COUNT(*) c FROM clients').get().c;
  const ncon = db.prepare('SELECT COUNT(*) c FROM contracts').get().c;
  setMeta('phase1_migrated', new Date().toISOString());
  log('system', 'migrate.phase1', { clients: nc, contracts: ncon });
  console.log(`Phase 1 migration: ${nc} clients, ${ncon} contracts backfilled from ${db.prepare('SELECT COUNT(*) c FROM visits').get().c} visits.`);
}

/* ---------- monthly client roster snapshot ---------- */
/* Freezes every client's current status into client_month_snapshots for the given
   period (default: this calendar month, UTC). Idempotent per (period, client_id) —
   INSERT OR REPLACE means re-running the same month just refreshes it with today's
   status rather than creating duplicates, so it's safe to call as often as you like;
   only the *first* call for a new month matters, but later ones just update in place. */
function snapshotClientMonth(period){
  const p = period || new Date().toISOString().slice(0, 7);
  const clients = db.prepare('SELECT * FROM clients').all();
  const ins = db.prepare(`INSERT INTO client_month_snapshots(period,client_id,name,status,active_contracts,keap_id,created)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(period,client_id) DO UPDATE SET name=excluded.name, status=excluded.status,
      active_contracts=excluded.active_contracts, keap_id=excluded.keap_id`);
  const now = new Date().toISOString();
  let n = 0;
  for(const c of clients){
    const activeContracts = db.prepare("SELECT COUNT(*) c FROM contracts WHERE client_id=? AND status='active'").get(c.id).c;
    ins.run(p, c.id, c.name, c.status, activeContracts, c.keap_id || '', now);
    n++;
  }
  log('system', 'snapshot.client_month', { period: p, clients: n });
  return { period: p, clients: n };
}
/* Runs the current month's snapshot once, guarded by a meta flag so a restart
   or a busy day doesn't re-run it needlessly. Call this at startup — cheap even
   if it's a no-op, and guarantees every month gets captured without a cron job. */
function ensureCurrentMonthSnapshot(){
  const period = new Date().toISOString().slice(0, 7);
  const flagKey = 'snapshot_done_' + period;
  if(getMeta(flagKey)) return;
  snapshotClientMonth(period);
  setMeta(flagKey, new Date().toISOString());
}

/* ---------- one-time: Coaching Assignments sheet import ---------- */
/* Sourced from the "Coaching Assignments" tab of the Coach Master File —
   118 existing clients matched by name to their coach, plus 51 net-new
   "Coaching Only" clients (remote coaching, no LID visits ever generated —
   visits stays 0 on their contract) that the sheet has but the app didn't.
   Guarded by a meta flag so it only ever runs once; safe to leave in place. */
const COACH_ASSIGN_DATA = {
  "assign": [
    {
      "client_norm": "franklin s spring creek ford",
      "coach_id": "bryan_bryan_hubert"
    },
    {
      "client_norm": "speck ford of prosser",
      "coach_id": "bryan_bryan_hubert"
    },
    {
      "client_norm": "d arcy buick gmc",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "goldstein cdjr",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "honda superstore of joliet",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "nissan of new rochelle",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "speck buick gmc of tri cities",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "speck cdjr",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "c speck motors inc",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "speck chevrolet of prosser",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "speck hyundai of tri cities",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "suski chevrolet buick",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "tom hesser chevrolet bmw",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "tom hesser nissan",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "volvo cars lisle",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "honda superstore of lisle",
      "coach_id": "hogi_jean_giurguis"
    },
    {
      "client_norm": "automaxx cdjr",
      "coach_id": "hogi_jerrad_avery"
    },
    {
      "client_norm": "turan foley chev cad buick",
      "coach_id": "hogi_jerrad_avery"
    },
    {
      "client_norm": "walla walla toyota",
      "coach_id": "hogi_jerrad_avery"
    },
    {
      "client_norm": "bill luke cdjr",
      "coach_id": "hogi_jerrad_avery"
    },
    {
      "client_norm": "blasius kia",
      "coach_id": "hogi_jerrad_avery"
    },
    {
      "client_norm": "bristol honda",
      "coach_id": "hogi_jerrad_avery"
    },
    {
      "client_norm": "university auto center",
      "coach_id": "hogi_jerrad_avery"
    },
    {
      "client_norm": "lum s auto center",
      "coach_id": "hogi_jerrad_avery"
    },
    {
      "client_norm": "lum s gmc",
      "coach_id": "hogi_jerrad_avery"
    },
    {
      "client_norm": "m a g classic nissan newport news",
      "coach_id": "hogi_jerrad_avery"
    },
    {
      "client_norm": "harnish chevrolet buick gmc of puyallup",
      "coach_id": "hogi_jerrad_avery"
    },
    {
      "client_norm": "harnish volkswagen of puyallup",
      "coach_id": "hogi_jerrad_avery"
    },
    {
      "client_norm": "bowman chevrolet",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "coleman le mars chevrolet",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "toyota of ann arbor",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "m a g classic toyota wilkesboro",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "m a g infiniti of charlotte",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "twin state ford inc",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "gallatin ford",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "coleman nissan streetsboro",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "gallatin cdjr",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "m a g audi of hampton",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "m a g classic cdjrf lancaster",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "m a g classic ford lincoln of shelby",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "tinney chevrolet gmc",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "lamoille valley ford",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "m a g classic cdjr of south charlotte",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "m a g classic ford lincoln of columbia",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "m a g classic volkswagen gastonia",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "m a g ford of harvey",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "m a g porsche charlotte northlake",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "north star kia",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "page honda bloomfield",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "cowboy chevrolet gmc",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "patriot chevrolet of warminster",
      "coach_id": "cliff_cliff_honeycutt"
    },
    {
      "client_norm": "bowman chevrolet of clinton",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "coleman nissan of warsaw",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "finnin kia",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "johnson city acura",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g classic cdjrf of goldsboro",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g classic ford of smithfield",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g classic kia smithfield",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "tyson motor cdjr",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g classic toyota hampton",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g classic nissan sanford",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g infiniti of greenville",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g mazda of greenville",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g jaguar columbia",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g stateline cdjr maserati alfa romeo",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "sterling acura of austin",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g bentley vinfast ineos",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g honda of harvey",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g bmw mercedes benz of bowling green",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g classic nissan williamsburg",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "m a g classic toyota henderson",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "d arcy hyundai",
      "coach_id": "hogi_chris_hogland"
    },
    {
      "client_norm": "subaru of pueblo",
      "coach_id": "hogi_chris_hogland"
    },
    {
      "client_norm": "leo payne honda",
      "coach_id": "hogi_chris_hogland"
    },
    {
      "client_norm": "planet honda of golden co",
      "coach_id": "hogi_chris_hogland"
    },
    {
      "client_norm": "planet hyundai",
      "coach_id": "hogi_chris_hogland"
    },
    {
      "client_norm": "randy wise chevrolet",
      "coach_id": "hogi_chris_hogland"
    },
    {
      "client_norm": "culver city chevrolet",
      "coach_id": "bryan_dylan_roberts"
    },
    {
      "client_norm": "harnish chevrolet of everett",
      "coach_id": "bryan_dylan_roberts"
    },
    {
      "client_norm": "gary rome kia",
      "coach_id": "bryan_dylan_roberts"
    },
    {
      "client_norm": "puente hills cdjr",
      "coach_id": "bryan_dylan_roberts"
    },
    {
      "client_norm": "north bend chevrolet",
      "coach_id": "bryan_dylan_roberts"
    },
    {
      "client_norm": "scott honda of west chester",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "m a g hyundai genesis of hampton",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "central chevrolet inc",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "mandal buick gmc",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "k a g keating toyota",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "k a g northwest hyundai",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "scott honda of vineland",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "devoe cadillac",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "karl flammer ford",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "mandal cdjr",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "scott kia of springfield",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "selking international trucks",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "strong volkswagen",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "scott kia of limerick",
      "coach_id": "hogi_hunter_blake"
    },
    {
      "client_norm": "livingston motor company",
      "coach_id": "bryan_james_baumer"
    },
    {
      "client_norm": "paragon acura",
      "coach_id": "bryan_james_baumer"
    },
    {
      "client_norm": "jenkins hyundai of ocala",
      "coach_id": "bryan_james_baumer"
    },
    {
      "client_norm": "gary rome hyundai",
      "coach_id": "bryan_james_baumer"
    },
    {
      "client_norm": "dralle chevrolet and buick",
      "coach_id": "bryan_james_baumer"
    },
    {
      "client_norm": "easterns nissan of white marsh",
      "coach_id": "bryan_james_baumer"
    },
    {
      "client_norm": "prince chevrolet albany",
      "coach_id": "bryan_james_baumer"
    },
    {
      "client_norm": "yokem toyota",
      "coach_id": "bryan_vicki_johns"
    },
    {
      "client_norm": "hedrick s chevrolet",
      "coach_id": "bryan_vicki_johns"
    },
    {
      "client_norm": "metro toyota",
      "coach_id": "bryan_vicki_johns"
    },
    {
      "client_norm": "lasco ford",
      "coach_id": "bryan_vicki_johns"
    },
    {
      "client_norm": "m a g land rover volvo shreveport",
      "coach_id": "bryan_vicki_johns"
    },
    {
      "client_norm": "m a g toyota of kenner",
      "coach_id": "bryan_vicki_johns"
    },
    {
      "client_norm": "brickell honda of dt chicago",
      "coach_id": "bryan_vicki_johns"
    },
    {
      "client_norm": "honda libertyville",
      "coach_id": "bryan_vicki_johns"
    },
    {
      "client_norm": "price family volvo marin",
      "coach_id": "bryan_vicki_johns"
    },
    {
      "client_norm": "brickell vw of dt chicago",
      "coach_id": "bryan_vicki_johns"
    },
    {
      "client_norm": "price family mercedes benz of fairfield",
      "coach_id": "bryan_vicki_johns"
    },
    {
      "client_norm": "riverside chevrolet gmc of rome",
      "coach_id": "bryan_bryan_hubert"
    },
    {
      "client_norm": "riverside cadillac gmc of cartersville",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "riverside nissan of rome",
      "coach_id": "cliff_josh_stuban"
    },
    {
      "client_norm": "riverside toyota",
      "coach_id": "bryan_dylan_roberts"
    }
  ],
  "newClients": [
    {
      "name": "Roseville Chevrolet",
      "coach_id": "bryan_bryan_hubert",
      "price": 1995.0
    },
    {
      "name": "Price Family Ford Sacramento",
      "coach_id": "bryan_bryan_hubert",
      "price": 1750.0
    },
    {
      "name": "Cambridge Centre Honda",
      "coach_id": "hogi_jean_giurguis",
      "price": 1460.73
    },
    {
      "name": "Wesley Chapel Toyota",
      "coach_id": "hogi_jean_giurguis",
      "price": 1500.0
    },
    {
      "name": "Sherwood Honda",
      "coach_id": "hogi_jean_giurguis",
      "price": 1457.88
    },
    {
      "name": "BMW of Lafayette",
      "coach_id": "cliff_cliff_honeycutt",
      "price": 1495
    },
    {
      "name": "Koehne Chevrolet Buick GMC, Inc",
      "coach_id": "cliff_cliff_honeycutt",
      "price": 1500.0
    },
    {
      "name": "Mercedes Benz of Lafayette",
      "coach_id": "cliff_cliff_honeycutt",
      "price": 1495.0
    },
    {
      "name": "M.A.G. Classic Hyundai of North Wilkesboro",
      "coach_id": "cliff_cliff_honeycutt",
      "price": 3500.0
    },
    {
      "name": "M.A.G. Beckley Chevrolet",
      "coach_id": "cliff_cliff_honeycutt",
      "price": 3500.0
    },
    {
      "name": "M.A.G. Mercedes-Benz of Hampton",
      "coach_id": "cliff_cliff_honeycutt",
      "price": 3500.0
    },
    {
      "name": "Page Toyota",
      "coach_id": "cliff_cliff_honeycutt",
      "price": 1500.0
    },
    {
      "name": "Patriot Chevrolet of Limerick",
      "coach_id": "cliff_cliff_honeycutt",
      "price": 1500.0
    },
    {
      "name": "Sam Boswell Honda",
      "coach_id": "cliff_cliff_honeycutt",
      "price": 1500.0
    },
    {
      "name": "BMW of Barrington",
      "coach_id": "cliff_cliff_honeycutt",
      "price": 1495.0
    },
    {
      "name": "Rogers Toyota Lewiston",
      "coach_id": "cliff_josh_stuban",
      "price": 1495.0
    },
    {
      "name": "Brickell Buick GMC",
      "coach_id": "hogi_chris_hogland",
      "price": 1495
    },
    {
      "name": "Brickell Mazda",
      "coach_id": "hogi_chris_hogland",
      "price": 1495.0
    },
    {
      "name": "Brickell Honda",
      "coach_id": "hogi_chris_hogland",
      "price": 1495.0
    },
    {
      "name": "Federico CDJR",
      "coach_id": "hogi_chris_hogland",
      "price": 2000.0
    },
    {
      "name": "Federico Kia",
      "coach_id": "hogi_chris_hogland",
      "price": 2000.0
    },
    {
      "name": "Watsonville CDJR",
      "coach_id": "hogi_chris_hogland",
      "price": 1500.0
    },
    {
      "name": "Price Family Modesto Toyota",
      "coach_id": "bryan_dylan_roberts",
      "price": 1750.0
    },
    {
      "name": "Cox Chevrolet",
      "coach_id": "hogi_hunter_blake",
      "price": 800.0
    },
    {
      "name": "Brickell Bentley of Central NJ",
      "coach_id": "hogi_hunter_blake",
      "price": 500.0
    },
    {
      "name": "MotorWerks Cadillac",
      "coach_id": "hogi_hunter_blake",
      "price": 1495.0
    },
    {
      "name": "MotorWerks Infiniti",
      "coach_id": "hogi_hunter_blake",
      "price": 1495.0
    },
    {
      "name": "Motorwerks Porsche of Barrington",
      "coach_id": "hogi_hunter_blake",
      "price": 1495.0
    },
    {
      "name": "Steven Nissan",
      "coach_id": "bryan_james_baumer",
      "price": 1500.0
    },
    {
      "name": "Northampton Volkswagen",
      "coach_id": "bryan_james_baumer",
      "price": 1500.0
    },
    {
      "name": "Steven Toyota",
      "coach_id": "bryan_james_baumer",
      "price": 1500.0
    },
    {
      "name": "Steven Kia",
      "coach_id": "bryan_james_baumer",
      "price": 1500.0
    },
    {
      "name": "Bill Jacobs BMW/MINI",
      "coach_id": "bryan_vicki_johns",
      "price": 1495
    },
    {
      "name": "Bill Jacobs Land Rover of Hinsdale",
      "coach_id": "bryan_vicki_johns",
      "price": 1495.0
    },
    {
      "name": "Price Family Toyota Walnut Creek",
      "coach_id": "bryan_vicki_johns",
      "price": 1750.0
    },
    {
      "name": "Bill Jacobs Volkswagen",
      "coach_id": "bryan_vicki_johns",
      "price": 1495.0
    },
    {
      "name": "Riverton Elko Chevrolet Buick GMC Cadillac",
      "coach_id": "bryan_vicki_johns",
      "price": 1495.0
    },
    {
      "name": "Price Family JLR of Marin Luxury Cars",
      "coach_id": "bryan_vicki_johns",
      "price": 1750.0
    },
    {
      "name": "Price The Luxury Collection Walnut Creek",
      "coach_id": "bryan_vicki_johns",
      "price": 1750.0
    },
    {
      "name": "Holmes Honda Bossier City",
      "coach_id": "bryan_vicki_johns",
      "price": 1395.0
    },
    {
      "name": "Holmes Honda - Shreveport",
      "coach_id": "bryan_vicki_johns",
      "price": 1395.0
    },
    {
      "name": "Acura of Highland Park",
      "coach_id": "bryan_vicki_johns",
      "price": 1495.0
    },
    {
      "name": "Motorwerks Honda",
      "coach_id": "bryan_vicki_johns",
      "price": 1495.0
    },
    {
      "name": "Brickell Bentley Jacksonville",
      "coach_id": "bryan_vicki_johns",
      "price": 500.0
    },
    {
      "name": "Brickell Infiniti Stuart",
      "coach_id": "bryan_vicki_johns",
      "price": 1495.0
    },
    {
      "name": "Country Nissan",
      "coach_id": "bryan_vicki_johns",
      "price": 1500.0
    },
    {
      "name": "Mercedes Benz of Midlothian",
      "coach_id": "bryan_vicki_johns",
      "price": 1495.0
    },
    {
      "name": "Brickell Ocean Cadillac",
      "coach_id": "bryan_vicki_johns",
      "price": 1495.0
    },
    {
      "name": "Riverton Chevrolet",
      "coach_id": "bryan_vicki_johns",
      "price": 1495.0
    },
    {
      "name": "Patriot Buick GMC of Boyertown",
      "coach_id": "bryan_vicki_johns",
      "price": 1500.0
    },
    {
      "name": "Motorwerks Mercedez Benz",
      "coach_id": "bryan_vicki_johns",
      "price": 1495.0
    }
  ]
};
function migrateCoachingAssignments(){
  if(getMeta('coaching_assignments_migrated')) return;
  let assigned = 0, skippedAlreadySet = 0, created = 0;
  const tx = () => {
    for(const a of COACH_ASSIGN_DATA.assign){
      const row = db.prepare('SELECT id, assigned_coach_id FROM clients WHERE norm=?').get(a.client_norm);
      if(!row) continue; // name not found — leave for manual follow-up, don't guess
      if(row.assigned_coach_id){ skippedAlreadySet++; continue; }
      db.prepare('UPDATE clients SET assigned_coach_id=? WHERE id=?').run(a.coach_id, row.id);
      assigned++;
    }
    for(const nc of COACH_ASSIGN_DATA.newClients){
      const clientId = resolveClient(nc.name, {});
      const row = db.prepare('SELECT assigned_coach_id FROM clients WHERE id=?').get(clientId);
      if(!row.assigned_coach_id) db.prepare('UPDATE clients SET assigned_coach_id=? WHERE id=?').run(nc.coach_id, clientId);
      const already = db.prepare("SELECT id FROM contracts WHERE client_id=? AND program='Coaching Only'").get(clientId);
      if(!already){
        db.prepare(`INSERT INTO contracts(client_id,program,visits,start_date,price,status,source,created)
          VALUES(?,?,0,NULL,?,'active','sheet',?)`).run(clientId, 'Coaching Only', nc.price ?? null, new Date().toISOString());
        created++;
      }
    }
  };
  db.exec('BEGIN');
  try{ tx(); db.exec('COMMIT'); }
  catch(e){ db.exec('ROLLBACK'); console.error('Coaching assignments migration failed:', e); return; }
  setMeta('coaching_assignments_migrated', new Date().toISOString());
  log('system', 'migrate.coaching_assignments', { assigned, created, skippedAlreadySet });
  console.log(`Coaching Assignments import: ${assigned} clients assigned a coach, ${created} new Coaching-Only clients created.`);
}

/* ---------- keep the Unassigned Clients queue clean ---------- */
/* A Keap webhook can queue a subscription for a dealership that's already a
   known client here (most commonly: one of the Coaching-Only clients we just
   added straight from the sheet, which have no keap_subscription_id link yet
   to tell the webhook handler "already handled"). Runs every boot — cheap,
   and safe to re-run since it only ever touches rows still sitting at
   status='pending'. Matched-and-cleared rows are marked 'ignored' (not
   deleted) with resolved_client_id set, so there's a record of why. */
function reconcilePendingClients(){
  const pending = db.prepare("SELECT * FROM pending_clients WHERE status='pending'").all();
  let cleared = 0;
  for(const p of pending){
    const nm = normName(p.company_name || p.contact_name || '');
    if(!nm) continue;
    const existing = db.prepare('SELECT id FROM clients WHERE norm=?').get(nm);
    if(!existing) continue;
    db.prepare("UPDATE pending_clients SET status='ignored', resolved_client_id=? WHERE id=?").run(existing.id, p.id);
    log('system', 'pendingclient.auto_cleared', { pendingId: p.id, company: p.company_name, matchedClientId: existing.id });
    cleared++;
  }
  if(cleared) console.log(`Unassigned Clients queue: auto-cleared ${cleared} entr${cleared===1?'y':'ies'} already matching a known client.`);
}

/* ---------- one-time: archive legacy M.A.G. duplicate clients ---------- */
/* These 13 are pre-dating the "split M.A.G. by store to match Keap 1:1"
   decision — combined slash-names (or in one case a typo) left over from
   before that split. Checked against the live Keap export on 2026-08-06:
   11 are combined names for stores that already exist correctly and
   separately (created via the Coaching Assignments import), 1 is a plain
   typo of an already-correct client, and 2 have no Keap company at all
   under any name. None represent a real client we're missing. Archived
   (not deleted) — renamed with a clear prefix and status forced to
   'inactive' so they stay out of active-client views but the history isn't
   destroyed. Guarded by a meta flag; runs once, ever. */
function archiveLegacyMagDuplicates(){
  if(getMeta('mag_duplicates_archived')) return;
  const today = new Date().toISOString().slice(0, 10);
  const targets = [
    { name: 'M.A.G. Audi Hampton', supersededBy: 'M.A.G. Audi of Hampton' },
    { name: 'M.A.G. Audi, Mercedes-Benz and Hyundai of Hampton', supersededBy: 'M.A.G. Audi of Hampton, M.A.G. Mercedes-Benz of Hampton, and M.A.G. Hyundai Genesis of Hampton' },
    { name: 'M.A.G. Classic CDJRF Lancaster / Goldsboro', supersededBy: 'M.A.G. Classic CDJRF Lancaster and M.A.G. Classic CDJRF of Goldsboro' },
    { name: 'M.A.G. Classic CDJRF Lancaster / M.A.G. Infiniti of Charlotte', supersededBy: 'M.A.G. Classic CDJRF Lancaster and M.A.G. Infiniti of Charlotte' },
    { name: 'M.A.G. Classic Hyundai / Toyota of North Wilkesboro', supersededBy: 'M.A.G. Classic Hyundai of North Wilkesboro and M.A.G. Classic Toyota Wilkesboro' },
    { name: 'M.A.G. Classic Toyota / Hyundai Wilkesboro', supersededBy: 'M.A.G. Classic Toyota Wilkesboro and M.A.G. Classic Hyundai of North Wilkesboro' },
    { name: 'M.A.G. Classic Toyota and Hyundai Wilkesboro', supersededBy: 'M.A.G. Classic Toyota Wilkesboro and M.A.G. Classic Hyundai of North Wilkesboro' },
    { name: 'M.A.G. Classic Toyota of Henderson', supersededBy: 'M.A.G. Classic Toyota Henderson' },
    { name: 'M.A.G. Infiniti of Charlotte / Greenville', supersededBy: 'M.A.G. Infiniti of Charlotte and M.A.G. Infiniti of Greenville' },
    { name: 'M.A.G. Land Rober Volvo Shreveport', supersededBy: 'M.A.G. Land Rover Volvo Shreveport (typo of this name)' },
    { name: 'M.A.G. Mercedes-Benz / Hyundai and Audi of Hampton', supersededBy: 'M.A.G. Mercedes-Benz of Hampton, M.A.G. Hyundai Genesis of Hampton, and M.A.G. Audi of Hampton' },
    { name: 'M.A.G. - Subaru Atlanta', supersededBy: null },
    { name: 'M.A.G. Crossroads Chevrolet', supersededBy: null },
  ];
  let archived = 0;
  for(const t of targets){
    const row = db.prepare('SELECT id, name FROM clients WHERE norm=?').get(normName(t.name));
    if(!row) continue;
    const newName = `[Archived — duplicate] ${row.name}`;
    db.prepare("UPDATE clients SET name=?, status='inactive' WHERE id=?").run(newName, row.id);
    const note = t.supersededBy
      ? `Archived 2026-08-06 — legacy pre-split duplicate. No matching Keap company under this name; superseded by ${t.supersededBy}, which is already a correct, separate client.`
      : `Archived 2026-08-06 — no matching Keap company under this name in the current export. Not a real active client; kept for history rather than deleted.`;
    db.prepare('INSERT INTO client_notes(client_id,note_date,note_type,author_email,author_name,body,created) VALUES(?,?,?,?,?,?,?)')
      .run(row.id, today, 'LID', 'system', 'System', note, new Date().toISOString());
    archived++;
  }
  setMeta('mag_duplicates_archived', new Date().toISOString());
  log('system', 'migrate.archive_mag_duplicates', { archived });
  console.log(`Archived ${archived} legacy M.A.G. duplicate client(s).`);
}

if(!getMeta('secret')) setMeta('secret', crypto.randomBytes(32).toString('hex'));
seed();
migratePhase1();
migrateCoachingAssignments();
reconcilePendingClients();
archiveLegacyMagDuplicates();
ensureCurrentMonthSnapshot();

module.exports = { db, hashPw, checkPw, getMeta, setMeta, log, resolveClient, normName, findClientByKeapId, createPasswordReset, consumePasswordReset, snapshotClientMonth, ensureCurrentMonthSnapshot };
