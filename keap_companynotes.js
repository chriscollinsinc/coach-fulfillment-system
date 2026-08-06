#!/usr/bin/env node
/*
 * Keap Classic — Company Notes access probe (Phase 2, step 6)
 * -----------------------------------------------------------
 * Read-only. Runs on YOUR machine. Token stays local, redacted from output.
 *
 * We learned from the Suski Chevrolet screenshot (CompanyID 61275) that LID
 * completions live in COMPANY NOTES titled like "Mar 2026 LID Recap Email To GM"
 * and monthly coaching calls as "Jun 2026 CC Recap". The contact-notes REST endpoint
 * (/v1/notes) never returns these. This probe hunts for the endpoint that DOES, and
 * verifies it by finding that known "LID Recap" title on company 61275.
 *
 * ── RUN ────────────────────────────────────────────────────────────────────────
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' node keap_companynotes.js
 *
 * Optional: probe a different company id:
 *   KEAP_TOKEN='...' KEAP_COMPANY_ID=61275 node keap_companynotes.js
 * ────────────────────────────────────────────────────────────────────────────────
 */
'use strict';
const fs = require('node:fs');

const TOKEN = process.env.KEAP_TOKEN;
const BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
const CID = process.env.KEAP_COMPANY_ID || '61275'; // Suski Chevrolet Buick
if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_companynotes.js\n"); process.exit(1); }
const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' };
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');

async function get(path) {
  const r = await fetch(BASE + path, { headers: H });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { ok: r.ok, status: r.status, json: j, text: t };
}
const hasRecap = t => /recap|lid recap/i.test(t || '');

(async () => {
  const out = { ranAt: new Date().toISOString(), companyId: CID, endpointTests: [] };
  console.log(`Probing Company Notes access for company ${CID}…\n`);

  // A) battery of candidate company-notes endpoints
  const candidates = [
    `/v1/companies/${CID}`,
    `/v1/companies/${CID}?optional_properties=custom_fields`,
    `/v1/companies/${CID}/notes`,
    `/v2/companies/${CID}`,
    `/v2/companies/${CID}/notes?page_size=50`,
    `/v2/companies/${CID}/notes`,
  ];
  for (const path of candidates) {
    const r = await get(path);
    const recapInBody = hasRecap(r.text);
    out.endpointTests.push({
      path, status: r.status, ok: r.ok,
      bytes: r.text.length,
      mentionsRecap: recapInBody,
      topKeys: r.json && !Array.isArray(r.json) ? Object.keys(r.json).slice(0, 25) : null,
      snippet: r.ok ? null : redact(r.text).slice(0, 160),
    });
    console.log(`  ${r.ok ? '✓' : '·'} ${path} → HTTP ${r.status}${recapInBody ? '   *** contains "Recap" ***' : ''}`);
  }

  // B) inspect v2 notes schema — does a note carry a company link?
  const v2 = await get('/v2/notes?page_size=5');
  const v2notes = (v2.json && (v2.json.notes || v2.json.results)) || [];
  out.v2NotesSchema = { status: v2.status, keys: v2notes[0] ? Object.keys(v2notes[0]) : null, sample: v2notes[0] ? JSON.parse(redact(JSON.stringify(v2notes[0]))) : null };
  console.log(`\n  v2 /notes → HTTP ${v2.status}; note keys: ${v2notes[0] ? Object.keys(v2notes[0]).join(', ') : '(none)'}`);

  // C) does a v2 note filter by company work? (v1 company_id was ignored on notes)
  const v2f = await get(`/v2/notes?filter=company_id==${CID}&page_size=25`);
  const v2fList = (v2f.json && (v2f.json.notes || v2f.json.results)) || [];
  const recapHits = v2fList.filter(n => hasRecap(n.title));
  out.v2NotesCompanyFilter = {
    status: v2f.status, pulled: v2fList.length,
    recapTitles: recapHits.map(n => n.title).slice(0, 20),
    sample: v2fList.slice(0, 3).map(n => JSON.parse(redact(JSON.stringify(n)))),
  };
  console.log(`  v2 /notes?filter=company_id==${CID} → HTTP ${v2f.status}, ${v2fList.length} notes, ${recapHits.length} with "Recap"`);
  if (recapHits.length) recapHits.slice(0, 8).forEach(n => console.log(`       • ${n.title}`));

  fs.writeFileSync('keap_companynotes.json', JSON.stringify(out, null, 2));
  const win = out.endpointTests.find(e => e.mentionsRecap) || (recapHits.length ? 'v2 company filter' : null);
  console.log(`\n${win ? '✓ Found a path that returns the Recap notes.' : '✗ No endpoint returned the company Recap notes — we\'ll need XML-RPC or an export.'}`);
  console.log('Wrote keap_companynotes.json — safe to share. Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
