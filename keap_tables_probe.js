#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const TOKEN = process.env.KEAP_TOKEN;
const XR = (process.env.KEAP_XMLRPC || 'https://api.infusionsoft.com/crm/xmlrpc/v1') + '?access_token=' + (TOKEN || '');
if (!TOKEN) { console.error("\n✗ No token. Run:  KEAP_TOKEN='your-token' node keap_tables_probe.js\n"); process.exit(1); }
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
  const tables = ['Order', 'Payment', 'LineItem', 'OrderItem', 'Task'];

  for (const table of tables) {
    console.log(`Probing ${table}…`);
    const { text, fault } = await rpc('DataService.query', ['', table, 5, 0, {}, []]);
    const rows = parseStructs(text);
    const fields = rows[0] ? Object.keys(rows[0]) : [];

    out.tries.push({
      table,
      fault: fault ? redact(fault) : null,
      rowCount: rows.length,
      fields,
      sample: rows[0] ? JSON.parse(redact(JSON.stringify(rows[0]))) : null
    });

    if (fault) {
      console.log(`  ✗ ${redact(fault).slice(0, 80)}`);
    } else {
      console.log(`  ✓ ${rows.length} rows; fields: ${fields.join(', ')}`);
    }
  }

  fs.writeFileSync('keap_tables_probe.json', JSON.stringify(out, null, 2));
  console.log('\nWrote keap_tables_probe.json — safe to share. Tell Claude it\'s ready.');
})().catch(e => { console.error('Error:', redact(e.message)); process.exit(1); });