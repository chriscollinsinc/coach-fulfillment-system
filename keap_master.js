#!/usr/bin/env node
/*
 * Keap Classic — master audit pull (Phase 2, final data pull)
 * -----------------------------------------------------------
 * Read-only. Runs on YOUR machine. Token stays local, redacted from output.
 *
 * For every coaching-client company (from keap_roster.json) it:
 *   1. XML-RPC: Contact by CompanyID -> the company's contact ids (reliable linkage).
 *   2. REST: all subscriptions, joined to companies via those contact ids -> revenue
 *      (active recurring $, billing cycle, earliest start).
 *   3. XML-RPC: ContactAction (newest first) for each contact -> the LID/CC Recap
 *      completion notes (title, coach UserID, dates).
 * Writes keap_master.json for the Keap-vs-app reconciliation. No credentials in output.
 *
 * Needs keap_roster.json in the same folder (already generated).
 * Takes a few minutes (a few hundred small XML-RPC calls). Prints progress.
 *
 * ── RUN ────────────────────────────────────────────────────────────────────────
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' node keap_master.js
 * ────────────────────────────────────────────────────────────────────────────────
 */
'use strict';
const fs = require('node:fs');
const TOKEN = process.env.KEAP_TOKEN;
const BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
const XR = (process.env.KEAP_XMLRPC || 'https://api.infusionsoft.com/crm/xmlrpc/v1') + '?access_token=' + (TOKEN || '');
const ACTIONS_PER_CONTACT = +(process.env.KEAP_ACTIONS || 150);
if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_master.js\n"); process.exit(1); }
if (!fs.existsSync('keap_roster.json')) { console.error('\n✗ keap_roster.json not found — run keap_roster.js first.\n'); process.exit(1); }
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');

