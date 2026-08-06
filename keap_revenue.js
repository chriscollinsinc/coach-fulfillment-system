#!/usr/bin/env node
/*
 * Keap Classic — subscription revenue aggregator (Phase 2, revenue side)
 * ----------------------------------------------------------------------
 * Read-only. Runs on YOUR machine. Token stays local, redacted from output.
 *
 * Pulls ALL recurring subscriptions, resolves each subscription's contact -> company,
 * and aggregates per company: active recurring $, billing cycle/frequency, earliest
 * start date, plan ids. Output feeds the Keap-vs-app revenue/contract reconciliation.
 *
 * It fetches one contact per unique subscription-holder to map company; that can be a
 * few thousand small requests, so it prints progress and may take a few minutes.
 *
 * ── RUN ────────────────────────────────────────────────────────────────────────
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' node keap_revenue.js
 * ────────────────────────────────────────────────────────────────────────────────
 */
'use strict';
const fs = require('node:fs');
const TOKEN = process.env.KEAP_TOKEN;
const BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_revenue.js\n"); process.exit(1); }
const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' };
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');
async function get(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(BASE + path, { headers: H });
      if (r.status === 429) { await new Promise(z => setTimeout(z, 1500)); continue; }
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      return { ok: r.ok, status: r.status, json: j };
    } catch (e) { if (attempt === 2) return { ok: false, status: 0, error: redact(e.message) }; }
  }
  return { ok: false, status: 0 };
}
const minDate = (a, b) => !a ? b : !b ? a : (a < b ? a : b);

(async () => {
  // 1) all subscriptions
  console.log('Pulling all subscriptions…');
  const subs = []; let offset = 0, total = null;
  while (true) {
    const r = await get(`/v1/subscriptions?limit=1000&offset=${offset}`);
    const list = (r.ok && r.json.subscriptions) || [];
    total = r.ok ? r.json.count : total;
    subs.push(...list); offset += list.length;
    process.stdout.write(`\r  ${subs.length}/${total ?? '?'}`);
    if (!list.length || (total != null && offset >= total)) break;
  }
  console.log('');

  // 2) resolve contact -> company for each unique contact
  const contactIds = [...new Set(subs.map(s => s.contact_id).filter(Boolean))];
  console.log(`Resolving ${contactIds.length} unique contacts -> company…`);
  const contactCompany = {};
  let done = 0;
  for (const cid of contactIds) {
    const r = await get(`/v1/contacts/${cid}?optional_properties=company`);
    const c = r.json || {};
    contactCompany[cid] = c.company ? { id: c.company.id, name: c.company.company_name } : null;
    if (++done % 100 === 0) process.stdout.write(`\r  ${done}/${contactIds.length}`);
  }
  console.log(`\r  ${done}/${contactIds.length} done`);

  // 3) aggregate per company
  const byCompany = {};
  for (const s of subs) {
    const co = contactCompany[s.contact_id];
    if (!co || !co.id) continue;
    const b = (byCompany[co.id] ||= { companyId: co.id, companyName: co.name, subs: [], activeMonthly: 0, earliestStart: null, cycles: new Set(), planIds: new Set() });
    b.subs.push({ id: s.id, active: s.active, billing_amount: s.billing_amount, billing_cycle: s.billing_cycle, billing_frequency: s.billing_frequency, start_date: s.start_date, next_bill_date: s.next_bill_date, end_date: s.end_date, plan: s.subscription_plan_id });
    if (s.active) b.activeMonthly += Number(s.billing_amount) || 0;
    b.earliestStart = minDate(b.earliestStart, s.start_date);
    if (s.billing_cycle) b.cycles.add(s.billing_cycle);
    if (s.subscription_plan_id) b.planIds.add(s.subscription_plan_id);
  }
  const perCompany = Object.values(byCompany).map(b => ({ ...b, cycles: [...b.cycles], planIds: [...b.planIds] }))
    .sort((a, b) => (a.companyName || '').localeCompare(b.companyName || ''));

  const out = {
    ranAt: new Date().toISOString(),
    totals: { subscriptions: subs.length, uniqueContacts: contactIds.length, companiesWithSubs: perCompany.length,
      activeMonthlySum: perCompany.reduce((s, c) => s + c.activeMonthly, 0) },
    perCompany,
  };
  fs.writeFileSync('keap_revenue.json', JSON.stringify(out, null, 2));
  console.log(`\n✓ ${perCompany.length} companies with subscriptions; active monthly total $${Math.round(out.totals.activeMonthlySum).toLocaleString()}.`);
  console.log('Wrote keap_revenue.json — safe to share. Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
