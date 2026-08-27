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
  due TEXT, completed INTEGER DEFAULT 0, scheduled_week TEXT,
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
ensureColumn('clients', 'company_id', 'TEXT');
// Phantom-contract cleanup (2026-08-25): archived_at marks a contract as retired
// without deleting it — used for old duplicate shell contracts created by past sheet
// imports that never checked for an existing match before inserting. Archived
// contracts are excluded from primary-contract selection everywhere but stay fully
// visible/reversible (see /api/contracts/:id/unarchive).
ensureColumn('contracts', 'archived_at', 'TEXT');
ensureColumn('contracts', 'archived_reason', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS ict_keapsub ON contracts(keap_subscription_id)');
/* The date the client's first charge actually happened, as manually entered when
 * the contract is created — start_date (the first VISIT due date) is always this
 * date + 90 days for any contract that has one. Null for contracts created before
 * this existed, or for ones where start_date was set/edited directly (Keap-linked,
 * Coaching Only, or via Regenerate schedule/the program edit dialog). */
ensureColumn('contracts', 'first_pay_date', 'TEXT');
/* Set when this contract was folded into another one via the contract-splits
 * merge tool (2026-08-23) — the archive/Keap-link split found across ~20 clients
 * where the real visit history and the Keap subscription ended up on two separate
 * active contract rows. A contract with merged_into_contract_id set is never the
 * one to act on directly; look at the contract it points to instead. Status is set
 * to 'completed' at the same time (no separate 'merged' value — the CHECK
 * constraint on contracts.status only allows active/completed/cancelled). */
ensureColumn('contracts', 'merged_into_contract_id', 'INTEGER');
ensureColumn('contracts', 'merged_at', 'TEXT');
/* App-only "stores covered" list for a single contract that funds visits across
 * several dealerships (a shared/à-la-carte LID like Steven Auto Group or M.A.G.).
 * Stored as a JSON array of store names. NULL/empty = ordinary single-store contract.
 * Never written back to Keap — the LID stays on this one parent contract; the store
 * is purely an in-app scheduling label (see visits.store). */
ensureColumn('contracts', 'stores', 'TEXT');
ensureColumn('clients', 'assigned_coach_id', 'TEXT');
/* For cases like Castle (one Keap invoice covering multiple separately-visited
   locations): the linked client's own contract price stays $0, and this field
   points at whichever client is the real revenue owner, so revenue totals never
   double-count or guess at a split. Purely informational until someone sets it —
   does not change any existing aggregation. */
ensureColumn('clients', 'revenue_owner_client_id', 'INTEGER');
/* Soft delete: "Delete client" sets this instead of removing the row, so a
   mis-click has a recovery window. A nightly job purges rows older than 30
   days for real. Deleted clients are excluded from every normal listing —
   see the WHERE deleted_at IS NULL clauses added alongside this column. */
ensureColumn('clients', 'deleted_at', 'TEXT');

/* ---------- revenue history ---------- */
/* One row per day the app has been running, capturing the total active
   revenue and active client count at that moment — lets the "is our number
   converging with Keap's" question be answered as a trend, not just as
   today's snapshot. Written by the nightly job (see server.js). */
db.exec(`
CREATE TABLE IF NOT EXISTS revenue_snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,          -- 'YYYY-MM-DD'
  total_revenue REAL NOT NULL,
  active_clients INTEGER NOT NULL,
  keap_linked_contracts INTEGER NOT NULL DEFAULT 0,
  created TEXT);
`);

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
/* Ties a note to the specific visit it documents (set automatically when a coach
   completes a visit and writes a note in the same step) rather than only ever
   being general-purpose client commentary. Nullable — general notes still work. */
ensureColumn('client_notes', 'visit_id', 'INTEGER');
/* Keap notes import: 'source' distinguishes notes typed in this app ('app', the
   default) from notes pulled in from Keap ('keap'). 'keap_note_id' is Keap's own
   note id, recorded only on imported notes — a unique index on it makes re-running
   an import idempotent (re-importing the same Keap note is a no-op, never a dupe). */
ensureColumn('client_notes', 'source', "TEXT NOT NULL DEFAULT 'app'");
ensureColumn('client_notes', 'keap_note_id', 'TEXT');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ucn_keap_note ON client_notes(keap_note_id) WHERE keap_note_id IS NOT NULL;`);
/* Who actually completed a visit, captured at the moment it's completed — this is
   what a coach's profile/history is built from. It's intentionally separate from
   cal_coach (who's currently scheduled) so that reassigning a client to a new coach,
   or a coach leaving, never rewrites who really did the historical work. */
ensureColumn('visits', 'completed_by_coach_id', 'TEXT');
ensureColumn('visits', 'completed_by_email', 'TEXT');
/* Which store this visit occurrence covered, for a multi-store contract (see
 * contracts.stores). App-only label chosen from the parent contract's store list;
 * NULL for ordinary single-store visits. Never sent to Keap. */
ensureColumn('visits', 'store', 'TEXT');
/* Basic profile fields for a coach as a person, not just as a scheduling id —
   shown on their profile page, editable by admins/leads. */
ensureColumn('coaches', 'phone', 'TEXT');
ensureColumn('coaches', 'start_date', 'TEXT');
/* Resolved company/client name for a webhook event, filled in when we successfully
   look it up from Keap (or from our own records for edit/delete) — so the Admin
   "Keap webhook activity" diagnostic table can show a human name instead of forcing
   someone to open the raw JSON for every row. Blank means the lookup itself failed
   or hasn't been attempted (e.g. an unhandled event type) — that's useful signal too. */
ensureColumn('keap_events', 'company_name', "TEXT DEFAULT ''");
/* Set manually when ops emails in that a client gave their 30-day notice to quit —
 * Keap itself won't show anything different until the final invoice actually lapses,
 * which can be well past the point coaching should stop. Purely a marker; nothing
 * reads it except the "give notice" bulk action (which also clears open visits at the
 * same time it's set) and the nightly digest (which flags anyone past their 30 days
 * that Keap still hasn't confirmed as cancelled). Client status itself is untouched —
 * they're still a real, paying, active client through their last month. */
ensureColumn('clients', 'notice_given_date', 'TEXT');
/* Company ID and synced name for direct Keap company lookups (when available,
   used to auto-populate company info in client profiles). */
ensureColumn('clients', 'company_id', 'TEXT');
ensureColumn('clients', 'company_name', 'TEXT');

/* ---------- The Visit Record (Theme A): structured notes + commitment loop ----------
   A visit note stops being a freeform blob: wins / issues / focus are captured as their
   own fields (body still holds a composed copy for search + backward compat). Action
   items are a client's open commitments that carry forward across visits — the loop that
   turns a visit into an accountable coaching relationship. */
ensureColumn('client_notes', 'wins', 'TEXT');
ensureColumn('client_notes', 'issues', 'TEXT');
ensureColumn('client_notes', 'focus', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS sheet2026_import(
  id INTEGER PRIMARY KEY CHECK(id=1),
  uploaded_at TEXT NOT NULL,
  filename TEXT,
  uploaded_by TEXT,
  csv TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS action_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  contract_id INTEGER,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','dropped')),
  created_visit_id INTEGER,
  resolved_visit_id INTEGER,
  created_by TEXT,
  created TEXT NOT NULL,
  resolved_at TEXT);
CREATE INDEX IF NOT EXISTS iai_client ON action_items(client_id, status);
`);