/* ---- REST ---- */
async function rest(path) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' } });
      if (r.status === 429 || r.status === 503) { await sleep(1500); continue; }
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      return { ok: r.ok, status: r.status, json: j };
    } catch (e) { if (a === 3) return { ok: false, status: 0 }; await sleep(800); }
  }
  return { ok: false, status: 0 };
}
/* ---- XML-RPC ---- */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function xval(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? `<int>${v}</int>` : `<double>${v}</double>`;
  if (typeof v === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`;
  if (Array.isArray(v)) return `<array><data>${v.map(x => `<value>${xval(x)}</value>`).join('')}</data></array>`;
  if (v && typeof v === 'object') return `<struct>${Object.entries(v).map(([k, val]) => `<member><name>${esc(k)}</name><value>${xval(val)}</value></member>`).join('')}</struct>`;
  return `<string>${esc(v)}</string>`;
}
const build = (m, p) => `<?xml version="1.0"?><methodCall><methodName>${m}</methodName><params>${p.map(x => `<param><value>${xval(x)}</value></param>`).join('')}</params></methodCall>`;
async function xrpc(method, params) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(XR, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: build(method, params) });
      const text = await r.text();
      if (/throttl|<fault>[\s\S]*(503|limit)/i.test(text) && a < 3) { await sleep(1500); continue; }
      return text;
    } catch (e) { if (a === 3) return ''; await sleep(800); }
  }
  return '';
}
const sleep = ms => new Promise(z => setTimeout(z, ms));
/* tolerant XML-RPC struct parser */
function parseStructs(xml) {
  const rows = [];
  for (const seg of xml.split('<struct>').slice(1)) {
    const body = seg.slice(0, seg.indexOf('</struct>'));
    const o = {};
    const re = /<member>\s*<name>([^<]+)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g;
    let m;
    while ((m = re.exec(body))) {
      const name = m[1]; let raw = m[2];
      let val;
      let t;
      if ((t = raw.match(/<i4>([-\d]+)<\/i4>|<int>([-\d]+)<\/int>/))) val = +(t[1] ?? t[2]);
      else if ((t = raw.match(/<dateTime\.iso8601>([^<]+)<\/dateTime\.iso8601>/))) val = t[1];
      else if ((t = raw.match(/<string>([\s\S]*?)<\/string>/))) val = t[1];
      else val = raw.trim();
      o[name] = val;
    }
    rows.push(o);
  }
  return rows;
}
const minDate = (a, b) => !a ? b : !b ? a : (a < b ? a : b);
const isRecap = t => /recap|coaching call|\blid\b|dashboard|\bcc\b|comp\b/i.test(t || '');

(async () => {
  const roster = JSON.parse(fs.readFileSync('keap_roster.json', 'utf8'));
  const companies = [...roster.activeClients.map(c => ({ ...c, status: 'Active' })),
                     ...roster.inactiveClients.map(c => ({ ...c, status: 'Inactive' }))];
  console.log(`Roster: ${companies.length} coaching-client companies.`);

  // users map
  const u = await rest('/v1/users?limit=1000');
  const userName = {}; for (const x of (u.json?.users || [])) userName[x.id] = [x.given_name, x.family_name].filter(Boolean).join(' ') || x.email_address || ('user#' + x.id);

  // all subscriptions
  console.log('Pulling subscriptions…');
  const subs = []; let off = 0, tot = null;
  while (true) {
    const r = await rest(`/v1/subscriptions?limit=1000&offset=${off}`);
    const list = (r.ok && r.json.subscriptions) || []; tot = r.ok ? r.json.count : tot;
    subs.push(...list); off += list.length;
    process.stdout.write(`\r  ${subs.length}/${tot ?? '?'}`);
    if (!list.length || (tot != null && off >= tot)) break;
  }
  const subByContact = {}; for (const s of subs) (subByContact[s.contact_id] ||= []).push(s);
  console.log('');

  // per company: contacts (XML-RPC) -> revenue + completion notes
  const out = { ranAt: new Date().toISOString(), users: userName, perCompany: [] };
  let i = 0;
  for (const co of companies) {
    i++;
    // 1) contact ids for this company
    const cxml = await xrpc('DataService.query', ['', 'Contact', 200, 0, { CompanyID: co.id }, ['Id']]);
    const contactIds = parseStructs(cxml).map(r => r.Id).filter(Boolean);

    // 2) revenue
    let activeMonthly = 0, earliestStart = null; const cycles = new Set(); const subRows = [];
    for (const cid of contactIds) for (const s of (subByContact[cid] || [])) {
      subRows.push({ id: s.id, active: s.active, amount: s.billing_amount, cycle: s.billing_cycle, freq: s.billing_frequency, start: s.start_date, next: s.next_bill_date, end: s.end_date, plan: s.subscription_plan_id });
      if (s.active) activeMonthly += Number(s.billing_amount) || 0;
      earliestStart = minDate(earliestStart, s.start_date);
      if (s.billing_cycle) cycles.add(s.billing_cycle);
    }

    // 3) completion notes across the company's contacts
    const recaps = [];
    for (const cid of contactIds) {
      const axml = await xrpc('DataService.queryWithOrderBy', ['', 'ContactAction', ACTIONS_PER_CONTACT, 0,
        { ContactId: +cid }, ['Id', 'ContactId', 'ActionDescription', 'UserID', 'ActionDate', 'CompletionDate'], 'ActionDate', false]);
      for (const a of parseStructs(axml)) {
        if (!isRecap(a.ActionDescription)) continue;
        recaps.push({ title: a.ActionDescription, coach: userName[a.UserID] || ('user#' + a.UserID), date: a.CompletionDate || a.ActionDate, contactId: a.ContactId });
      }
    }
    out.perCompany.push({
      companyId: co.id, name: co.name, status: co.status, contactIds,
      revenue: { activeMonthly, earliestStart, cycles: [...cycles], subCount: subRows.length, subs: subRows },
      recaps,
    });
    if (i % 10 === 0 || i === companies.length) process.stdout.write(`\r  companies ${i}/${companies.length}`);
  }
  console.log('');

  fs.writeFileSync('keap_master.json', JSON.stringify(out, null, 2));
  const withSub = out.perCompany.filter(c => c.revenue.subCount).length;
  const monthly = out.perCompany.reduce((s, c) => s + c.revenue.activeMonthly, 0);
  const withRecaps = out.perCompany.filter(c => c.recaps.length).length;
  console.log(`\n✓ ${out.perCompany.length} companies · ${withSub} with subscriptions · active monthly $${Math.round(monthly).toLocaleString()} · ${withRecaps} with recap notes.`);
  // Suski self-check
  const s = out.perCompany.find(c => c.companyId === 61275);
  if (s) { console.log(`\nSuski check: ${s.contactIds.length} contacts, $${s.revenue.activeMonthly}/mo, ${s.recaps.length} recap notes; sample:`); s.recaps.slice(0, 6).forEach(r => console.log(`   • ${r.date ? r.date.slice(0,8) : ''}  ${r.title}  [${r.coach}]`)); }
  console.log('\nWrote keap_master.json — safe to share. Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
