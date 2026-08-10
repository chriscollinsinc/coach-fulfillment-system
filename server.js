/* Coach Fulfillment System — zero-dependency Node server (Node 22+). */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { db, hashPw, checkPw, getMeta, setMeta, log, resolveClient, findClientByKeapId, createPasswordReset, consumePasswordReset, snapshotClientMonth, ensureCurrentMonthSnapshot, DB_PATH } = require('./db.js');
const { sendMail } = require('./mail.js');

const PORT = process.env.PORT || 3000;
const SECRET = getMeta('secret');
const PUB = path.join(__dirname, 'public');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

/* ---------- Google SSO (OAuth 2.0 / OIDC "Sign in with Google") ----------
   Adds an alternate login path alongside the existing email/password login —
   it never replaces it. Deliberately does NOT auto-create accounts: SSO only
   ever signs in a user who already exists (created by an admin the normal
   way), the same access-control model as today. Set these three env vars on
   Render to turn it on; until GOOGLE_CLIENT_ID is set, the button is hidden
   and these routes 404 harmlessly.
     GOOGLE_CLIENT_ID       — from the OAuth client in Google Cloud Console
     GOOGLE_CLIENT_SECRET   — from the same OAuth client
     GOOGLE_ALLOWED_DOMAIN  — e.g. chriscollinsinc.com; Google accounts outside
                              this Workspace domain are rejected even if a user
                              row somehow matched by email. */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_ALLOWED_DOMAIN = (process.env.GOOGLE_ALLOWED_DOMAIN || '').toLowerCase();
function googleRedirectUri(req){
  return `https://${req.headers.host}/auth/google/callback`;
}
async function handleGoogleStart(req, res){
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  if(GOOGLE_ALLOWED_DOMAIN) params.set('hd', GOOGLE_ALLOWED_DOMAIN); // Workspace hint only — we verify server-side too
  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    'Set-Cookie': `ssostate=${encodeURIComponent(sign(state))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
  });
  res.end();
}
async function handleGoogleCallback(req, res, url){
  const fail = (reason) => { res.writeHead(302, { Location: `/?ssoerror=${encodeURIComponent(reason)}` }); res.end(); };
  try{
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieMatch = /(?:^|;\s*)ssostate=([^;]+)/.exec(req.headers.cookie || '');
    const cookieState = unsign(cookieMatch && decodeURIComponent(cookieMatch[1]));
    if(!code || !state || !cookieState || cookieState !== state) return fail('bad_state');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(req), grant_type: 'authorization_code',
      }),
    });
    const tokenJson = await tokenRes.json();
    if(!tokenRes.ok || !tokenJson.access_token) return fail('token_exchange_failed');

    const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenJson.access_token },
    });
    const info = await infoRes.json();
    if(!infoRes.ok || !info.email) return fail('userinfo_failed');
    if(!info.email_verified) return fail('email_not_verified');
    const domain = String(info.email).split('@')[1] || '';
    if(GOOGLE_ALLOWED_DOMAIN && domain.toLowerCase() !== GOOGLE_ALLOWED_DOMAIN) return fail('wrong_domain');

    const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(String(info.email).toLowerCase().trim());
    if(!u) return fail('no_account'); // real account required — SSO signs in, it never provisions

    log(u.email, 'login.google_sso', '');
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': [
        `cfs=${encodeURIComponent(sign(String(u.id)))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        'ssostate=; Path=/; Max-Age=0',
      ],
    });
    res.end();
  }catch(e){
    console.error('Google SSO callback error:', e);
    fail('server_error');
  }
}