/* ---------- prospect holds (soft pencil, done right) ----------
   A hold is a real record of "we reserved these weeks on this coach's calendar for
   a prospect who hasn't signed yet" — with its own identity, owner, program, and
   expiry — instead of the earlier label-string-on-calendar-blocks approach, where a
   typo in the label made two weeks read as two different prospects. The calendar
   blocks (kind='soft_pencil') are generated FROM these rows and removed when the
   hold is released/converted/expired; the hold row is the source of truth. */
db.exec(`
CREATE TABLE IF NOT EXISTS client_health_log(
  date TEXT NOT NULL,
  client_id INTEGER NOT NULL,
  level TEXT NOT NULL,
  PRIMARY KEY(date, client_id));
CREATE TABLE IF NOT EXISTS prospect_holds(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  coach_id TEXT NOT NULL,
  program TEXT NOT NULL DEFAULT 'Quarterly',
  weeks TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created TEXT NOT NULL,
  expires TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','converted','released','expired')),
  resolved TEXT);
`);
/* One-time: adopt any label-based soft_pencil blocks placed before this table
   existed, grouping by coach+label so they keep working under the new system. */
function migrateProspectHolds(){
  if(getMeta('prospect_holds_migrated')) return;
  const blocks = db.prepare("SELECT * FROM blocks WHERE kind='soft_pencil'").all();
  const groups = {};
  for(const b of blocks){
    const key = b.coach_id + '|' + (b.label || '');
    (groups[key] = groups[key] || { coach_id: b.coach_id, label: b.label || '(unlabeled hold)', weeks: [] }).weeks.push(b.week);
  }
  const now = new Date().toISOString();
  for(const g of Object.values(groups)){
    g.weeks.sort();
    const lastWeek = g.weeks[g.weeks.length - 1];
    const expires = new Date(new Date(lastWeek + 'T12:00:00').getTime() + 30*24*60*60*1000).toISOString().slice(0,10);
    db.prepare(`INSERT INTO prospect_holds(name,coach_id,program,weeks,created_by,created,expires) VALUES(?,?,?,?,?,?,?)`)
      .run(g.label, g.coach_id, 'Quarterly', JSON.stringify(g.weeks), 'migration', now, expires);
  }
  setMeta('prospect_holds_migrated', now);
  if(Object.keys(groups).length) console.log(`Prospect holds migration: adopted ${Object.keys(groups).length} label-based hold(s).`);
}

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
  // A real new contract/subscription for a name that matches a soft-deleted client
  // means it's back — restore it rather than silently attaching new work to a
  // client that's hidden from every listing.
  if(row.deleted_at){
    db.prepare('UPDATE clients SET deleted_at=NULL WHERE id=?').run(row.id);
    log('system', 'client.auto_restore', { clientId: row.id, name: row.name, reason: 'new contract/subscription matched a soft-deleted client' });
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

/* ---------- one-time: delete legacy M.A.G. duplicate clients ---------- */
/* These 13 are pre-dating the "split M.A.G. by store to match Keap 1:1"
   decision — combined slash-names (or in one case a typo) left over from
   before that split. Checked against the live Keap export on 2026-08-06:
   11 are combined names for stores that already exist correctly and
   separately (created via the Coaching Assignments import), 1 is a plain
   typo of an already-correct client, and 2 have no Keap company at all
   under any name. None represent a real client — confirmed not real by
   Mike directly, so these are hard-deleted (client + any contracts/visits/
   notes attached), not just archived. Guarded by a meta flag; runs once. */
function deleteLegacyMagDuplicates(){
  if(getMeta('mag_duplicates_deleted')) return;
  const targets = [
    'M.A.G. Audi Hampton',
    'M.A.G. Audi, Mercedes-Benz and Hyundai of Hampton',
    'M.A.G. Classic CDJRF Lancaster / Goldsboro',
    'M.A.G. Classic CDJRF Lancaster / M.A.G. Infiniti of Charlotte',
    'M.A.G. Classic Hyundai / Toyota of North Wilkesboro',
    'M.A.G. Classic Toyota / Hyundai Wilkesboro',
    'M.A.G. Classic Toyota and Hyundai Wilkesboro',
    'M.A.G. Classic Toyota of Henderson',
    'M.A.G. Infiniti of Charlotte / Greenville',
    'M.A.G. Land Rober Volvo Shreveport',
    'M.A.G. Mercedes-Benz / Hyundai and Audi of Hampton',
    'M.A.G. - Subaru Atlanta',
    'M.A.G. Crossroads Chevrolet',
  ];
  let deleted = 0;
  const names = [];
  for(const name of targets){
    const row = db.prepare('SELECT id, name FROM clients WHERE norm=?').get(normName(name));
    if(!row) continue;
    db.prepare('DELETE FROM client_notes WHERE client_id=?').run(row.id);
    db.prepare('DELETE FROM visits WHERE client_id=?').run(row.id);
    db.prepare('DELETE FROM contracts WHERE client_id=?').run(row.id);
    db.prepare('DELETE FROM client_month_snapshots WHERE client_id=?').run(row.id);
    db.prepare('DELETE FROM clients WHERE id=?').run(row.id);
    names.push(row.name);
    deleted++;
  }
  setMeta('mag_duplicates_deleted', new Date().toISOString());
  log('system', 'migrate.delete_mag_duplicates', { deleted, names });
  console.log(`Deleted ${deleted} legacy M.A.G. duplicate client(s) — not real, confirmed with Mike.`);
}

/* ---------- one-time: Keap identity-linking reconciliation pass ---------- */
/* Approved by Mike 2026-08-06. Matches every current client that has no
   keap_id yet against the live Keap company export by normalized name.
   Only unambiguous, exact normalized-name matches are auto-linked here —
   anything fuzzy or unmatched is left alone and listed in the SOP/notes
   for a person to resolve by hand. This only writes into the app's DB;
   it never touches Keap. Guarded by a meta flag; runs once. */
function migrateKeapIdentityLink(){
  if(getMeta('keap_identity_linked')) return;
  const matches = [
    ['Acura of Highland Park', 288678],
    ['BMW of Lafayette', 32042],
    ['Bill Jacobs BMW/MINI', 28513],
    ['Bill Jacobs Land Rover of Hinsdale', 41631],
    ['Bill Jacobs Volkswagen', 44183],
    ['Brickell Bentley Jacksonville', 251393],
    ['Brickell Buick GMC', 218999],
    ['Brickell Honda', 158567],
    ['Brickell Mazda', 219001],
    ['Cambridge Centre Honda', 37143],
    ['Country Nissan', 226195],
    ['Cox Chevrolet', 28535],
    ['Federico CDJR', 305447],
    ['Federico Kia', 288470],
    ['Holmes Honda - Shreveport', 29745],
    ['Holmes Honda Bossier City', 236001],
    ['Koehne Chevrolet Buick GMC, Inc', 256550],
    ['M.A.G. Beckley Chevrolet', 337616],
    ['M.A.G. Classic Hyundai of North Wilkesboro', 337554],
    ['M.A.G. Mercedes-Benz of Hampton', 337668],
    ['Mercedes Benz of Lafayette', 301970],
    ['Northampton Volkswagen', 226203],
    ['Page Toyota', 45885],
    ['Patriot Buick GMC of Boyertown', 28943],
    ['Patriot Chevrolet of Limerick', 95655],
    ['Price Family Ford Sacramento', 349300],
    ['Price Family JLR of Marin Luxury Cars', 337138],
    ['Price Family Modesto Toyota', 349228],
    ['Price Family Toyota Walnut Creek', 337136],
    ['Price The Luxury Collection Walnut Creek', 337148],
    ['Riverton Chevrolet', 41003],
    ['Riverton Elko Chevrolet Buick GMC Cadillac', 187093],
    ['Rogers Toyota Lewiston', 193217],
    ['Roseville Chevrolet', 310195],
    ['Sam Boswell Honda', 175013],
    ['Sherwood Honda', 198319],
    ['Steven Kia', 370364],
    ['Steven Nissan', 288332],
    ['Steven Toyota', 36610],
    ['Watsonville CDJR', 249712],
    ['Wesley Chapel Toyota', 219793],
    ['Steven Honda, Hyundai, Ford', 370358],
  ];
  let linked = 0;
  const linkedNames = [];
  const skipped = [];
  for(const [name, keapId] of matches){
    const row = db.prepare('SELECT id, name, keap_id FROM clients WHERE norm=?').get(normName(name));
    if(!row){ skipped.push(name + ' (not found)'); continue; }
    if(row.keap_id){ skipped.push(name + ' (already linked)'); continue; }
    db.prepare('UPDATE clients SET keap_id=? WHERE id=?').run(String(keapId), row.id);
    linkedNames.push(row.name);
    linked++;
  }
  setMeta('keap_identity_linked', new Date().toISOString());
  log('system', 'migrate.keap_identity_link', { linked, linkedNames, skipped });
  console.log(`Keap identity link: linked keap_id on ${linked} client(s). Still unresolved (need human review): BMW of Barrington, Brickell Bentley of Central NJ, Brickell Infiniti Stuart, Brickell Ocean Cadillac, Castle Downers Grove, Castle Subaru of Portage, Mercedes Benz of Midlothian, Mills -, MotorWerks Cadillac, MotorWerks Infiniti, Motorwerks Honda, Motorwerks Mercedez Benz, Motorwerks Porsche of Barrington.`);
}


/* ---------- one-time + ongoing: Keap revenue sync ---------- */
/* Keap is the source of truth for money (see SOP). For any client that has
   a keap_id, backfill its active contract's price from Keap's normalized
   activeMonthly figure (monthly-equivalent, even for quarterly/semi-annual
   billers — confirmed with Mike 2026-08-07). Where the company has exactly
   one active Keap subscription, also stamp keap_subscription_id onto that
   contract so future Keap status/amount changes can flow through automatically.
   Contracts without a keap_subscription_id are never touched automatically —
   a manually-entered price always wins until that contract is Keap-linked.
   This one-time pass covers everyone already linked as of 2026-08-07; going
   forward, apply the same rule (Keap wins only for keap_subscription_id
   contracts) at the point a client is newly linked. Guarded by a meta flag. */
const KEAP_REVENUE = [
    [288678, 1495, 6552],
    [349958, 5495, 6794],
    [28513, 1495, 1069],
    [41631, 1495, 1073],
    [44183, 1495, 1071],
    [196821, 6495, 6482],
    [300258, 6495, 6454],
    [32042, 1495, 7155],
    [87679, 3333, 6925],
    [314212, 4833, 6120],
    [218983, 1495, 2237],
    [251393, 500, 6961],
    [218999, 1495, 4786],
    [158567, 1495, 6426],
    [218989, 1495, 2239],
    [219001, 1495, 4784],
    [218995, 1495, 2245],
    [284514, 6495, 6466],
    [37521, 4495, 6816],
    [37143, 1410.68, 6989],
    [227465, 6495, 7091],
    [354363, 5795, 6951],
    [351252, 5795, 6806],
    [356261, 5795, 6993],
    [226195, 1500, 6492],
    [350008, 6495, 6762],
    [28535, 1467, null],
    [353231, 15495, 6897],
    [66239, 6495, 6204],
    [338218, 8995, 7234],
    [161421, 5495, 6228],
    [161761, 6495, 6969],
    [351714, 5995, 6830],
    [305447, 2000, 6836],
    [288470, 2000, 6838],
    [200185, 6495, 6546],
    [323238, 6495, 6268],
    [355895, 4833, 7055],
    [355899, 4833, 7057],
    [53983, 5995, 6788],
    [163735, 6012.05, null],
    [294778, 4495, 6398],
    [356659, 6495, 7001],
    [299022, 6495, 7005],
    [356669, 6495, 7003],
    [55627, 6495, 6851],
    [29745, 1395, 1543],
    [236001, 1395, 2635],
    [288936, 3333, 7157],
    [37181, 5395, 6308],
    [57269, 5395, 6362],
    [63891, 5495, 6901],
    [329246, 6495, 6462],
    [284844, 5995, 6670],
    [338876, 6295, 6594],
    [34330, 6495, 6983],
    [256550, 1500, 5985],
    [251365, 3333, 6855],
    [61229, 3333, 6270],
    [325788, 3333, 7185],
    [351742, 4495, 7149],
    [329728, 5495, 6544],
    [348966, 5495, 6704],
    [329652, 6495, 7173],
    [349102, 6495, 6786],
    [301970, 1495, 7153],
    [53375, 4495, 6396],
    [322616, 8995, 6428],
    [326196, 9495, 7147],
    [327684, 8995, 7103],
    [226203, 1500, 6498],
    [291942, 3995, 6774],
    [45885, 1500, 6810],
    [226001, 6495, 7177],
    [28943, 1500, 6891],
    [95655, 1500, 6889],
    [249819, 1500, 7228],
    [82197, 3333, 7069],
    [57879, 3333, 6824],
    [349300, 1750, 6724],
    [337138, 1750, 6532],
    [170361, 3695, 7183],
    [349228, 1750, 6722],
    [337136, 1750, 6572],
    [337130, 1750, 6536],
    [337148, 1750, 6528],
    [355197, 6995, 7097],
    [354993, 6495, 7009],
    [302582, 4495, 6939],
    [286972, 1500, 6382],
    [41003, 1495, 1945],
    [187093, 1495, 2231],
    [193217, 1512.05, null],
    [310195, 1995, 7232],
    [175013, 1500, 6849],
    [291566, 3333, 4882],
    [252518, 3333, 7073],
    [336836, 3333, 6504],
    [217385, 3333, 3208],
    [359532, 25000, 7236],
    [198319, 1995, 6642],
    [36404, 4495, 6812],
    [312103, 4495, 6370],
    [312105, 4495, 6372],
    [354075, 3995, 6921],
    [36398, 4495, 6814],
    [46951, 4495, 6893],
    [69825, 6495, 6844],
    [247003, 4495, 5855],
    [61275, 6495, 6202],
    [68469, 5495, 6875],
    [68201, 5495, 6436],
    [271748, 6333, null],
    [52269, 6495, 6232],
    [242655, 3333, 5989],
    [305945, 6495, 6029],
    [346774, 6495, 6756],
    [337446, 5395, 6540],
    [337734, 5495, 6542],
    [249712, 1500, 3606],
    [349908, 5495, 6738],
    [349906, 5495, 6736],
    [349904, 5495, 6740],
    [349912, 5495, 6734],
    [219793, 1500, 6490],
    [261420, 4495, 7111],
];

// ============================================================================
// VISIT DISCIPLINE FUNCTIONS - Enforce find-or-create pattern
// ============================================================================
// These functions implement architectural discipline for visit creation:
// 1. Check if visit already exists (prevents duplicates)
// 2. Validate cycle sequence maintains order (prevents orphan cycles)
// 3. Only create if all validations pass

function parseCycleLabel(label) {
  if (!label) return null;
  const match = /^(\d+)\s+of\s+(\d+)$/i.exec(String(label).trim());
  return match ? { k: +match[1], n: +match[2] } : null;
}

function getLastVisitForContract(contractId) {
  const sql = `SELECT id, cycle, due, completed, team, program FROM visits 
               WHERE contract_id = ? ORDER BY due DESC, id DESC LIMIT 1`;
  return db.prepare(sql).get(contractId);
}

function getIncompleteVisitsByContract(contractId) {
  const sql = `SELECT id, cycle, due, completed, team, program FROM visits 
               WHERE contract_id = ? AND completed IS NULL 
               ORDER BY due ASC`;
  return db.prepare(sql).all(contractId);
}

function findExistingVisit(contractId, dueDate, cycleLabel) {
  // Finds an existing visit matching contract, due date, and cycle label
  // Returns visit id if found, null otherwise
  if (!contractId || !dueDate) return null;
  
  const normalizedDue = String(dueDate).trim();
  const normalizedCycle = cycleLabel ? String(cycleLabel).trim() : null;
  
  let sql = `SELECT id FROM visits WHERE contract_id = ? AND due = ?`;
  let params = [contractId, normalizedDue];
  
  if (normalizedCycle) {
    sql += ` AND cycle = ?`;
    params.push(normalizedCycle);
  }
  
  const result = db.prepare(sql).get(...params);
  return result ? result.id : null;
}

function validateCycleSequence(contractId, nextCycleNum, n) {
  // Ensures that all cycles 1 through (nextCycleNum - 1) exist
  // before allowing creation of nextCycleNum
  // Returns true if sequence is valid, false if there are gaps
  
  if (nextCycleNum <= 1) return true; // Can always create cycle 1
  
  const sql = `SELECT DISTINCT cycle FROM visits 
               WHERE contract_id = ? 
               AND completed IS NULL 
               AND cycle NOT LIKE '%carryover%' 
               AND cycle NOT LIKE '%extra%'`;
  
  const visits = db.prepare(sql).all(contractId);
  const present = new Set();
  
  for (const v of visits) {
    const parsed = parseCycleLabel(v.cycle);
    if (parsed && parsed.n === n) {
      present.add(parsed.k);
    }
  }
  
  // Check all cycles 1 through (nextCycleNum - 1) exist
  for (let i = 1; i < nextCycleNum; i++) {
    if (!present.has(i)) {
      return false; // Gap detected
    }
  }
  
  return true;
}

function getNextCycleNumber(contractId, n) {
  // Determines what the next cycle number should be for a contract
  // by looking at existing cycles and continuing the sequence
  
  const sql = `SELECT DISTINCT cycle FROM visits 
               WHERE contract_id = ? 
               AND completed IS NULL 
               AND cycle NOT LIKE '%carryover%' 
               AND cycle NOT LIKE '%extra%'`;
  
  const visits = db.prepare(sql).all(contractId);
  const present = new Set();
  
  for (const v of visits) {
    const parsed = parseCycleLabel(v.cycle);
    if (parsed && parsed.n === n) {
      present.add(parsed.k);
    }
  }
  
  // Find the highest continuous cycle from 1
  let highestContinuous = 0;
  for (let i = 1; i <= n; i++) {
    if (present.has(i)) {
      highestContinuous = i;
    } else {
      break;
    }
  }
  
  return highestContinuous + 1;
}

function findOrCreateVisit(opts = {}) {
  // Core find-or-create function that enforces visit creation discipline
  // Parameters:
  //   contractId: required, the contract this visit belongs to
  //   dueDate: the date the visit is due (week or date)
  //   cycleLabel: the cycle label (e.g., "1 of 4", "Carryover", "Extra")
  //   program: the program type
  //   team: optional, the team assigned
  //   client: optional, client name (for reporting)
  //   source: optional, source of creation (e.g., 'app', 'sheet-2026')
  //   sold: optional, date field
  //   client_id: optional, client id
  //   cal_week: optional, calendar week
  //   cal_coach: optional, calendar coach
  //   ...other fields as needed
  // Returns: { created: bool, id: visit_id, reason: string, error?: string }
  
  const { contractId, dueDate, cycleLabel, program, team, ...otherFields } = opts;
  
  if (!contractId) {
    return { created: false, id: null, reason: 'missing_contract_id', error: 'contractId required' };
  }
  
  if (!dueDate) {
    return { created: false, id: null, reason: 'missing_due_date', error: 'dueDate required' };
  }
  
  // Check if visit already exists
  const existingId = findExistingVisit(contractId, dueDate, cycleLabel);
  if (existingId) {
    return { created: false, id: existingId, reason: 'existing_visit_found' };
  }
  
  // If this is a numbered cycle (e.g., "1 of 4"), validate sequence
  if (cycleLabel && !String(cycleLabel).toLowerCase().includes('carryover') && !String(cycleLabel).toLowerCase().includes('extra')) {
    const parsed = parseCycleLabel(cycleLabel);
    if (parsed) {
      const { k, n } = parsed;
      
      // Validate that all previous cycles exist
      if (!validateCycleSequence(contractId, k, n)) {
        const missing = [];
        for (let i = 1; i < k; i++) {
          const exists = db.prepare(`SELECT id FROM visits WHERE contract_id = ? AND cycle = ?`).get(contractId, `${i} of ${n}`);
          if (!exists) missing.push(i);
        }
        
        const missingStr = missing.join(', ');
        return {
          created: false,
          id: null,
          reason: 'cycle_sequence_violation',
          error: `Cannot create cycle "${cycleLabel}" — missing predecessors: [${missingStr}]`
        };
      }
    }
  }
  
  // All validations passed, create the visit with all provided fields
  try {
    const insertFields = ['contract_id', 'due', 'cycle', 'program', 'team'];
    const insertValues = [contractId, dueDate, cycleLabel, program, team];
    
    // Add any additional fields that were provided
    const allowedExtraFields = ['client', 'source', 'sold', 'client_id', 'cal_week', 'cal_coach', 'completed', 'scheduled_week', 'coach_hist', 'salesperson', 'sched_hist'];
    for (const field of allowedExtraFields) {
      if (field in otherFields && otherFields[field] !== undefined && otherFields[field] !== null) {
        insertFields.push(field);
        insertValues.push(otherFields[field]);
      }
    }
    
    const placeholders = insertFields.map(() => '?').join(', ');
    const fieldNames = insertFields.join(', ');
    
    const sql = `INSERT INTO visits (${fieldNames}) VALUES (${placeholders})`;
    const result = db.prepare(sql).run(...insertValues);
    
    return {
      created: true,
      id: result.lastID,
      reason: 'visit_created'
    };
  } catch (err) {
    return {
      created: false,
      id: null,
      reason: 'creation_failed',
      error: err.message
    };
  }
}

function migrateKeapRevenueSync(){
  if(getMeta('keap_revenue_synced')) return;
  let priced = 0, subLinked = 0, skippedNoContract = 0;
  for(const [companyId, monthly, subId] of KEAP_REVENUE){
    const client = db.prepare('SELECT id FROM clients WHERE keap_id=?').get(String(companyId));
    if(!client) continue;
    const contract = db.prepare("SELECT id, price, keap_subscription_id FROM contracts WHERE client_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(client.id);
    if(!contract){ skippedNoContract++; continue; }
    if(!contract.price){
      db.prepare('UPDATE contracts SET price=? WHERE id=?').run(monthly, contract.id);
      priced++;
    }
    if(subId && !contract.keap_subscription_id){
      const dupe = db.prepare('SELECT id FROM contracts WHERE keap_subscription_id=?').get(String(subId));
      if(!dupe){
        db.prepare('UPDATE contracts SET keap_subscription_id=? WHERE id=?').run(String(subId), contract.id);
        subLinked++;
      }
    }
  }
  setMeta('keap_revenue_synced', new Date().toISOString());
  log('system', 'migrate.keap_revenue_sync', { priced, subLinked, skippedNoContract });
  console.log(`Keap revenue sync: priced ${priced} contract(s) from Keap's monthly-equivalent amount, linked keap_subscription_id on ${subLinked}, skipped ${skippedNoContract} (no active contract to price).`);
}

if(!getMeta('secret')) setMeta('secret', crypto.randomBytes(32).toString('hex'));

/* Auto-migration: rename completed_on to scheduled_week if the old column still exists */
function migrateScheduledWeekColumn(){
  if(getMeta('scheduled_week_migrated')) return;
  try {
    const tableInfo = db.prepare("PRAGMA table_info(visits)").all();
    const hasOldColumn = tableInfo.some(col => col.name === 'completed_on');
    const hasNewColumn = tableInfo.some(col => col.name === 'scheduled_week');
    
    if(hasOldColumn && !hasNewColumn){
      db.exec('ALTER TABLE visits RENAME COLUMN completed_on TO scheduled_week');
      console.log('✅ Auto-migration: renamed completed_on to scheduled_week');
    } else if(hasNewColumn) {
      console.log('✅ Column scheduled_week already exists');
    }
    setMeta('scheduled_week_migrated', new Date().toISOString());
  } catch(e) {
    console.error('⚠️  Auto-migration failed:', e.message);
  }
}
seed();
migrateScheduledWeekColumn();
migratePhase1();
migrateCoachingAssignments();
reconcilePendingClients();
deleteLegacyMagDuplicates();
migrateKeapIdentityLink();
migrateKeapRevenueSync();
migrateProspectHolds();
ensureCurrentMonthSnapshot();

module.exports = { db, hashPw, checkPw, getMeta, setMeta, log, resolveClient, normName, findClientByKeapId, createPasswordReset, consumePasswordReset, snapshotClientMonth, ensureCurrentMonthSnapshot, DB_PATH, parseCycleLabel, getLastVisitForContract, getIncompleteVisitsByContract, findExistingVisit, validateCycleSequence, getNextCycleNumber, findOrCreateVisit };
