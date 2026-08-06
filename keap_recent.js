#!/usr/bin/env node
/*
 * Keap Classic — NEWEST notes puller (Phase 2, step 5)
 * ----------------------------------------------------
 * Read-only. Runs on YOUR machine. Token stays local, redacted from output.
 *
 * Why: earlier dumps returned the OLDEST notes (2016-2018). To see today's completion
 * template we need the most RECENT notes. This reads the total count, jumps to the tail
 * of the list, and also tries a `since` filter, then shows the current title patterns +
 * the newest samples so we can build a reliable completion detector.
 *
 * ── RUN ────────────────────────────────────────────────────────────────────────
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' node keap_recent.js
 * ────────────────────────────────────────────────────────────────────────────────
 */
'use strict';
const fs = require('node:fs');

const TOKEN = process.env.KEAP_TOKEN;
const BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_recent.js\n"); process.exit(1); }
const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' };
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');

async function get(path) {
  const r = await fetch(BASE + path, { headers: H });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { ok: r.ok, status: r.status, json: j, raw: j ? null : redact(t).slice(0, 200) };
}
const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;
const shapeOf = t => String(t || '').replace(MONTHS, 'MON').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 70);

(async () => {
  const out = { ranAt: new Date().toISOString() };

  // users map
  const u = await get('/v1/users?limit=1000');
  const userName = {};
  for (const x of (u.json?.users || [])) userName[x.id] = [x.given_name, x.family_name].filter(Boolean).join(' ') || x.email_address || ('user#' + x.id);

  // total count
  const head = await get('/v1/notes?limit=1');
  const count = head.json && head.json.count;
  console.log('Total notes on account:', count);
  out.totalNotes = count;

  let recent = [];

  // A) try a `since` filter for the last ~9 months (works if supported)
  const since = new Date(Date.now() - 280 * 864e5).toISOString();
  const s = await get(`/v1/notes?limit=200&since=${encodeURIComponent(since)}`);
  const sList = (s.ok && s.json.notes) || [];
  const sMax = sList.reduce((a, n) => (n.last_updated > a ? n.last_updated : a), '');
  console.log(`A) since=${since.slice(0,10)} → HTTP ${s.status}, ${sList.length} notes, newest ${sMax || 'n/a'}`);
  out.sinceProbe = { status: s.status, pulled: sList.length, newest: sMax };

  // B) tail of the list by offset (newest if list is ascending)
  if (count) {
    const start = Math.max(0, count - 2000);
    let offset = start;
    while (offset < count) {
      const r = await get(`/v1/notes?limit=1000&offset=${offset}`);
      const batch = (r.ok && r.json.notes) || [];
      recent.push(...batch);
      offset += batch.length || 1000;
      if (!batch.length) break;
    }
  }
  // pick whichever set is genuinely more recent
  if (sList.length && (!recent.length || sMax > recent.reduce((a,n)=>(n.last_updated>a?n.last_updated:a),''))) recent = sList;

  recent.sort((a, b) => String(b.last_updated || '').localeCompare(String(a.last_updated || '')));
  const newest = recent.slice(0, 60);
  console.log('Newest note last_updated:', recent[0] && recent[0].last_updated);

  // title-shape histogram over the recent set
  const shapes = {};
  for (const n of recent) { const sh = shapeOf(n.title); shapes[sh] = (shapes[sh] || 0) + 1; }
  const top = Object.entries(shapes).sort((a, b) => b[1] - a[1]).slice(0, 30);

  out.recentCount = recent.length;
  out.newestLastUpdated = recent[0] && recent[0].last_updated;
  out.titleShapes = top.map(([shape, c]) => ({ shape, count: c }));
  out.newestSamples = newest.map(n => ({
    title: n.title, type: n.type, last_updated: n.last_updated, date_created: n.date_created,
    user_id: n.user_id, user_name: userName[n.user_id] || null, contact_id: n.contact_id,
  }));

  fs.writeFileSync('keap_recent.json', JSON.stringify(out, null, 2));
  console.log('\nTop recent title shapes:');
  for (const [shape, c] of top.slice(0, 12)) console.log(`  ${String(c).padStart(4)}  ${shape}`);
  console.log('\n✓ Wrote keap_recent.json — safe to share (data only). Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
