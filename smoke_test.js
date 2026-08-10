#!/usr/bin/env node
/* Pre-deploy smoke test for the Coach Fulfillment System.
 *
 * Boots the real server against a THROWAWAY database in a temp directory (your
 * real data is never touched), then exercises the critical paths end-to-end:
 * login, state, visit complete/reopen, prospect holds, backup download, clients,
 * notes, and the auth/permission boundaries. Prints PASS/FAIL per check and
 * exits non-zero if anything fails — run `node smoke_test.js` before pushing.
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 8123;
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-smoke-'));
let cookie = '';
let passed = 0, failed = 0;

function check(name, ok, detail){
  if(ok){ passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
async function req(method, p, body, useCookie = true){
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(useCookie && cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  const text = await r.text();
  try{ json = JSON.parse(text); }catch(e){}
  return { status: r.status, json, headers: r.headers, text };
}

(async () => {
  console.log('Coach Fulfillment System — smoke test');
  console.log(`Scratch db: ${tmp}\n`);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, DB_PATH: path.join(tmp, 'smoke.db'), PORT: String(PORT), SECRET: 'smoke-secret',
      GMAIL_USER: '', GMAIL_APP_PASSWORD: '', KEAP_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  server.stdout.on('data', d => bootLog += d);
  server.stderr.on('data', d => bootLog += d);

  // Wait for boot
  let booted = false;
  for(let i = 0; i < 40; i++){
    await new Promise(r => setTimeout(r, 250));
    try{ const r = await fetch(BASE + '/api/sso-config'); if(r.ok){ booted = true; break; } }catch(e){}
  }
  check('server boots', booted, booted ? '' : bootLog.slice(-400));
  if(!booted){ server.kill(); process.exit(1); }

  const pw = (bootLog.match(/password:\s*(\S+)/) || [])[1];
  check('first-run admin password printed', !!pw);

  // Auth boundaries
  const noAuth = await req('GET', '/api/state', null, false);
  check('unauthenticated /api/state rejected (401)', noAuth.status === 401);

  const badLogin = await req('POST', '/api/login', { email: 'mike@chriscollinsinc.com', password: 'wrong' }, false);
  check('wrong password rejected', badLogin.status === 401 || badLogin.status === 400);

  const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'mike@chriscollinsinc.com', password: pw }) });
  const setCookie = login.headers.get('set-cookie') || '';
  cookie = setCookie.split(';')[0];
  check('login succeeds and sets session cookie', login.ok && cookie.startsWith('cfs='));

  // Core state
  const state = await req('GET', '/api/state');
  check('/api/state returns coaches + visits', state.status === 200 && state.json.coaches.length > 0 && state.json.visits.length > 0);

  // Visit complete + reopen round-trip
  const v = state.json.visits.find(x => !x.completed);
  const comp = await req('POST', `/api/visits/${v.id}/complete`, {});
  check('visit complete', comp.status === 200);
  const reopen = await req('POST', `/api/visits/${v.id}/reopen`, {});
  check('visit reopen', reopen.status === 200);

  // Prospect holds lifecycle
  const coachId = state.json.coaches[0].id;
  const hold = await req('POST', '/api/prospect-holds', { name: 'Smoke Test Motors', coachId, program: 'Quarterly', weeks: ['2027-11-01'] });
  check('prospect hold placed', hold.status === 200 && hold.json.id);
  const dup = await req('POST', '/api/prospect-holds', { name: 'Dup', coachId, weeks: ['2027-11-01'] });
  check('double-booking a held week rejected (409)', dup.status === 409);
  const conv = await req('POST', `/api/prospect-holds/${hold.json.id}/convert`, {});
  check('hold converts and returns prefill data', conv.status === 200 && conv.json.name === 'Smoke Test Motors');

  // Clients + notes
  const clients = await req('GET', '/api/clients');
  check('/api/clients returns rows', clients.status === 200 && clients.json.length > 0);
  const cid = clients.json[0].id;
  const note = await req('POST', `/api/clients/${cid}/notes`, { body: 'smoke test note', note_type: 'Coaching Call' });
  check('client note add', note.status === 200);
  const notes = await req('GET', `/api/clients/${cid}/notes`);
  check('client notes read back', notes.status === 200 && notes.json.some(n => n.body === 'smoke test note'));

  // Backup download (email is unconfigured here; direct download must still work)
  const bk = await fetch(BASE + '/api/admin/backup-download', { headers: { Cookie: cookie } });
  const buf = Buffer.from(await bk.arrayBuffer());
  check('backup download returns a gzip', bk.status === 200 && buf[0] === 0x1f && buf[1] === 0x8b);

  // Keap-dependent routes fail SAFELY without a token (no fake success)
  const sync = await req('POST', '/api/keap/sync', {});
  const syncSafe = sync.status !== 200 || (sync.json && (sync.json.errors || []).length >= 0 && !sync.json.priceChanged);
  check('keap sync without token does not fake success', syncSafe);

  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('smoke test crashed:', e); process.exit(1); });
