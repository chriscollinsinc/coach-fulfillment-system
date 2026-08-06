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
`);

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
if(!getMeta('secret')) setMeta('secret', crypto.randomBytes(32).toString('hex'));
seed();

module.exports = { db, hashPw, checkPw, getMeta, setMeta, log, createPasswordReset, consumePasswordReset };
