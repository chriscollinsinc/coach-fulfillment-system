#!/usr/bin/env node
/*
 * Keap Classic — XML-RPC company-notes hunt (Phase 2, step 7)
 * -----------------------------------------------------------
 * Read-only. Runs on YOUR machine. Token stays local, redacted from output.
 *
 * REST can't see Company Notes. This uses the old Infusionsoft XML-RPC "DataService"
 * back-channel to find where the LID/CC Recap notes actually live. We verify by
 * searching for the known Suski note "Mar 2026 LID Recap Email To GM".
 *
 * Auth note: with an OAuth/PAT you append ?access_token=... to the URL and pass an
 * EMPTY STRING for the legacy key (first DataService param). That's what this does.
 *
 * ── RUN ────────────────────────────────────────────────────────────────────────
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' node keap_xmlrpc.js
 * ────────────────────────────────────────────────────────────────────────────────
 */
'use strict';
const fs = require('node:fs');

const TOKEN = process.env.KEAP_TOKEN;
const ENDPOINT = (process.env.KEAP_XMLRPC || 'https://api.infusionsoft.com/crm/xmlrpc/v1') + '?access_token=' + (TOKEN || '');
if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_xmlrpc.js\n"); process.exit(1); }
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');

// ---- tiny XML-RPC serializer ----
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function xval(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? `<int>${v}</int>` : `<double>${v}</double>`;
  if (typeof v === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`;
  if (Array.isArray(v)) return `<array><data>${v.map(x => `<value>${xval(x)}</value>`).join('')}</data></array>`;
  if (v && typeof v === 'object') return `<struct>${Object.entries(v).map(([k, val]) => `<member><name>${esc(k)}</name><value>${xval(val)}</value></member>`).join('')}</struct>`;
  return `<string>${esc(v)}</string>`;
}
const buildCall = (method, params) =>
  `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(p => `<param><value>${xval(p)}</value></param>`).join('')}</params></methodCall>`;

async function rpc(method, params) {
  const body = buildCall(method, params);
  const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body });
  const text = await r.text();
  const fault = /<fault>/.test(text) ? (text.match(/<name>faultString<\/name>\s*<value>\s*<string>([^<]*)/) || [])[1] : null;
  return { status: r.status, ok: r.ok && !fault, fault: fault ? redact(fault) : null, text };
}
// count result rows + pull the values of a given member name across all structs
const countStructs = t => (t.match(/<struct>/g) || []).length;
function memberValues(xml, name) {
  const re = new RegExp(`<name>${name}</name>\\s*<value>\\s*(?:<string>)?([^<]*)`, 'g');
  const out = []; let m; while ((m = re.exec(xml))) out.push(m[1]); return out;
}

(async () => {
  const out = { ranAt: new Date().toISOString(), tests: [] };
  const record = (label, r, extra = {}) => {
    out.tests.push({ label, status: r.status, ok: r.ok, fault: r.fault, structs: countStructs(r.text), rawSnippet: redact(r.text).slice(0, 1200), ...extra });
    console.log(`  ${r.ok ? '✓' : '✗'} ${label} → HTTP ${r.status}${r.fault ? '  FAULT: ' + r.fault : ''}  (${countStructs(r.text)} structs)`);
  };

  console.log('XML-RPC auth + schema hunt…\n');

  // 1) auth check: read the Suski company row
  record('DataService.query Company Id=61275', await rpc('DataService.query', ['', 'Company', 1, 0, { Id: 61275 }, ['Id', 'Company']]));

  // 2) ContactAction full schema (empty selectedFields => all fields) — see what a note/action looks like
  const schema = await rpc('DataService.query', ['', 'ContactAction', 2, 0, {}, []]);
  record('DataService.query ContactAction (schema sample)', schema);

  // 3) search ContactAction for the Recap notes by title (ActionDescription LIKE %Recap%)
  const search = await rpc('DataService.query', ['', 'ContactAction', 25, 0, { ActionDescription: '%Recap%' },
    ['Id', 'ContactId', 'ActionType', 'ActionDescription', 'CreationNotes', 'UserID', 'ActionDate', 'CreationDate', 'CompletionDate']]);
  const titles = memberValues(search.text, 'ActionDescription');
  record('DataService.query ContactAction ActionDescription LIKE %Recap%', search, { sampleTitles: titles.slice(0, 20) });
  if (titles.length) { console.log('     sample titles:'); titles.slice(0, 10).forEach(t => console.log('       •', t)); }

  // 4) also try a LID-specific search
  const lid = await rpc('DataService.query', ['', 'ContactAction', 25, 0, { ActionDescription: '%LID Recap%' },
    ['Id', 'ContactId', 'ActionDescription', 'UserID', 'ActionDate', 'CompletionDate']]);
  record('DataService.query ContactAction ActionDescription LIKE %LID Recap%', lid, { sampleTitles: memberValues(lid.text, 'ActionDescription').slice(0, 20) });

  fs.writeFileSync('keap_xmlrpc.json', JSON.stringify(out, null, 2));
  const found = titles.some(t => /recap/i.test(t));
  console.log(`\n${found ? '✓ ContactAction holds the Recap notes — XML-RPC is our door.' : '· No Recap notes in ContactAction; the raw output will tell us where to look next.'}`);
  console.log('Wrote keap_xmlrpc.json — safe to share. Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
