/* Coach Fulfillment System — zero-dependency Node server (Node 22+). */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { db, hashPw, checkPw, getMeta, setMeta, log, resolveClient, normName, findClientByKeapId, createPasswordReset, consumePasswordReset, snapshotClientMonth, ensureCurrentMonthSnapshot, DB_PATH } = require('./db.js');
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
        sessionCookie(String(u.id)),
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
/* Sessions carry an issued-at timestamp and expire after SESSION_IDLE_HOURS of
   inactivity (default 24h) — activity slides the window via a refreshed cookie in
   the dispatcher below. Pre-timestamp cookies (no '|') just force one re-login. */
const SESSION_IDLE_MS = (parseFloat(process.env.SESSION_IDLE_HOURS) || 24) * 60 * 60 * 1000;
const sessionCookie = id => `cfs=${encodeURIComponent(sign(id + '|' + Date.now()))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
function currentUser(req){
  const m = /(?:^|;\s*)cfs=([^;]+)/.exec(req.headers.cookie || '');
  const v = unsign(m && decodeURIComponent(m[1]));
  if(!v) return null;
  const [id, issuedAt] = v.split('|');
  if(!issuedAt) return null; // legacy cookie format — re-login once
  const age = Date.now() - (+issuedAt || 0);
  if(age > SESSION_IDLE_MS) return null;
  const u = db.prepare('SELECT id,email,name,role,team,coach_id,active FROM users WHERE id=?').get(+id);
  if(!u || !u.active) return null;
  u._cookieAge = age;
  return u;
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
  // lead/sales/coach are all scoped to their own single team the same way — this
  // only matters on routes whose own role allowlist admits sales/coach in the first
  // place (currently just the week-block route below), so broadening it here can't
  // widen access to contracts, visit placement, etc. which stay admin/lead-only via
  // their route-level allowlists regardless of what this function returns.
  if(user.role === 'lead' || user.role === 'sales' || user.role === 'coach') return !team || user.team === team;
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
const CYCLE_LEN = { 'Monthly':12, 'Semi-Monthly':6, 'Quarterly':4, 'Bi-Annual':2, 'LID (Purchase)':1, '6 Visits Monthly':6, 'Coaching Only':0 };
const PROGRAM_NAMES = Object.keys(CYCLE_LEN);
/* Mirrors the client-side guessProgram() in app.js — used only to SUGGEST a program
 * label from a Keap subscription's billing_cycle/billing_frequency, never to write
 * it automatically. A resync/relink surfaces this as "Keap suggests X" for a human
 * to accept or ignore; it is deliberately never applied by the webhook path or the
 * bulk "Sync with Keap" sweep, since a wrong guess there would silently mutate every
 * Keap-linked contract's program with no review, not just the one row a person is
 * actually looking at. */
function guessProgramFromCycle(cycle, freq){
  const c = (cycle || '').toUpperCase(); const f = +freq || 1;
  if(c === 'MONTH'){
    if(f >= 6) return 'Bi-Annual';
    if(f === 3) return 'Quarterly';
    if(f === 2) return 'Semi-Monthly';
    return 'Monthly';
  }
  if(c === 'YEAR') return 'Bi-Annual';
  return 'Quarterly';
}
/* first + 90 days, for the "new clients: first visit isn't due until 90 days after
 * the first actual charge" rule. Plain calendar-day math (no month-length quirks
 * to worry about, unlike the visit-spacing-by-month math below). */
function addDays(iso, days){
  const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function createContractAndVisits({ clientName, program, n, first, firstPayDate, team, source, keapSubscriptionId, price, keapCompanyId, actorEmail }){
  const clientId = resolveClient(clientName, { billing_start: first, keap_id: keapCompanyId || '', fromKeap: source === 'keap' });
  const cr = db.prepare(`INSERT INTO contracts(client_id,program,visits,start_date,price,status,source,keap_subscription_id,first_pay_date,created)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(clientId, program, n, first, price ?? null, 'active', source || 'app', keapSubscriptionId || null, firstPayDate || null, new Date().toISOString());
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
    { 'Set-Cookie': sessionCookie(String(u.id)) });
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
    clientHealth: computeHealthMap(),
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
/* New clients: the first visit isn't due until 90 days after the date they were
 * actually first charged. That date has to be entered manually here (Keap doesn't
 * reliably expose a real charge date through this account's API — see keap-diag),
 * so the form collects "First pay date" and this route does the +90 day math itself
 * rather than trusting a client-computed due date. `first` (a due date passed
 * directly, no +90 days applied) still works for callers that already know the
 * exact first visit due date and aren't going through the new-client flow. */
