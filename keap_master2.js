#!/usr/bin/env node
/*
 * Keap Classic — master audit pull v2 (leaner, throttle-safe)
 * -----------------------------------------------------------
 * Read-only. Runs on YOUR machine. Token stays local, redacted from output.
 *
 * v1 made ~800 per-contact XML-RPC calls and got rate-limited (0 recap notes).
 * v2 is lean and uses ONLY DataService.query (proven reliable), paced:
 *   1. 165 paced Contact-by-CompanyID lookups -> contact ids per company + a
 *      contactId->companyId map (fixes the 25 companies v1 dropped, incl. Suski).
 *   2. REST: all subscriptions -> revenue per company via that map.
 *   3. A FEW bulk account-wide ContactAction queries (ActionDescription LIKE '%LID%'
 *      and '%Recap%', paged) -> every completion-ish note, mapped back to companies.
 * Writes keap_master.json for the Keap-vs-app reconciliation. No credentials in output.
 *
 * Needs keap_roster.json in the folder. Takes ~1-3 min. Prints progress.
 *
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' node keap_master2.js
 */
'use strict';
const fs = require('node:fs');
const TOKEN = process.env.KEAP_TOKEN;
const BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
const XR = (process.env.KEAP_XMLRPC || 'https://api.infusionsoft.com/crm/xmlrpc/v1') + '?access_token=' + (TOKEN || '');
const PACE = +(process.env.KEAP_PACE || 130); // ms between XML-RPC calls
if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_master2.js\n"); process.exit(1); }
if (!fs.existsSync('keap_roster.json')) { console.error('\n✗ keap_roster.json not found — run keap_roster.js first.\n'); process.exit(1); }
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');
const sleep = ms => new Promise(z => setTimeout(z, ms));

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
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function xval(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? `<int>${v}</int>` : `<double>${v}</double>`;
  if (typeof v === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`;
  if (Array.isArray(v)) return `<array><data>${v.map(x => `<value>${xval(x)}</value>`).join('')}</data></array>`;
  if (v && typeof v === 'object') return `<struct>${Object.entries(v).map(([k, val]) => `<member><name>${esc(k)}</name><value>${xval(val)}</value></member>`).join('')}</struct>`;
  return `<string>${esc(v)}</string>`;
}
const build = (m, p) => `<?xml version="1.0"?><methodCall><methodName>${m}</methodName><params>${p.map(x => `<param><value>${xval(x)}</value></param>`).join('')}</params></methodCall>`;
async function xq(table, limit, page, query, fields) {
  const params = ['', table, limit, page, query, fields];
  for (let a = 0; a < 5; a++) {
    await sleep(PACE);
    try {
      const r = await fetch(XR, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: build('DataService.query', params) });
      const text = await r.text();
      if (/<fault>/.test(text)) {
        const fs2 = (text.match(/faultString<\/name>\s*<value>\s*<string>([^<]*)/) || [])[1] || '';
        if (/throttl|too many|rate|limit|503|timeout/i.test(fs2) && a < 4) { await sleep(2500); continue; }
        return { rows: [], fault: redact(fs2) };
      }
      return { rows: parseStructs(text) };
    } catch (e) { if (a === 4) return { rows: [], fault: redact(e.message) }; await sleep(1500); }
  }
  return { rows: [] };
}
function parseStructs(xml) {
  const rows = [];
  for (const seg of xml.split('<struct>').slice(1)) {
    const body = seg.slice(0, seg.indexOf('</struct>'));
    const o = {}; const re = /<member>\s*<name>([^<]+)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g; let m;
    while ((m = re.exec(body))) {
      const name = m[1]; const raw = m[2]; let t, val;
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

(async () => {
  const roster = JSON.parse(fs.readFileSync('keap_roster.json', 'utf8'));
  const companies = [...roster.activeClients.map(c => ({ ...c, status: 'Active' })),
                     ...roster.inactiveClients.map(c => ({ ...c, status: 'Inactive' }))];
  const coachingIds = new Set(companies.map(c => c.id));
  console.log(`Roster: ${companies.length} coaching-client companies.`);

  // users
  const u = await rest('/v1/users?limit=1000');
  const userName = {}; for (const x of (u.json?.users || [])) userName[x.id] = [x.given_name, x.family_name].filter(Boolean).join(' ') || x.email_address || ('user#' + x.id);

  // 1) contacts per company (paced) + reverse map
  console.log('Mapping contacts per company (paced)…');
  const contact2co = {}; const co2contacts = {};
  let i = 0, failed = 0;
  for (const co of companies) {
    const { rows, fault } = await xq('Contact', 1000, 0, { CompanyID: co.id }, ['Id']);
    if (fault) failed++;
    const ids = rows.map(r => r.Id).filter(Boolean);
    co2contacts[co.id] = ids;
    for (const id of ids) contact2co[id] = co.id;
    if (++i % 20 === 0 || i === companies.length) process.stdout.write(`\r  ${i}/${companies.length} (contacts mapped: ${Object.keys(contact2co).length})`);
  }
  console.log(`\n  ${Object.keys(contact2co).length} contacts mapped; ${failed} company lookups faulted.`);

  // 2) subscriptions -> revenue
  console.log('Pulling subscriptions…');
  const subs = []; let off = 0, tot = null;
  while (true) {
    const r = await rest(`/v1/subscriptions?limit=1000&offset=${off}`);
    const list = (r.ok && r.json.subscriptions) || []; tot = r.ok ? r.json.count : tot;
    subs.push(...list); off += list.length;
    if (!list.length || (tot != null && off >= tot)) break;
  }
  const revByCo = {};
  for (const s of subs) {
    const coid = contact2co[s.contact_id]; if (!coid) continue;
    const b = (revByCo[coid] ||= { activeMonthly: 0, earliestStart: null, cycles: new Set(), subs: [] });
    b.subs.push({ id: s.id, active: s.active, amount: s.billing_amount, cycle: s.billing_cycle, freq: s.billing_frequency, start: s.start_date, next: s.next_bill_date, end: s.end_date, plan: s.subscription_plan_id });
    if (s.active) b.activeMonthly += Number(s.billing_amount) || 0;
    b.earliestStart = minDate(b.earliestStart, s.start_date);
    if (s.billing_cycle) b.cycles.add(s.billing_cycle);
  }

  // 3) bulk recap/LID notes (account-wide, paged) -> map to companies
  console.log('Pulling completion notes in bulk…');
  const seen = new Set(); const recaps = [];
  const fields = ['Id', 'ContactId', 'ActionDescription', 'UserID', 'ActionDate', 'CompletionDate'];
  for (const pattern of ['%LID%', '%Recap%']) {
    let page = 0;
    while (true) {
      const { rows, fault } = await xq('ContactAction', 1000, page, { ActionDescription: pattern }, fields);
      if (fault) { console.log(`  (${pattern} page ${page} fault: ${fault})`); break; }
      for (const a of rows) {
        if (seen.has(a.Id)) continue; seen.add(a.Id);
        const coid = contact2co[a.ContactId];
        if (!coid || !coachingIds.has(coid)) continue; // only coaching clients
        recaps.push({ id: a.Id, companyId: coid, contactId: a.ContactId, title: a.ActionDescription, coach: userName[a.UserID] || ('user#' + a.UserID), date: a.CompletionDate || a.ActionDate });
      }
      process.stdout.write(`\r  ${pattern}: page ${page}, kept ${recaps.length}`);
      if (rows.length < 1000) break;
      page++;
    }
    console.log('');
  }

  // assemble
  const out = { ranAt: new Date().toISOString(), users: userName, perCompany: companies.map(co => ({
    companyId: co.id, name: co.name, status: co.status,
    contactIds: co2contacts[co.id] || [],
    revenue: revByCo[co.id] ? { ...revByCo[co.id], cycles: [...revByCo[co.id].cycles], subCount: revByCo[co.id].subs.length } : { activeMonthly: 0, earliestStart: null, cycles: [], subCount: 0, subs: [] },
    recaps: recaps.filter(r => r.companyId === co.id).map(r => ({ title: r.title, coach: r.coach, date: r.date })),
  })) };

  fs.writeFileSync('keap_master.json', JSON.stringify(out, null, 2));
  const withSub = out.perCompany.filter(c => c.revenue.subCount).length;
  const monthly = out.perCompany.reduce((s, c) => s + c.revenue.activeMonthly, 0);
  const withRecaps = out.perCompany.filter(c => c.recaps.length).length;
  console.log(`\n✓ ${out.perCompany.length} companies · ${withSub} with subs · active monthly $${Math.round(monthly).toLocaleString()} · ${withRecaps} with recap notes (${recaps.length} notes).`);
  const s = out.perCompany.find(c => c.companyId === 61275);
  if (s) { console.log(`\nSuski: ${s.contactIds.length} contacts, $${s.revenue.activeMonthly}/mo, ${s.recaps.length} recaps; sample:`); s.recaps.slice(0, 8).forEach(r => console.log(`   • ${(r.date||'').slice(0,8)}  ${r.title}  [${r.coach}]`)); }
  console.log('\nWrote keap_master.json — safe to share. Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
