#!/usr/bin/env node
/*
 * Keap Classic — webhook event-key + existing-hooks probe
 * ---------------------------------------------------------
 * Read-only. Runs on YOUR machine. Token stays local, redacted from output.
 */
'use strict';
const fs = require('node:fs');
const TOKEN = process.env.KEAP_TOKEN;
const BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_hooks_probe.js\n"); process.exit(1); }
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');
async function get(path) {
  const r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' } });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { ok: r.ok, status: r.status, json: j, raw: redact(t).slice(0, 2000) };
}
(async () => {
  const out = {};
  console.log('Fetching available event keys…');
  const keys = await get('/v1/hooks/event-keys');
  out.eventKeys = keys.json;
  console.log(keys.ok ? `  ✓ ${JSON.stringify(keys.json)}` : `  ✗ status ${keys.status}: ${keys.raw}`);

  console.log('\nFetching existing hooks…');
  const hooks = await get('/v1/hooks');
  out.existingHooks = hooks.json;
  console.log(hooks.ok ? `  ✓ ${JSON.stringify(hooks.json)}` : `  ✗ status ${hooks.status}: ${hooks.raw}`);

  fs.writeFileSync('keap_hooks_probe.json', JSON.stringify(out, null, 2));
  console.log('\nWrote keap_hooks_probe.json — safe to share. Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
