/* Coach Fulfillment System — zero-dependency Node server (Node 22+). */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, hashPw, checkPw, getMeta, setMeta, log, createPasswordReset, consumePasswordReset } = require('./db.js');
const { sendMail } = require('./mail.js');

const PORT = process.env.PORT || 3000;
const SECRET = getMeta('secret');
const PUB = path.join(__dirname, 'public');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

/* ---------- Keap REST helper (server-side, for webhook enrichment + hook verify) ---------- */
const KEAP_TOKEN = process.env.KEAP_TOKEN || '';
const KEAP_BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
async function keapGet(p){
  if(!KEAP_TOKEN) return { ok:false, status:0, json:null };
  try{
    const r = await fetch(KEAP_BASE + p, { headers: { Authorization: 'Bearer ' + KEAP_TOKEN, Accept: 'application/json' } });
    const t = await r.text(); let j = null; try{ j = JSON.parse(t); }catch(e){}
    return { ok: r.ok, status: r.status, json: j };
  }catch(e){ return { ok:false, status:0, json:null, error:String(e) }; }
}
async function keapPost(p, body){
  if(!KEAP_TOKEN) return { ok:false, status:0, json:null };
  try{
    const r = await fetch(KEAP_BASE + p, { method:'POST', headers: { Authorization: 'Bearer ' + KEAP_TOKEN, 'Content-Type':'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text(); let j = null; try{ j = JSON.parse(t); }catch(e){}
    return { ok: r.ok, status: r.status, json: j };
  }catch(e){ return { ok:false, status:0, json:null, error:String(e) }; }
}

/* ---------- auth ---------- */
const sign = v => v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);
const unsign = t => { if(!t) return null; const i = t.lastIndexOf('.'); if(i < 0) return null;
  const v = t.slice(0, i); return sign(v) === t ? v : null; };
function currentUser(req){
  const m = /(?:^|;\s*)cfs=([^;]+)/.exec(req.headers.cookie || '');
  const id = unsign(m && decodeURIComponent(m[1]));
  if(!id) return null;
  const u = db.prepare('SELECT id,email,name,role,team,coach_id,active FROM users WHERE id=?').get(+id);
  return (u && u.active) ? u : null;
}

/* ---------- tiny router ---------- */
const routes = [];
const route = (method, pattern, roles, fn) => routes.push({ method, pattern, roles, fn });
function send(res, code, body, headers = {}){
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(data);
}
const err = (res, code, msg) => send(res, code, { error: msg });

/* ---------- shared checks ---------- */
function canEditTeam(user, team){
  if(user.role === 'admin') return true;
  if(user.role === 'lead') return !team || user.team === team;
  return false;
}
function snapMonday(iso){
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
function cellFree(coachId, week, ignoreVisit){
  const b = db.prepare('SELECT 1 FROM blocks WHERE coach_id=? AND week=?').get(coachId, week);
  if(b) return false;
  const v = db.prepare('SELECT id FROM visits WHERE cal_coach=? AND cal_week=? AND completed=0').get(coachId, week);
  return !v || v.id === ignoreVisit;
}
const getVisit = id => db.prepare('SELECT * FROM visits WHERE id=?').get(+id);
const getCoach = id => db.prepare('SELECT * FROM coaches WHERE id=?').get(id);

/* ================= API ================= */
route('POST', /^\/api\/login$/, null, (req, res, m, body) => {
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(String(body.email || '').toLowerCase().trim());
  if(!u || !checkPw(String(body.password || ''), u.pw)) return err(res, 401, 'Invalid email or password');
  log(u.email, 'login', '');
  send(res, 200, { ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role, team: u.team, coach_id: u.coach_id } },
    { 'Set-Cookie': `cfs=${encodeURIComponent(sign(String(u.id)))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` });
});
route('POST', /^\/api\/logout$/, ['admin','lead','sales','coach'], (req, res, m, body, user) => {
  send(res, 200, { ok: true }, { 'Set-Cookie': 'cfs=; Path=/; Max-Age=0' });
});
route('POST', /^\/api\/forgot-password$/, null, (req, res, m, body) => {
  // Always respond the same way whether or not the email exists, so the endpoint
  // can't be used to enumerate registered users.
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(String(body.email || '').toLowerCase().trim());
  if(u){
    const token = createPasswordReset(u.id);
    const origin = `https://${req.headers.host}`;
    const link = `${origin}/?reset=${token}`;
    sendMail({
      to: u.email,
      subject: 'Reset your Coach Fulfillment System password',
      text: `Hi ${u.name},\n\nSomeone (hopefully you) requested a password reset for the Coach Fulfillment System.\n\nReset your password here (link expires in 30 minutes):\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    }).catch(e => console.error('sendMail failed:', e.message));
  }
  send(res, 200, { ok: true });
});
route('POST', /^\/api\/reset-password$/, null, (req, res, m, body) => {
  const pw = String(body.password || '');
  if(pw.length < 8) return err(res, 400, 'Use at least 8 characters');
  const result = consumePasswordReset(String(body.token || ''), pw);
  if(!result.ok) return err(res, 400, result.error);
  log(result.user.email, 'password.reset_via_email', '');
  send(res, 200, { ok: true });
});
route('GET', /^\/api\/state$/, ['admin','lead','sales','coach'], (req, res, m, body, user) => {
  const out = {
    user,
    teams: JSON.parse(getMeta('teams') || '[]'),
    coaches: db.prepare('SELECT * FROM coaches WHERE active=1 ORDER BY team,name').all(),
    blocks: db.prepare('SELECT * FROM blocks').all(),
    visits: db.prepare('SELECT * FROM visits').all(),
  };
  if(user.role === 'admin'){
    out.users = db.prepare('SELECT id,email,name,role,team,coach_id,active FROM users ORDER BY role,name').all();
  }
  if(user.role === 'admin' || user.role === 'lead'){
    out.pendingClientCount = db.prepare("SELECT COUNT(*) c FROM pending_clients WHERE status='pending'").get().c;
  }
  send(res, 200, out);
});

/* ----- Keap-synced contracts & visits ----- */
const KEAP_INTERVAL = { 'Monthly':1, 'Semi-Monthly':2, 'Quarterly':3, 'Bi-Annual':6, 'LID (Purchase)':0, '6 Visits Monthly':1 };
function createKeapContractAndVisits({ clientName, program, n, first, team, keapSubscriptionId, keapCompanyId, price, actorEmail }){
  const cr = db.prepare(`INSERT INTO contracts(client_name,program,team,status,keap_subscription_id,keap_company_id,created)
    VALUES(?,?,?,'active',?,?,?)`)
    .run(clientName.trim(), program, team, keapSubscriptionId || null, keapCompanyId || null, new Date().toISOString());
  const contractId = Number(cr.lastInsertRowid);
  const iv = KEAP_INTERVAL[program] ?? 3;
  const ids = [];
  for(let k = 0; k < n; k++){
    const d = new Date(first + 'T12:00:00'); d.setMonth(d.getMonth() + k * iv);
    const r = db.prepare(`INSERT INTO visits(client,program,cycle,due,team,source,sold,contract_id)
      VALUES(?,?,?,?,?,?,?,?)`).run(clientName.trim(), program, `${k+1} of ${n}`, d.toISOString().slice(0,10), team, 'keap', new Date().toISOString().slice(0,10), contractId);
    ids.push(Number(r.lastInsertRowid));
  }
  log(actorEmail || 'system', 'contract.create', { client: clientName, program, n, first, team, source: 'keap' });
  return { contractId, ids };
}
route('GET', /^\/api\/pending-clients$/, ['admin','lead'], (req, res, m, body, user) => {
  send(res, 200, db.prepare("SELECT * FROM pending_clients WHERE status='pending' ORDER BY created DESC").all());
});
route('POST', /^\/api\/pending-clients\/(\d+)\/assign$/, ['admin','lead'], (req, res, m, body, user) => {
  const pc = db.prepare('SELECT * FROM pending_clients WHERE id=?').get(+m[1]);
  if(!pc) return err(res, 404, 'not found');
  if(pc.status !== 'pending') return err(res, 400, 'already handled');
  const { client, program, n, first, team } = body;
  if(!client || !first || !(n > 0) || !team) return err(res, 400, 'client, program visit count, first due date and team required');
  if(!canEditTeam(user, team)) return err(res, 403, 'You can only assign to your own team');
  const { contractId, ids } = createKeapContractAndVisits({
    clientName: client, program, n, first, team,
    keapSubscriptionId: pc.keap_subscription_id, keapCompanyId: pc.keap_company_id, price: pc.billing_amount,
    actorEmail: user.email,
  });
  db.prepare("UPDATE pending_clients SET status='assigned', resolved_contract_id=? WHERE id=?").run(contractId, pc.id);
  log(user.email, 'pendingclient.assign', { pendingId: pc.id, client, team, contractId });
  send(res, 200, { ok: true, contractId, ids });
});
route('POST', /^\/api\/pending-clients\/(\d+)\/ignore$/, ['admin','lead'], (req, res, m, body, user) => {
  const pc = db.prepare('SELECT * FROM pending_clients WHERE id=?').get(+m[1]);
  if(!pc) return err(res, 404, 'not found');
  db.prepare("UPDATE pending_clients SET status='ignored' WHERE id=?").run(pc.id);
  log(user.email, 'pendingclient.ignore', { pendingId: pc.id, company: pc.company_name });
  send(res, 200, { ok: true });
});
route('GET', /^\/api\/keap\/cancelled-contracts$/, ['admin','lead'], (req, res) => {
  send(res, 200, db.prepare("SELECT * FROM contracts WHERE status='cancelled' ORDER BY id DESC LIMIT 50").all());
});

/* ----- contracts & visits ----- */
const INTERVAL = { 'Monthly':1, 'Semi-Monthly':2, 'Quarterly':3, 'Bi-Annual':6, 'LID (Purchase)':0, '6 Visits Monthly':1 };
route('POST', /^\/api\/contracts$/, ['admin','lead'], (req, res, m, body, user) => {
  const { client, program, n, first, team } = body;
  if(!client || !first || !(n > 0)) return err(res, 400, 'client, first due date and visit count required');
  if(!canEditTeam(user, team)) return err(res, 403, 'You can only add to your own team');
  const iv = INTERVAL[program] ?? 3;
  const ids = [];
  for(let k = 0; k < n; k++){
    const d = new Date(first + 'T12:00:00'); d.setMonth(d.getMonth() + k * iv);
    const r = db.prepare(`INSERT INTO visits(client,program,cycle,due,team,source,sold)
      VALUES(?,?,?,?,?,?,?)`).run(client.trim(), program, `${k+1} of ${n}`, d.toISOString().slice(0,10), team || user.team, 'app', new Date().toISOString().slice(0,10));
    ids.push(Number(r.lastInsertRowid));
  }
  log(user.email, 'contract.create', { client, program, n, first, team });
  send(res, 200, { ok: true, ids });
});
route('POST', /^\/api\/visits$/, ['admin','lead'], (req, res, m, body, user) => {
  if(!body.client) return err(res, 400, 'client required');
  if(!canEditTeam(user, body.team)) return err(res, 403, 'Not your team');
  const r = db.prepare('INSERT INTO visits(client,program,cycle,due,team,source,sold) VALUES(?,?,?,?,?,?,?)')
    .run(body.client.trim(), body.program||'', body.cycle||'', body.due||null, body.team||user.team, 'app', new Date().toISOString().slice(0,10));
  log(user.email, 'visit.create', body);
  send(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
});
route('PATCH', /^\/api\/visits\/(\d+)$/, ['admin','lead'], (req, res, m, body, user) => {
  const v = getVisit(m[1]); if(!v) return err(res, 404, 'not found');
  if(!canEditTeam(user, v.team)) return err(res, 403, 'Not your team');
  const f = {};
  for(const k of ['client','program','cycle','due','team']) if(body[k] !== undefined) f[k] = body[k];
  if(Object.keys(f).length){
    db.prepare(`UPDATE visits SET ${Object.keys(f).map(k=>k+'=?').join(',')} WHERE id=?`)
      .run(...Object.values(f), v.id);
    log(user.email, 'visit.edit', { id: v.id, ...f });
  }
  send(res, 200, { ok: true });
});
route('DELETE', /^\/api\/visits\/(\d+)$/, ['admin','lead'], (req, res, m, body, user) => {
  const v = getVisit(m[1]); if(!v) return err(res, 404, 'not found');
  if(!canEditTeam(user, v.team)) return err(res, 403, 'Not your team');
  db.prepare('DELETE FROM visits WHERE id=?').run(v.id);
  log(user.email, 'visit.delete', { id: v.id, client: v.client, cycle: v.cycle });
  send(res, 200, { ok: true });
});
route('POST', /^\/api\/visits\/(\d+)\/place$/, ['admin','lead'], (req, res, m, body, user) => {
  const v = getVisit(m[1]); if(!v) return err(res, 404, 'not found');
  const c = getCoach(body.coach); if(!c || !c.active) return err(res, 400, 'unknown coach');
  if(!canEditTeam(user, v.team) || !canEditTeam(user, c.team)) return err(res, 403, 'Not your team');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(body.week || '')) return err(res, 400, 'bad week');
  body.week = snapMonday(body.week);
  if(!cellFree(body.coach, body.week, v.id)) return err(res, 409, 'That week is no longer open');
  db.prepare('UPDATE visits SET cal_coach=?, cal_week=? WHERE id=?').run(body.coach, body.week, v.id);
  log(user.email, 'visit.place', { id: v.id, client: v.client, coach: body.coach, week: body.week });
  send(res, 200, { ok: true });
});
route('POST', /^\/api\/visits\/(\d+)\/unschedule$/, ['admin','lead'], (req, res, m, body, user) => {
  const v = getVisit(m[1]); if(!v) return err(res, 404, 'not found');
  if(!canEditTeam(user, v.team)) return err(res, 403, 'Not your team');
  db.prepare('UPDATE visits SET cal_coach=NULL, cal_week=NULL WHERE id=?').run(v.id);
  log(user.email, 'visit.unschedule', { id: v.id, client: v.client });
  send(res, 200, { ok: true });
});
route('POST', /^\/api\/visits\/(\d+)\/complete$/, ['admin','lead'], (req, res, m, body, user) => {
  const v = getVisit(m[1]); if(!v) return err(res, 404, 'not found');
  if(!canEditTeam(user, v.team)) return err(res, 403, 'Not your team');
  db.prepare('UPDATE visits SET completed=1, completed_on=? WHERE id=?').run(new Date().toISOString().slice(0,10), v.id);
  log(user.email, 'visit.complete', { id: v.id, client: v.client, cycle: v.cycle });
  send(res, 200, { ok: true });
});
route('POST', /^\/api\/visits\/(\d+)\/reopen$/, ['admin','lead'], (req, res, m, body, user) => {
  const v = getVisit(m[1]); if(!v) return err(res, 404, 'not found');
  if(!canEditTeam(user, v.team)) return err(res, 403, 'Not your team');
  db.prepare('UPDATE visits SET completed=0, completed_on=NULL WHERE id=?').run(v.id);
  log(user.email, 'visit.reopen', { id: v.id, client: v.client });
  send(res, 200, { ok: true });
});

/* ----- week blocks ----- */
route('PUT', /^\/api\/blocks$/, ['admin','lead'], (req, res, m, body, user) => {
  const c = getCoach(body.coach); if(!c) return err(res, 400, 'unknown coach');
  if(!canEditTeam(user, c.team)) return err(res, 403, 'Not your team');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(body.week || '')) return err(res, 400, 'bad week');
  body.week = snapMonday(body.week);
  const occupied = db.prepare('SELECT id FROM visits WHERE cal_coach=? AND cal_week=? AND completed=0').get(body.coach, body.week);
  if(occupied && body.kind !== 'open') return err(res, 409, 'A visit is scheduled that week — unschedule it first');
  if(body.kind === 'open') db.prepare('DELETE FROM blocks WHERE coach_id=? AND week=?').run(body.coach, body.week);
  else db.prepare(`INSERT INTO blocks(coach_id,week,kind,label) VALUES(?,?,?,?)
    ON CONFLICT(coach_id,week) DO UPDATE SET kind=excluded.kind, label=excluded.label`)
    .run(body.coach, body.week, body.kind, body.label || '');
  log(user.email, 'block.set', body);
  send(res, 200, { ok: true });
});

/* ----- coaches & teams ----- */
route('POST', /^\/api\/coaches$/, ['admin','lead'], (req, res, m, body, user) => {
  if(!body.name) return err(res, 400, 'name required');
  if(!canEditTeam(user, body.team)) return err(res, 403, 'Not your team');
  const id = (body.team + '_' + body.name).toLowerCase().replace(/[^a-z0-9]+/g,'_') + '_' + Date.now().toString(36);
  db.prepare('INSERT INTO coaches(id,name,team) VALUES(?,?,?)').run(id, body.name.trim(), body.team);
  log(user.email, 'coach.add', { id, name: body.name, team: body.team });
  send(res, 200, { ok: true, id });
});
route('PATCH', /^\/api\/coaches\/([\w-]+)$/, ['admin','lead'], (req, res, m, body, user) => {
  const c = getCoach(m[1]); if(!c) return err(res, 404, 'not found');
  if(!canEditTeam(user, c.team) || (body.team && !canEditTeam(user, body.team))) return err(res, 403, 'Not your team');
  if(body.name) db.prepare('UPDATE coaches SET name=? WHERE id=?').run(body.name.trim(), c.id);
  if(body.team){
    db.prepare('UPDATE coaches SET team=? WHERE id=?').run(body.team, c.id);
    db.prepare('UPDATE visits SET team=? WHERE cal_coach=? AND completed=0').run(body.team, c.id);
  }
  log(user.email, 'coach.edit', { id: c.id, ...body });
  send(res, 200, { ok: true });
});
route('DELETE', /^\/api\/coaches\/([\w-]+)$/, ['admin','lead'], (req, res, m, body, user) => {
  const c = getCoach(m[1]); if(!c) return err(res, 404, 'not found');
  if(!canEditTeam(user, c.team)) return err(res, 403, 'Not your team');
  db.prepare('UPDATE visits SET cal_coach=NULL, cal_week=NULL WHERE cal_coach=? AND completed=0').run(c.id);
  db.prepare('UPDATE coaches SET active=0 WHERE id=?').run(c.id);
  log(user.email, 'coach.remove', { id: c.id, name: c.name });
  send(res, 200, { ok: true });
});
route('POST', /^\/api\/teams$/, ['admin'], (req, res, m, body, user) => {
  const teams = JSON.parse(getMeta('teams') || '[]');
  const t = String(body.name || '').trim();
  if(!t || teams.includes(t)) return err(res, 400, 'invalid or duplicate team');
  teams.push(t); setMeta('teams', JSON.stringify(teams));
  log(user.email, 'team.add', t);
  send(res, 200, { ok: true });
});

/* ----- users (admin) ----- */
route('POST', /^\/api\/users$/, ['admin'], (req, res, m, body, user) => {
  const { email, name, role, team, coach_id, password } = body;
  if(!email || !name || !role || !password) return err(res, 400, 'email, name, role, password required');
  try{
    db.prepare('INSERT INTO users(email,name,pw,role,team,coach_id) VALUES(?,?,?,?,?,?)')
      .run(email.toLowerCase().trim(), name.trim(), hashPw(password), role, team || null, coach_id || null);
  }catch(e){ return err(res, 400, 'email already exists'); }
  log(user.email, 'user.add', { email, role, team });
  send(res, 200, { ok: true });
});
route('PATCH', /^\/api\/users\/(\d+)$/, ['admin','lead','sales','coach'], (req, res, m, body, user) => {
  const target = +m[1];
  if(user.role !== 'admin' && user.id !== target) return err(res, 403, 'forbidden');
  if(body.password){
    db.prepare('UPDATE users SET pw=? WHERE id=?').run(hashPw(String(body.password)), target);
    log(user.email, 'user.password', { id: target });
  }
  if(user.role === 'admin'){
    for(const k of ['name','role','team','coach_id']) if(body[k] !== undefined)
      db.prepare(`UPDATE users SET ${k}=? WHERE id=?`).run(body[k], target);
    if(body.active !== undefined) db.prepare('UPDATE users SET active=? WHERE id=?').run(body.active ? 1 : 0, target);
    log(user.email, 'user.edit', { id: target, ...body, password: undefined });
  }
  send(res, 200, { ok: true });
});

/* ----- audit ----- */
route('GET', /^\/api\/audit$/, ['admin'], (req, res) => {
  send(res, 200, db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300').all());
});

/* TEMPORARY diagnostic — remove once Keap webhook verification is confirmed working.
 * Token-gated the same way the earlier _migrate-db/_reset-admin-pw endpoints were. */
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || '';
route('GET', /^\/api\/_keap-events-debug$/, null, (req, res) => {
  if(!DEBUG_TOKEN || req.headers['x-debug-token'] !== DEBUG_TOKEN) return err(res, 403, 'forbidden');
  const rows = db.prepare('SELECT * FROM keap_events ORDER BY id DESC LIMIT 20').all();
  send(res, 200, { count: rows.length, rows, keapTokenConfigured: !!KEAP_TOKEN });
});

/* ================= Keap webhook receiver ================= */
/* Keap Classic sends a POST for each event; the payload can also be a verification
 * ping (contains a "key" to confirm) rather than a real event. We log everything raw
 * first (cheap insurance while validating the integration), then try to handle it.
 * No cookie auth here — Keap calls this directly. We only ever use the payload to
 * look up/mutate our own records, never to run arbitrary commands. */
async function handleKeapWebhook(req, res, rawBody){
  let events;
  try{ events = JSON.parse(rawBody || '[]'); }catch(e){ events = []; }
  if(!Array.isArray(events)) events = [events];

  for(const evt of events){
    const eventKey = evt.event_key || evt.eventKey || '';
    const verifyKey = evt.key || evt.verify_key || null;
    const objectId = (evt.object_keys && evt.object_keys[0]) || (evt.objectKeys && evt.objectKeys[0]) || evt.object_key || evt.id || evt.subscription_id || null;

    db.prepare('INSERT INTO keap_events(ts,event_key,object_id,raw) VALUES(?,?,?,?)')
      .run(new Date().toISOString(), eventKey || '(verify)', String(objectId || ''), JSON.stringify(evt).slice(0, 4000));

    if(verifyKey && !eventKey){
      const hooks = await keapGet('/v1/hooks');
      const hookId = (hooks.json || []).find(h => h.hookUrl && h.hookUrl.includes('/api/webhooks/keap'))?.key;
      if(hookId) await keapPost(`/v1/hooks/${hookId}/verify`, { key: verifyKey });
      continue;
    }
    if(eventKey === 'subscription.add' && objectId){
      await onSubscriptionAdd(objectId);
    } else if((eventKey === 'subscription.edit' || eventKey === 'subscription.delete') && objectId){
      await onSubscriptionChange(objectId, eventKey);
    }
    // other event keys are logged to keap_events but not acted on yet.
  }
  send(res, 200, { ok: true });
}
async function onSubscriptionAdd(subId){
  const already = db.prepare('SELECT id FROM pending_clients WHERE keap_subscription_id=?').get(String(subId));
  const existingContract = db.prepare('SELECT id FROM contracts WHERE keap_subscription_id=?').get(String(subId));
  if(already || existingContract) return; // already queued or already assigned

  const sub = await keapGet(`/v1/subscriptions/${subId}`);
  const s = sub.json || {};
  let companyName = '', contactName = '';
  if(s.contact_id){
    const c = await keapGet(`/v1/contacts/${s.contact_id}?optional_properties=company`);
    const cj = c.json || {};
    companyName = cj.company?.company_name || '';
    contactName = [cj.given_name, cj.family_name].filter(Boolean).join(' ');
  }
  db.prepare(`INSERT INTO pending_clients
    (keap_subscription_id,keap_contact_id,keap_company_id,company_name,contact_name,product_desc,billing_amount,billing_cycle,billing_frequency,start_date,status,created)
    VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)
    ON CONFLICT(keap_subscription_id) DO NOTHING`)
    .run(String(subId), s.contact_id ? String(s.contact_id) : null, s.contact_id_company || '', companyName, contactName,
      s.subscription_plan_id ? String(s.subscription_plan_id) : (s.product_id ? String(s.product_id) : ''),
      Number(s.billing_amount) || null, s.billing_cycle || '', s.billing_frequency || null, s.start_date || null,
      new Date().toISOString());
  log('keap.webhook', 'pendingclient.queued', { subId, companyName, contactName });
}
async function onSubscriptionChange(subId, eventKey){
  const sub = await keapGet(`/v1/subscriptions/${subId}`);
  const s = sub.json || {};
  const contract = db.prepare('SELECT * FROM contracts WHERE keap_subscription_id=?').get(String(subId));
  const stillActive = eventKey === 'subscription.delete' ? false : !!s.active;

  if(!contract){
    if(!stillActive) db.prepare("UPDATE pending_clients SET status='ignored' WHERE keap_subscription_id=?").run(String(subId));
    return;
  }
  const newStatus = stillActive ? 'active' : 'cancelled';
  if(contract.status !== newStatus){
    db.prepare('UPDATE contracts SET status=? WHERE id=?').run(newStatus, contract.id);
    log('keap.webhook', 'contract.status', { contractId: contract.id, subId, status: newStatus });
  }
  // We deliberately do NOT auto-delete future scheduled visits on churn — a lead
  // reviews the Admin screen (now flagged via the contract's cancelled status) and
  // removes/reassigns them by hand, so nothing gets silently wiped off the board.
}

/* ================= server ================= */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if(url.pathname === '/api/webhooks/keap' && req.method === 'POST'){
    let chunks = [];
    req.on('data', d => { chunks.push(d); if(Buffer.concat(chunks).length > 2e6) req.destroy(); });
    req.on('end', () => { handleKeapWebhook(req, res, Buffer.concat(chunks).toString()).catch(e => { console.error(e); send(res, 200, { ok:true }); }); });
    return;
  }

  // API
  if(url.pathname.startsWith('/api/')){
    let chunks = [];
    req.on('data', d => { chunks.push(d); if(Buffer.concat(chunks).length > 1e6) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try{ if(chunks.length) body = JSON.parse(Buffer.concat(chunks).toString()); }catch(e){}
      for(const r of routes){
        if(r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if(!m) continue;
        let user = null;
        if(r.roles){
          user = currentUser(req);
          if(!user) return err(res, 401, 'Please sign in');
          if(!r.roles.includes(user.role)) return err(res, 403, 'Insufficient permissions');
        }
        try{ return r.fn(req, res, m, body, user); }
        catch(e){ console.error(e); return err(res, 500, 'Server error'); }
      }
      return err(res, 404, 'Unknown endpoint');
    });
    return;
  }
  // static
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUB, p);
  if(!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){
    // SPA fallback
    const idx = path.join(PUB, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(idx));
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
server.listen(PORT, () => console.log(`Coach Fulfillment System running → http://localhost:${PORT}`));
