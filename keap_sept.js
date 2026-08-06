#!/usr/bin/env node
/*
 * Keap Classic — September 2026 recurring cash forecast (Phase 2, revenue reconcile)
 * ----------------------------------------------------------------------------------
 * Read-only. Runs on YOUR machine. Token stays local, redacted from output.
 *
 * Sums recurring subscription charges scheduled to bill in Sept 1-30 2026, reported at
 * BOTH scopes so you can match your Keap cash-forecast report however it's scoped:
 *   • ALL clients   • COACHING clients only (from keap_master.json's contact set)
 * NOTE: recurring subscriptions only — does NOT include one-time orders/invoices. If your
 * report still exceeds the ALL-clients number here, one-time charges are the difference and
 * we'll add an orders-due-in-Sept pull next.
 *
 * Needs keap_master.json in the folder (for the coaching contact set).
 *
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' node keap_sept.js
 */
'use strict';
const fs = require('node:fs');
const TOKEN = process.env.KEAP_TOKEN;
const BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
const TARGET = process.env.KEAP_MONTH || '2026-09';
if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_sept.js\n"); process.exit(1); }
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');
async function get(path) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' } });
      if (r.status === 429 || r.status === 503) { await new Promise(z => setTimeout(z, 1500)); continue; }
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      return { ok: r.ok, status: r.status, json: j };
    } catch (e) { if (a === 3) return { ok: false }; }
  }
  return { ok: false };
}
const [TY, TM] = TARGET.split('-').map(Number);
const monthIndex = iso => { if (!iso) return null; const [y, m] = String(iso).slice(0, 10).split('-').map(Number); return y * 12 + (m - 1); };
const TIDX = TY * 12 + (TM - 1);
function billsInTarget(s) {
  if (!s.active) return false;
  const start = monthIndex(s.start_date), end = monthIndex(s.end_date);
  if (start != null && start > TIDX) return false;         // not started by target
  if (end != null && end < TIDX) return false;             // ended before target
  const anchor = monthIndex(s.next_bill_date) ?? monthIndex(s.start_date);
  if (anchor == null) return true;                          // no schedule info -> assume bills
  const freq = Math.max(1, Number(s.billing_frequency) || 1);
  const cyc = String(s.billing_cycle || 'MONTH').toUpperCase();
  const step = cyc === 'YEAR' ? 12 * freq : cyc === 'MONTH' ? freq : 1; // WEEK/DAY -> assume monthly-ish
  if (cyc === 'WEEK' || cyc === 'DAY') return true;
  return Math.abs(TIDX - anchor) % step === 0;
}

(async () => {
  // coaching contact set from master pull
  let coachingContacts = new Set();
  if (fs.existsSync('keap_master.json')) {
    const M = JSON.parse(fs.readFileSync('keap_master.json', 'utf8'));
    for (const c of M.perCompany) for (const id of (c.contactIds || [])) coachingContacts.add(id);
    console.log(`Coaching contact set: ${coachingContacts.size} contacts (from keap_master.json).`);
  } else console.log('(no keap_master.json — coaching-only figure will be blank)');

  console.log('Pulling subscriptions…');
  const subs = []; let off = 0, tot = null;
  while (true) {
    const r = await get(`/v1/subscriptions?limit=1000&offset=${off}`);
    const list = (r.ok && r.json.subscriptions) || []; tot = r.ok ? r.json.count : tot;
    subs.push(...list); off += list.length;
    if (!list.length || (tot != null && off >= tot)) break;
  }

  let allSum = 0, allN = 0, coSum = 0, coN = 0;
  for (const s of subs) {
    if (!billsInTarget(s)) continue;
    const amt = Number(s.billing_amount) || 0;
    allSum += amt; allN++;
    if (coachingContacts.has(s.contact_id)) { coSum += amt; coN++; }
  }
  const out = { ranAt: new Date().toISOString(), month: TARGET, subscriptions: subs.length,
    allClients: { count: allN, recurring: Math.round(allSum) },
    coachingOnly: { count: coN, recurring: Math.round(coSum) },
    note: 'Recurring subscription charges scheduled in ' + TARGET + '. Excludes one-time orders/invoices.' };
  fs.writeFileSync('keap_sept.json', JSON.stringify(out, null, 2));
  console.log(`\n=== ${TARGET} recurring cash forecast ===`);
  console.log(`  ALL clients:      ${allN} charges  →  $${allSum.toLocaleString()}`);
  console.log(`  Coaching clients: ${coN} charges  →  $${coSum.toLocaleString()}`);
  console.log('  (recurring only — one-time orders/invoices NOT included)');
  console.log('\nWrote keap_sept.json — safe to share. Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