/* ---------- Keap REST helper (server-side, for webhook enrichment + hook verify) ---------- */
const KEAP_TOKEN = process.env.KEAP_TOKEN || '';
const KEAP_BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
async function keapGet(p){
  if(!KEAP_TOKEN) return { ok:false, status:0, json:null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout after 10s')), 10000);
  try{
    const r = await fetch(KEAP_BASE + p, { headers: { Authorization: 'Bearer ' + KEAP_TOKEN, Accept: 'application/json' }, signal: ctrl.signal });
    const t = await r.text(); let j = null; try{ j = JSON.parse(t); }catch(e){}
    return { ok: r.ok, status: r.status, json: j };
  }catch(e){ return { ok:false, status:0, json:null, error:String(e && e.message || e) }; }
  finally{ clearTimeout(timer); }
}
async function keapPost(p, body){
  if(!KEAP_TOKEN) return { ok:false, status:0, json:null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout after 10s')), 10000);
  try{
    const r = await fetch(KEAP_BASE + p, { method:'POST', headers: { Authorization: 'Bearer ' + KEAP_TOKEN, 'Content-Type':'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    const t = await r.text(); let j = null; try{ j = JSON.parse(t); }catch(e){}
    return { ok: r.ok, status: r.status, json: j };
  }catch(e){ return { ok:false, status:0, json:null, error:String(e && e.message || e) }; }
  finally{ clearTimeout(timer); }
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

/* ----- contracts & visits (shared so Keap-assigned contracts generate the same way) ----- */
const INTERVAL = { 'Monthly':1, 'Semi-Monthly':2, 'Quarterly':3, 'Bi-Annual':6, 'LID (Purchase)':0, '6 Visits Monthly':1 };
function createContractAndVisits({ clientName, program, n, first, team, source, keapSubscriptionId, price, keapCompanyId, actorEmail }){
  const clientId = resolveClient(clientName, { billing_start: first, keap_id: keapCompanyId || '', fromKeap: source === 'keap' });
  const cr = db.prepare(`INSERT INTO contracts(client_id,program,visits,start_date,price,status,source,keap_subscription_id,created)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(clientId, program, n, first, price ?? null, 'active', source || 'app', keapSubscriptionId || null, new Date().toISOString());
  const contractId = Number(cr.lastInsertRowid);
  const iv = INTERVAL[program] ?? 3;
  const ids = [];
  for(let k = 0; k < n; k++){
    const d = new Date(first + 'T12:00:00'); d.setMonth(d.getMonth() + k * iv);
    const r = db.prepare(`INSERT INTO visits(client,program,cycle,due,team,source,sold,client_id,contract_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(clientName.trim(), program, `${k+1} of ${n}`, d.toISOString().slice(0,10), team, source || 'app', new Date().toISOString().slice(0,10), clientId, contractId);
    ids.push(Number(r.lastInsertRowid));
  }
  log(actorEmail || 'system', 'contract.create', { client: clientName, program, n, first, team, source });
  return { clientId, contractId, ids };
}

/* ================= API ================= */
route('GET', /^\/api\/sso-config$/, null, (req, res) => {
  send(res, 200, { googleEnabled: !!GOOGLE_CLIENT_ID });
});
/* ---------- login rate limiting ----------
   In-memory only (resets on redeploy — acceptable, this is a speed bump against
   automated guessing, not a persistent ban list). Keyed by normalized email so
   one attacker can't lock out a real user by spraying wrong passwords under
   their address from many IPs — that's still possible here, but only delays
   that one account's own login, not a mechanism to block anyone else. */
const LOGIN_ATTEMPTS = new Map(); // email -> { count, firstAt, lockedUntil }
const LOGIN_MAX_ATTEMPTS = 5, LOGIN_WINDOW_MS = 15*60*1000, LOGIN_LOCKOUT_MS = 15*60*1000;
function loginRateLimited(email){
  const rec = LOGIN_ATTEMPTS.get(email);
  if(!rec) return false;
  if(rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
  if(rec.lockedUntil && rec.lockedUntil <= Date.now()) { LOGIN_ATTEMPTS.delete(email); return false; }
  return false;
}
function recordLoginFailure(email){
  const now = Date.now();
  let rec = LOGIN_ATTEMPTS.get(email);
  if(!rec || (now - rec.firstAt) > LOGIN_WINDOW_MS) rec = { count: 0, firstAt: now, lockedUntil: 0 };
  rec.count++;
  if(rec.count >= LOGIN_MAX_ATTEMPTS) rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
  LOGIN_ATTEMPTS.set(email, rec);
}
function clearLoginFailures(email){ LOGIN_ATTEMPTS.delete(email); }

route('POST', /^\/api\/login$/, null, (req, res, m, body) => {
  const email = String(body.email || '').toLowerCase().trim();
  if(loginRateLimited(email)) return err(res, 429, 'Too many failed attempts — try again in a few minutes.');
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
  if(!u || !checkPw(String(body.password || ''), u.pw)){ recordLoginFailure(email); return err(res, 401, 'Invalid email or password'); }
  clearLoginFailures(email);
  log(u.email, 'login', '');
  send(res, 200, { ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role, team: u.team, coach_id: u.coach_id } },
    { 'Set-Cookie': `cfs=${encodeURIComponent(sign(String(u.id)))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` });
});
route('POST', /^\/api\/logout$/, ['admin','lead','sales','coach'], (req, res, m, body, user) => {
  send(res, 200, { ok: true }, { 'Set-Cookie': 'cfs=; Path=/; Max-Age=0' });
});
route('POST', /^\/api\/forgot-password$/, null, (req, res, m, body) => {
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
    coaches: db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM clients WHERE assigned_coach_id=c.id AND deleted_at IS NULL) AS assigned_stores,
      (SELECT COUNT(*) FROM visits WHERE cal_coach=c.id AND completed=0) AS upcoming_count
      FROM coaches c WHERE c.active=1 ORDER BY c.team,c.name`).all(),
    blocks: db.prepare('SELECT * FROM blocks').all(),
    visits: db.prepare(`SELECT v.*, cl.assigned_coach_id AS client_assigned_coach_id
      FROM visits v LEFT JOIN clients cl ON cl.id = v.client_id`).all(),
  };
  if(user.role === 'admin' || user.role === 'lead'){
    out.pendingClientCount = db.prepare("SELECT COUNT(*) c FROM pending_clients WHERE status='pending'").get().c;
  }
  if(user.role === 'admin'){
    out.users = db.prepare('SELECT id,email,name,role,team,coach_id,active FROM users ORDER BY role,name').all();
  }
  send(res, 200, out);
});

/* ----- contracts & visits ----- */
route('POST', /^\/api\/contracts$/, ['admin','lead'], (req, res, m, body, user) => {
  const { client, program, n, first, team, coachId } = body;
  const isCoachingOnly = program === 'Coaching Only';
  if(!client) return err(res, 400, 'client name required');
  if(!isCoachingOnly && (!first || !(n > 0))) return err(res, 400, 'client, first due date and visit count required');
  if(!canEditTeam(user, team)) return err(res, 403, 'You can only add to your own team');
  if(coachId && !getCoach(coachId)) return err(res, 400, 'unknown coach');
  const { clientId, ids } = createContractAndVisits({ clientName: client, program, n: isCoachingOnly ? 0 : n, first: first || null, team: team || user.team, source: 'app', actorEmail: user.email });
  if(coachId) db.prepare('UPDATE clients SET assigned_coach_id=? WHERE id=? AND assigned_coach_id IS NULL').run(coachId, clientId);
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
/* A coach may complete a visit only if they're the one who scheduled it
   (cal_coach) or the one permanently assigned to the client (clients.assigned_coach_id)
   — never any visit generally, even on their own team. Admin/lead keep the
   broader team-level permission they already had. Re-derived from the DB here,
   never trusted from the request body. */
function canCompleteVisit(user, v){
  if(user.role === 'admin') return true;
  if(user.role === 'lead') return canEditTeam(user, v.team);
  if(user.role === 'coach'){
    if(v.cal_coach && v.cal_coach === user.coach_id) return true;
    if(v.client_id){
      const cl = db.prepare('SELECT assigned_coach_id FROM clients WHERE id=?').get(v.client_id);
      if(cl && cl.assigned_coach_id && cl.assigned_coach_id === user.coach_id) return true;
    }
    return false;
  }
  return false;
}
route('POST', /^\/api\/visits\/(\d+)\/complete$/, ['admin','lead','coach'], (req, res, m, body, user) => {
  const v = getVisit(m[1]); if(!v) return err(res, 404, 'not found');
  if(!canCompleteVisit(user, v)) return err(res, 403, 'You can only complete a visit you scheduled or are the assigned coach for');
  // Snapshot who actually did the work, for the coach's permanent history — the coach
  // themself if a coach completed it, otherwise whichever coach it was scheduled under
  // (an admin/lead completing on a coach's behalf still credits that coach).
  const creditCoachId = user.role === 'coach' ? user.coach_id : (v.cal_coach || null);
  db.prepare('UPDATE visits SET completed=1, completed_on=?, completed_by_coach_id=?, completed_by_email=? WHERE id=?')
    .run(new Date().toISOString().slice(0,10), creditCoachId, user.email, v.id);
  log(user.email, 'visit.complete', { id: v.id, client: v.client, cycle: v.cycle });
  // Optional note logged in the same step, tied to this specific visit rather than
  // just general client commentary — this is how a completion becomes documented.
  if(body && body.note && String(body.note).trim()){
    if(v.client_id){
      db.prepare(`INSERT INTO client_notes(client_id,note_date,note_type,author_email,author_name,body,visit_id,created)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(v.client_id, new Date().toISOString().slice(0,10), 'LID', user.email, user.name, String(body.note).trim(), v.id, new Date().toISOString());
    }
  }
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
  if(body.phone !== undefined) db.prepare('UPDATE coaches SET phone=? WHERE id=?').run(String(body.phone||'').trim(), c.id);
  if(body.start_date !== undefined){
    if(body.start_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.start_date)) return err(res, 400, 'bad start date');
    db.prepare('UPDATE coaches SET start_date=? WHERE id=?').run(body.start_date || null, c.id);
  }
  log(user.email, 'coach.edit', { id: c.id, ...body });
  send(res, 200, { ok: true });
});
route('DELETE', /^\/api\/coaches\/([\w-]+)$/, ['admin','lead'], (req, res, m, body, user) => {
  const c = getCoach(m[1]); if(!c) return err(res, 404, 'not found');
  if(!canEditTeam(user, c.team)) return err(res, 403, 'Not your team');
  // Reassignment is optional — pass reassignToCoachId to hand this coach's current
  // stores + open scheduled slots to someone else in one step; omit it to just free
  // them up (stores become unassigned, slots return to the to-schedule pool).
  // Either way, nothing about their COMPLETED history changes — completed_by_coach_id
  // permanently credits the coach who actually did the work, so their profile/history
  // stays intact and correct even after they're deactivated.
  const toId = body && body.reassignToCoachId ? String(body.reassignToCoachId) : null;
  if(toId){
    const dest = getCoach(toId);
    if(!dest) return err(res, 400, 'reassignment target coach not found');
    if(!canEditTeam(user, dest.team)) return err(res, 403, 'Reassignment target is not on your team');
  }
  const storesMoved = db.prepare('SELECT COUNT(*) n FROM clients WHERE assigned_coach_id=?').get(c.id).n;
  db.prepare('UPDATE clients SET assigned_coach_id=? WHERE assigned_coach_id=?').run(toId, c.id);
  if(toId) db.prepare('UPDATE visits SET cal_coach=? WHERE cal_coach=? AND completed=0').run(toId, c.id);
  else db.prepare('UPDATE visits SET cal_coach=NULL, cal_week=NULL WHERE cal_coach=? AND completed=0').run(c.id);
  db.prepare('UPDATE coaches SET active=0 WHERE id=?').run(c.id);
  log(user.email, 'coach.remove', { id: c.id, name: c.name, storesMoved, reassignedTo: toId || null });
  send(res, 200, { ok: true, storesMoved });
});
route('GET', /^\/api\/coaches\/inactive$/, ['admin','lead'], (req, res, m, body, user) => {
  const rows = db.prepare('SELECT * FROM coaches WHERE active=0 ORDER BY team,name').all()
    .filter(c => canEditTeam(user, c.team));
  send(res, 200, rows);
});
/* ----- coach profile: assigned stores, visit history, notes — the "what happens
   when a coach leaves" answer is that none of this ever disappears. A deactivated
   coach's profile is still fully browsable by admins/leads; only future scheduling
   moves on without them. ----- */
route('GET', /^\/api\/coaches\/([\w-]+)\/profile$/, ['admin','lead','coach'], (req, res, m, body, user) => {
  const c = getCoach(m[1]); if(!c) return err(res, 404, 'not found');
  if(user.role === 'coach' && user.coach_id !== c.id) return err(res, 403, 'You can only view your own profile');
  if(user.role === 'lead' && !canEditTeam(user, c.team)) return err(res, 403, 'Not your team');
  const assignedClients = db.prepare(`SELECT id, name, status FROM clients WHERE assigned_coach_id=? AND deleted_at IS NULL ORDER BY name`).all(c.id);
  const yr = new Date().getFullYear();
  const visitHistory = db.prepare(`
    SELECT v.id, v.client, v.client_id, v.program, v.cycle, v.due, v.completed_on, v.completed_by_email
    FROM visits v WHERE v.completed_by_coach_id=? ORDER BY v.completed_on DESC LIMIT 500`).all(c.id);
  const upcoming = db.prepare(`
    SELECT v.id, v.client, v.client_id, v.program, v.cycle, v.due, v.cal_week
    FROM visits v WHERE v.cal_coach=? AND v.completed=0 ORDER BY v.due`).all(c.id);
  const completedThisYear = visitHistory.filter(v => (v.completed_on||'').slice(0,4) === String(yr)).length;
  const notes = db.prepare(`
    SELECT n.id, n.client_id, cl.name AS client_name, n.note_date, n.note_type, n.body, n.author_name, n.author_email, n.source
    FROM client_notes n JOIN clients cl ON cl.id = n.client_id
    WHERE n.author_email IN (SELECT email FROM users WHERE coach_id=?)
    ORDER BY n.note_date DESC LIMIT 200`).all(c.id);
  // Quick-glance to-do: everything currently in this coach's court, worked out fresh
  // on every load rather than stored, so it's always accurate.
  const todayIso = new Date().toISOString().slice(0,10);
  const in14 = new Date(Date.now() + 14*24*60*60*1000).toISOString().slice(0,10);
  const openWork = db.prepare(`
    SELECT v.id, v.client, v.client_id, v.due, v.program
    FROM visits v LEFT JOIN clients cl ON cl.id = v.client_id
    WHERE v.completed=0 AND (v.cal_coach=? OR cl.assigned_coach_id=?)
    ORDER BY v.due`).all(c.id, c.id);
  const overdue = openWork.filter(v => v.due && v.due < todayIso);
  const dueSoon = openWork.filter(v => v.due && v.due >= todayIso && v.due <= in14);
  const missingNotes = db.prepare(`
    SELECT v.id, v.client, v.client_id, v.completed_on
    FROM visits v
    WHERE v.completed_by_coach_id=? AND v.id NOT IN (SELECT visit_id FROM client_notes WHERE visit_id IS NOT NULL)
    ORDER BY v.completed_on DESC LIMIT 50`).all(c.id);
  send(res, 200, {
    coach: c,
    assignedClients,
    stats: { assignedStores: assignedClients.length, completedThisYear, allTimeCompleted: visitHistory.length, upcomingCount: upcoming.length },
    visitHistory, upcoming, notes,
    todo: { overdue, dueSoon, missingNotes },
  });
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
    if(body.email !== undefined){
      const newEmail = String(body.email).toLowerCase().trim();
      if(!/^\S+@\S+\.\S+$/.test(newEmail)) return err(res, 400, 'bad email');
      try{ db.prepare('UPDATE users SET email=? WHERE id=?').run(newEmail, target); }
      catch(e){ return err(res, 400, 'that email is already in use'); }
    }
    for(const k of ['name','role','team','coach_id']) if(body[k] !== undefined)
      db.prepare(`UPDATE users SET ${k}=? WHERE id=?`).run(body[k], target);
    if(body.active !== undefined) db.prepare('UPDATE users SET active=? WHERE id=?').run(body.active ? 1 : 0, target);
    log(user.email, 'user.edit', { id: target, ...body, password: undefined });
  }
  send(res, 200, { ok: true });
});

/* ----- pending clients (Keap subscriptions awaiting team assignment) ----- */
route('GET', /^\/api\/pending-clients$/, ['admin','lead'], (req, res, m, body, user) => {
  send(res, 200, db.prepare("SELECT * FROM pending_clients WHERE status='pending' ORDER BY created DESC").all());
});
route('POST', /^\/api\/pending-clients\/(\d+)\/assign$/, ['admin','lead'], (req, res, m, body, user) => {
  const pc = db.prepare('SELECT * FROM pending_clients WHERE id=?').get(+m[1]);
  if(!pc) return err(res, 404, 'not found');
  if(pc.status !== 'pending') return err(res, 400, 'already handled');
  const { client, program, n, first, team, coachId } = body;
  const isCoachingOnly = program === 'Coaching Only';
  if(!client || !team) return err(res, 400, 'client and team required');
  if(!isCoachingOnly && (!first || !(n > 0))) return err(res, 400, 'program visit count and first due date required');
  if(!canEditTeam(user, team)) return err(res, 403, 'You can only assign to your own team');
  if(coachId && !getCoach(coachId)) return err(res, 400, 'unknown coach');
  const { clientId, contractId, ids } = createContractAndVisits({
    clientName: client, program, n: isCoachingOnly ? 0 : n, first: first || null, team, source: 'keap',
    keapSubscriptionId: pc.keap_subscription_id, price: pc.billing_amount, keapCompanyId: pc.keap_company_id,
    actorEmail: user.email,
  });
  if(coachId) db.prepare('UPDATE clients SET assigned_coach_id=? WHERE id=?').run(coachId, clientId);
  db.prepare("UPDATE pending_clients SET status='assigned', resolved_client_id=?, resolved_contract_id=? WHERE id=?")
    .run(clientId, contractId, pc.id);
  log(user.email, 'pendingclient.assign', { pendingId: pc.id, client, team, contractId, coachId });
  send(res, 200, { ok: true, clientId, contractId, ids });
});
route('POST', /^\/api\/pending-clients\/(\d+)\/ignore$/, ['admin','lead'], (req, res, m, body, user) => {
  const pc = db.prepare('SELECT * FROM pending_clients WHERE id=?').get(+m[1]);
  if(!pc) return err(res, 404, 'not found');
  db.prepare("UPDATE pending_clients SET status='ignored' WHERE id=?").run(pc.id);
  log(user.email, 'pendingclient.ignore', { pendingId: pc.id, company: pc.company_name });
  send(res, 200, { ok: true });
});
route('POST', /^\/api\/keap\/sync$/, ['admin'], (req, res, m, body, user) => {
  keapSyncAllLinkedContracts(user.email)
    .then(summary => send(res, 200, { ok: true, ...summary }))
    .catch(e => { console.error('keap sync failed:', e); err(res, 500, 'Sync failed: ' + String(e && e.message || e)); });
});
route('GET', /^\/api\/keap\/cancelled-contracts$/, ['admin','lead'], (req, res) => {
  send(res, 200, db.prepare(`
    SELECT c.id, c.program, c.status, cl.name AS client_name,
      (SELECT v.team FROM visits v WHERE v.contract_id=c.id ORDER BY v.id LIMIT 1) AS team
    FROM contracts c JOIN clients cl ON cl.id=c.client_id
    WHERE c.status='cancelled' ORDER BY c.id DESC LIMIT 50`).all());
});

/* ----- revenue history ----- */
route('GET', /^\/api\/revenue-history$/, ['admin','lead'], (req, res) => {
  send(res, 200, db.prepare('SELECT * FROM revenue_snapshots ORDER BY date DESC LIMIT 180').all());
});

/* ----- backups + nightly maintenance (admin can also trigger by hand) ----- */
const ADMIN_EMAILS = () => db.prepare("SELECT email FROM users WHERE role='admin' AND active=1").all().map(r => r.email);

async function takeBackupAndEmail(actorEmail){
  const admins = ADMIN_EMAILS();
  if(!admins.length) return { ok: false, error: 'No active admin users to send the backup to.' };
  let raw;
  try{ raw = fs.readFileSync(DB_PATH); }
  catch(e){ return { ok: false, error: 'Could not read database file: ' + e.message }; }
  const gz = zlib.gzipSync(raw);
  const dateStr = new Date().toISOString().slice(0, 10);
  const results = [];
  for(const to of admins){
    try{
      await sendMail({
        to, subject: `Coach Fulfillment System — DB backup (${dateStr})`,
        text: `Attached is a full backup of the Coach Fulfillment System database as of ${new Date().toISOString()}.\n\nTo restore: gunzip the attachment and replace the running server's database file (see README for the exact path), then restart the app.\n\nTriggered by: ${actorEmail}`,
        attachments: [{ filename: `coach-fulfillment-backup-${dateStr}.db.gz`, content: gz, contentType: 'application/gzip' }],
      });
      results.push({ to, ok: true });
    }catch(e){ results.push({ to, ok: false, error: e.message }); }
  }
  const anyOk = results.some(r => r.ok);
  if(anyOk) setMeta('last_backup_at', new Date().toISOString());
  log(actorEmail, 'backup.sent', { sizeBytes: gz.length, results });
  return { ok: anyOk, sizeBytes: gz.length, results };
}
route('POST', /^\/api\/admin\/backup-now$/, ['admin'], (req, res, m, body, user) => {
  takeBackupAndEmail(user.email)
    .then(r => send(res, 200, r))
    .catch(e => err(res, 500, 'Backup failed: ' + e.message));
});
/* Direct download — a second, independent recovery path that doesn't depend on
   email deliverability (spam filters, a wrong/missing GMAIL_APP_PASSWORD, etc).
   Same raw file the emailed backup contains, gzipped, streamed straight down. */
route('GET', /^\/api\/admin\/backup-download$/, ['admin'], (req, res, m, body, user) => {
  let raw;
  try{ raw = fs.readFileSync(DB_PATH); }
  catch(e){ return err(res, 500, 'Could not read database file: ' + e.message); }
  const gz = zlib.gzipSync(raw);
  const dateStr = new Date().toISOString().slice(0, 10);
  log(user.email, 'backup.downloaded', { sizeBytes: gz.length });
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="coach-fulfillment-backup-${dateStr}.db.gz"`,
    'Content-Length': gz.length,
  });
  res.end(gz);
});
route('GET', /^\/api\/admin\/backup-status$/, ['admin'], (req, res, m, body, user) => {
  send(res, 200, { lastBackupAt: getMeta('last_backup_at') || null, dbPath: DB_PATH });
});

/* Soft-deleted clients older than this are purged for real — cascades through
   their notes/visits/contracts/snapshots. Runs nightly; never runs on-demand
   from a route, since there's no undo past this point. */
function purgeOldSoftDeletes(){
  const cutoff = new Date(Date.now() - 30*24*60*60*1000).toISOString();
  const rows = db.prepare('SELECT id, name FROM clients WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff);
  for(const r of rows){
    db.prepare('UPDATE pending_clients SET resolved_client_id=NULL WHERE resolved_client_id=?').run(r.id);
    db.prepare('DELETE FROM client_notes WHERE client_id=?').run(r.id);
    db.prepare('DELETE FROM visits WHERE client_id=?').run(r.id);
    db.prepare('DELETE FROM contracts WHERE client_id=?').run(r.id);
    db.prepare('DELETE FROM client_month_snapshots WHERE client_id=?').run(r.id);
    db.prepare('DELETE FROM clients WHERE id=?').run(r.id);
    log('system', 'client.purge', { clientId: r.id, name: r.name });
  }
  return { purged: rows.length };
}

function recordRevenueSnapshot(){
  const today = new Date().toISOString().slice(0, 10);
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(price),0) t FROM contracts WHERE status='active'").get().t;
  const activeClients = db.prepare("SELECT COUNT(*) c FROM clients WHERE status='active' AND deleted_at IS NULL").get().c;
  const keapLinked = db.prepare("SELECT COUNT(*) c FROM contracts WHERE status='active' AND keap_subscription_id IS NOT NULL AND keap_subscription_id != ''").get().c;
  db.prepare(`INSERT INTO revenue_snapshots(date,total_revenue,active_clients,keap_linked_contracts,created) VALUES(?,?,?,?,?)
    ON CONFLICT(date) DO UPDATE SET total_revenue=excluded.total_revenue, active_clients=excluded.active_clients, keap_linked_contracts=excluded.keap_linked_contracts`)
    .run(today, totalRevenue, activeClients, keapLinked, new Date().toISOString());
  return { totalRevenue, activeClients, keapLinked };
}

async function runNightlyMaintenance(actorEmail){
  const summary = { startedAt: new Date().toISOString() };
  try{ summary.sync = await keapSyncAllLinkedContracts(actorEmail); }
  catch(e){ summary.sync = { error: String(e && e.message || e) }; }
  try{ summary.revenue = recordRevenueSnapshot(); }
  catch(e){ summary.revenue = { error: String(e && e.message || e) }; }
  try{ summary.purge = purgeOldSoftDeletes(); }
  catch(e){ summary.purge = { error: String(e && e.message || e) }; }
  try{ summary.backup = await takeBackupAndEmail(actorEmail); }
  catch(e){ summary.backup = { error: String(e && e.message || e) }; }

  // Digest: overdue visits + stale pending queue, alongside the above — one email,
  // not four, so admins get one thing to skim instead of a flood.
  try{
    const overdue = db.prepare("SELECT COUNT(*) c FROM visits WHERE completed=0 AND due IS NOT NULL AND due < ?").get(new Date().toISOString().slice(0,10)).c;
    const stalePending = db.prepare("SELECT COUNT(*) c FROM pending_clients WHERE status='pending' AND created < ?").get(new Date(Date.now()-7*24*60*60*1000).toISOString()).c;
    const syncErrors = (summary.sync && summary.sync.errors) ? summary.sync.errors.length : 0;
    const lines = [
      `Coach Fulfillment System — nightly summary for ${new Date().toISOString().slice(0,10)}`,
      '',
      `Keap sync: ${summary.sync.error ? 'FAILED — ' + summary.sync.error : `checked ${summary.sync.checked}, price updated ${summary.sync.priceChanged}, status changed ${summary.sync.statusChanged}, errors ${syncErrors}`}`,
      `Revenue snapshot: ${summary.revenue.error ? 'FAILED — ' + summary.revenue.error : `$${Math.round(summary.revenue.totalRevenue).toLocaleString()} across ${summary.revenue.activeClients} active client(s)`}`,
      `Soft-delete purge: ${summary.purge.error ? 'FAILED — ' + summary.purge.error : `${summary.purge.purged} client(s) purged (past the 30-day recovery window)`}`,
      `Database backup: ${summary.backup.ok ? `sent (${Math.round((summary.backup.sizeBytes||0)/1024)} KB)` : 'FAILED — ' + (summary.backup.error || 'see results')}`,
      '',
      `Overdue visits (not yet completed, past due): ${overdue}`,
      `Pending Clients queue items older than 7 days: ${stalePending}`,
    ];
    if(overdue > 0 || stalePending > 0 || syncErrors > 0 || !summary.backup.ok) lines.push('', 'One or more of the above needs a look.');
    const admins = ADMIN_EMAILS();
    let digestSent = 0;
    for(const to of admins){
      try{ await sendMail({ to, subject: 'Coach Fulfillment System — nightly summary', text: lines.join('\n') }); digestSent++; }
      catch(e){ console.error('digest email failed:', e.message); }
    }
    summary.digestSentTo = digestSent;
    summary.digestAttempted = admins.length;
  }catch(e){ summary.digestError = String(e && e.message || e); }

  log(actorEmail, 'nightly.maintenance', summary);
  return summary;
}
route('POST', /^\/api\/admin\/run-nightly-now$/, ['admin'], (req, res, m, body, user) => {
  runNightlyMaintenance(user.email)
    .then(r => send(res, 200, r))
    .catch(e => err(res, 500, 'Nightly run failed: ' + e.message));
});

/* ----- audit ----- */
route('GET', /^\/api\/audit$/, ['admin'], (req, res) => {
  send(res, 200, db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300').all());
});

/* ----- client roster history (monthly archive) ----- */
route('GET', /^\/api\/client-history\/periods$/, ['admin','lead'], (req, res) => {
  const rows = db.prepare('SELECT DISTINCT period FROM client_month_snapshots ORDER BY period DESC').all();
  send(res, 200, rows.map(r => r.period));
});
route('GET', /^\/api\/client-history\/(\d{4}-\d{2})$/, ['admin','lead'], (req, res, m) => {
  const rows = db.prepare('SELECT * FROM client_month_snapshots WHERE period=? ORDER BY name').all(m[1]);
  send(res, 200, rows);
});
route('POST', /^\/api\/client-history\/snapshot-now$/, ['admin'], (req, res, m, body, user) => {
  const result = snapshotClientMonth();
  log(user.email, 'client_history.manual_snapshot', result);
  send(res, 200, { ok: true, ...result });
});

/* ----- client profiles ----- */
route('GET', /^\/api\/clients\/export\.csv$/, ['admin','lead'], (req, res) => {
  const rows = db.prepare(`
    SELECT cl.*,
      (SELECT COUNT(*) FROM contracts co WHERE co.client_id=cl.id AND co.status='active') AS active_contracts,
      co.name AS assigned_coach_name
    FROM clients cl
    LEFT JOIN coaches co ON co.id = cl.assigned_coach_id
    WHERE cl.deleted_at IS NULL
    ORDER BY cl.status='active' DESC, cl.name`).all();
  const activeContracts = db.prepare("SELECT client_id, program, price FROM contracts WHERE status='active'").all();
  const byClient = {};
  for(const c of activeContracts) (byClient[c.client_id] ||= []).push(c);
  const esc = s => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  const header = ['Client','Status','Program(s)','Monthly Revenue','Active Contracts','Assigned Coach','Keap ID'];
  const lines = [header.join(',')];
  for(const r of rows){
    const cs = byClient[r.id] || [];
    const programs = [...new Set(cs.map(c => c.program).filter(Boolean))].join(', ');
    const revenue = cs.reduce((sum, c) => sum + (Number(c.price) || 0), 0);
    lines.push([esc(r.name), esc(r.status), esc(programs), revenue.toFixed(2), r.active_contracts, esc(r.assigned_coach_name||''), esc(r.keap_id||'')].join(','));
  }
  res.writeHead(200, {
    'Content-Type': 'text/csv',
    'Content-Disposition': `attachment; filename="clients-${new Date().toISOString().slice(0,10)}.csv"`,
  });
  res.end(lines.join('\r\n'));
});
route('GET', /^\/api\/clients\/deleted$/, ['admin'], (req, res) => {
  send(res, 200, db.prepare("SELECT id, name, deleted_at FROM clients WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all());
});
route('POST', /^\/api\/clients\/(\d+)\/restore$/, ['admin'], (req, res, m, body, user) => {
  const cl = db.prepare('SELECT * FROM clients WHERE id=?').get(+m[1]);
  if(!cl) return err(res, 404, 'not found');
  if(!cl.deleted_at) return err(res, 400, 'not deleted');
  db.prepare('UPDATE clients SET deleted_at=NULL WHERE id=?').run(cl.id);
  log(user.email, 'client.restore', { clientId: cl.id, name: cl.name });
  send(res, 200, { ok: true });
});
route('GET', /^\/api\/clients$/, ['admin','lead','sales','coach'], (req, res, m, body, user) => {
  const rows = db.prepare(`
    SELECT cl.*,
      (SELECT COUNT(*) FROM contracts co WHERE co.client_id=cl.id AND co.status='active') AS active_contracts,
      co.name AS assigned_coach_name
    FROM clients cl
    LEFT JOIN coaches co ON co.id = cl.assigned_coach_id
    WHERE cl.deleted_at IS NULL
    ORDER BY cl.status='active' DESC, cl.name`).all();
  const activeContracts = db.prepare("SELECT client_id, program, price FROM contracts WHERE status='active'").all();
  const byClient = {};
  for(const c of activeContracts) (byClient[c.client_id] ||= []).push(c);
  for(const r of rows){
    const cs = byClient[r.id] || [];
    r.programs = [...new Set(cs.map(c => c.program).filter(Boolean))].join(', ');
    r.revenue = cs.reduce((sum, c) => sum + (Number(c.price) || 0), 0);
  }
  send(res, 200, rows);
});
route('GET', /^\/api\/clients\/(\d+)$/, ['admin','lead','sales','coach'], (req, res, m) => {
  const cl = db.prepare('SELECT * FROM clients WHERE id=?').get(+m[1]);
  if(!cl) return err(res, 404, 'not found');
  const contracts = db.prepare('SELECT * FROM contracts WHERE client_id=? ORDER BY created DESC').all(cl.id);
  const visits = db.prepare('SELECT * FROM visits WHERE client_id=? ORDER BY due').all(cl.id);
  const year = new Date().getUTCFullYear();
  const visitsThisYear = visits.filter(v => v.due && +v.due.slice(0,4) === year);
  const completedThisYear = visitsThisYear.filter(v => v.completed).length;
  const assignedCoach = cl.assigned_coach_id ? getCoach(cl.assigned_coach_id) : null;
  send(res, 200, {
    client: cl,
    assignedCoach,
    contracts, visits,
    visitProgress: { year, total: visitsThisYear.length, completed: completedThisYear },
  });
});
route('PATCH', /^\/api\/clients\/(\d+)$/, ['admin','lead'], (req, res, m, body, user) => {
  const cl = db.prepare('SELECT * FROM clients WHERE id=?').get(+m[1]);
  if(!cl) return err(res, 404, 'not found');
  if(body.assigned_coach_id !== undefined){
    const coachId = body.assigned_coach_id || null;
    if(coachId && !getCoach(coachId)) return err(res, 400, 'unknown coach');
    db.prepare('UPDATE clients SET assigned_coach_id=? WHERE id=?').run(coachId, cl.id);
    log(user.email, 'client.assign_coach', { clientId: cl.id, name: cl.name, coachId });
  }
  if(body.name !== undefined && String(body.name).trim()){
    db.prepare('UPDATE clients SET name=? WHERE id=?').run(String(body.name).trim(), cl.id);
    log(user.email, 'client.rename', { clientId: cl.id, name: body.name });
  }
  send(res, 200, { ok: true });
});
route('DELETE', /^\/api\/clients\/(\d+)$/, ['admin'], (req, res, m, body, user) => {
  const cl = db.prepare('SELECT * FROM clients WHERE id=?').get(+m[1]);
  if(!cl) return err(res, 404, 'not found');
  // Soft delete — hides the client from every normal listing immediately, but keeps
  // all its data intact for 30 days in case this was a mis-click. A nightly job purges
  // it for real after that window (see purgeOldSoftDeletes). Restore via Admin ->
  // Recently deleted any time before the purge runs.
  db.prepare('UPDATE clients SET deleted_at=? WHERE id=?').run(new Date().toISOString(), cl.id);
  log(user.email, 'client.delete', { clientId: cl.id, name: cl.name, note: 'soft delete — recoverable for 30 days' });
  send(res, 200, { ok: true });
});
route('GET', /^\/api\/clients\/(\d+)\/notes$/, ['admin','lead','sales','coach'], (req, res, m) => {
  send(res, 200, db.prepare(`
    SELECT n.*, v.due AS visit_due, v.program AS visit_program
    FROM client_notes n LEFT JOIN visits v ON v.id = n.visit_id
    WHERE n.client_id=? ORDER BY n.id DESC`).all(+m[1]));
});
const NOTE_TYPES = ['Coaching Call', 'LID'];
route('POST', /^\/api\/clients\/(\d+)\/notes$/, ['admin','lead','sales','coach'], (req, res, m, body, user) => {
  const cl = db.prepare('SELECT * FROM clients WHERE id=?').get(+m[1]);
  if(!cl) return err(res, 404, 'not found');
  const text = String(body.body || '').trim();
  if(!text) return err(res, 400, 'note text required');
  const noteDate = /^\d{4}-\d{2}-\d{2}$/.test(body.note_date || '') ? body.note_date : new Date().toISOString().slice(0,10);
  const noteType = NOTE_TYPES.includes(body.note_type) ? body.note_type : 'Coaching Call';
  const r = db.prepare('INSERT INTO client_notes(client_id,note_date,note_type,author_email,author_name,body,created) VALUES(?,?,?,?,?,?,?)')
    .run(cl.id, noteDate, noteType, user.email, user.name, text, new Date().toISOString());
  log(user.email, 'client.note_add', { clientId: cl.id, name: cl.name, noteDate, noteType });
  send(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
});
route('PATCH', /^\/api\/clients\/(\d+)\/notes\/(\d+)$/, ['admin'], (req, res, m, body, user) => {
  const note = db.prepare('SELECT * FROM client_notes WHERE id=? AND client_id=?').get(+m[2], +m[1]);
  if(!note) return err(res, 404, 'not found');
  const f = {};
  if(body.body !== undefined){ const t = String(body.body).trim(); if(!t) return err(res, 400, 'note text required'); f.body = t; }
  if(body.note_date !== undefined){ if(!/^\d{4}-\d{2}-\d{2}$/.test(body.note_date)) return err(res, 400, 'bad date'); f.note_date = body.note_date; }
  if(body.note_type !== undefined){ if(!NOTE_TYPES.includes(body.note_type)) return err(res, 400, 'bad type'); f.note_type = body.note_type; }
  if(Object.keys(f).length){
    f.edited = new Date().toISOString();
    db.prepare(`UPDATE client_notes SET ${Object.keys(f).map(k=>k+'=?').join(',')} WHERE id=?`)
      .run(...Object.values(f), note.id);
    log(user.email, 'client.note_edit', { clientId: note.client_id, noteId: note.id, ...f });
  }
  send(res, 200, { ok: true });
});
route('DELETE', /^\/api\/clients\/(\d+)\/notes\/(\d+)$/, ['admin'], (req, res, m, body, user) => {
  const note = db.prepare('SELECT * FROM client_notes WHERE id=? AND client_id=?').get(+m[2], +m[1]);
  if(!note) return err(res, 404, 'not found');
  db.prepare('DELETE FROM client_notes WHERE id=?').run(note.id);
  log(user.email, 'client.note_delete', { clientId: note.client_id, noteId: note.id });
  send(res, 200, { ok: true });
});

/* ---------- Keap notes import (preview-then-approve) ----------
 * Keap's /v1/notes endpoint mixes real human coaching notes in with a much
 * larger volume of sales/system noise (webform logs, dedupe entries, "no
 * contact made" call logs) that all carry user_id:0. We treat "a real,
 * non-zero user_id" as the signal for "a person actually typed this" rather
 * than matching on title text, since real coaching content sometimes has a
 * vague/unrelated-looking title. Nothing gets written to client_notes until
 * an admin reviews the exact list and picks which notes to bring in. */
async function fetchKeapNoteCandidates(cl){
  if(!KEAP_TOKEN) return { ok:false, error:'KEAP_TOKEN is not configured on this server.' };
  if(!cl.keap_id) return { ok:false, error:'This client has no linked Keap company id yet.' };
  const already = new Set(db.prepare('SELECT keap_note_id FROM client_notes WHERE keap_note_id IS NOT NULL').all().map(r => r.keap_note_id));
  const all = [];
  let offset = 0;
  const PAGE = 200, MAX_PAGES = 15; // 3000 notes ceiling per client — generous for any single dealer
  for(let page = 0; page < MAX_PAGES; page++){
    const r = await keapGet(`/v1/notes?company_id=${encodeURIComponent(cl.keap_id)}&limit=${PAGE}&offset=${offset}`);
    if(!r.ok) return { ok:false, error: `Keap returned an error (HTTP ${r.status || 'network'}) while fetching notes.` };
    const batch = (r.json && r.json.notes) || [];
    all.push(...batch);
    if(batch.length < PAGE) break;
    offset += PAGE;
  }
  const excluded = [];
  const candidates = [];
  for(const n of all){
    const keapId = String(n.id);
    const isReal = n.user_id && Number(n.user_id) !== 0;
    if(!isReal){ excluded.push({ keap_note_id: keapId, title: n.title || '', reason: 'system/no author (user_id 0)' }); continue; }
    if(already.has(keapId)){ excluded.push({ keap_note_id: keapId, title: n.title || '', reason: 'already imported' }); continue; }
    const when = n.date_created || n.last_updated || '';
    candidates.push({
      keap_note_id: keapId,
      title: n.title || '',
      body: n.body || '',
      author_name: n.user_name || (n.created_by && n.created_by.name) || '',
      note_date: /^\d{4}-\d{2}-\d{2}/.test(when) ? when.slice(0,10) : new Date().toISOString().slice(0,10),
    });
  }
  return { ok:true, candidates, excludedCount: excluded.length, totalFetched: all.length };
}
route('GET', /^\/api\/clients\/(\d+)\/keap-notes-preview$/, ['admin','lead'], async (req, res, m) => {
  const cl = db.prepare('SELECT * FROM clients WHERE id=?').get(+m[1]);
  if(!cl) return err(res, 404, 'not found');
  fetchKeapNoteCandidates(cl).then(r => {
    if(!r.ok) return err(res, 400, r.error);
    send(res, 200, { candidates: r.candidates, excludedCount: r.excludedCount, totalFetched: r.totalFetched });
  }).catch(e => err(res, 500, String(e && e.message || e)));
});
route('POST', /^\/api\/clients\/(\d+)\/keap-notes-import$/, ['admin','lead'], async (req, res, m, body, user) => {
  const cl = db.prepare('SELECT * FROM clients WHERE id=?').get(+m[1]);
  if(!cl) return err(res, 404, 'not found');
  const wantIds = new Set((body.noteIds || []).map(String));
  if(!wantIds.size) return err(res, 400, 'no notes selected');
  fetchKeapNoteCandidates(cl).then(r => {
    if(!r.ok) return err(res, 400, r.error);
    let imported = 0;
    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO client_notes(client_id,note_date,note_type,author_email,author_name,body,created,source,keap_note_id)
      VALUES(?,?,?,?,?,?,?,'keap',?)`);
    for(const c of r.candidates){
      if(!wantIds.has(c.keap_note_id)) continue;
      // keap_note_id has a unique index — a re-import of an already-picked note is a
      // silent no-op here rather than a duplicate row or a thrown error.
      try{ ins.run(cl.id, c.note_date, 'Coaching Call', 'keap-import', c.author_name, c.title ? `${c.title}\n\n${c.body}` : c.body, now, c.keap_note_id); imported++; }
      catch(e){ /* unique constraint — already imported, skip */ }
    }
    log(user.email, 'client.keap_notes_import', { clientId: cl.id, name: cl.name, imported, requested: wantIds.size });
    send(res, 200, { ok:true, imported });
  }).catch(e => err(res, 500, String(e && e.message || e)));
});

