#!/usr/bin/env node
/*
 * Keap Classic — full note dump for a few real coaching clients (Phase 2, step 3)
 * -------------------------------------------------------------------------------
 * Read-only. Runs on YOUR machine. Token stays local, redacted from all output.
 *
 * Why: the roster sampler only saw each company's OLDEST 100 notes (Keap returns
 * notes oldest-first), which are old web-form/automation entries — so the recent
 * "Month Year LID" completion notes never showed up. This pulls EVERY note for a
 * few known-active dealerships, then shows the real title patterns so we can build
 * a parser that matches the actual completion notes.
 *
 * ── RUN ────────────────────────────────────────────────────────────────────────
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' node keap_notes.js
 *
 * Defaults to 3 clients (Acura of Highland Park, AutoMaxx CDJR, Bill Jacobs BMW/MINI).
 * Override with a comma-separated list of company ids:
 *   KEAP_TOKEN='...' KEAP_COMPANY_IDS=349958,158567 node keap_notes.js
 * ────────────────────────────────────────────────────────────────────────────────
 */
'use strict';
const fs = require('node:fs');

const TOKEN = process.env.KEAP_TOKEN;
const BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
const IDS = (process.env.KEAP_COMPANY_IDS || '288678,349958,28513').split(',').map(s => s.trim()).filter(Boolean);

if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_notes.js\n"); process.exit(1); }
const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' };
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');

async function get(path) {
  const r = await fetch(BASE + path, { headers: H });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { ok: r.ok, status: r.status, json: j, raw: j ? null : redact(t).slice(0, 200) };
}

// normalize a title into a "shape" so we can histogram patterns
const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;
const shapeOf = t => String(t || '')
  .replace(MONTHS, 'MON').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 60);
// candidate "this is a LID completion note" detector
const looksLID = t => /\blid\b/i.test(t || '') ||
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*'?\d{2,4}\b/i.test(t || '');

async function allNotes(companyId) {
  const notes = []; let offset = 0;
  while (true) {
    const r = await get(`/v1/notes?company_id=${companyId}&limit=1000&offset=${offset}`);
    if (!r.ok) { console.log(`   notes page failed HTTP ${r.status} ${r.raw || ''}`); break; }
    const batch = r.json.notes || [];
    notes.push(...batch);
    offset += batch.length;
    if (!batch.length || (r.json.count != null && offset >= r.json.count)) break;
    if (offset > 20000) break; // safety
  }
  return notes;
}

(async () => {
  const out = { ranAt: new Date().toISOString(), companies: [] };

  // users map for attribution
  const u = await get('/v1/users?limit=1000');
  const userName = {};
  for (const x of (u.json?.users || [])) userName[x.id] = [x.given_name, x.family_name].filter(Boolean).join(' ') || x.email_address || ('user#' + x.id);

  for (const id of IDS) {
    console.log(`\nCompany ${id}: pulling all notes…`);
    const notes = await allNotes(id);
    console.log(`  ${notes.length} notes total.`);

    // title-shape histogram
    const shapes = {};
    for (const n of notes) { const s = shapeOf(n.title); shapes[s] = (shapes[s] || 0) + 1; }
    const topShapes = Object.entries(shapes).sort((a, b) => b[1] - a[1]).slice(0, 25);

    // recent notes (by last_updated desc)
    const recent = notes.slice().sort((a, b) => String(b.last_updated || '').localeCompare(String(a.last_updated || ''))).slice(0, 20);

    // LID candidates
    const lids = notes.filter(n => looksLID(n.title));

    out.companies.push({
      companyId: id,
      totalNotes: notes.length,
      titleShapes: topShapes.map(([shape, count]) => ({ shape, count })),
      recentNotes: recent.map(n => ({
        title: n.title, type: n.type, last_updated: n.last_updated, date_created: n.date_created,
        user_id: n.user_id, user_name: userName[n.user_id] || null, contact_id: n.contact_id,
      })),
      lidCandidates: lids.map(n => ({
        id: n.id, title: n.title, type: n.type,
        user_id: n.user_id, user_name: userName[n.user_id] || null,
        date_created: n.date_created, last_updated: n.last_updated, contact_id: n.contact_id,
        body_snippet: redact((n.body || '').slice(0, 200)),
      })),
    });
    console.log(`  ${lids.length} notes look like LID/month-year completion notes.`);
    console.log('  top title shapes:');
    for (const [shape, count] of topShapes.slice(0, 8)) console.log(`     ${String(count).padStart(4)}  ${shape}`);
  }

  fs.writeFileSync('keap_notes.json', JSON.stringify(out, null, 2));
  console.log('\n✓ Wrote keap_notes.json — safe to share (data only). Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