route('POST', /^\/api\/contracts$/, ['admin','lead'], (req, res, m, body, user) => {
  const { client, program, n, first, firstPayDate, team, coachId } = body;
  const isCoachingOnly = program === 'Coaching Only';
  if(!client) return err(res, 400, 'client name required');
  let dueDate = first || null;
  if(!isCoachingOnly && firstPayDate){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(firstPayDate)) return err(res, 400, 'First pay date must be YYYY-MM-DD');
    dueDate = addDays(firstPayDate, 90);
  }
  if(!isCoachingOnly && (!dueDate || !(n > 0))) return err(res, 400, 'client, first pay date and visit count required');
  if(!canEditTeam(user, team)) return err(res, 403, 'You can only add to your own team');
  if(coachId && !getCoach(coachId)) return err(res, 400, 'unknown coach');
  const { clientId, ids } = createContractAndVisits({ clientName: client, program, n: isCoachingOnly ? 0 : n, first: isCoachingOnly ? null : dueDate, firstPayDate: isCoachingOnly ? null : (firstPayDate || null), team: team || user.team, source: 'app', actorEmail: user.email });
  if(coachId) db.prepare('UPDATE clients SET assigned_coach_id=? WHERE id=? AND assigned_coach_id IS NULL').run(coachId, clientId);
  send(res, 200, { ok: true, ids, firstVisitDue: dueDate });
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
  // Moving an open visit to another team can't leave it sitting on the old team's
  // board: if it's scheduled under a coach who isn't on the new team, unschedule it
  // so it surfaces in the NEW team's to-schedule list instead of visually vanishing.
  let unscheduled = false;
  if(f.team && f.team !== v.team && !v.completed && v.cal_coach){
    const c = getCoach(v.cal_coach);
    if(!c || c.team !== f.team){ f.cal_coach = null; f.cal_week = null; unscheduled = true; }
  }
  if(Object.keys(f).length){
    db.prepare(`UPDATE visits SET ${Object.keys(f).map(k=>k+'=?').join(',')} WHERE id=?`)
      .run(...Object.values(f), v.id);
    log(user.email, 'visit.edit', { id: v.id, ...f, unscheduled });
  }
  send(res, 200, { ok: true, unscheduled });
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

/* ----- week blocks -----
 * sales/coach can set/clear open-week labels (Home/Off/Training/etc.) for coaches
 * on their own team — the same team scope lead already had — but this route never
 * touches the visits table, so it can't be used to place or remove a scheduled
 * visit: an occupied week only accepts kind='open', which just clears any stale
 * blocks row underneath it (a no-op when the cell is occupied by a real visit,
 * since occupied cells don't carry a blocks row in the first place). */
route('PUT', /^\/api\/blocks$/, ['admin','lead','sales','coach'], (req, res, m, body, user) => {
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

/* ----- prospect holds (soft pencil launch dates) ----- */
const holdWeeks = h => JSON.parse(h.weeks || '[]');
function removeHoldBlocks(h){
  for(const w of holdWeeks(h)) db.prepare("DELETE FROM blocks WHERE coach_id=? AND week=? AND kind='soft_pencil'").run(h.coach_id, w);
}
function resolveHold(h, status, actorEmail){
  db.prepare('UPDATE prospect_holds SET status=?, resolved=? WHERE id=?').run(status, new Date().toISOString(), h.id);
  removeHoldBlocks(h);
  log(actorEmail, 'hold.' + status, { holdId: h.id, name: h.name, coach: h.coach_id, weeks: holdWeeks(h).length });
}
route('GET', /^\/api\/prospect-holds$/, ['admin','lead','sales'], (req, res) => {
  const rows = db.prepare("SELECT * FROM prospect_holds WHERE status='active' ORDER BY expires").all();
  send(res, 200, rows.map(h => ({ ...h, weeks: holdWeeks(h) })));
});
route('POST', /^\/api\/prospect-holds$/, ['admin','lead'], (req, res, m, body, user) => {
  const name = String(body.name || '').trim();
  if(!name) return err(res, 400, 'prospect name required');
  const c = getCoach(body.coachId); if(!c || !c.active) return err(res, 400, 'unknown coach');
  if(!canEditTeam(user, c.team)) return err(res, 403, 'Not your team');
  const weeks = [...new Set((body.weeks || []).filter(w => /^\d{4}-\d{2}-\d{2}$/.test(w)).map(snapMonday))].sort();
  if(!weeks.length) return err(res, 400, 'at least one week required');
  const taken = weeks.filter(w => !cellFree(c.id, w));
  if(taken.length) return err(res, 409, `No longer open: ${taken.join(', ')} — re-run availability and try again`);
  const program = String(body.program || 'Quarterly');
  const lastWeek = weeks[weeks.length - 1];
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(body.expires || '') ? body.expires
    : new Date(new Date(lastWeek + 'T12:00:00').getTime() + 30*24*60*60*1000).toISOString().slice(0,10);
  const r = db.prepare(`INSERT INTO prospect_holds(name,coach_id,program,weeks,created_by,created,expires) VALUES(?,?,?,?,?,?,?)`)
    .run(name, c.id, program, JSON.stringify(weeks), user.email, new Date().toISOString(), expires);
  for(const w of weeks){
    db.prepare(`INSERT INTO blocks(coach_id,week,kind,label) VALUES(?,?,'soft_pencil',?)
      ON CONFLICT(coach_id,week) DO UPDATE SET kind='soft_pencil', label=excluded.label`).run(c.id, w, name);
  }
  log(user.email, 'hold.place', { holdId: Number(r.lastInsertRowid), name, coach: c.id, weeks });
  send(res, 200, { ok: true, id: Number(r.lastInsertRowid), weeks, expires });
});
route('POST', /^\/api\/prospect-holds\/(\d+)\/release$/, ['admin','lead'], (req, res, m, body, user) => {
  const h = db.prepare("SELECT * FROM prospect_holds WHERE id=? AND status='active'").get(+m[1]);
  if(!h) return err(res, 404, 'not found or already resolved');
  const c = getCoach(h.coach_id);
  if(c && !canEditTeam(user, c.team)) return err(res, 403, 'Not your team');
  resolveHold(h, 'released', user.email);
  send(res, 200, { ok: true });
});
/* Convert = the deal signed. Frees the calendar weeks and hands everything the
   frontend needs to open the normal New Contract form pre-filled. The contract
   itself is still created through the same route as every other client, so
   Keap linking/reconciliation works identically — a converted hold leaves no
   special residue anywhere. */
route('POST', /^\/api\/prospect-holds\/(\d+)\/convert$/, ['admin','lead'], (req, res, m, body, user) => {
  const h = db.prepare("SELECT * FROM prospect_holds WHERE id=? AND status='active'").get(+m[1]);
  if(!h) return err(res, 404, 'not found or already resolved');
  const c = getCoach(h.coach_id);
  if(c && !canEditTeam(user, c.team)) return err(res, 403, 'Not your team');
  resolveHold(h, 'converted', user.email);
  send(res, 200, { ok: true, name: h.name, program: h.program, weeks: holdWeeks(h), coachId: h.coach_id, team: c ? c.team : null });
});
/* Nightly upkeep: auto-release holds whose expiry has passed (the deal went quiet),
   and surface soon-to-expire ones in the digest so a hold never silently rots. */
function sweepProspectHolds(){
  const today = new Date().toISOString().slice(0,10);
  const soon = new Date(Date.now() + 7*24*60*60*1000).toISOString().slice(0,10);
  const expired = db.prepare("SELECT * FROM prospect_holds WHERE status='active' AND expires IS NOT NULL AND expires < ?").all(today);
  for(const h of expired) resolveHold(h, 'expired', 'system.nightly');
  const expiring = db.prepare("SELECT * FROM prospect_holds WHERE status='active' AND expires IS NOT NULL AND expires <= ?").all(soon);
  return { expired: expired.map(h => h.name), expiring: expiring.map(h => `${h.name} (${h.expires})`) };
}

/* ----- Today: the role-aware action queue the dashboard is built from -----
   One place that answers "what needs a person right now", computed fresh from
   the DB on every load. Ordering inside each list is worst-first. */
route('GET', /^\/api\/today$/, ['admin','lead','sales','coach'], (req, res, m, body, user) => {
  const today = new Date().toISOString().slice(0,10);
  const plus30 = new Date(Date.now()+30*24*60*60*1000).toISOString().slice(0,10);
  const plus14 = new Date(Date.now()+14*24*60*60*1000).toISOString().slice(0,10);
  const cut60 = new Date(Date.now()-60*24*60*60*1000).toISOString().slice(0,10);
  const cut30 = new Date(Date.now()-30*24*60*60*1000).toISOString().slice(0,10);

  if(user.role === 'coach'){
    const mine = `(v.cal_coach=? OR EXISTS(SELECT 1 FROM clients cl WHERE cl.id=v.client_id AND cl.assigned_coach_id=?))`;
    const nextVisit = db.prepare(`SELECT v.id, v.client, v.client_id, v.program, v.cycle, v.due, v.cal_week
      FROM visits v WHERE v.completed=0 AND v.cal_coach=? AND v.cal_week>=? ORDER BY v.cal_week LIMIT 1`).get(user.coach_id, today);
    const overdueMine = db.prepare(`SELECT v.id, v.client, v.client_id, v.program, v.cycle, v.due, v.cal_week
      FROM visits v WHERE v.completed=0 AND v.due<? AND ${mine} ORDER BY v.due LIMIT 20`).all(today, user.coach_id, user.coach_id);
    const dueSoonMine = db.prepare(`SELECT v.id, v.client, v.client_id, v.program, v.cycle, v.due, v.cal_week
      FROM visits v WHERE v.completed=0 AND v.due>=? AND v.due<=? AND ${mine} ORDER BY v.due LIMIT 20`).all(today, plus30, user.coach_id, user.coach_id);
    const missingNotes = db.prepare(`SELECT v.id, v.client, v.client_id, v.completed_on
      FROM visits v WHERE v.completed=1 AND v.completed_by_coach_id=? AND COALESCE(v.completed_on, v.due)>=?
      AND v.id NOT IN (SELECT visit_id FROM client_notes WHERE visit_id IS NOT NULL) ORDER BY v.completed_on DESC LIMIT 20`).all(user.coach_id, cut30);
    return send(res, 200, { role:'coach', nextVisit: nextVisit||null, overdueMine, dueSoonMine, missingNotes });
  }

  const teamFilter = user.role === 'lead' ? user.team : null;
  const tf = teamFilter ? ` AND v.team=?` : '';
  const tArgs = teamFilter ? [teamFilter] : [];
  // Overdue with NO plan — the actual fires. Late-but-scheduled is a separate, calmer list.
  const overdueNoPlan = db.prepare(`SELECT v.id, v.client, v.client_id, v.team, v.program, v.cycle, v.due
    FROM visits v WHERE v.completed=0 AND v.cal_week IS NULL AND v.due<?${tf} ORDER BY v.due LIMIT 100`).all(today, ...tArgs);
  const lateOnCalendar = db.prepare(`SELECT COUNT(*) c FROM visits v WHERE v.completed=0 AND v.cal_week IS NOT NULL AND v.due<?${tf}`).get(today, ...tArgs).c;
  const dueSoonUnscheduled = db.prepare(`SELECT v.id, v.client, v.client_id, v.team, v.program, v.cycle, v.due
    FROM visits v WHERE v.completed=0 AND v.cal_week IS NULL AND v.due>=? AND v.due<=?${tf} ORDER BY v.due LIMIT 100`).all(today, plus30, ...tArgs);
  // At-risk: active paying visit-clients with nothing recent and nothing planned.
  let atRisk = db.prepare(`SELECT cl.id, cl.name, cl.assigned_coach_id
    FROM clients cl WHERE cl.status='active' AND cl.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM contracts k WHERE k.client_id=cl.id AND k.status='active' AND k.program!='Coaching Only')
    AND NOT EXISTS(SELECT 1 FROM visits v WHERE v.client_id=cl.id AND v.completed=1 AND COALESCE(v.completed_on, v.due)>=?)
    AND NOT EXISTS(SELECT 1 FROM visits v WHERE v.client_id=cl.id AND v.completed=0 AND v.cal_week IS NOT NULL)
    ORDER BY cl.name LIMIT 50`).all(cut60);
  if(teamFilter){
    const teamCoachIds = new Set(db.prepare('SELECT id FROM coaches WHERE team=?').all(teamFilter).map(r=>r.id));
    atRisk = atRisk.filter(c => c.assigned_coach_id && teamCoachIds.has(c.assigned_coach_id));
  }
  const missingNotes = db.prepare(`SELECT v.id, v.client, v.client_id, v.completed_on, v.completed_by_coach_id
    FROM visits v WHERE v.completed=1 AND v.completed_by_coach_id IS NOT NULL AND COALESCE(v.completed_on, v.due)>=?${tf}
    AND v.id NOT IN (SELECT visit_id FROM client_notes WHERE visit_id IS NOT NULL) ORDER BY v.completed_on DESC LIMIT 50`).all(cut30, ...tArgs);
  const holdsExpiring = db.prepare(`SELECT id, name, coach_id, expires FROM prospect_holds
    WHERE status='active' AND expires IS NOT NULL AND expires<=? ORDER BY expires LIMIT 20`).all(plus14)
    .filter(h => { if(!teamFilter) return true; const c = getCoach(h.coach_id); return c && c.team === teamFilter; });
  const pendingCount = db.prepare("SELECT COUNT(*) c FROM pending_clients WHERE status='pending'").get().c;
  const completedThisMonth = db.prepare(`SELECT COUNT(*) c FROM visits v WHERE v.completed=1 AND COALESCE(v.completed_on,v.due) LIKE ?${tf}`)
    .get(today.slice(0,7)+'%', ...tArgs).c;
  send(res, 200, { role: user.role, team: teamFilter, overdueNoPlan, lateOnCalendar, dueSoonUnscheduled, atRisk, missingNotes, holdsExpiring, pendingCount, completedThisMonth });
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
  let dest = null;
  if(toId){
    dest = getCoach(toId);
    if(!dest) return err(res, 400, 'reassignment target coach not found');
    if(!canEditTeam(user, dest.team)) return err(res, 403, 'Reassignment target is not on your team');
  }
  const storesMoved = db.prepare('SELECT COUNT(*) n FROM clients WHERE assigned_coach_id=?').get(c.id).n;
  db.prepare('UPDATE clients SET assigned_coach_id=? WHERE assigned_coach_id=?').run(toId, c.id);
  // Every visit currently on this coach's calendar (cal_coach set implies cal_week set —
  // this never touches unscheduled work, that's tracked via clients.assigned_coach_id
  // above, not here). Reassigning blindly onto the new coach's calendar without checking
  // for a conflict would silently double-book them if they already have something that
  // week — same cellFree check used for a single-client coach reassignment, applied here
  // too so both paths behave identically.
  const cascade = { keptWeek: 0, needsReplacing: 0, unscheduled: 0 };
  const openVisits = db.prepare('SELECT * FROM visits WHERE cal_coach=? AND completed=0').all(c.id);
  for(const v of openVisits){
    if(dest && cellFree(dest.id, v.cal_week, v.id)){
      db.prepare('UPDATE visits SET cal_coach=?, team=? WHERE id=?').run(dest.id, dest.team, v.id);
      cascade.keptWeek++;
    } else if(dest){
      db.prepare('UPDATE visits SET cal_coach=NULL, cal_week=NULL, team=? WHERE id=?').run(dest.team, v.id);
      cascade.needsReplacing++;
    } else {
      db.prepare('UPDATE visits SET cal_coach=NULL, cal_week=NULL WHERE id=?').run(v.id);
      cascade.unscheduled++;
    }
  }
  db.prepare('UPDATE coaches SET active=0 WHERE id=?').run(c.id);
  log(user.email, 'coach.remove', { id: c.id, name: c.name, storesMoved, reassignedTo: toId || null, ...cascade });
  send(res, 200, { ok: true, storesMoved, cascade });
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
/* Rename a team everywhere at once. Team names are plain strings on coaches,
   visits, and users (there's no team id), so a rename has to cascade through all
   three plus the meta list in one transaction — a partial rename would strand
   coaches on a team that no longer exists in the list. */
route('PATCH', /^\/api\/teams\/rename$/, ['admin'], (req, res, m, body, user) => {
  const from = String(body.from || '').trim();
  const to = String(body.to || '').trim();
  const teams = JSON.parse(getMeta('teams') || '[]');
  if(!teams.includes(from)) return err(res, 404, 'no such team');
  if(!to) return err(res, 400, 'new name required');
  if(teams.includes(to)) return err(res, 400, `"${to}" already exists — to merge two teams, move the coaches over and delete the empty one instead`);
  db.exec('BEGIN');
  try{
    const nCoaches = db.prepare('UPDATE coaches SET team=? WHERE team=?').run(to, from).changes;
    const nVisits = db.prepare('UPDATE visits SET team=? WHERE team=?').run(to, from).changes;
    const nUsers = db.prepare('UPDATE users SET team=? WHERE team=?').run(to, from).changes;
    setMeta('teams', JSON.stringify(teams.map(t => t === from ? to : t)));
    db.exec('COMMIT');
    log(user.email, 'team.rename', { from, to, nCoaches, nVisits, nUsers });
    send(res, 200, { ok: true, nCoaches, nVisits, nUsers });
  }catch(e){ db.exec('ROLLBACK'); err(res, 500, 'Rename failed: ' + e.message); }
});
/* Delete only ever allowed on an empty team — no coaches (active or former), no
   users, no open visits. History on completed visits keeps the old team string,
   which is correct: that's what the team was called when the work happened. */
route('DELETE', /^\/api\/teams\/([^/]+)$/, ['admin'], (req, res, m, body, user) => {
  const t = decodeURIComponent(m[1]);
  const teams = JSON.parse(getMeta('teams') || '[]');
  if(!teams.includes(t)) return err(res, 404, 'no such team');
  const blockers = [];
  const nCoaches = db.prepare('SELECT COUNT(*) c FROM coaches WHERE team=? AND active=1').get(t).c;
  const nUsers = db.prepare('SELECT COUNT(*) c FROM users WHERE team=? AND active=1').get(t).c;
  const nOpen = db.prepare('SELECT COUNT(*) c FROM visits WHERE team=? AND completed=0').get(t).c;
  if(nCoaches) blockers.push(`${nCoaches} active coach(es)`);
  if(nUsers) blockers.push(`${nUsers} active user(s)`);
  if(nOpen) blockers.push(`${nOpen} open visit(s)`);
  if(blockers.length) return err(res, 409, `Can't delete "${t}" — it still has ${blockers.join(', ')}. Move or deactivate them first.`);
  setMeta('teams', JSON.stringify(teams.filter(x => x !== t)));
  log(user.email, 'team.delete', t);
  send(res, 200, { ok: true });
});

/* ----- users (admin) ----- */
route('POST', /^\/api\/users$/, ['admin'], (req, res, m, body, user) => {
  const { email, name, role, team, coach_id, password } = body;
  if(!email || !name || !role) return err(res, 400, 'email, name, role required');
  if(!/^\S+@\S+\.\S+$/.test(String(email))) return err(res, 400, 'bad email');
  // Password is optional: leave it blank to create a Google-sign-in-only account.
  // The stored sentinel can never match checkPw's salt:hash format, so password
  // login is structurally impossible for these accounts until an admin sets one.
  const pw = password ? hashPw(String(password)) : 'sso-only';
  try{
    db.prepare('INSERT INTO users(email,name,pw,role,team,coach_id) VALUES(?,?,?,?,?,?)')
      .run(email.toLowerCase().trim(), name.trim(), pw, role, team || null, coach_id || null);
  }catch(e){ return err(res, 400, 'email already exists'); }
  log(user.email, 'user.add', { email, role, team, ssoOnly: !password });
  send(res, 200, { ok: true, ssoOnly: !password });
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
/* Fuzzy-match a new Keap subscription against active prospect holds: if sales
   soft-penciled "Acme Motors — Launch" and Keap now fires a subscription for
   "Acme Motors of Dallas", the Unassigned Clients row should say so, and offer
   to convert the hold instead of making someone connect the dots by memory.
   Token-overlap on normalized names: every meaningful word of the shorter name
   appearing in the longer one counts as a match. */
function matchHoldForName(name){
  const target = normName(name);
  if(!target) return null;
  const targetTokens = new Set(target.split(' ').filter(t => t.length > 1));
  const holds = db.prepare("SELECT * FROM prospect_holds WHERE status='active'").all();
  let best = null;
  for(const h of holds){
    // Strip decoration like "— Launch" that sales adds to labels
    const hn = normName(h.name.replace(/\b(launch|hold|prospect)\b/gi, ''));
    if(!hn) continue;
    const holdTokens = hn.split(' ').filter(t => t.length > 1);
    if(!holdTokens.length || !targetTokens.size) continue;
    const smaller = holdTokens.length <= targetTokens.size ? holdTokens : [...targetTokens];
    const larger = new Set(holdTokens.length <= targetTokens.size ? [...targetTokens] : holdTokens);
    const hits = smaller.filter(t => larger.has(t)).length;
    const score = hits / smaller.length;
    if(score >= 0.6 && (!best || score > best.score)) best = { score, hold: h };
  }
  if(!best) return null;
  const c = getCoach(best.hold.coach_id);
  return { id: best.hold.id, name: best.hold.name, program: best.hold.program, weeks: holdWeeks(best.hold),
    coachId: best.hold.coach_id, coachName: c ? c.name : best.hold.coach_id, team: c ? c.team : null };
}
route('GET', /^\/api\/pending-clients$/, ['admin','lead'], (req, res, m, body, user) => {
  const rows = db.prepare("SELECT * FROM pending_clients WHERE status='pending' ORDER BY created DESC").all();
  send(res, 200, rows.map(r => ({ ...r, hold_match: matchHoldForName(r.company_name || r.contact_name || '') })));
});
/* Diagnostic for "(unknown)" rows — re-fetches this pending item's subscription and
 * contact straight from Keap right now and returns the raw JSON, so a field-name
 * mismatch (Keap nesting company info somewhere other than where the app expects)
 * can be seen and fixed precisely instead of guessed at again. */
/* Diagnostic for "everything is 404ing" — hits a handful of known-shape Keap
 * endpoints directly with the configured token so we can see, side by side,
 * which paths this account's Keap API actually answers to right now, rather
 * than guessing whether it's the token, the base URL, or the resource path. */
route('GET', /^\/api\/admin\/keap-diag$/, ['admin'], async (req, res) => {
  if(!KEAP_TOKEN) return err(res, 400, 'KEAP_TOKEN is not configured on this server.');
  // Summarize rather than return raw bodies — a "list" response can be megabytes if an
  // unrecognized query param gets silently ignored and Keap falls back to its full
  // default page, which is itself useful signal but must never be dumped whole.
  const summarize = j => {
    if(j == null) return null;
    if(Array.isArray(j)) return { _shape: 'array', length: j.length, sample: j[0] };
    if(typeof j === 'object'){
      const out = {};
      for(const k of Object.keys(j)){
        const v = j[k];
        if(Array.isArray(v)) out[k] = { _shape: 'array', length: v.length, sample: v[0] };
        else out[k] = v;
      }
      return out;
    }
    return j;
  };
  const checks = [
    ['account profile (sanity check token+base)', '/v1/account/profile'],
    ['contacts list', '/v1/contacts?limit=1'],
    ['subscriptions list (no id)', '/v1/subscriptions?limit=1'],
    ['subscriptions list (page params as used by Backfill)', '/v1/subscriptions?limit=1&offset=0'],
  ];
  const out = { keapBase: KEAP_BASE, results: [] };
  for(const [label, path] of checks){
    const r = await keapGet(path);
    out.results.push({ label, path, ok: r.ok, status: r.status, json: summarize(r.json) });
  }
  // The critical test: does GET-by-ID work at all for a subscription we can PROVE
  // exists (the first row returned by the list call above)? If the list works but
  // this 404s, the "get one subscription by id" endpoint itself is the broken path —
  // not any particular ID being stale/deleted.
  const listResult = out.results.find(r => r.label.startsWith('subscriptions list (no id)'));
  const knownId = listResult && listResult.json && listResult.json.subscriptions && listResult.json.subscriptions.sample && listResult.json.subscriptions.sample.id;
  if(knownId != null){
    // Keap's own "next"/"previous" pagination links above are shaped
    // ".../v1/subscriptions/?limit=1&offset=1" — note the trailing slash before the
    // query string. Try a handful of URL-shape variants for the single-item fetch in
    // case the item route needs something the collection route tolerates either way.
    const variants = [
      `/v1/subscriptions/${knownId}`,
      `/v1/subscriptions/${knownId}/`,
      `/v1/subscriptions?id=${knownId}`,
      `/v1/subscriptions/?id=${knownId}`,
    ];
    for(const path of variants){
      const r = await keapGet(path);
      out.results.push({ label: `single subscription fetch, KNOWN-GOOD id ${knownId}`, path, ok: r.ok, status: r.status, json: summarize(r.json) });
    }
  }
  // Product lookup is the other single-item-by-id call the coaching-subscription
  // filter depends on (keapGetProductName) — check it the same way: list to prove a
  // real id exists, then try fetching that exact id.
  const productsList = await keapGet('/v1/products?limit=1');
  out.results.push({ label: 'products list', path: '/v1/products?limit=1', ok: productsList.ok, status: productsList.status, json: summarize(productsList.json) });
  const knownProductId = productsList.ok && productsList.json && (productsList.json.products || productsList.json.result_set) && (productsList.json.products || productsList.json.result_set)[0] && (productsList.json.products || productsList.json.result_set)[0].id;
  if(knownProductId != null){
    const r = await keapGet(`/v1/products/${knownProductId}`);
    out.results.push({ label: `single product fetch, KNOWN-GOOD id ${knownProductId}`, path: `/v1/products/${knownProductId}`, ok: r.ok, status: r.status, json: summarize(r.json) });
  }
  // And contact-by-id, since keap-raw / queueSubscriptionAsPending both fetch a
  // specific contact by id too — worth confirming that one's genuinely fine (it
  // returned a real "Unable to find this Contact" message earlier, unlike
  // subscriptions' blank SPA-fallback 404, which is a good sign it's a real route).
  const contactsList = out.results.find(r => r.label === 'contacts list');
  const knownContactId = contactsList && contactsList.json && contactsList.json.contacts && contactsList.json.contacts.sample && contactsList.json.contacts.sample.id;
  if(knownContactId != null){
    const r = await keapGet(`/v1/contacts/${knownContactId}?optional_properties=company`);
    out.results.push({ label: `single contact fetch, KNOWN-GOOD id ${knownContactId}`, path: `/v1/contacts/${knownContactId}`, ok: r.ok, status: r.status, json: summarize(r.json) });
  }
  // End-to-end check against the exact real case in question: resolve subscription
  // 7202 (Steven Kia) through the list-based lookup, resolve its product name the
  // same way, and show exactly what program the resync flow would now suggest.
  const testSubId = new URL(req.url, 'http://x').searchParams.get('testSubId');
  if(testSubId){
    const sub = await keapFindSubscriptionById(testSubId, { force: true });
    if(sub.ok){
      const suggestion = await suggestProgramForSubscription(sub.json);
      out.testSubscription = { subId: testSubId, billing_cycle: sub.json.billing_cycle, billing_frequency: sub.json.billing_frequency, product_id: sub.json.product_id, productName: await keapGetProductName(sub.json), suggestion };
    } else {
      out.testSubscription = { subId: testSubId, error: sub.error || sub.status };
    }
  }
  // Investigating "first pay date" for the 90-day due-date rule: does Keap expose
  // actual order/payment history via list endpoints (already proven reliable for
  // subscriptions/products/contacts), and if so what do the date fields look like?
  // Nothing downstream depends on this yet — this is purely to observe real shapes
  // against a known contact before writing any code that assumes a field name.
  const ordersList = await keapGet('/v1/orders?limit=1');
  out.results.push({ label: 'orders list (no filter)', path: '/v1/orders?limit=1', ok: ordersList.ok, status: ordersList.status, json: summarize(ordersList.json) });
  const txList = await keapGet('/v1/transactions?limit=1');
  out.results.push({ label: 'transactions list (no filter)', path: '/v1/transactions?limit=1', ok: txList.ok, status: txList.status, json: summarize(txList.json) });
  const testContactId = new URL(req.url, 'http://x').searchParams.get('testContactId');
  if(testContactId){
    const ordersForContact = await keapGet(`/v1/orders?contact_id=${encodeURIComponent(testContactId)}&limit=50`);
    out.testContactOrders = { contactId: testContactId, path: `/v1/orders?contact_id=${testContactId}&limit=50`, ok: ordersForContact.ok, status: ordersForContact.status, json: summarize(ordersForContact.json) };
    const txForContact = await keapGet(`/v1/transactions?contact_id=${encodeURIComponent(testContactId)}&limit=50`);
    out.testContactTransactions = { contactId: testContactId, path: `/v1/transactions?contact_id=${testContactId}&limit=50`, ok: txForContact.ok, status: txForContact.status, json: summarize(txForContact.json) };
  }
  send(res, 200, out);
});
/* Company billing lookup — everything Keap knows about one company's money, keyed by
 * company id (clients.keap_id). Built for the Tinney case: a cancelled dealership that
 * was never Keap-linked, where before we can decide what "coverage end / last-bill
 * date" should be we need to SEE the real subscription and its actual date fields —
 * and, because a cancelled subscription can drop out of the /v1/subscriptions list
 * entirely, also its orders/transactions (where the real last charge date lives).
 * Read-only; never writes. Returns raw Keap objects so exact field names are visible.
 * Query: ?keapId=<company id> and/or ?contactId=<contact id> (at least one). */
route('GET', /^\/api\/admin\/keap\/company-billing$/, ['admin'], async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const keapId = String(q.get('keapId') || '').trim();
  const contactIdParam = String(q.get('contactId') || '').trim();
  if(!keapId && !contactIdParam) return err(res, 400, 'keapId (company id) or contactId required');
  if(!KEAP_TOKEN) return err(res, 400, 'KEAP_TOKEN is not configured on this server.');
  const out = { keapId: keapId || null, contactId: contactIdParam || null, subscriptions: {}, contacts: {}, orders: {}, transactions: {} };

  // 1) Subscriptions: the list endpoint is the only one that works for this account
  //    (see keapFindSubscriptionById note). Filter by company id on the sub, or by contact.
  const listing = await keapListAllSubscriptions();
  if(!listing.ok){ out.subscriptions.error = listing.error; }
  else{
    out.subscriptions.totalListed = listing.subs.length;
    out.subscriptions.sampleKeys = listing.subs[0] ? Object.keys(listing.subs[0]) : [];
    const matches = listing.subs.filter(s =>
      (keapId && String(s.contact_id_company) === keapId) ||
      (contactIdParam && String(s.contact_id) === contactIdParam));
    out.subscriptions.matchCount = matches.length;
    out.subscriptions.matches = matches; // full raw objects — inspect for end/next-bill/paid-thru dates
  }

  // 2) Resolve this company's contacts (a cancelled sub may be gone from the list above,
  //    so we still want a contact id to reach orders/transactions).
  let contactIds = contactIdParam ? [contactIdParam] : [];
  if(keapId){
    const c = await keapGet(`/v1/contacts?company_id=${encodeURIComponent(keapId)}&limit=50`);
    const list = (c.json && (c.json.contacts || c.json.results)) || [];
    out.contacts = { ok: c.ok, status: c.status, ids: list.map(x => x.id) };
    if(!contactIds.length) contactIds = list.map(x => String(x.id));
  }

  // 3) Orders + transactions per contact — where a real charge/last-bill date lives.
  out.orders.byContact = {}; out.transactions.byContact = {};
  for(const cid of contactIds.slice(0, 5)){
    const o = await keapGet(`/v1/orders?contact_id=${encodeURIComponent(cid)}&limit=50`);
    out.orders.byContact[cid] = { ok: o.ok, status: o.status, data: (o.json && (o.json.orders || o.json.results)) || o.json };
    const t = await keapGet(`/v1/transactions?contact_id=${encodeURIComponent(cid)}&limit=50`);
    out.transactions.byContact[cid] = { ok: t.ok, status: t.status, data: (t.json && (t.json.transactions || t.json.results)) || t.json };
  }
  send(res, 200, out);
});
route('GET', /^\/api\/admin\/pending-clients\/(\d+)\/keap-raw$/, ['admin'], async (req, res, m) => {
  const pc = db.prepare('SELECT * FROM pending_clients WHERE id=?').get(+m[1]);
  if(!pc) return err(res, 404, 'not found');
  if(!KEAP_TOKEN) return err(res, 400, 'KEAP_TOKEN is not configured on this server.');
  const out = { pendingClient: pc };
  if(pc.keap_subscription_id){
    const sub = await keapFindSubscriptionById(pc.keap_subscription_id, { force: true });
    out.subscription = { ok: sub.ok, status: sub.status, json: sub.json, error: sub.error };
  }
  if(pc.keap_contact_id){
    const c = await keapGet(`/v1/contacts/${pc.keap_contact_id}?optional_properties=company`);
    out.contact = { ok: c.ok, status: c.status, json: c.json };
  }
  send(res, 200, out);
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
/* Hard-delete ONE pending row outright — distinct from Ignore (which is a permanent
 * "we looked at this, skip it" decision, kept as status='ignored' forever so the
 * unique constraint on keap_subscription_id blocks it from resurfacing).
 * This is for the opposite case: a row whose stored keap_subscription_id/keap_contact_id
 * are stale/corrupt (e.g. captured under an old bug, or the underlying Keap record was
 * since deleted/merged) and 404 when re-fetched — deleting it lets a corrected Backfill
 * cleanly re-create it fresh under the real current Keap IDs instead of being permanently
 * blocked by a row that can never resolve. */
route('POST', /^\/api\/admin\/pending-clients\/(\d+)\/delete$/, ['admin'], (req, res, m, body, user) => {
  const pc = db.prepare('SELECT * FROM pending_clients WHERE id=?').get(+m[1]);
  if(!pc) return err(res, 404, 'not found');
  db.prepare('DELETE FROM pending_clients WHERE id=?').run(pc.id);
  log(user.email, 'pendingclient.delete_stale', { pendingId: pc.id, company: pc.company_name, keapSubscriptionId: pc.keap_subscription_id, keapContactId: pc.keap_contact_id });
  send(res, 200, { ok: true });
});
route('POST', /^\/api\/pending-clients\/ignore-all$/, ['admin','lead'], (req, res, m, body, user) => {
  // Bulk clear, not a bulk "soft ignore" — this DELETES the pending rows rather than
  // flipping status to 'ignored'. That distinction matters: a single Ignore click is a
  // human decision about one real subscription that should never resurface, so it stays
  // as a permanent 'ignored' row the unique constraint respects forever. Ignore All exists
  // for the opposite situation — clearing out a batch that never should have been queued
  // in the first place (e.g. a Backfill run from before the product filter existed) — and
  // deleting those rows outright means a corrected Backfill can cleanly re-queue anything
  // that's actually legitimate afterward instead of having it permanently blocked.
  const r = db.prepare("DELETE FROM pending_clients WHERE status='pending'").run();
  log(user.email, 'pendingclient.ignore_all', { count: r.changes });
  send(res, 200, { ok: true, count: r.changes });
});
route('POST', /^\/api\/keap\/sync$/, ['admin'], (req, res, m, body, user) => {
  keapSyncAllLinkedContracts(user.email)
    .then(summary => send(res, 200, { ok: true, ...summary }))
    .catch(e => { console.error('keap sync failed:', e); err(res, 500, 'Sync failed: ' + String(e && e.message || e)); });
});
/* Per-contract version of the button above, from a client's own profile — same
 * underlying check (re-fetch the linked subscription, update price/status if it's
 * drifted), just scoped to one contract instead of sweeping every Keap-linked
 * contract in the system. */
route('POST', /^\/api\/contracts\/(\d+)\/keap-resync$/, ['admin'], async (req, res, m, body, user) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(+m[1]);
  if(!contract) return err(res, 404, 'not found');
  if(!contract.keap_subscription_id) return err(res, 400, `This contract isn't linked to Keap yet — use "Link to Keap" to attach a subscription ID first.`);
  try{
    const r = await onSubscriptionChange(contract.keap_subscription_id, 'subscription.edit', { source: 'manual_resync' });
    if(r.error) return err(res, 502, `Keap lookup failed: ${r.error}`);
    log(user.email, 'contract.keap_resync', { contractId: contract.id, subId: contract.keap_subscription_id, statusChanged: !!r.statusChanged, priceChanged: !!r.priceChanged });
    // Program/cadence is never auto-corrected — just surfaced as a suggestion, and
    // the product name (e.g. "...and Quarterly Live-in-Drive") is checked first
    // since that's the real cadence; billing_cycle/frequency reflects how the
    // subscription is BILLED, which can differ from how often it's actually visited.
    const sub = await keapFindSubscriptionById(contract.keap_subscription_id);
    let programSuggestion = null;
    if(sub.ok && sub.json){
      const suggestion = await suggestProgramForSubscription(sub.json);
      if(suggestion.guessed !== contract.program) programSuggestion = { guessed: suggestion.guessed, current: contract.program, basis: suggestion.basis };
    }
    send(res, 200, { ok: true, ...r, programSuggestion });
  }catch(e){ err(res, 500, String(e && e.message || e)); }
});
/* Re-point a contract at a different Keap subscription ID — for when the link
 * itself is wrong, not just stale. Validates the new ID is real (via the same
 * list-based lookup everything else uses — see keapFindSubscriptionById) and isn't
 * already claimed by another contract before touching anything, then relinks and
 * immediately resyncs price/status from the corrected subscription in one step. */
route('POST', /^\/api\/contracts\/(\d+)\/keap-relink$/, ['admin'], async (req, res, m, body, user) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(+m[1]);
  if(!contract) return err(res, 404, 'not found');
  const subId = String(body.subscriptionId || '').trim();
  if(!subId) return err(res, 400, 'Subscription ID required');
  const conflict = db.prepare('SELECT c.id, cl.name FROM contracts c JOIN clients cl ON cl.id=c.client_id WHERE c.keap_subscription_id=? AND c.id!=?').get(subId, contract.id);
  if(conflict) return err(res, 409, `Subscription ${subId} is already linked to ${conflict.name}'s contract (#${conflict.id}) — unlink it there first.`);
  const found = await keapFindSubscriptionById(subId, { force: true });
  if(!found.ok) return err(res, 400, `Keap doesn't have a subscription with ID ${subId} (${found.error || found.status}). Double-check the ID in Keap and try again.`);
  const oldSubId = contract.keap_subscription_id;
  db.prepare('UPDATE contracts SET keap_subscription_id=? WHERE id=?').run(subId, contract.id);
  log(user.email, 'contract.keap_relink', { contractId: contract.id, oldSubId: oldSubId || null, newSubId: subId });
  // Program/cadence is never auto-corrected — just surfaced as a suggestion, product
  // name checked first (see suggestProgramForSubscription above) since billing_cycle
  // reflects payment frequency, not necessarily visit frequency.
  let programSuggestion = null;
  if(found.json){
    const suggestion = await suggestProgramForSubscription(found.json);
    if(suggestion.guessed !== contract.program) programSuggestion = { guessed: suggestion.guessed, current: contract.program, basis: suggestion.basis };
  }
  try{
    const r = await onSubscriptionChange(subId, 'subscription.edit', { source: 'manual_relink' });
    send(res, 200, { ok: true, relinked: true, oldSubId: oldSubId || null, newSubId: subId, ...r, programSuggestion });
  }catch(e){
    // The relink itself already committed — report the resync failure but don't
    // pretend the whole operation failed, since the link change did take effect.
    send(res, 200, { ok: true, relinked: true, oldSubId: oldSubId || null, newSubId: subId, resyncError: String(e && e.message || e), programSuggestion });
  }
});
/* Manual correction of a contract's program/cadence label — e.g. after a resync or
 * relink surfaces a mismatch against what Keap's billing actually implies. This
 * only ever changes the contract row's own program/visits fields; it never touches
 * the visits table, so already-generated visits keep whatever program/cycle label
 * they were created with (that's what the per-visit Edit button on the profile's
 * Visit history table is for) — no auto-regeneration of anyone's calendar. */
route('PATCH', /^\/api\/contracts\/(\d+)$/, ['admin'], (req, res, m, body, user) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(+m[1]);
  if(!contract) return err(res, 404, 'not found');
  const f = {};
  if(body.program !== undefined){
    if(!PROGRAM_NAMES.includes(body.program)) return err(res, 400, 'unknown program');
    f.program = body.program;
  }
  if(body.visits !== undefined){
    const n = +body.visits;
    if(!Number.isFinite(n) || n < 0) return err(res, 400, 'bad visit count');
    f.visits = n;
  }
  if(!Object.keys(f).length) return err(res, 400, 'nothing to update');
  db.prepare(`UPDATE contracts SET ${Object.keys(f).map(k=>k+'=?').join(',')} WHERE id=?`).run(...Object.values(f), contract.id);
  log(user.email, 'contract.edit', { contractId: contract.id, ...f, oldProgram: contract.program, oldVisits: contract.visits });
  send(res, 200, { ok: true });
});
/* Regenerate a contract's remaining visit schedule from scratch on its CURRENT
 * program/cadence — for when the contract's program was corrected (e.g. Monthly ->
 * Quarterly) after visits had already been generated under the old cadence, or when
 * an anchor date needs to move and the rest of the schedule should follow it (the
 * "butterfly effect" — pass a new anchorDate, or a corrected firstPayDate, to
 * re-space everything from there). Completed visits are NEVER touched — only
 * not-yet-completed visits under this contract are deleted and replaced.
 * Two ways to set where the new schedule starts:
 *   - firstPayDate: the corrected "actually charged" date — the due date is always
 *     that + 90 days (same rule new contracts use), and the corrected pay date is
 *     saved back onto the contract for next time.
 *   - anchorDate: the due date itself, for contracts with no clean pay date on
 *     record (e.g. Keap-linked legacy contracts) — bypasses the 90-day math.
 * If neither is passed, falls back to the contract's own existing start_date.
 * Whichever way is used, first_pay_date is saved to match what was actually
 * submitted (cleared to null if the field was submitted empty), so it never sits
 * out of sync with the due date it's supposed to explain. */
route('POST', /^\/api\/contracts\/(\d+)\/regenerate$/, ['admin'], (req, res, m, body, user) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(+m[1]);
  if(!contract) return err(res, 404, 'not found');
  const client = db.prepare('SELECT name FROM clients WHERE id=?').get(contract.client_id);
  if(!client) return err(res, 404, 'client not found');
  const n = +contract.visits;
  if(!Number.isFinite(n) || n <= 0) return err(res, 400, `${contract.program} has no fixed visit count to schedule — nothing to regenerate.`);
  const firstPayDateProvided = body.firstPayDate !== undefined;
  let firstPayDate = firstPayDateProvided ? String(body.firstPayDate || '').trim() : null;
  let anchorDate;
  if(firstPayDate){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(firstPayDate)) return err(res, 400, 'First pay date must be YYYY-MM-DD');
    anchorDate = addDays(firstPayDate, 90);
  } else {
    anchorDate = body.anchorDate !== undefined && body.anchorDate !== null && body.anchorDate !== ''
      ? String(body.anchorDate).trim() : (contract.start_date || null);
  }
  if(!anchorDate) return err(res, 400, 'This contract has no start date — set an anchor date (or a first pay date) to regenerate from.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) return err(res, 400, 'Anchor date must be YYYY-MM-DD');
  // Guard against exactly the failure mode that produced the Bowman Chevrolet
  // duplicates: regenerating a contract whose cycle numbers (e.g. "2 of 4") are
  // ALREADY completed just creates a second, stray, never-scheduled copy of the
  // same slot — it can never be a legitimate correction, only a duplicate. Block
  // by default; the UI surfaces this as a hard stop rather than a silently-created
  // mess, and a caller can pass force:true only if they've confirmed this really
  // is intentional (which in practice it never should be — completed cycles need
  // a NEW contract for a renewal, not a regenerate on the old one).
  const completedCycles = db.prepare('SELECT cycle, due FROM visits WHERE contract_id=? AND completed=1').all(contract.id);
  const completedCycleSet = new Set(completedCycles.map(r => r.cycle));
  const collisions = [];
  for(let k = 0; k < n; k++){
    const label = `${k+1} of ${n}`;
    if(completedCycleSet.has(label)) collisions.push(label);
  }
  if(collisions.length && !body.force){
    return err(res, 409, `This contract already has a COMPLETED visit for ${collisions.join(', ')} — regenerating would create duplicate, never-scheduled copies of already-finished cycles, not fix anything. If this client genuinely renewed, that needs a new contract, not a regenerate on this one. Pass force:true only if you're certain this is intentional.`);
  }
  // Same team every not-completed visit under this contract already carries — a
  // contract's visits are always created on one team, so the first row's team is as
  // good as any; fall back to the caller's own team only if none exist yet.
  const teamRow = db.prepare(`SELECT team FROM visits WHERE contract_id=? ORDER BY id LIMIT 1`).get(contract.id);
  const team = (teamRow && teamRow.team) || user.team || null;
  const deletedVisits = db.prepare('DELETE FROM visits WHERE contract_id=? AND completed=0').run(contract.id).changes;
  const iv = INTERVAL[contract.program] ?? 3;
  const ids = [];
  for(let k = 0; k < n; k++){
    const d = new Date(anchorDate + 'T12:00:00'); d.setMonth(d.getMonth() + k * iv);
    const r = db.prepare(`INSERT INTO visits(client,program,cycle,due,team,source,sold,client_id,contract_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(client.name, contract.program, `${k+1} of ${n}`, d.toISOString().slice(0,10), team, 'app', new Date().toISOString().slice(0,10), contract.client_id, contract.id);
    ids.push(Number(r.lastInsertRowid));
  }
  if(firstPayDateProvided){
    // Explicit from the dialog (always sends this field, even blank) — save exactly
    // what was submitted, clearing to null if the field was left empty, so the
    // stored pay date never claims a relationship to a due date it didn't produce.
    db.prepare('UPDATE contracts SET start_date=?, first_pay_date=? WHERE id=?').run(anchorDate, firstPayDate || null, contract.id);
  } else {
    // Called without the field at all (e.g. a future non-UI caller) — don't touch
    // whatever first_pay_date already exists on the contract.
    db.prepare('UPDATE contracts SET start_date=? WHERE id=?').run(anchorDate, contract.id);
  }
  log(user.email, 'contract.regenerate', { contractId: contract.id, client: client.name, program: contract.program, anchorDate, firstPayDate: firstPayDate || null, deletedVisits, createdVisits: n });
  send(res, 200, { ok: true, deletedVisits, createdVisits: n, anchorDate, firstPayDate: firstPayDate || null });
});
/* Delete a contract outright — for duplicates (e.g. a leftover sheet-import row
 * sitting alongside the correctly Keap-linked one) or ones created by mistake.
 * Completed visit history is never destroyed: a completed visit generated under
 * this contract is only detached (contract_id cleared) so it stays exactly as-is
 * on the client's Visit history — its own program/cycle/completed_on/notes live on
 * the visit row itself, not on the contract. Only NOT-YET-completed visits under
 * this contract are removed, since those were generated by the contract being
 * deleted and would otherwise be dangling duplicates on the board. */
route('DELETE', /^\/api\/contracts\/(\d+)$/, ['admin'], (req, res, m, body, user) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(+m[1]);
  if(!contract) return err(res, 404, 'not found');
  const client = db.prepare('SELECT name FROM clients WHERE id=?').get(contract.client_id);
  const detached = db.prepare('UPDATE visits SET contract_id=NULL WHERE contract_id=? AND completed=1').run(contract.id).changes;
  const deletedVisits = db.prepare('DELETE FROM visits WHERE contract_id=? AND completed=0').run(contract.id).changes;
  db.prepare('DELETE FROM contracts WHERE id=?').run(contract.id);
  log(user.email, 'contract.delete', { contractId: contract.id, client: client && client.name, program: contract.program, keapSubscriptionId: contract.keap_subscription_id || null, deletedVisits, detachedCompletedVisits: detached });
  send(res, 200, { ok: true, deletedVisits, detachedCompletedVisits: detached });
});
route('GET', /^\/api\/keap\/cancelled-contracts$/, ['admin','lead'], (req, res) => {
  send(res, 200, db.prepare(`
    SELECT c.id, c.program, c.status, cl.name AS client_name,
      (SELECT v.team FROM visits v WHERE v.contract_id=c.id ORDER BY v.id LIMIT 1) AS team
    FROM contracts c JOIN clients cl ON cl.id=c.client_id
    WHERE c.status='cancelled' ORDER BY c.id DESC LIMIT 50`).all());
});
/* System-wide duplicate-visit finder — the Bowman Chevrolet of Clinton case
 * (found 2026-08-21) generalized: a not-completed, never-scheduled visit sitting
 * under the same contract as an already-COMPLETED visit with the identical cycle
 * label (e.g. two "2 of 4"s), landing close in time to it.
 *
 * IMPORTANT — confirmed against the Coach Master File and directly from Mike
 * 2026-08-21: a contract's "k of n" cycle is NOT a one-time batch. It repeats
 * forever at the same cadence (wrapping back to "1 of n" every n visits) until
 * the client cancels or the program changes. That means the SAME cycle label
 * legitimately recurs roughly every n*interval months for the life of a healthy,
 * ongoing contract — e.g. Bowman Chevrolet's real "1 of 4" for cycle 2 (Sep 2025)
 * is a full year after cycle 1's real, completed "1 of 4" (Sep 2024), and that's
 * correct, not a duplicate. The ORIGINAL version of this query didn't check
 * timing at all, so it would have wrongly flagged that legitimate year-later
 * repeat. The fix: only flag a cycle-label match when the two due dates are
 * within 45 days of each other — a real duplicate (like the stray same-quarter
 * copies this was built to catch) sits days apart, never anywhere near a full
 * cycle length apart. Read-only; the actual deletion happens only via the
 * confirm step below, and re-derives this same query itself rather than trusting
 * a client-submitted id list. */
function findDuplicateVisits(){
  return db.prepare(`
    SELECT DISTINCT v1.id AS dupId, v1.contract_id, v1.client_id, v1.client, v1.program, v1.cycle, v1.due AS dupDue
    FROM visits v1
    JOIN visits v2 ON v2.contract_id = v1.contract_id AND v2.cycle = v1.cycle AND v2.completed = 1 AND v2.id != v1.id
    WHERE v1.completed = 0 AND v1.cal_week IS NULL AND v1.contract_id IS NOT NULL
      AND ABS(julianday(v1.due) - julianday(v2.due)) <= 45
    ORDER BY v1.contract_id, v1.cycle
  `).all();
}
route('GET', /^\/api\/admin\/duplicate-visits-audit$/, ['admin'], (req, res) => {
  const dups = findDuplicateVisits();
  const byContract = {};
  for(const d of dups){
    (byContract[d.contract_id] ||= { contractId: d.contract_id, clientId: d.client_id, client: d.client, program: d.program, duplicates: [] })
      .duplicates.push({ visitId: d.dupId, cycle: d.cycle, due: d.dupDue });
  }
  send(res, 200, { count: dups.length, contracts: Object.values(byContract) });
});
route('POST', /^\/api\/admin\/duplicate-visits-cleanup$/, ['admin'], (req, res, m, body, user) => {
  const dups = findDuplicateVisits();
  const del = db.prepare('DELETE FROM visits WHERE id=?');
  let deleted = 0;
  const affected = new Set();
  for(const d of dups){
    del.run(d.dupId);
    deleted++;
    affected.add(`${d.client} (contract #${d.contract_id})`);
  }
  log(user.email, 'admin.duplicate_visits_cleanup', { deleted, affected: [...affected] });
  send(res, 200, { ok: true, deleted, affectedContracts: [...affected] });
});

/* Archive-to-system handoff gap, found 2026-08-23 alongside Cowboy Chevrolet GMC
 * and Bowman Chevrolet of Clinton: some completed visits imported from the sheet
 * were never linked to a contract_id. Every contract-scoped feature (rolling
 * schedule, Regenerate, the duplicate finder above) reads history by contract_id,
 * so to all of them these contracts look like they have zero history — which is
 * exactly how Bowman got 4 duplicate visits recreated from scratch, and exactly
 * why the duplicate finder above missed it (its join requires v2.contract_id to
 * match, and the real completed originals have contract_id = NULL).
 *
 * Read-only. For each orphaned completed visit, proposes which contract it
 * belongs to: 'high' confidence when the client has exactly one contract whose
 * program matches; 'ambiguous' when the client has more than one contract with
 * a matching program (needs a human to pick); 'none' when no contract on that
 * client has a matching program at all (needs a human to look directly). Nothing
 * gets linked until a human approves — see the (not-yet-built) apply step. */
function findOrphanedVisits(){
  const orphans = db.prepare(`
    SELECT id, client_id, client, program, cycle, due, completed, sold, source
    FROM visits WHERE contract_id IS NULL
    ORDER BY client_id, due
  `).all();
  const contractsByClient = {};
  const getContracts = (clientId) => contractsByClient[clientId] ??=
    db.prepare('SELECT id, program, status, start_date, keap_subscription_id FROM contracts WHERE client_id=?').all(clientId);
  return orphans.map(v => {
    const contracts = getContracts(v.client_id);
    const sameProgram = contracts.filter(c => c.program === v.program);
    let confidence, candidateContractId, reason;
    if(sameProgram.length === 1){
      confidence = 'high'; candidateContractId = sameProgram[0].id;
      reason = `Only contract #${sameProgram[0].id} on this client is ${v.program}.`;
    } else if(sameProgram.length > 1){
      confidence = 'ambiguous'; candidateContractId = null;
      reason = `${sameProgram.length} contracts on this client are ${v.program} (#${sameProgram.map(c=>c.id).join(', #')}) — needs a human pick.`;
    } else if(contracts.length === 0){
      confidence = 'none'; candidateContractId = null;
      reason = `This client has no contracts at all yet.`;
    } else {
      confidence = 'none'; candidateContractId = null;
      reason = `No contract on this client is program "${v.program}" (has: ${contracts.map(c=>`#${c.id} ${c.program}`).join(', ')}).`;
    }
    return {
      visitId: v.id, clientId: v.client_id, client: v.client, program: v.program,
      cycle: v.cycle, due: v.due, completed: !!v.completed, source: v.source,
      confidence, candidateContractId,
      candidates: sameProgram.map(c => c.id), reason,
    };
  });
}
route('GET', /^\/api\/admin\/orphaned-visits-audit$/, ['admin'], (req, res) => {
  const rows = findOrphanedVisits();
  const byConfidence = { high: 0, ambiguous: 0, none: 0 };
  for(const r of rows) byConfidence[r.confidence]++;
  send(res, 200, { count: rows.length, byConfidence, rows });
});

/* Apply step for the orphaned-visit audit above. Links ONLY 'high'-confidence
 * orphans (the client has exactly one contract whose program matches the visit's)
 * onto that contract by setting contract_id. Never touches 'ambiguous' or 'none'
 * orphans — those need a human to pick. The candidate contract is recomputed here
 * server-side via findOrphanedVisits(), so the caller can never supply an arbitrary
 * contract id; the request only chooses WHICH high-confidence orphans to link.
 * Idempotent and safe to re-run: findOrphanedVisits() only returns visits with
 * contract_id IS NULL, and the UPDATE is additionally guarded by contract_id IS NULL.
 * Optional body: {visitIds:[...]} restricts the action to those visit ids (each still
 * linked only if it classifies 'high'); {dryRun:true} returns exactly what WOULD be
 * linked without writing anything. */
route('POST', /^\/api\/admin\/orphaned-visits\/apply$/, ['admin'], (req, res, m, body, user) => {
  const rows = findOrphanedVisits();
  const only = Array.isArray(body && body.visitIds) ? new Set(body.visitIds.map(Number)) : null;
  const toLink = [], skipped = [];
  for(const r of rows){
    if(only && !only.has(r.visitId)) continue;
    if(r.confidence === 'high' && r.candidateContractId){
      toLink.push(r);
    } else {
      skipped.push({ visitId: r.visitId, confidence: r.confidence, reason: r.reason });
    }
  }
  const preview = toLink.map(r => ({ visitId: r.visitId, client: r.client, program: r.program, cycle: r.cycle, due: r.due, contractId: r.candidateContractId }));
  if(body && body.dryRun){
    return send(res, 200, { ok: true, dryRun: true, wouldLinkCount: preview.length, skippedCount: skipped.length, wouldLink: preview, skipped });
  }
  const link = db.prepare('UPDATE visits SET contract_id=? WHERE id=? AND contract_id IS NULL');
  const linked = [];
  db.exec('BEGIN');
  try{
    for(const r of toLink){
      const changes = link.run(r.candidateContractId, r.visitId).changes;
      if(changes === 1) linked.push({ visitId: r.visitId, client: r.client, program: r.program, cycle: r.cycle, contractId: r.candidateContractId });
      else skipped.push({ visitId: r.visitId, confidence: 'high', reason: 'already linked at write time (no change)' });
    }
    db.exec('COMMIT');
  }catch(e){ db.exec('ROLLBACK'); return err(res, 500, 'Link failed: ' + e.message); }
  log(user.email, 'admin.orphaned_visits_link', { linkedCount: linked.length, linked });
  send(res, 200, { ok: true, linkedCount: linked.length, skippedCount: skipped.length, linked, skipped });
});

/* Split-contract finder, found 2026-08-23 while checking Keap sync on clients that
 * DO match the archive: a client's real, current visit cycle is sitting on one
 * active contract (usually no keap_subscription_id, no price — this is the sheet-
 * imported "system of record" for the schedule), while a SEPARATE active contract
 * on the same client holds the actual Keap subscription link and price, with only
 * 0-1 visits attached. Same root cause as the orphaned-visit gap above: the archive
 * and the Keap-driven billing record were never reconciled into one contract row.
 * This matters more than the orphaned-visit gap because Keap webhooks update a
 * contract by keap_subscription_id — so a price/cadence change from Keap lands on
 * the near-empty contract, not the one with the real schedule, and anything that
 * reads "this contract's history" (rolling schedule, Regenerate) would see almost
 * nothing there and risk recreating a duplicate schedule from scratch.
 *
 * Read-only. For each client with 2+ active contracts, proposes a primary (the one
 * with the most visits already attached — ties broken toward whichever already has
 * a keap_subscription_id) and lists what would need to move onto it from each
 * other active contract on the client: its keap_subscription_id, price, and any
 * visits. Nothing is merged until a human approves — no apply step exists yet. */
function findContractSplits(){
  const contracts = db.prepare(`
    SELECT c.*, cl.name AS client_name FROM contracts c
    JOIN clients cl ON cl.id = c.client_id
    WHERE c.status = 'active'
    ORDER BY c.client_id
  `).all();
  const byClient = {};
  for(const c of contracts) (byClient[c.client_id] ??= []).push(c);
  const visitCount = db.prepare('SELECT COUNT(*) n FROM visits WHERE contract_id=?');
  const results = [];
  for(const [clientId, cs] of Object.entries(byClient)){
    if(cs.length < 2) continue;
    const withVisits = cs.map(c => ({ ...c, visits: visitCount.get(c.id).n }));
    const primary = withVisits.slice().sort((a, b) =>
      (b.visits - a.visits) || ((b.keap_subscription_id ? 1 : 0) - (a.keap_subscription_id ? 1 : 0)) || (a.id - b.id)
    )[0];
    const others = withVisits.filter(c => c.id !== primary.id);
    results.push({
      clientId: +clientId, client: cs[0].client_name,
      primary: { contractId: primary.id, program: primary.program, price: primary.price, keapSubscriptionId: primary.keap_subscription_id || null, visits: primary.visits },
      moveFrom: others.map(o => ({
        contractId: o.id, program: o.program, price: o.price, keapSubscriptionId: o.keap_subscription_id || null, visits: o.visits,
        wouldMove: [
          o.keap_subscription_id && !primary.keap_subscription_id ? `keap subscription ${o.keap_subscription_id}` : null,
          o.price != null && primary.price == null ? `price $${o.price}` : null,
          o.visits > 0 ? `${o.visits} visit(s)` : null,
        ].filter(Boolean),
      })),
    });
  }
  return results;
}
route('GET', /^\/api\/admin\/contract-splits-audit$/, ['admin'], (req, res) => {
  const rows = findContractSplits();
  send(res, 200, { count: rows.length, rows });
});

/* Actually merges a split: folds one or more "secondary" active contracts into
 * one "primary" active contract on the same client. Confirmed against real cases
 * 2026-08-23 (Mike): Tinney Chevrolet GMC's split ties to a CANCELLED Keap
 * subscription (handle via Resync/Link to Keap, not this merge — the cancelled
 * status needs to surface, not get papered over); Cox Chevrolet's "secondary" is
 * a genuinely separate Coaching Only subscription ("SUB - Chris Collins Signature
 * Coaching Program"), not a duplicate at all; Toyota of Ann Arbor is a real
 * mid-cycle program-change-plus-billing-credit situation that needs Mike's manual
 * input, not automated merging. This function does not filter those out itself —
 * the caller decides which clients to actually merge.
 *
 * What it does, per client:
 *  - Every visit on every secondary contract moves onto the primary contract.
 *  - A COMPLETED visit's cycle label is never touched — it's the ground-truth
 *    archive history.
 *  - A NOT-completed visit's cycle label IS recomputed, in due-date order,
 *    continuing the wrap (1..n) from whatever the last completed cycle was —
 *    same logic as the rolling schedule generator's anchor detection — so the
 *    merged contract's history reads as one coherent, correctly-numbered cycle
 *    instead of two contracts each independently numbering from "1". Due dates
 *    and calendar placement (cal_week) are never changed, only the label.
 *  - If two not-completed visits land within 45 days of each other after the
 *    merge (a real duplicate, not just the next cycle), only one survives —
 *    preferring whichever is already on the calendar — and the other is deleted.
 *  - The secondary's keap_subscription_id/price/first_pay_date move onto the
 *    primary only where the primary doesn't already have one.
 *  - The secondary contract is then set to status='completed' (contracts.status
 *    has no "merged" value to use instead) with merged_into_contract_id/merged_at
 *    stamped, so it's never mistaken for a still-open contract again but the row
 *    survives for audit trail. */
function planContractMerge(clientId, primaryId, secondaryIds){
  const primary = db.prepare('SELECT * FROM contracts WHERE id=? AND client_id=?').get(primaryId, clientId);
  if(!primary) throw new Error(`Contract #${primaryId} not found on client #${clientId}`);
  if(primary.merged_into_contract_id) throw new Error(`Contract #${primary.id} was already merged into #${primary.merged_into_contract_id} — pick that one as primary instead.`);
  const secondaries = secondaryIds.map(id => {
    const c = db.prepare('SELECT * FROM contracts WHERE id=? AND client_id=?').get(id, clientId);
    if(!c) throw new Error(`Contract #${id} not found on client #${clientId}`);
    if(c.merged_into_contract_id) throw new Error(`Contract #${id} was already merged into #${c.merged_into_contract_id} — nothing left to move.`);
    return c;
  });
  const n = +primary.visits || 0;
  const iv = INTERVAL[primary.program] ?? 3;
  const allIds = [primary.id, ...secondaries.map(s => s.id)];
  const visits = db.prepare(`SELECT * FROM visits WHERE contract_id IN (${allIds.map(()=>'?').join(',')})`).all(...allIds);
  const completed = visits.filter(v => v.completed).sort((a,b) => (a.due||'').localeCompare(b.due||''));
  const notCompleted = visits.filter(v => !v.completed).sort((a,b) => (a.due||'').localeCompare(b.due||''));

  // dedupe not-completed visits that land within 45 days of each other
  const kept = [];
  const dropped = [];
  for(const v of notCompleted){
    const near = kept.find(k => k.due && v.due && Math.abs((new Date(k.due) - new Date(v.due)) / 864e5) <= 45);
    if(near){
      // prefer whichever is already on the calendar; tie-break lower id
      const loser = (near.cal_week ? v : (v.cal_week ? near : (near.id <= v.id ? v : near)));
      const winner = loser === v ? near : v;
      if(loser === near){ kept.splice(kept.indexOf(near), 1); kept.push(winner); }
      dropped.push(loser);
    } else {
      kept.push(v);
    }
  }
  kept.sort((a,b) => (a.due||'').localeCompare(b.due||''));

  // relabel kept not-completed visits, continuing the wrap from the last completed cycle.
  // Exception: if the last completed visit's own label implies a DIFFERENT cycle-size
  // than the primary contract's current one, that's a real program/cadence change (e.g.
  // Quarterly -> Bi-Annual), and per business rule "the day they change their subscription
  // frequency is the day we calculate their new cycle" — so restart at 1 of new_n rather
  // than continuing the old modulus.
  let nextK = 1;
  let cadenceChanged = false;
  if(completed.length){
    const last = completed[completed.length - 1];
    const parsed = /^(\d+)\s*of\s*(\d+)/i.exec(last.cycle || '');
    const k = parsed ? +parsed[1] : n;
    const lastN = parsed ? +parsed[2] : n;
    cadenceChanged = n && lastN && lastN !== n;
    nextK = cadenceChanged ? 1 : (n ? (k % n) + 1 : k + 1);
  }
  const relabeled = kept.map(v => {
    const newCycle = n ? `${nextK} of ${n}` : v.cycle;
    nextK = n ? (nextK % n) + 1 : nextK + 1;
    return { ...v, newCycle };
  });

  const keapMove = !primary.keap_subscription_id && secondaries.find(s => s.keap_subscription_id) || null;
  const priceMove = (primary.price == null) && secondaries.find(s => s.price != null) || null;
  const firstPayMove = !primary.first_pay_date && secondaries.find(s => s.first_pay_date) || null;

  return {
    clientId, primaryId: primary.id, secondaryIds: secondaries.map(s => s.id),
    cadenceChanged,
    keapMove: keapMove ? { fromContractId: keapMove.id, keapSubscriptionId: keapMove.keap_subscription_id } : null,
    priceMove: priceMove ? { fromContractId: priceMove.id, price: priceMove.price } : null,
    firstPayMove: firstPayMove ? { fromContractId: firstPayMove.id, firstPayDate: firstPayMove.first_pay_date } : null,
    completed: completed.map(v => ({ id: v.id, cycle: v.cycle, due: v.due, fromContractId: v.contract_id })),
    relabeled: relabeled.map(v => ({ id: v.id, oldCycle: v.cycle, newCycle: v.newCycle, due: v.due, fromContractId: v.contract_id, onCalendar: !!v.cal_week })),
    dropped: dropped.map(v => ({ id: v.id, cycle: v.cycle, due: v.due, fromContractId: v.contract_id })),
  };
}
function applyContractMerge(plan, actorEmail){
  const moveVisit = db.prepare('UPDATE visits SET contract_id=? WHERE id=?');
  const relabelVisit = db.prepare('UPDATE visits SET contract_id=?, cycle=? WHERE id=?');
  const deleteVisit = db.prepare('DELETE FROM visits WHERE id=?');
  for(const v of plan.completed) moveVisit.run(plan.primaryId, v.id);
  for(const v of plan.relabeled) relabelVisit.run(plan.primaryId, v.newCycle, v.id);
  for(const v of plan.dropped) deleteVisit.run(v.id);
  const sets = [], vals = [];
  if(plan.keapMove){ sets.push('keap_subscription_id=?'); vals.push(plan.keapMove.keapSubscriptionId); }
  if(plan.priceMove){ sets.push('price=?'); vals.push(plan.priceMove.price); }
  if(plan.firstPayMove){ sets.push('first_pay_date=?'); vals.push(plan.firstPayMove.firstPayDate); }
  if(sets.length) db.prepare(`UPDATE contracts SET ${sets.join(', ')} WHERE id=?`).run(...vals, plan.primaryId);
  const now = new Date().toISOString();
  for(const secId of plan.secondaryIds){
    db.prepare(`UPDATE contracts SET status='completed', merged_into_contract_id=?, merged_at=?, keap_subscription_id=NULL WHERE id=?`)
      .run(plan.primaryId, now, secId);
  }
  log(actorEmail, 'admin.contract_merge', plan);
}
route('POST', /^\/api\/admin\/contract-splits\/preview$/, ['admin'], (req, res, m, body) => {
  try{
    const plan = planContractMerge(body.clientId, body.primaryId, body.secondaryIds || []);
    send(res, 200, plan);
  }catch(e){ err(res, 400, e.message); }
});
route('POST', /^\/api\/admin\/contract-splits\/apply$/, ['admin'], (req, res, m, body, user) => {
  try{
    const plan = planContractMerge(body.clientId, body.primaryId, body.secondaryIds || []);
    applyContractMerge(plan, user.email);
    send(res, 200, { ok: true, plan });
  }catch(e){ err(res, 400, e.message); }
});

/* ----- Keap webhook diagnostics (admin only) -----
   Two separate questions when "I added a store in Keap and it never showed up":
   1. Did ANYTHING from Keap ever reach this app? (raw keap_events — every inbound
      hit, whether we acted on it or not, is logged here regardless of event type.)
   2. Is Keap's hook subscription for subscription.add/edit/delete actually registered
      and Verified against this app's URL right now? (live GET /v1/hooks call.) */
route('GET', /^\/api\/admin\/keap-events$/, ['admin'], (req, res) => {
  send(res, 200, db.prepare('SELECT * FROM keap_events ORDER BY id DESC LIMIT 100').all());
});
route('POST', /^\/api\/admin\/keap-events\/(\d+)\/reprocess$/, ['admin'], async (req, res, m, body, user) => {
  const row = db.prepare('SELECT * FROM keap_events WHERE id=?').get(+m[1]);
  if(!row) return err(res, 404, 'not found');
  let evt; try{ evt = JSON.parse(row.raw || '{}'); }catch(e){ return err(res, 400, 'stored event is not valid JSON'); }
  const eventKey = evt.event_key || evt.eventKey || row.event_key;
  const objectId = extractKeapObjectId(evt);
  if(!objectId) return err(res, 400, 'could not extract an object id from this event’s raw payload');
  try{
    let result = null;
    if(eventKey === 'subscription.add') result = await onSubscriptionAdd(objectId, { force: true });
    else if(eventKey === 'subscription.edit' || eventKey === 'subscription.delete') result = await onSubscriptionChange(objectId, eventKey, { source: 'admin.reprocess' });
    else return err(res, 400, `don't know how to reprocess event type "${eventKey}"`);
    db.prepare('UPDATE keap_events SET object_id=? WHERE id=?').run(String(objectId), row.id);
    recordKeapEventOutcome(row.id, result);
    log(user.email, 'keap_event.reprocess', { id: row.id, eventKey, objectId, result });
    send(res, 200, { ok: true, result });
  }catch(e){ err(res, 500, String(e && e.message || e)); }
});
route('GET', /^\/api\/admin\/keap-hooks-status$/, ['admin'], async (req, res) => {
  if(!KEAP_TOKEN) return err(res, 400, 'KEAP_TOKEN is not configured on this server — cannot check hook status.');
  try{
    const r = await keapGet('/v1/hooks');
    if(!r.ok) return err(res, 502, `Keap returned status ${r.status} for GET /v1/hooks`);
    const hooks = (r.json && (r.json.hooks || r.json)) || [];
    send(res, 200, { hooks: Array.isArray(hooks) ? hooks : [] });
  }catch(e){ err(res, 500, String(e && e.message || e)); }
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

/* Record today's health per client and report movement against the previous
   snapshot — "who dropped a tier" is the digest line leads actually act on. */
const HEALTH_RANK = { on_track: 0, behind: 1, at_risk: 2, inactive: -1 };
function snapshotClientHealth(){
  const today = new Date().toISOString().slice(0,10);
  const map = computeHealthMap();
  const prevDate = db.prepare('SELECT MAX(date) d FROM client_health_log WHERE date < ?').get(today).d;
  const prev = prevDate ? Object.fromEntries(db.prepare('SELECT client_id, level FROM client_health_log WHERE date=?').all(prevDate).map(r=>[r.client_id, r.level])) : {};
  const names = Object.fromEntries(db.prepare('SELECT id, name FROM clients WHERE deleted_at IS NULL').all().map(r=>[r.id, r.name]));
  const dropped = [], improved = [];
  for(const [id, level] of Object.entries(map)){
    const was = prev[id];
    if(!was || was === level || level === 'inactive' || was === 'inactive') continue;
    if(HEALTH_RANK[level] > HEALTH_RANK[was]) dropped.push(`${names[id] || id}: ${was.replace('_',' ')} → ${level.replace('_',' ')}`);
    else improved.push(`${names[id] || id}: ${was.replace('_',' ')} → ${level.replace('_',' ')}`);
  }
  const ins = db.prepare('INSERT INTO client_health_log(date, client_id, level) VALUES(?,?,?) ON CONFLICT(date, client_id) DO UPDATE SET level=excluded.level');
  for(const [id, level] of Object.entries(map)) ins.run(today, +id, level);
  // Keep 90 days of history — enough for trend questions without unbounded growth
  db.prepare('DELETE FROM client_health_log WHERE date < ?').run(new Date(Date.now()-90*24*60*60*1000).toISOString().slice(0,10));
  const counts = {};
  for(const level of Object.values(map)) counts[level] = (counts[level] || 0) + 1;
  return { counts, dropped, improved, comparedTo: prevDate || null };
}

/* ---------- rolling schedule generator ----------
 * Confirmed with Mike 2026-08-21 (against the Coach Master File — Bowman
 * Chevrolet of Clinton was the case that surfaced this): a contract's "k of n"
 * cycle is not a one-time batch — it repeats forever at the program's cadence,
 * wrapping back to "1 of n" every n visits, until the client cancels or the
 * program changes. Nothing in the app was keeping that repetition going once the
 * most recently generated batch ran out, so a long-lived contract's visits would
 * just silently stop appearing (Bowman Chevrolet had nothing past Dec 2025).
 * This keeps a rolling ROLLING_MONTHS-out window of future visits populated for
 * every active, fixed-cadence contract — "visits for a calendar year should be
 * visible from today's date," per Mike's own framing. Purely additive: it reads
 * whatever the contract's own most recent visit already is (completed or not)
 * and only ever adds visits past that point, at the program's interval, wrapping
 * the cycle counter — never deletes or edits an existing row, so it's safe to run
 * unattended every night. It intentionally doesn't know or care about program
 * CHANGE history — once the reanchor-on-Keap-cadence-change feature exists (the
 * next phase), this will just keep counting forward from whatever fresh anchor
 * that produces, the same as it does today from a plain completed visit. */
const ROLLING_MONTHS = 12;
/* dryRun:true computes the exact same list without writing anything — used both
 * by the preview endpoint (so this can be reviewed before it ever touches real
 * data or a coach's in-progress manual audit) and by the nightly job itself,
 * which currently runs in dry-run/report-only mode until Mike has reviewed a
 * real preview and explicitly turns on auto-apply — see runNightlyMaintenance. */
function extendRollingSchedule(contract, opts = {}){
  const dryRun = !!opts.dryRun;
  const n = +contract.visits;
  const iv = INTERVAL[contract.program] ?? 0;
  // Coaching Only (visits=0), LID (Purchase) (iv=0, genuinely one-and-done), or
  // any contract with an unrecognized/blank program — nothing to repeat.
  if(!Number.isFinite(n) || n <= 0 || !iv) return { created: 0, visits: [] };
  const last = db.prepare('SELECT due, cycle, team FROM visits WHERE contract_id=? ORDER BY due DESC, id DESC LIMIT 1').get(contract.id);
  let nextDue, nextK, team;
  if(last && last.due){
    const parsed = /^(\d+)\s*of\s*(\d+)/i.exec(last.cycle || '');
    const k = parsed ? +parsed[1] : n; // unparsable cycle label — safest assumption is it was the last slot in its cycle
    nextK = (k % n) + 1;
    const d = new Date(last.due + 'T12:00:00'); d.setMonth(d.getMonth() + iv);
    nextDue = d.toISOString().slice(0, 10);
    team = last.team || null;
  } else {
    // No visits at all yet under this contract (shouldn't normally happen —
    // create/regenerate always seed at least one — but don't skip silently).
    nextK = 1;
    nextDue = contract.start_date || new Date().toISOString().slice(0, 10);
    team = null;
  }
  if(!team){
    const teamRow = db.prepare('SELECT team FROM visits WHERE contract_id=? ORDER BY id LIMIT 1').get(contract.id);
    team = (teamRow && teamRow.team) || null;
  }
  const horizon = new Date(); horizon.setMonth(horizon.getMonth() + ROLLING_MONTHS);
  const horizonStr = horizon.toISOString().slice(0, 10);
  const visits = [];
  let guard = 0; // safety valve, not a real cap — see note below if it's ever hit
  while(nextDue <= horizonStr && guard < 60){
    const cycle = `${nextK} of ${n}`;
    if(dryRun){
      visits.push({ due: nextDue, cycle });
    } else {
      const r = db.prepare(`INSERT INTO visits(client,program,cycle,due,team,source,sold,client_id,contract_id)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(contract.client_name, contract.program, cycle, nextDue, team, 'app', new Date().toISOString().slice(0, 10), contract.client_id, contract.id);
      visits.push({ id: Number(r.lastInsertRowid), due: nextDue, cycle });
    }
    nextK = (nextK % n) + 1;
    const d = new Date(nextDue + 'T12:00:00'); d.setMonth(d.getMonth() + iv);
    nextDue = d.toISOString().slice(0, 10);
    guard++;
  }
  // guard===60 would mean a contract was over a decade stale — surfaced, not
  // silently truncated, so it gets a human look rather than quietly staying short.
  return { created: visits.length, visits, cappedAt60: guard >= 60 };
}
function sweepRollingSchedule(opts = {}){
  const contracts = db.prepare(`
    SELECT c.*, cl.name AS client_name FROM contracts c
    JOIN clients cl ON cl.id = c.client_id
    WHERE c.status='active' AND cl.deleted_at IS NULL AND cl.status != 'cancelled'
  `).all();
  let totalCreated = 0;
  const perClient = [];
  const capped = [];
  for(const c of contracts){
    const r = extendRollingSchedule(c, opts);
    if(r.created){ totalCreated += r.created; perClient.push({ client: c.client_name, clientId: c.client_id, contractId: c.id, program: c.program, created: r.created, visits: r.visits }); }
    if(r.cappedAt60) capped.push(`${c.client_name} (contract #${c.id})`);
  }
  return { dryRun: !!opts.dryRun, contractsChecked: contracts.length, totalCreated, perClient, capped };
}
// Preview: computes the full list without writing anything — review this before
// ever applying it, and before relying on it to judge whether a coach's manual
// audit still needs to happen.
route('GET', /^\/api\/admin\/rolling-schedule\/preview$/, ['admin'], (req, res) => {
  send(res, 200, sweepRollingSchedule({ dryRun: true }));
});
// Apply: the only route that actually writes. Deliberately separate from preview
// and from the nightly job (which stays dry-run-only — see runNightlyMaintenance)
// so nothing gets created without an explicit, reviewed action.
route('POST', /^\/api\/admin\/rolling-schedule\/run-now$/, ['admin'], (req, res, m, body, user) => {
  const r = sweepRollingSchedule({ dryRun: false });
  log(user.email, 'admin.rolling_schedule_run', { contractsChecked: r.contractsChecked, totalCreated: r.totalCreated, capped: r.capped });
  send(res, 200, r);
});

async function runNightlyMaintenance(actorEmail){
  const summary = { startedAt: new Date().toISOString() };
  try{ summary.sync = await keapSyncAllLinkedContracts(actorEmail); }
  catch(e){ summary.sync = { error: String(e && e.message || e) }; }
  // Dry-run only for now, by design: Mike asked to see the real list before this
  // ever auto-applies against live data, since coaches are actively doing a
  // manual audit and this shouldn't create visits underneath that work
  // unreviewed. Flip to {dryRun:false} once he's reviewed a preview and says go —
  // until then this only reports what it WOULD do, same as everything else here.
  try{ summary.rollingSchedule = sweepRollingSchedule({ dryRun: true }); }
  catch(e){ summary.rollingSchedule = { error: String(e && e.message || e) }; }
  try{ summary.revenue = recordRevenueSnapshot(); }
  catch(e){ summary.revenue = { error: String(e && e.message || e) }; }
  try{ summary.purge = purgeOldSoftDeletes(); }
  catch(e){ summary.purge = { error: String(e && e.message || e) }; }
  try{ summary.holds = sweepProspectHolds(); }
  catch(e){ summary.holds = { error: String(e && e.message || e) }; }
  try{ summary.health = snapshotClientHealth(); }
  catch(e){ summary.health = { error: String(e && e.message || e) }; }
  try{ summary.backup = await takeBackupAndEmail(actorEmail); }
  catch(e){ summary.backup = { error: String(e && e.message || e) }; }

  // Digest: overdue visits + stale pending queue, alongside the above — one email,
  // not four, so admins get one thing to skim instead of a flood.
  try{
    const overdue = db.prepare("SELECT COUNT(*) c FROM visits WHERE completed=0 AND due IS NOT NULL AND due < ?").get(new Date().toISOString().slice(0,10)).c;
    const stalePending = db.prepare("SELECT COUNT(*) c FROM pending_clients WHERE status='pending' AND created < ?").get(new Date(Date.now()-7*24*60*60*1000).toISOString()).c;
    const syncErrors = (summary.sync && summary.sync.errors) ? summary.sync.errors.length : 0;
    // Someone gave notice 30+ days ago and Keap still hasn't reported the subscription
    // cancelled — either a billing/follow-up gap worth chasing, or they changed their
    // mind and the notice marker should be cleared so this stops nagging.
    const noticeOverdue = db.prepare(`
      SELECT name, notice_given_date FROM clients
      WHERE deleted_at IS NULL AND status!='cancelled' AND notice_given_date IS NOT NULL
        AND date(notice_given_date,'+30 days') <= date('now')
      ORDER BY notice_given_date`).all();
    const lines = [
      `Coach Fulfillment System — nightly summary for ${new Date().toISOString().slice(0,10)}`,
      '',
      `Keap sync: ${summary.sync.error ? 'FAILED — ' + summary.sync.error : `checked ${summary.sync.checked}, price updated ${summary.sync.priceChanged}, status changed ${summary.sync.statusChanged}, errors ${syncErrors}`}`,
      `Rolling schedule (PREVIEW ONLY — not yet applied): ${summary.rollingSchedule.error ? 'FAILED — ' + summary.rollingSchedule.error : `would add ${summary.rollingSchedule.totalCreated} visit(s) across ${summary.rollingSchedule.perClient.length} contract(s) to keep the next ${ROLLING_MONTHS} months populated (${summary.rollingSchedule.contractsChecked} active contract(s) checked) — review at Admin → Data → Rolling schedule before applying`}`,
      `Revenue snapshot: ${summary.revenue.error ? 'FAILED — ' + summary.revenue.error : `$${Math.round(summary.revenue.totalRevenue).toLocaleString()} across ${summary.revenue.activeClients} active client(s)`}`,
      `Soft-delete purge: ${summary.purge.error ? 'FAILED — ' + summary.purge.error : `${summary.purge.purged} client(s) purged (past the 30-day recovery window)`}`,
      `Database backup: ${summary.backup.ok ? `sent (${Math.round((summary.backup.sizeBytes||0)/1024)} KB)` : 'FAILED — ' + (summary.backup.error || 'see results')}`,
      '',
      `Overdue visits (not yet completed, past due): ${overdue}`,
      `Pending Clients queue items older than 7 days: ${stalePending}`,
    ];
    if(noticeOverdue.length){
      lines.push(`Clients past their 30-day notice, Keap still hasn't confirmed cancelled: ${noticeOverdue.length}`);
      noticeOverdue.slice(0,15).forEach(c => lines.push(`  - ${c.name} (notice given ${c.notice_given_date})`));
      if(noticeOverdue.length > 15) lines.push(`  …and ${noticeOverdue.length - 15} more`);
    }
    if(summary.holds && !summary.holds.error){
      if(summary.holds.expired.length) lines.push(`Prospect holds auto-released (expired): ${summary.holds.expired.join(', ')}`);
      if(summary.holds.expiring.length) lines.push(`Prospect holds expiring within 7 days: ${summary.holds.expiring.join(', ')}`);
    }
    if(summary.rollingSchedule && !summary.rollingSchedule.error && summary.rollingSchedule.capped.length){
      lines.push(`Rolling schedule hit its per-run safety cap (over a decade stale) for: ${summary.rollingSchedule.capped.join(', ')} — needs a manual look, not fully caught up yet.`);
    }
    if(summary.health && !summary.health.error){
      const h = summary.health;
      lines.push('', `Client health: ${h.counts.on_track||0} on track · ${h.counts.behind||0} behind · ${h.counts.at_risk||0} at risk`);
      if(h.dropped.length){ lines.push(`Dropped a tier since ${h.comparedTo}:`); h.dropped.slice(0,15).forEach(x => lines.push('  - ' + x)); if(h.dropped.length>15) lines.push(`  …and ${h.dropped.length-15} more`); }
      if(h.improved.length) lines.push(`Improved: ${h.improved.length} client(s).`);
    }
    // Data integrity: things that are wrong in the data itself, not just late.
    try{
      const noTeam = db.prepare("SELECT COUNT(*) c FROM visits WHERE completed=0 AND (team IS NULL OR team='' OR team='?')").get().c;
      const orphanVisits = db.prepare('SELECT COUNT(*) c FROM visits WHERE completed=0 AND client_id IS NULL').get().c;
      const noPriceContracts = db.prepare("SELECT COUNT(*) c FROM contracts WHERE status='active' AND (price IS NULL OR price=0)").get().c;
      const noKeapClients = db.prepare("SELECT COUNT(*) c FROM clients WHERE status='active' AND deleted_at IS NULL AND (keap_id IS NULL OR keap_id='')").get().c;
      const integrity = [];
      if(noTeam) integrity.push(`${noTeam} open visit(s) with no team assigned`);
      if(orphanVisits) integrity.push(`${orphanVisits} open visit(s) not linked to any client record`);
      if(noPriceContracts) integrity.push(`${noPriceContracts} active contract(s) with no price (excluding intentional $0 revenue-owner setups, review these)`);
      if(noKeapClients) integrity.push(`${noKeapClients} active client(s) with no Keap company id linked`);
      if(integrity.length){ lines.push('', 'Data integrity — worth a cleanup pass:'); integrity.forEach(x => lines.push('  - ' + x)); }
    }catch(e){ lines.push('Data integrity check failed: ' + e.message); }
    if(overdue > 0 || stalePending > 0 || syncErrors > 0 || noticeOverdue.length > 0 || !summary.backup.ok) lines.push('', 'One or more of the above needs a look.');
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
  const healthMap = computeHealthMap();
  for(const r of rows){
    const cs = byClient[r.id] || [];
    r.programs = [...new Set(cs.map(c => c.program).filter(Boolean))].join(', ');
    r.revenue = cs.reduce((sum, c) => sum + (Number(c.price) || 0), 0);
    r.health = healthMap[r.id] || 'inactive';
  }
  send(res, 200, rows);
});
/* Set-based health for EVERY non-deleted client in four grouped queries — same
   tiers as the per-client clientHealth() banner, so no surface ever disagrees.
   Used by the Clients list, /api/state (board tinting), and the nightly digest. */
function computeHealthMap(){
  const today = new Date().toISOString().slice(0,10);
  const cut60 = new Date(Date.now()-60*24*60*60*1000).toISOString().slice(0,10);
  const plus30 = new Date(Date.now()+30*24*60*60*1000).toISOString().slice(0,10);
  const toMap = (sql, ...args) => Object.fromEntries(db.prepare(sql).all(...args).map(r => [r.client_id, r.v]));
  const mOverdueNoPlan = toMap(`SELECT client_id, COUNT(*) v FROM visits WHERE completed=0 AND cal_week IS NULL AND due<? AND client_id IS NOT NULL GROUP BY client_id`, today);
  const mBehind = toMap(`SELECT client_id, COUNT(*) v FROM visits WHERE completed=0 AND client_id IS NOT NULL AND ((cal_week IS NOT NULL AND due<?) OR (cal_week IS NULL AND due>=? AND due<=?)) GROUP BY client_id`, today, today, plus30);
  const mScheduled = toMap(`SELECT client_id, COUNT(*) v FROM visits WHERE completed=0 AND cal_week>=? AND client_id IS NOT NULL GROUP BY client_id`, today);
  const mLastDone = toMap(`SELECT client_id, MAX(COALESCE(completed_on,due)) v FROM visits WHERE completed=1 AND client_id IS NOT NULL GROUP BY client_id`);
  const cs = db.prepare("SELECT client_id, program FROM contracts WHERE status='active'").all();
  const progs = {};
  for(const c of cs) (progs[c.client_id] ||= []).push(c.program);
  const out = {};
  for(const r of db.prepare('SELECT id, status, assigned_coach_id FROM clients WHERE deleted_at IS NULL').all()){
    if(r.status !== 'active'){ out[r.id] = 'inactive'; continue; }
    const p = progs[r.id] || [];
    if(p.length && p.every(x => x === 'Coaching Only')){ out[r.id] = r.assigned_coach_id ? 'on_track' : 'behind'; continue; }
    const stale = (!mLastDone[r.id] || mLastDone[r.id] < cut60) && !mScheduled[r.id];
    out[r.id] = (mOverdueNoPlan[r.id] || stale) ? 'at_risk' : mBehind[r.id] ? 'behind' : 'on_track';
  }
  return out;
}
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
    health: clientHealth(cl, contracts, visits, assignedCoach),
  });
});
/* One computed answer to "is this client okay?" — shown as the banner at the top
   of every client profile. level: on_track | behind | at_risk | inactive.
   reasons[] explains WHY in plain language; fixes[] hints at the next action. */
function clientHealth(cl, contracts, visits, assignedCoach){
  const today = new Date().toISOString().slice(0,10);
  const cut60 = new Date(Date.now()-60*24*60*60*1000).toISOString().slice(0,10);
  const plus30 = new Date(Date.now()+30*24*60*60*1000).toISOString().slice(0,10);
  const reasons = [], warnings = [];
  if(cl.status !== 'active'){
    return { level:'inactive', label: cl.status === 'cancelled' ? 'Cancelled' : 'Inactive',
      reasons: ['No active contracts — history is preserved below.'], warnings: [] };
  }
  const activeCs = contracts.filter(c => c.status === 'active');
  const coachingOnly = activeCs.length > 0 && activeCs.every(c => c.program === 'Coaching Only');
  if(!assignedCoach) warnings.push('No coach assigned — nobody owns this relationship.');
  if(!cl.keap_id) warnings.push('No Keap company linked — billing can\'t be reconciled automatically.');
  if(coachingOnly){
    return { level: assignedCoach ? 'on_track' : 'behind', label: assignedCoach ? 'On track — Coaching Only' : 'Needs attention',
      reasons: assignedCoach ? [`Remote coaching with ${assignedCoach.name}; no LID visits owed.`] : ['Coaching Only client with no coach assigned.'], warnings };
  }
  const open = visits.filter(v => !v.completed);
  const overdueNoPlan = open.filter(v => v.due && v.due < today && !v.cal_week);
  const lateOnCal = open.filter(v => v.due && v.due < today && v.cal_week);
  const dueSoonUnsched = open.filter(v => v.due && v.due >= today && v.due <= plus30 && !v.cal_week);
  const nextScheduled = open.filter(v => v.cal_week && v.cal_week >= today).sort((a,b)=>a.cal_week.localeCompare(b.cal_week))[0] || null;
  const completed = visits.filter(v => v.completed);
  const lastDone = completed.map(v => v.completed_on || v.due).filter(Boolean).sort().pop() || null;
  const staleRelationship = (!lastDone || lastDone < cut60) && !nextScheduled;

  if(overdueNoPlan.length){
    const oldest = overdueNoPlan[0];
    const days = Math.floor((new Date(today) - new Date(oldest.due)) / 864e5);
    reasons.push(`${overdueNoPlan.length} overdue visit${overdueNoPlan.length>1?'s':''} with no calendar slot — oldest is ${days} days late (${oldest.cycle} ${oldest.program}).`);
  }
  if(staleRelationship) reasons.push(lastDone ? `No completed visit since ${lastDone} and nothing on the calendar.` : 'No visit has ever been completed and nothing is on the calendar.');
  if(lateOnCal.length) reasons.push(`${lateOnCal.length} visit${lateOnCal.length>1?'s are':' is'} past due but already scheduled — late, not lost.`);
  if(dueSoonUnsched.length) reasons.push(`${dueSoonUnsched.length} visit${dueSoonUnsched.length>1?'s':''} due within 30 days, not yet scheduled.`);
  if(nextScheduled) reasons.push(`Next visit: week of ${nextScheduled.cal_week} (${nextScheduled.cycle} ${nextScheduled.program}).`);
  if(lastDone) reasons.push(`Last completed visit: ${lastDone}.`);

  const level = (overdueNoPlan.length || staleRelationship) ? 'at_risk'
    : (lateOnCal.length || dueSoonUnsched.length) ? 'behind'
    : 'on_track';
  const label = level === 'at_risk' ? 'At risk' : level === 'behind' ? 'Behind — recoverable' : 'On track';
  return { level, label, reasons, warnings };
}
route('PATCH', /^\/api\/clients\/(\d+)$/, ['admin','lead'], (req, res, m, body, user) => {
  const cl = db.prepare('SELECT * FROM clients WHERE id=?').get(+m[1]);
  if(!cl) return err(res, 404, 'not found');
  const result = { ok: true };
  if(body.assigned_coach_id !== undefined){
    const coachId = body.assigned_coach_id || null;
    const dest = coachId ? getCoach(coachId) : null;
    if(coachId && !dest) return err(res, 400, 'unknown coach');
    db.prepare('UPDATE clients SET assigned_coach_id=? WHERE id=?').run(coachId, cl.id);
    // Cascade to the client's OPEN visits so the Schedule Board and LID Inventory
    // actually reflect the reassignment instead of silently keeping the old team:
    //  - unscheduled open visits move to the new coach's team (they surface in that
    //    team's to-schedule list)
    //  - scheduled open visits move to the new coach's calendar IF the same week is
    //    free on it (the planned date survives); otherwise they're unscheduled into
    //    the new team's list rather than left on the old coach — nothing is lost,
    //    it just needs re-placing.
    // Completed visits are never touched: history keeps who really did the work.
    if(dest){
      const cascade = { teamMoved: 0, keptWeek: 0, needsReplacing: 0 };
      const open = db.prepare('SELECT * FROM visits WHERE client_id=? AND completed=0').all(cl.id);
      for(const v of open){
        if(!v.cal_week){
          db.prepare('UPDATE visits SET team=? WHERE id=?').run(dest.team, v.id);
          cascade.teamMoved++;
        } else if(v.cal_coach === dest.id){
          db.prepare('UPDATE visits SET team=? WHERE id=?').run(dest.team, v.id);
          cascade.keptWeek++;
        } else if(cellFree(dest.id, v.cal_week, v.id)){
          db.prepare('UPDATE visits SET team=?, cal_coach=? WHERE id=?').run(dest.team, dest.id, v.id);
          cascade.keptWeek++;
        } else {
          db.prepare('UPDATE visits SET team=?, cal_coach=NULL, cal_week=NULL WHERE id=?').run(dest.team, v.id);
          cascade.needsReplacing++;
        }
      }
      result.cascade = cascade;
      result.newTeam = dest.team;
      log(user.email, 'client.assign_coach', { clientId: cl.id, name: cl.name, coachId, ...cascade });
    } else {
      log(user.email, 'client.assign_coach', { clientId: cl.id, name: cl.name, coachId: null, note: 'unassigned — open visits left untouched' });
    }
  }
  if(body.name !== undefined && String(body.name).trim()){
    db.prepare('UPDATE clients SET name=? WHERE id=?').run(String(body.name).trim(), cl.id);
    log(user.email, 'client.rename', { clientId: cl.id, name: body.name });
  }
  send(res, 200, result);
});
/* ----- 30-day cancellation notice -----
   Purely a manual marker: someone read an email saying a dealership is quitting, with
   a 30-day notice — Keap itself keeps showing the subscription as active until the
   final invoice actually lapses, which can be well past when coaching should stop.
   This does NOT touch client/contract status (they're still a real active client
   through their last paid month) — it only stops scheduling work for them by clearing
   out their open visits. Deliberately a hard delete, not the usual soft-delete pattern,
   per how this was scoped: if a client rescinds notice, those visits get recreated by
   hand rather than restored. */
route('POST', /^\/api\/clients\/notice$/, ['admin','lead'], (req, res, m, body, user) => {
  const ids = Array.isArray(body.clientIds) ? [...new Set(body.clientIds.map(Number).filter(Boolean))] : [];
  if(!ids.length) return err(res, 400, 'clientIds required');
  const noticeDate = /^\d{4}-\d{2}-\d{2}$/.test(body.noticeDate || '') ? body.noticeDate : new Date().toISOString().slice(0,10);
  let clientsUpdated = 0, visitsDeleted = 0;
  const results = [];
  for(const id of ids){
    const cl = db.prepare('SELECT * FROM clients WHERE id=? AND deleted_at IS NULL').get(id);
    if(!cl) continue;
    db.prepare('UPDATE clients SET notice_given_date=? WHERE id=?').run(noticeDate, cl.id);
    const del = db.prepare('DELETE FROM visits WHERE client_id=? AND completed=0').run(cl.id);
    clientsUpdated++;
    visitsDeleted += del.changes;
    results.push({ clientId: cl.id, name: cl.name, visitsDeleted: del.changes });
  }
  log(user.email, 'client.give_notice', { noticeDate, clientsUpdated, visitsDeleted, clients: results.map(r => r.name) });
  send(res, 200, { ok: true, clientsUpdated, visitsDeleted, results });
});
route('POST', /^\/api\/clients\/(\d+)\/notice\/clear$/, ['admin','lead'], (req, res, m, body, user) => {
  const cl = db.prepare('SELECT * FROM clients WHERE id=?').get(+m[1]);
  if(!cl) return err(res, 404, 'not found');
  // Clears the marker only — does not recreate any visits that were removed when
  // notice was given. Use this when notice was entered on the wrong client, or a
  // client rescinds and coaching resumes (schedule their next visits normally after).
  db.prepare('UPDATE clients SET notice_given_date=NULL WHERE id=?').run(cl.id);
  log(user.email, 'client.notice_clear', { clientId: cl.id, name: cl.name });
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
    const objectId = extractKeapObjectId(evt);

    const eventRow = db.prepare('INSERT INTO keap_events(ts,event_key,object_id,raw) VALUES(?,?,?,?)')
      .run(new Date().toISOString(), eventKey || '(unknown)', objectId != null ? String(objectId) : '', JSON.stringify(evt).slice(0, 4000));

    try{
      let result = null;
      if(eventKey === 'subscription.add' && objectId){
        result = await onSubscriptionAdd(objectId);
      } else if((eventKey === 'subscription.edit' || eventKey === 'subscription.delete') && objectId){
        result = await onSubscriptionChange(objectId, eventKey);
      }
      // other event keys (contact.*, order.*, invoice.*) are logged to keap_events but not
      // acted on yet — safe to extend here later.
      recordKeapEventOutcome(eventRow.lastInsertRowid, result);
    }catch(e){
      // Never let one bad event take down the batch (or silently vanish) — the raw
      // payload is already saved above, so it's always reprocessable once the bug's fixed.
      console.error('keap webhook: failed to handle event', eventKey, objectId, e);
      db.prepare('UPDATE keap_events SET handled=? WHERE id=?').run('error: ' + String(e && e.message || e).slice(0, 200), eventRow.lastInsertRowid);
    }
  }
  send(res, 200, { ok: true });
}
/* Turns whatever onSubscriptionAdd/onSubscriptionChange returned into the two
 * columns the Admin diagnostics table shows: a plain-English handled status, and
 * a resolved company/client name (blank if nothing could be resolved — itself a
 * useful signal that the Keap lookup failed rather than that nothing happened). */
function recordKeapEventOutcome(eventId, result){
  const handled = !result ? 'ok — no action needed for this event type'
    : result.error ? 'error: ' + result.error
    : result.skipped ? 'skipped — ' + (result.reason || 'already handled')
    : result.found === false ? 'no matching contract found (still pending, or unrelated)'
    : 'ok';
  const companyName = (result && (result.companyName || result.clientName)) || '';
  db.prepare('UPDATE keap_events SET handled=?, company_name=? WHERE id=?').run(handled, companyName, eventId);
}
/* Keap's REST hooks send object_keys as an array of OBJECTS (e.g. {id, apiUrl}),
 * not bare IDs — a payload-shape assumption we got wrong on first build, which
 * silently swallowed every subscription.add/edit event (object_id stored as the
 * literal string "[object Object]", and the downstream Keap API call built from it
 * always 404'd). Unwrap whatever shape shows up rather than assuming one. */
function extractKeapObjectId(evt){
  const raw = (evt.object_keys && evt.object_keys[0]) ?? (evt.objectKeys && evt.objectKeys[0]) ?? evt.object_key ?? evt.id ?? evt.subscription_id ?? null;
  if(raw != null && typeof raw === 'object') return raw.id ?? raw.objectId ?? raw.object_id ?? raw.key ?? null;
  return raw;
}

/* Shared by the webhook path (which has only a subscription ID and must fetch it)
 * and the backfill sweep below (which already has the full subscription object from
 * a list call, so it skips the redundant single-subscription fetch). Both funnel
 * through here so "what counts as already tracked" and "how we enrich company/contact
 * name" only ever lives in one place. */
/* Not every subscription in the Keap account is one of ours — only the real
 * "Sub - Chris Collins' Signature Coaching" product should ever land in Unassigned
 * Clients. Matched loosely (lowercased, punctuation-tolerant substring check) rather
 * than an exact string, so a stray apostrophe/quote-character difference in Keap
 * doesn't silently break the filter. */
function isCoachingSubscriptionProduct(name){
  const n = String(name || '').toLowerCase();
  return n.includes('chris collins') && n.includes('signature coaching');
}
async function keapGetProductName(s){
  const pid = s.product_id || s.subscription_plan_id;
  if(!pid) return '';
  // Resolved through the cached list-based lookup (keapFindProductById, defined
  // below) rather than a direct /v1/products/{id} fetch — see the comment on that
  // function for why: the single-item GET pattern is already proven broken for
  // subscriptions on this account, so this never trusts it for products either.
  const r = await keapFindProductById(pid);
  if(!r.ok) return '';
  const pj = r.json || {};
  return pj.product_name || pj.name || '';
}
async function queueSubscriptionAsPending(s, opts = {}){
  const subId = String(s.id);
  const existingContract = db.prepare('SELECT id FROM contracts WHERE keap_subscription_id=?').get(subId);
  if(existingContract) return { subId, skipped: true, reason: 'already has a real contract' };
  const already = db.prepare('SELECT id FROM pending_clients WHERE keap_subscription_id=?').get(subId);
  // Normal webhook/backfill delivery: a pending item already queued (even a blank/
  // placeholder one from a past failed lookup) is left alone — don't silently re-run
  // enrichment on every retry. opts.force (used by the admin "Reprocess" button)
  // overrides this on purpose: a human explicitly asked to re-fetch and refresh it.
  if(already && !opts.force) return { subId, skipped: true, reason: 'already queued' };

  // Only real, currently-active Signature Coaching subscriptions belong in Unassigned
  // Clients — anything cancelled, or any other Keap product entirely, is skipped here
  // (not an error — most subscriptions in the account are expected to not match).
  if(!s.active) return { subId, skipped: true, reason: 'subscription is cancelled/inactive' };
  const productName = await keapGetProductName(s);
  if(!isCoachingSubscriptionProduct(productName)){
    return { subId, skipped: true, reason: `product "${productName || '(unknown product)'}" is not Chris Collins' Signature Coaching` };
  }

  let companyName = '', contactName = '';
  if(s.contact_id){
    const c = await keapGet(`/v1/contacts/${s.contact_id}?optional_properties=company`);
    if(c.ok){
      const cj = c.json || {};
      companyName = cj.company?.company_name || '';
      contactName = [cj.given_name, cj.family_name].filter(Boolean).join(' ');
    }
  }
  db.prepare(`INSERT INTO pending_clients
    (keap_subscription_id,keap_contact_id,keap_company_id,company_name,contact_name,product_desc,billing_amount,billing_cycle,billing_frequency,start_date,status,created)
    VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)
    ON CONFLICT(keap_subscription_id) DO UPDATE SET
      keap_contact_id=excluded.keap_contact_id, keap_company_id=excluded.keap_company_id,
      company_name=excluded.company_name, contact_name=excluded.contact_name,
      product_desc=excluded.product_desc, billing_amount=excluded.billing_amount,
      billing_cycle=excluded.billing_cycle, billing_frequency=excluded.billing_frequency,
      start_date=excluded.start_date, status='pending'
    WHERE pending_clients.status != 'assigned'`)
    .run(subId, s.contact_id ? String(s.contact_id) : null, s.contact_id_company || '', companyName, contactName,
      productName || (s.subscription_plan_id ? String(s.subscription_plan_id) : (s.product_id ? String(s.product_id) : '')),
      Number(s.billing_amount) || null, s.billing_cycle || '', s.billing_frequency || null, s.start_date || null,
      new Date().toISOString());
  log('keap.webhook', 'pendingclient.queued', { subId, companyName, contactName, productName, forced: !!opts.force });
  return { subId, companyName, contactName, startDate: s.start_date || null, active: !!s.active, productName };
}
/* Keap's REST v1 "get one subscription by id" endpoint (GET /v1/subscriptions/{id})
 * does not work against this account — confirmed directly: it 404s even for an id
 * the LIST endpoint just proved exists, with or without a trailing slash, and an
 * `?id=` query filter is silently ignored (Keap just returns its default full list).
 * The list endpoint itself works fine and returns every field we need (contact_id,
 * billing_amount, billing_cycle, product_id, start_date, active), so every lookup
 * that used to be a single-item fetch now finds its record in a cached full listing
 * instead. Cache is short-lived (60s) so a burst of webhook events for the same
 * moment in time shares one Keap round-trip instead of re-listing per event.
 */
let _subsCache = { at: 0, subs: null };
async function keapFindSubscriptionById(subId, opts = {}){
  const now = Date.now();
  if(opts.force || !_subsCache.subs || (now - _subsCache.at) > 60000){
    const listing = await keapListAllSubscriptions();
    if(!listing.ok) return { ok:false, error: listing.error };
    _subsCache = { at: now, subs: listing.subs };
  }
  const match = _subsCache.subs.find(s => String(s.id) === String(subId));
  if(!match){
    // One retry with a forced fresh list — covers the case where this is a
    // brand-new subscription created after our cache snapshot.
    if(!opts._retried){
      return keapFindSubscriptionById(subId, { force: true, _retried: true });
    }
    return { ok:false, status: 404, error: 'not found in Keap subscriptions list' };
  }
  return { ok:true, status: 200, json: match };
}
async function onSubscriptionAdd(subId, opts = {}){
  const sub = await keapFindSubscriptionById(subId);
  if(!sub.ok) return { subId, error: `keap lookup failed (${sub.error || sub.status}) — nothing was queued or changed` };
  return queueSubscriptionAsPending({ ...(sub.json || {}), id: subId }, opts);
}
/* Same list-based fix as keapFindSubscriptionById above, applied to products — Keap's
 * single-item "get one product by id" may have the same broken-GET-by-id shape we
 * already proved for subscriptions, so keapGetProductName below never trusts a direct
 * /v1/products/{id} fetch; it always resolves through this cached full listing. */
let _productsCache = { at: 0, products: null };
async function keapListAllProducts(){
  const PAGE = 200, MAX_PAGES = 25;
  const all = [];
  let offset = 0, hitCap = false;
  for(let page = 0; page < MAX_PAGES; page++){
    const r = await keapGet(`/v1/products?limit=${PAGE}&offset=${offset}`);
    if(!r.ok) return { ok:false, error: `Keap returned an error (HTTP ${r.status || 'network'}) while listing products.` };
    const batch = (r.json && (r.json.products || r.json.results)) || (Array.isArray(r.json) ? r.json : []);
    all.push(...batch);
    if(batch.length < PAGE) break;
    offset += PAGE;
    if(page === MAX_PAGES - 1) hitCap = true;
  }
  return { ok:true, products: all, hitCap };
}
async function keapFindProductById(productId, opts = {}){
  if(!productId) return { ok:false, status:400, error:'no product id' };
  const now = Date.now();
  if(opts.force || !_productsCache.products || (now - _productsCache.at) > 60000){
    const listing = await keapListAllProducts();
    if(!listing.ok) return { ok:false, error: listing.error };
    _productsCache = { at: now, products: listing.products };
  }
  const match = _productsCache.products.find(p => String(p.id) === String(productId));
  if(!match){
    if(!opts._retried) return keapFindProductById(productId, { force: true, _retried: true });
    return { ok:false, status: 404, error: 'not found in Keap products list' };
  }
  return { ok:true, status: 200, json: match };
}
/* Product names encode the real visit cadence in words (e.g. "...and Quarterly
 * Live-in-Drive") — that's the authoritative source, since a subscription can be
 * BILLED monthly for a program that's actually visited quarterly (billing_cycle
 * reflects payment frequency, not visit frequency). Only falls back to the
 * billing-cycle guess when the product name has no cadence keyword at all. */
function programFromProductName(name){
  const n = String(name || '').toLowerCase();
  if(n.includes('bi-annual') || n.includes('biannual') || n.includes('semi-annual')) return 'Bi-Annual';
  if(n.includes('semi-monthly') || n.includes('semimonthly')) return 'Semi-Monthly';
  if(n.includes('quarterly')) return 'Quarterly';
  if(n.includes('monthly')) return 'Monthly';
  return null;
}
async function suggestProgramForSubscription(sub){
  const name = await keapGetProductName(sub);
  const fromName = programFromProductName(name);
  if(fromName) return { guessed: fromName, basis: `the product name ("${name}")` };
  return { guessed: guessProgramFromCycle(sub.billing_cycle, sub.billing_frequency), basis: 'the billing cycle (no cadence keyword found in the product name)' };
}

/* ---------- backfill sweep: catch anything the webhook ever missed ----------
   Keap's list endpoints don't reliably support a "since" filter we could trust, so
   rather than guess at query params, this pulls every subscription in the account
   (paginated) and diffs it against what the app already knows. Anything with no
   matching contract AND no matching pending_clients row — whether it's a few weeks
   old (a webhook that silently failed) or start-dated in the future (added ahead of
   time) — gets queued exactly like a live webhook would. Nothing here overwrites an
   already-tracked item; that's what the per-event Reprocess button is for. */
async function keapListAllSubscriptions(){
  const PAGE = 200, MAX_PAGES = 25; // 5,000-subscription ceiling — generous for this account size
  const all = [];
  let offset = 0, hitCap = false;
  for(let page = 0; page < MAX_PAGES; page++){
    const r = await keapGet(`/v1/subscriptions?limit=${PAGE}&offset=${offset}`);
    if(!r.ok) return { ok:false, error: `Keap returned an error (HTTP ${r.status || 'network'}) while listing subscriptions.` };
    const batch = (r.json && (r.json.subscriptions || r.json.results)) || (Array.isArray(r.json) ? r.json : []);
    all.push(...batch);
    if(batch.length < PAGE) break;
    offset += PAGE;
    if(page === MAX_PAGES - 1) hitCap = true;
  }
  return { ok:true, subs: all, hitCap };
}
route('POST', /^\/api\/admin\/keap-backfill-subscriptions$/, ['admin'], async (req, res, m, body, user) => {
  if(!KEAP_TOKEN) return err(res, 400, 'KEAP_TOKEN is not configured on this server.');
  const listing = await keapListAllSubscriptions();
  if(!listing.ok) return err(res, 502, listing.error);
  const summary = { checked: listing.subs.length, queued: [], alreadyTracked: 0, notCoachingProduct: 0, cancelled: 0, errors: [], hitPageCap: !!listing.hitCap };
  for(const s of listing.subs){
    try{
      const r = await queueSubscriptionAsPending(s, { force: false });
      if(r.error) summary.errors.push(`sub ${r.subId}: ${r.error}`);
      else if(r.skipped){
        if(r.reason === 'subscription is cancelled/inactive') summary.cancelled++;
        else if(r.reason && r.reason.startsWith('product ')) summary.notCoachingProduct++;
        else summary.alreadyTracked++;
      } else summary.queued.push({ subId: r.subId, companyName: r.companyName, contactName: r.contactName, startDate: r.startDate, active: r.active, productName: r.productName });
    }catch(e){ summary.errors.push(`sub ${s.id}: ${String(e && e.message || e)}`); }
    await new Promise(r => setTimeout(r, 100)); // stay well under Keap's rate limit — contact lookups add up across a full sweep
  }
  log(user.email, 'keap.backfill_subscriptions', { checked: summary.checked, queuedCount: summary.queued.length, alreadyTracked: summary.alreadyTracked, notCoachingProduct: summary.notCoachingProduct, cancelled: summary.cancelled, errorCount: summary.errors.length });
  send(res, 200, summary);
});

async function onSubscriptionChange(subId, eventKey, opts = {}){
  const source = opts.source || 'keap.webhook';
  const isDelete = eventKey === 'subscription.delete';
  const sub = await keapFindSubscriptionById(subId);
  // For a delete event, Keap already told us via the event itself — the subscription
  // may legitimately be gone from the list once deleted, so we don't need a successful
  // lookup to act on it. For anything else (edit events, or a manual sync poll), a
  // failed lookup — timeout, network blip, genuinely not found — must NOT be read as
  // "inactive". Report it and touch nothing.
  if(!isDelete && !sub.ok){
    return { subId, found: false, error: `keap lookup failed (${sub.error || sub.status})` };
  }
  const s = sub.json || {};
  const contract = db.prepare('SELECT * FROM contracts WHERE keap_subscription_id=?').get(String(subId));
  const stillActive = isDelete ? false : !!s.active;

  if(!contract){
    // Might be a subscription that's still in the pending queue (never assigned yet) — ignore/remove it if cancelled.
    const pc = db.prepare('SELECT company_name FROM pending_clients WHERE keap_subscription_id=?').get(String(subId));
    if(!stillActive) db.prepare("UPDATE pending_clients SET status='ignored' WHERE keap_subscription_id=?").run(String(subId));
    return { subId, found: false, companyName: pc && pc.company_name || '' };
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
  return { subId, found: true, statusChanged, priceChanged, clientName: client ? client.name : '' };
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
          // Sliding idle window: refresh the cookie timestamp once it's over an hour old
          if(user._cookieAge > 60*60*1000) res.setHeader('Set-Cookie', sessionCookie(String(user.id)));
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