/* ================= Keap webhook receiver ================= */
/* Keap Classic verification is handled entirely at the HTTP layer below (the
 * X-Hook-Secret echo) per RESTHooks.org's Immediate Confirmation pattern —
 * nothing here needs to deal with verification anymore. This function only
 * ever sees real subscription events. */
async function handleKeapWebhook(req, res, rawBody){
  let events;
  try{ events = JSON.parse(rawBody || '[]'); }catch(e){ events = []; }
  if(!Array.isArray(events)) events = [events];

  for(const evt of events){
    const eventKey = evt.event_key || evt.eventKey || '';
    const objectId = (evt.object_keys && evt.object_keys[0]) || (evt.objectKeys && evt.objectKeys[0]) || evt.object_key || evt.id || evt.subscription_id || null;

    db.prepare('INSERT INTO keap_events(ts,event_key,object_id,raw) VALUES(?,?,?,?)')
      .run(new Date().toISOString(), eventKey || '(unknown)', String(objectId || ''), JSON.stringify(evt).slice(0, 4000));

    if(eventKey === 'subscription.add' && objectId){
      await onSubscriptionAdd(objectId);
    } else if((eventKey === 'subscription.edit' || eventKey === 'subscription.delete') && objectId){
      await onSubscriptionChange(objectId, eventKey);
    }
    // other event keys (contact.*, order.*, invoice.*) are logged to keap_events but not
    // acted on yet — safe to extend here later.
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

async function onSubscriptionChange(subId, eventKey, opts = {}){
  const source = opts.source || 'keap.webhook';
  const isDelete = eventKey === 'subscription.delete';
  const sub = await keapGet(`/v1/subscriptions/${subId}`);
  // For a delete event, Keap already told us via the event itself — the subscription
  // may legitimately 404 once gone, so we don't need a successful fetch to act on it.
  // For anything else (edit events, or a manual sync poll), a failed fetch — timeout,
  // network blip, non-2xx — must NOT be read as "inactive". Report it and touch nothing.
  if(!isDelete && !sub.ok){
    return { subId, found: false, error: `keap fetch failed (status ${sub.status})` };
  }
  const s = sub.json || {};
  const contract = db.prepare('SELECT * FROM contracts WHERE keap_subscription_id=?').get(String(subId));
  const stillActive = isDelete ? false : !!s.active;

  if(!contract){
    // Might be a subscription that's still in the pending queue (never assigned yet) — ignore/remove it if cancelled.
    if(!stillActive) db.prepare("UPDATE pending_clients SET status='ignored' WHERE keap_subscription_id=?").run(String(subId));
    return { subId, found: false };
  }
  let statusChanged = false, priceChanged = false;
  const newStatus = stillActive ? 'active' : 'cancelled';
  if(contract.status !== newStatus){
    db.prepare('UPDATE contracts SET status=? WHERE id=?').run(newStatus, contract.id);
    log(source, 'contract.status', { contractId: contract.id, subId, status: newStatus });
    statusChanged = true;
  }
  // Only ever overwrite price on a contract we already own via keap_subscription_id —
  // never touches a contract without one (see Keap_App_Source_of_Truth_SOP.md).
  const keapAmount = Number(s.billing_amount) || null;
  if(keapAmount && Number(contract.price) !== keapAmount){
    db.prepare('UPDATE contracts SET price=? WHERE id=?').run(keapAmount, contract.id);
    log(source, 'contract.price', { contractId: contract.id, subId, oldPrice: contract.price, newPrice: keapAmount });
    priceChanged = true;
  }
  // Roll client status up from all their contracts.
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(contract.client_id);
  if(client){
    const anyActive = db.prepare("SELECT COUNT(*) c FROM contracts WHERE client_id=? AND status='active'").get(client.id).c > 0;
    const newClientStatus = anyActive ? 'active' : 'cancelled';
    if(client.status !== newClientStatus){
      db.prepare('UPDATE clients SET status=? WHERE id=?').run(newClientStatus, client.id);
      log(source, 'client.status', { clientId: client.id, name: client.name, status: newClientStatus });
    }
  }
  // Note: we deliberately do NOT auto-delete future scheduled visits on churn — a lead
  // reviews the Inventory screen (now flagged via the client's cancelled status) and
  // removes/reassigns them by hand, so nothing gets silently wiped off the board.
  return { subId, found: true, statusChanged, priceChanged };
}

/* ---------- manual "Sync with Keap" pass ----------
   Admin-triggered refresh of every contract we already own via keap_subscription_id.
   Reuses the exact same single-subscription lookup the webhook handler uses — this
   is a bulk re-run of proven logic, not a new discovery mechanism. It never touches
   a contract that isn't already Keap-linked (that's still the manual identity-link
   review process). Runs contracts sequentially with a small delay to stay well under
   Keap's rate limits. */
async function keapSyncAllLinkedContracts(actorEmail){
  const rows = db.prepare("SELECT keap_subscription_id FROM contracts WHERE keap_subscription_id IS NOT NULL AND keap_subscription_id != ''").all();
  const summary = { checked: 0, statusChanged: 0, priceChanged: 0, notFound: 0, errors: [] };
  if(!KEAP_TOKEN){
    summary.errors.push(`KEAP_TOKEN is not configured on this server — ${rows.length} linked contract(s) were skipped, nothing was synced.`);
    return summary;
  }
  for(const row of rows){
    summary.checked++;
    try{
      const r = await onSubscriptionChange(row.keap_subscription_id, 'subscription.edit', { source: 'keap.manual_sync' });
      if(r.error) summary.errors.push(`sub ${row.keap_subscription_id}: ${r.error}`);
      else if(!r.found) summary.notFound++;
      else{
        if(r.statusChanged) summary.statusChanged++;
        if(r.priceChanged) summary.priceChanged++;
      }
    }catch(e){
      summary.errors.push(`sub ${row.keap_subscription_id}: ${String(e && e.message || e)}`);
    }
    await new Promise(r => setTimeout(r, 150)); // stay well under Keap's rate limit
  }
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(price),0) t FROM contracts WHERE status='active'").get().t;
  const activeClients = db.prepare("SELECT COUNT(*) c FROM clients WHERE status='active'").get().c;
  summary.totalRevenue = totalRevenue;
  summary.activeClients = activeClients;
  log(actorEmail, 'keap.manual_sync', summary);
  return summary;
}

/* ================= server ================= */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if(url.pathname === '/auth/google' && req.method === 'GET'){
    if(!GOOGLE_CLIENT_ID) { res.writeHead(404); res.end('Google SSO is not configured'); return; }
    handleGoogleStart(req, res).catch(e => { console.error(e); res.writeHead(500); res.end('SSO error'); });
    return;
  }
  if(url.pathname === '/auth/google/callback' && req.method === 'GET'){
    if(!GOOGLE_CLIENT_ID) { res.writeHead(404); res.end('Google SSO is not configured'); return; }
    handleGoogleCallback(req, res, url).catch(e => { console.error(e); res.writeHead(500); res.end('SSO error'); });
    return;
  }

  if(url.pathname === '/api/webhooks/keap' && req.method === 'POST'){
    // Keap/RESTHooks.org "Immediate Confirmation" verification: when a hook is
    // (re)created, Keap sends a POST to this URL carrying an X-Hook-Secret header.
    // We must respond 200 and echo that exact header/value back — that's the
    // entire verification handshake. No separate follow-up API call is involved.
    const hookSecret = req.headers['x-hook-secret'];
    if(hookSecret){
      db.prepare('INSERT INTO keap_events(ts,event_key,object_id,raw) VALUES(?,?,?,?)')
        .run(new Date().toISOString(), '(verify-header)', '', JSON.stringify({ hookSecret }).slice(0, 4000));
      res.writeHead(200, { 'X-Hook-Secret': hookSecret, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      req.resume(); // drain body, if any
      return;
    }
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
/* ---------- one-time: Castle store consolidation ---------- */
/* Keap organizes these as 5 separate companies, but fulfillment is 2 clients:
   the 4 Downers Grove brands (Genesis, Hyundai, Mazda, Volkswagen) share one
   monthly visit, and Castle Subaru of Portage gets its own. Decided directly
   with Mike on 2026-08-06; recorded here (and as a note on each client) so
   the "why" survives the next person who looks at Keap and wonders why
   there's no 1:1 match. Guarded by a meta flag — runs once, ever. */
function migrateCastleStores(){
  if(getMeta('castle_stores_migrated')) return;
  const today = new Date().toISOString().slice(0, 10);
  const COACH_ID = 'bryan_bryan_hubert'; // "Bryan's team" — defaulted to the team's namesake coach
  const stores = [
    { name: 'Castle Downers Grove', note: 'Represents Castle Genesis, Castle Hyundai, Castle Mazda, and Castle Volkswagen — all Downers Grove. Keap tracks these as 4 separate companies, but fulfillment is one monthly visit covering all four brands.' },
    { name: 'Castle Subaru of Portage', note: 'Separate Castle store (Portage, not Downers Grove) — its own monthly visit, not part of the Downers Grove consolidation.' },
  ];
  for(const s of stores){
    const clientId = resolveClient(s.name, { billing_start: today });
    db.prepare('UPDATE clients SET assigned_coach_id=? WHERE id=? AND assigned_coach_id IS NULL').run(COACH_ID, clientId);
    const already = db.prepare("SELECT id FROM contracts WHERE client_id=? AND program='Monthly'").get(clientId);
    if(!already) createContractAndVisits({ clientName: s.name, program: 'Monthly', n: 12, first: today, team: 'Bryan', source: 'manual', actorEmail: 'system' });
    db.prepare('INSERT INTO client_notes(client_id,note_date,note_type,author_email,author_name,body,created) VALUES(?,?,?,?,?,?,?)')
      .run(clientId, today, 'LID', 'system', 'System', s.note, new Date().toISOString());
  }
  setMeta('castle_stores_migrated', new Date().toISOString());
  log('system', 'migrate.castle_stores', { stores: stores.map(s => s.name) });
  console.log('Castle store consolidation: created Castle Downers Grove and Castle Subaru of Portage.');
}
migrateCastleStores();

server.listen(PORT, () => console.log(`Coach Fulfillment System running → http://localhost:${PORT}`));

// Re-check daily (in addition to the check db.js already runs at startup) so a new
// calendar month gets captured automatically even if the server just runs for weeks
// without a redeploy. Cheap no-op every day except the first day of a new month.
setInterval(() => { try{ ensureCurrentMonthSnapshot(); }catch(e){ console.error('monthly snapshot check failed:', e); } }, 24 * 60 * 60 * 1000);

// Nightly: Keap sync, revenue snapshot, soft-delete purge, DB backup email, admin digest.
// Anchored to a fixed UTC hour rather than "24h after whenever the process happened to
// boot" — a plain setInterval(24h) can drift for days on a host that redeploys often,
// since it never actually fires unless the process stays up a full 24h stretch. This
// recomputes the next occurrence of NIGHTLY_HOUR_UTC on every server start, so a backup
// runs at roughly the same time daily regardless of how many times the app restarts.
// Each piece is independently try/caught inside runNightlyMaintenance so one failure
// (e.g. Keap unreachable) doesn't skip the backup or the others.
const NIGHTLY_HOUR_UTC = 8; // ~3-4am US Eastern — low traffic
function msUntilNextNightlyRun(){
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NIGHTLY_HOUR_UTC, 0, 0));
  if(next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}
function scheduleNightly(){
  setTimeout(() => {
    runNightlyMaintenance('system.nightly').catch(e => console.error('nightly maintenance failed:', e));
    scheduleNightly();
  }, msUntilNextNightlyRun());
}
scheduleNightly();

// Startup catch-up: if the last successful backup is missing or more than 36 hours old
// (covers a redeploy that happened to land near the scheduled time and pushed it back a
// day), send one immediately instead of silently going up to a full day without a fresh
// backup on record.
(async () => {
  const last = getMeta('last_backup_at');
  const staleMs = 36 * 60 * 60 * 1000;
  if(!last || (Date.now() - new Date(last).getTime()) > staleMs){
    try{
      const r = await takeBackupAndEmail('system.startup_catchup');
      console.log('Startup catch-up backup:', r.ok ? `sent (${Math.round((r.sizeBytes||0)/1024)} KB)` : 'FAILED — ' + (r.error||'see results'));
    }catch(e){ console.error('Startup catch-up backup failed:', e.message); }
  }
})();
