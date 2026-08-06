#!/usr/bin/env node
/*
 * Keap Classic — ContactAction linkage + ordering probe (Phase 2, step 8)
 * -----------------------------------------------------------------------
 * Read-only. Runs on YOUR machine. Token stays local, redacted from output.
 *
 * We know LID/CC Recap notes are ContactAction rows keyed by ContactId. Two things to
 * settle: (1) how a COMPANY note ties to a company — via the company's own id in
 * ContactId, or via a person-contact under the company; and (2) how to get the RECENT
 * (2026) notes, not the oldest. This probe answers both, using Suski (company 61275).
 *
 * ── RUN ────────────────────────────────────────────────────────────────────────
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' node keap_xmlrpc2.js
 * ────────────────────────────────────────────────────────────────────────────────
 */
'use strict';
const fs = require('node:fs');
const TOKEN = process.env.KEAP_TOKEN;
const CID = +(process.env.KEAP_COMPANY_ID || 61275);
const ENDPOINT = (process.env.KEAP_XMLRPC || 'https://api.infusionsoft.com/crm/xmlrpc/v1') + '?access_token=' + (TOKEN || '');
if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_xmlrpc2.js\n"); process.exit(1); }
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function xval(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? `<int>${v}</int>` : `<double>${v}</double>`;
  if (typeof v === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`;
  if (Array.isArray(v)) return `<array><data>${v.map(x => `<value>${xval(x)}</value>`).join('')}</data></array>`;
  if (v && typeof v === 'object') return `<struct>${Object.entries(v).map(([k, val]) => `<member><name>${esc(k)}</name><value>${xval(val)}</value></member>`).join('')}</struct>`;
  return `<string>${esc(v)}</string>`;
}
const build = (method, params) => `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(p => `<param><value>${xval(p)}</value></param>`).join('')}</params></methodCall>`;
async function rpc(method, params) {
  const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: build(method, params) });
  const text = await r.text();
  const fault = /<fault>/.test(text) ? (text.match(/<name>faultString<\/name>\s*<value>\s*<string>([^<]*)/) || [])[1] : null;
  return { status: r.status, ok: r.ok && !fault, fault, text };
}
const nStructs = t => (t.match(/<struct>/g) || []).length;
const memberNames = t => { const first = t.indexOf('<struct>'); const end = t.indexOf('</struct>'); const seg = first >= 0 ? t.slice(first, end) : ''; return [...seg.matchAll(/<name>([^<]+)<\/name>/g)].map(m => m[1]); };
const values = (t, name) => [...t.matchAll(new RegExp(`<name>${name}</name>\\s*<value>\\s*(?:<[^>]+>)?([^<]*)`, 'g'))].map(m => m[1]);

(async () => {
  const out = { ranAt: new Date().toISOString(), companyId: CID, tests: {} };

  // A) FULL ContactAction schema — query one known row with empty selectedFields
  const A = await rpc('DataService.query', ['', 'ContactAction', 1, 0, { Id: 48915 }, []]);
  out.tests.schema = { ok: A.ok, fault: A.fault, memberNames: memberNames(A.text), snippet: redact(A.text).slice(0, 900) };
  console.log('A) ContactAction fields:', memberNames(A.text).join(', ') || '(none)');

  // B) company-note-by-company-id: ContactId == the COMPANY id, newest first
  const B = await rpc('DataService.queryWithOrderBy', ['', 'ContactAction', 25, 0, { ContactId: CID },
    ['Id', 'ContactId', 'ActionDescription', 'UserID', 'ActionDate', 'CompletionDate'], 'ActionDate', false]);
  out.tests.byCompanyId = { ok: B.ok, fault: B.fault, count: nStructs(B.text), titles: values(B.text, 'ActionDescription').slice(0, 25) };
  console.log(`B) ContactAction where ContactId=${CID} (newest first) → ${nStructs(B.text)} rows`);
  values(B.text, 'ActionDescription').slice(0, 12).forEach(t => console.log('     •', t));

  // C) contacts that belong to the company (in case notes key off a person-contact)
  const C = await rpc('DataService.query', ['', 'Contact', 25, 0, { CompanyID: CID }, ['Id', 'FirstName', 'LastName', 'Company', 'Email']]);
  out.tests.companyContacts = { ok: C.ok, fault: C.fault, count: nStructs(C.text), contactIds: values(C.text, 'Id').slice(0, 25) };
  console.log(`C) Contacts with CompanyID=${CID} → ${nStructs(C.text)} contacts; ids: ${values(C.text, 'Id').slice(0, 10).join(', ')}`);

  // D) if B was empty but we found contacts, pull the newest actions for the first such contact
  const firstContact = values(C.text, 'Id')[0];
  if ((!out.tests.byCompanyId.count) && firstContact) {
    const D = await rpc('DataService.queryWithOrderBy', ['', 'ContactAction', 25, 0, { ContactId: +firstContact },
      ['Id', 'ContactId', 'ActionDescription', 'UserID', 'ActionDate'], 'ActionDate', false]);
    out.tests.byPersonContact = { contactId: +firstContact, count: nStructs(D.text), titles: values(D.text, 'ActionDescription').slice(0, 25) };
    console.log(`D) newest actions for person-contact ${firstContact} → ${nStructs(D.text)} rows`);
    values(D.text, 'ActionDescription').slice(0, 12).forEach(t => console.log('     •', t));
  }

  fs.writeFileSync('keap_xmlrpc2.json', JSON.stringify(out, null, 2));
  console.log('\n✓ Wrote keap_xmlrpc2.json — safe to share. Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
