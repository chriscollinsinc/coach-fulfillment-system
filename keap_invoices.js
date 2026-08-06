#!/usr/bin/env node
/*
 * Keap Classic — Invoice table probe (revenue reconcile)
 * ------------------------------------------------------
 * Read-only. Runs on YOUR machine. Token stays local, redacted from output.
 *
 * Your cash-forecast report ($719,590 for Sep 2026) is higher than reconstructed recurring
 * ($612,044). Keap forecasts by INVOICE due-date (recurring-generated + one-time + tax).
 * This probes the Invoice table via XML-RPC to find its fields (esp. the due-date + total +
 * tax fields), so I can build a pull that reproduces your report exactly.
 *
 *   cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
 *   KEAP_TOKEN='KeapAK-your-full-token' node keap_invoices.js
 */
'use strict';
const fs = require('node:fs');
const TOKEN = process.env.KEAP_TOKEN;
const XR = (process.env.KEAP_XMLRPC || 'https://api.infusionsoft.com/crm/xmlrpc/v1') + '?access_token=' + (TOKEN || '');
if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_invoices.js\n"); process.exit(1); }
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function xval(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? `<int>${v}</int>` : `<double>${v}</double>`;
  if (typeof v === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`;
  if (Array.isArray(v)) return `<array><data>${v.map(x => `<value>${xval(x)}</value>`).join('')}</data></array>`;
  if (v && typeof v === 'object') return `<struct>${Object.entries(v).map(([k, val]) => `<member><name>${esc(k)}</name><value>${xval(val)}</value></member>`).join('')}</struct>`;
  return `<string>${esc(v)}</string>`;
}
const build = (m, p) => `<?xml version="1.0"?><methodCall><methodName>${m}</methodName><params>${p.map(x => `<param><value>${xval(x)}</value></param>`).join('')}</params></methodCall>`;
async function rpc(method, params) {
  const r = await fetch(XR, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: build(method, params) });
  const text = await r.text();
  const fault = /<fault>/.test(text) ? (text.match(/faultString<\/name>\s*<value>\s*<string>([^<]*)/) || [])[1] : null;
  return { text, fault };
}
function parseStructs(xml) {
  const rows = [];
  for (const seg of xml.split('<struct>').slice(1)) {
    const body = seg.slice(0, seg.indexOf('</struct>')); const o = {};
    const re = /<member>\s*<name>([^<]+)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g; let m;
    while ((m = re.exec(body))) { const n = m[1]; const raw = m[2]; let t, v;
      if ((t = raw.match(/<i4>([-\d]+)<\/i4>|<int>([-\d]+)<\/int>/))) v = +(t[1] ?? t[2]);
      else if ((t = raw.match(/<double>([-\d.]+)<\/double>/))) v = +t[1];
      else if ((t = raw.match(/<dateTime\.iso8601>([^<]+)<\/dateTime\.iso8601>/))) v = t[1];
      else if ((t = raw.match(/<string>([\s\S]*?)<\/string>/))) v = t[1];
      else v = raw.trim();
      o[n] = v; }
    rows.push(o);
  }
  return rows;
}

(async () => {
  const out = { ranAt: new Date().toISOString(), tries: [] };
  // find a table + criterion that returns invoice rows; try a few table names + fields
  const attempts = [
    ['Invoice', { PayStatus: 0 }, []],
    ['Invoice', { PayStatus: 1 }, []],
    ['Invoice', { Id: 1 }, []],
  ];
  for (const [table, q, f] of attempts) {
    const { text, fault } = await rpc('DataService.query', ['', table, 2, 0, q, f]);
    const rows = parseStructs(text);
    const fields = rows[0] ? Object.keys(rows[0]) : [];
    out.tries.push({ table, query: q, fault: fault ? redact(fault) : null, rowCount: rows.length, fields, sample: rows[0] ? JSON.parse(redact(JSON.stringify(rows[0]))) : null });
    console.log(`${table} ${JSON.stringify(q)} → ${fault ? 'FAULT ' + redact(fault) : rows.length + ' rows'}${fields.length ? '; fields: ' + fields.join(', ') : ''}`);
    if (fields.length) break;
  }
  // if we found fields, show a couple date-ish values to identify the due-date field
  const good = out.tries.find(t => t.fields && t.fields.length);
  if (good) {
    const dateFields = good.fields.filter(f => /date|due/i.test(f));
    console.log('\nDate-ish fields:', dateFields.join(', '));
    console.log('Sample row:', JSON.stringify(good.sample));
  }
  fs.writeFileSync('keap_invoices.json', JSON.stringify(out, null, 2));
  console.log('\nWrote keap_invoices.json — safe to share. Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });
