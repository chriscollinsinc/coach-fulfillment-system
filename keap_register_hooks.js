#!/usr/bin/env node
/*
 * Keap Classic — register subscription webhooks pointing at the deployed app
 * ----------------------------------------------------------------------------
 * Run this ONCE, after the app is deployed and reachable at a public HTTPS URL.
 * Registers (or repoints existing) hooks for subscription.add / .edit / .delete
 * to https://<your-app>/api/webhooks/keap.
 *
 * Your account already has these three event keys registered (currently pointed
 * at an old chriscollins.macanta.org integration, inactive) — this script repoints
 * them to the new app instead of creating duplicates.
 *
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' APP_URL='https://your-app.onrender.com' node keap_register_hooks.js
 */
'use strict';
const TOKEN = process.env.KEAP_TOKEN;
const APP_URL = process.env.APP_URL;
const BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
if (!TOKEN) { console.error("\n✗ No token. Set KEAP_TOKEN.\n"); process.exit(1); }
if (!APP_URL) { console.error("\n✗ Set APP_URL to your deployed app's public URL, e.g. https://your-app.onrender.com\n"); process.exit(1); }
const hookUrl = APP_URL.replace(/\/$/, '') + '/api/webhooks/keap';

async function get(p){ const r = await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' } }); return { ok:r.ok, status:r.status, json: await r.json().catch(()=>null) }; }
async function post(p, body){ const r = await fetch(BASE + p, { method:'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type':'application/json', Accept:'application/json' }, body: JSON.stringify(body) }); return { ok:r.ok, status:r.status, json: await r.json().catch(()=>null) }; }
async function del(p){ const r = await fetch(BASE + p, { method:'DELETE', headers: { Authorization: 'Bearer ' + TOKEN } }); return { ok:r.ok, status:r.status }; }

(async () => {
  console.log('Target webhook URL:', hookUrl, '\n');
  const existing = await get('/v1/hooks');
  const hooks = existing.json || [];
  const wanted = ['subscription.add', 'subscription.edit', 'subscription.delete'];

  for (const eventKey of wanted) {
    const already = hooks.find(h => h.eventKey === eventKey && h.hookUrl === hookUrl);
    if (already) { console.log(`✓ ${eventKey} already points here (status: ${already.status})`); continue; }

    // remove any old registration for this event key pointed elsewhere (avoid dupes)
    const stale = hooks.filter(h => h.eventKey === eventKey && h.hookUrl !== hookUrl);
    for (const s of stale) {
      const d = await del(`/v1/hooks/${s.key}`);
      console.log(d.ok ? `  removed stale ${eventKey} hook -> ${s.hookUrl}` : `  (could not remove stale hook ${s.key}: ${d.status})`);
    }

    const r = await post('/v1/hooks', { hookUrl, eventKey });
    if (r.ok) console.log(`✓ registered ${eventKey} — status: ${r.json?.status || 'pending verification'}`);
    else console.log(`✗ failed to register ${eventKey}: status ${r.status} ${JSON.stringify(r.json)}`);
  }

  console.log('\nKeap should now POST a verification ping to your app for each new hook.');
  console.log('The app auto-verifies it (see server.js handleKeapWebhook). Re-run this script');
  console.log('and check /v1/hooks status is "Verified" for all three to confirm it worked.');
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
