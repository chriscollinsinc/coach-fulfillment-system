#!/usr/bin/env node
/*
 * Keap Classic — coaching-client roster + LID note sampler (Phase 2, step 2)
 * --------------------------------------------------------------------------
 * Runs on YOUR machine (needs internet to Keap). Read-only. Your token stays local
 * and is never written to the output or printed (it's redacted everywhere).
 *
 * What it does:
 *   1. Maps Keap user_id -> name (so we can read who a note is assigned to).
 *   2. Pages the whole company list (limit 1000) and buckets every company by the
 *      "Coaching Client" custom field: Active / Inactive / Not Selected.
 *   3. For a handful of ACTIVE coaching clients, pulls their notes and picks out the
 *      ones whose title contains "LID" — the real completion notes — so we can see
 *      the title variants and the assigned coach.
 *   4. Writes keap_roster.json (roster ids+names + sampled LID notes). No credentials.
 *
 * ── RUN ────────────────────────────────────────────────────────────────────────
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' node keap_roster.js
 *
 * Optional: sample notes from more companies (default 8):
 *   KEAP_TOKEN='...' KEAP_SAMPLE=15 node keap_roster.js
 * ────────────────────────────────────────────────────────────────────────────────
 */
'use strict';
const fs = require('node:fs');

const TOKEN = process.env.KEAP_TOKEN;
const BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
const SAMPLE_N = Math.max(1, +(process.env.KEAP_SAMPLE || 8));
const COACHING_FIELD_ID = 59; // discovered by keap_probe.js

if (!TOKEN) {
  console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_roster.js\n");
  process.exit(1);
}
const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' };
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');

async function get(path) {
  const url = path.startsWith('http') ? path : BASE + path;
  const r = await fetch(url, { headers: H });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!r.ok) return { ok: false, status: r.status, raw: redact(text).slice(0, 200) };
  return { ok: true, status: r.status, json };
}
// read a company's Coaching Client value out of its custom_fields array
const coachingValue = c => {
  const f = (c.custom_fields || []).find(x => x.id === COACHING_FIELD_ID);
  return f && f.content ? String(f.content) : 'Not Selected';
};

(async () => {
  const out = { ranAt: new Date().toISOString() };

  // 1) users map
  console.log('Fetching users…');
  const u = await get('/v1/users?limit=1000');
  const users = (u.json && u.json.users) || [];
  const userName = {};
  for (const x of users) userName[x.id] = [x.given_name, x.family_name].filter(Boolean).join(' ') || x.email_address || ('user#' + x.id);
  out.users = users.map(x => ({ id: x.id, name: userName[x.id], email: x.email_address }));
  console.log('  ' + users.length + ' users.');

  // 2) page all companies, bucket by Coaching Client
  console.log('Paging companies (this is the ~11 requests)…');
  const active = [], inactive = [];
  let offset = 0, total = null, pages = 0;
  while (true) {
    const r = await get(`/v1/companies?limit=1000&offset=${offset}&optional_properties=custom_fields`);
    if (!r.ok) { console.log('  page failed HTTP ' + r.status + ' ' + (r.raw || '')); break; }
    const list = r.json.companies || [];
    total = r.json.count ?? total;
    for (const c of list) {
      const v = coachingValue(c);
      if (v === 'Active') active.push({ id: c.id, name: c.company_name });
      else if (v === 'Inactive') inactive.push({ id: c.id, name: c.company_name });
    }
    pages++; offset += list.length;
    process.stdout.write(`\r  scanned ${offset}/${total ?? '?'}  → active ${active.length}, inactive ${inactive.length}`);
    if (!list.length || (total != null && offset >= total)) break;
    if (pages > 40) { console.log('\n  (stopped after 40 pages as a safety cap)'); break; }
  }
  console.log('');
  out.totalCompanies = total;
  out.activeClients = active.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  out.inactiveClients = inactive.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  console.log(`  Coaching clients: ${active.length} Active, ${inactive.length} Inactive (of ${total} companies).`);

  // 3) sample LID notes from the first N active clients
  console.log(`Sampling notes from ${Math.min(SAMPLE_N, active.length)} active clients…`);
  const isLID = t => /\blid\b/i.test(t || '');
  out.lidNoteSamples = [];
  const titleShapes = new Set();
  for (const c of active.slice(0, SAMPLE_N)) {
    const r = await get(`/v1/notes?company_id=${c.id}&limit=100`);
    const notes = (r.ok && r.json.notes) || [];
    const lids = notes.filter(n => isLID(n.title));
    for (const n of lids) titleShapes.add(n.title);
    out.lidNoteSamples.push({
      company: { id: c.id, name: c.name },
      totalNotes: notes.length,
      lidNotes: lids.map(n => ({
        id: n.id, title: n.title,
        user_id: n.user_id, user_name: userName[n.user_id] || null,
        date_created: n.date_created, last_updated: n.last_updated,
        contact_id: n.contact_id,
        body_snippet: redact((n.body || '').slice(0, 160)),
      })),
    });
    console.log(`  ${c.name}: ${notes.length} notes, ${lids.length} with "LID" in title.`);
  }
  out.distinctLidTitles = [...titleShapes];

  fs.writeFileSync('keap_roster.json', JSON.stringify(out, null, 2));
  console.log('\n✓ Wrote keap_roster.json — safe to share (data only, no token).');
  console.log(`  Distinct LID note titles seen: ${titleShapes.size}. Tell Claude it's ready.`);
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
