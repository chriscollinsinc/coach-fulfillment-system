#!/usr/bin/env node
/*
 * Keap Classic — subscriptions / orders shape probe (Phase 2, step 4)
 * -------------------------------------------------------------------
 * Read-only. Runs on YOUR machine. Token stays local, redacted from all output.
 *
 * Goal: find the CLEAN money data — recurring subscriptions (price, billing cycle,
 * start date) and one-time orders — and confirm how to tie each one back to a
 * dealership (company), given Keap attaches these to CONTACTS, not companies.
 *
 * It:
 *   1. Lists subscriptions account-wide; shows the object shape + a few samples.
 *   2. Lists orders (for one-off "LID (Purchase)" type sales).
 *   3. Takes a contact_id from a real subscription and fetches that contact WITH its
 *      company link — proving the subscription -> contact -> company join works.
 *   4. Tests whether contact/company filters actually filter (Keap ignored company_id
 *      on notes, so we verify here instead of trusting it).
 *   5. Writes keap_subs.json (data only, no token).
 *
 * ── RUN ────────────────────────────────────────────────────────────────────────
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' node keap_subs.js
 * ────────────────────────────────────────────────────────────────────────────────
 */
'use strict';
const fs = require('node:fs');

const TOKEN = process.env.KEAP_TOKEN;
const BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_subs.js\n"); process.exit(1); }
const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' };
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');

async function get(path) {
  const r = await fetch(BASE + path, { headers: H });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { ok: r.ok, status: r.status, json: j, raw: j ? null : redact(t).slice(0, 200) };
}
const clean = o => JSON.parse(redact(JSON.stringify(o)));

(async () => {
  const out = { ranAt: new Date().toISOString(), steps: {} };

  // 1) subscriptions list
  console.log('1) GET /v1/subscriptions?limit=50 …');
  const subs = await get('/v1/subscriptions?limit=50');
  const subList = (subs.json && (subs.json.subscriptions || subs.json.plans)) || [];
  out.steps.subscriptions = {
    status: subs.status, ok: subs.ok, total: subs.json && subs.json.count,
    keys: subList[0] ? Object.keys(subList[0]) : [],
    samples: subList.slice(0, 5).map(clean),
    raw: subList.length ? null : (subs.raw || clean(subs.json)),
  };
  console.log(`   HTTP ${subs.status}, total=${subs.json && subs.json.count}, pulled ${subList.length}`);
  if (subList[0]) console.log('   keys:', Object.keys(subList[0]).join(', '));

  // 2) orders list (one-time purchases)
  console.log('2) GET /v1/orders?limit=10 …');
  const ord = await get('/v1/orders?limit=10');
  const ordList = (ord.json && ord.json.orders) || [];
  out.steps.orders = {
    status: ord.status, ok: ord.ok, total: ord.json && ord.json.count,
    keys: ordList[0] ? Object.keys(ordList[0]) : [],
    samples: ordList.slice(0, 3).map(clean),
    raw: ordList.length ? null : (ord.raw || clean(ord.json)),
  };
  console.log(`   HTTP ${ord.status}, total=${ord.json && ord.json.count}, pulled ${ordList.length}`);

  // 3) subscription -> contact -> company join
  const sampleContactId = subList.map(s => s.contact_id).find(Boolean);
  out.steps.join = { sampleContactId };
  if (sampleContactId) {
    console.log(`3) GET /v1/contacts/${sampleContactId}?optional_properties=company …`);
    const ct = await get(`/v1/contacts/${sampleContactId}?optional_properties=company`);
    const c = ct.json || {};
    out.steps.join.contact = clean({
      id: c.id, company: c.company, company_name: c.company_name,
      given_name: c.given_name, family_name: c.family_name,
      keys: Object.keys(c),
    });
    console.log('   contact.company =', JSON.stringify(c.company || c.company_name || '(none on contact)'));
  } else {
    console.log('3) no contact_id found on subscriptions — will need orders/contacts instead');
  }

  // 4) do filters actually filter? compare unfiltered vs contact-filtered subscription counts
  if (sampleContactId) {
    console.log('4) filter test: subscriptions?contact_id=' + sampleContactId);
    const f = await get(`/v1/subscriptions?limit=50&contact_id=${sampleContactId}`);
    const fList = (f.json && (f.json.subscriptions || f.json.plans)) || [];
    const allSameContact = fList.length > 0 && fList.every(s => String(s.contact_id) === String(sampleContactId));
    out.steps.filterTest = {
      unfilteredTotal: subs.json && subs.json.count,
      filteredTotal: f.json && f.json.count,
      filteredPulled: fList.length,
      filterHonored: allSameContact,
    };
    console.log(`   filtered total=${f.json && f.json.count}, all rows match contact? ${allSameContact}`);
  }

  fs.writeFileSync('keap_subs.json', JSON.stringify(out, null, 2));
  console.log('\n✓ Wrote keap_subs.json — safe to share (data only). Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
