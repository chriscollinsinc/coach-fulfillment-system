#!/usr/bin/env node
/*
 * Keap Classic — connection & shape probe (Phase 2, step 1)
 * ---------------------------------------------------------
 * Runs on YOUR machine (it needs internet access to Keap; the Cowork sandbox does not).
 * It authenticates, lists a few companies, finds the "Coaching Client" custom field,
 * and then TRIES SEVERAL WAYS to read one company's notes — reporting which works.
 * Nothing here is destructive: it only reads.
 *
 * Your token never leaves your machine. This script reads it from an env var; it is
 * never printed, and never sent to Claude. You share only the generated keap_probe.json,
 * which contains company/note DATA (no credentials).
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 * 1. Get a Personal Access Token (PAT) for your Keap Classic app:
 *      https://keys.developer.keap.com  →  sign in  →  create a Personal Access Token.
 *    (A PAT is the simplest option; it works as a Bearer token on the REST API.)
 *
 * 2. In Terminal, from the app folder, run — pasting your real token after the = :
 *
 *      KEAP_TOKEN='paste-your-PAT-here' node keap_probe.js
 *
 *    Optional, if you already know a specific Active company to sample:
 *      KEAP_TOKEN='...' KEAP_COMPANY_ID=123 node keap_probe.js
 *
 * 3. It prints a summary and writes  keap_probe.json  next to this script.
 *    Tell Claude when it's done — Claude reads keap_probe.json through the folder bridge.
 *
 * If auth fails, the script says so without leaking the token. If your app is on the
 * older XML-RPC-only setup, tell Claude and we'll switch approaches.
 * ──────────────────────────────────────────────────────────────────────────────
 */
'use strict';
const fs = require('node:fs');

const TOKEN = process.env.KEAP_TOKEN;
const BASE = process.env.KEAP_BASE || 'https://api.infusionsoft.com/crm/rest';
const SAMPLE_ID = process.env.KEAP_COMPANY_ID || null;

if (!TOKEN) {
  console.error('\n✗ No token found. Run it like:\n');
  console.error("    KEAP_TOKEN='KeapAK-019ceb3e1a7534afc1b7d2395b7ca21a4b41b27f1d9848a85e' node keap_probe.js\n");
  process.exit(1);
}

const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' };
const out = { ranAt: new Date().toISOString(), base: BASE, steps: {} };

// redact anything token-shaped from text we might print or save
const redact = s => String(s ?? '').replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '«token»');

async function get(path) {
  const url = path.startsWith('http') ? path : BASE + path;
  try {
    const r = await fetch(url, { headers: H });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, raw: json ? null : redact(text).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, error: redact(e.message) };
  }
}

function pick(obj, keys) { const o = {}; for (const k of keys) if (obj && obj[k] !== undefined) o[k] = obj[k]; return o; }

(async () => {
  console.log('Probing Keap at', BASE, '…\n');

  // 1) auth sanity — account profile
  const prof = await get('/v1/account/profile');
  out.steps.auth = { status: prof.status, ok: prof.ok };
  if (!prof.ok) {
    console.log('✗ Auth check failed (HTTP ' + prof.status + '). The token may be wrong, expired, or lack scope.');
    if (prof.raw) console.log('  response:', prof.raw);
    fs.writeFileSync('keap_probe.json', JSON.stringify(out, null, 2));
    console.log('\nWrote keap_probe.json (auth result only). Share it and we\'ll adjust.');
    return;
  }
  console.log('✓ Auth OK (HTTP 200).');

  // 2) custom-field model for companies — find "Coaching Client"
  const model = await get('/v1/companies/model');
  const fields = (model.json && model.json.custom_fields) || [];
  const coaching = fields.find(f => /coaching\s*client/i.test(f.label || f.name || ''));
  out.steps.customFields = {
    status: model.status,
    count: fields.length,
    all: fields.map(f => pick(f, ['id', 'label', 'field_name', 'field_type', 'options'])),
    coachingClientField: coaching ? pick(coaching, ['id', 'label', 'field_name', 'field_type', 'options']) : null,
  };
  console.log('✓ Company custom fields:', fields.length,
    coaching ? `— found "Coaching Client" (options: ${(coaching.options || []).map(o => o.label || o).join(', ') || 'n/a'})`
             : '— did NOT find a "Coaching Client" field (we\'ll look at the list).');

  // 3) list a few companies
  const list = await get('/v1/companies?limit=5&optional_properties=custom_fields');
  const companies = (list.json && list.json.companies) || [];
  out.steps.companies = {
    status: list.status,
    total: list.json && list.json.count,
    sample: companies.map(c => pick(c, ['id', 'company_name', 'custom_fields'])),
  };
  console.log('✓ Companies reachable. Total on account:', (list.json && list.json.count) ?? '?', '· pulled', companies.length, 'as a sample.');

  // choose a company to probe notes on
  const target = SAMPLE_ID || (companies[0] && companies[0].id);
  out.steps.noteProbe = { companyId: target, attempts: [] };

  if (target) {
    console.log('\nProbing NOTES for company id', target, '(company-level notes are the known quirk)…');
    // candidate endpoints across REST v1/v2 shapes — we record which return data
    const candidates = [
      `/v1/companies/${target}`,                 // may embed notes / more fields
      `/v1/notes?company_id=${target}&limit=25`,
      `/v1/companies/${target}/notes?limit=25`,
      `/v2/companies/${target}`,
      `/v2/companies/${target}/notes?page_size=25`,
      `/v2/notes?filter=company_id==${target}`,
    ];
    for (const path of candidates) {
      const r = await get(path);
      const noteCount = r.json
        ? (Array.isArray(r.json.notes) ? r.json.notes.length
          : Array.isArray(r.json.results) ? r.json.results.length : null)
        : null;
      out.steps.noteProbe.attempts.push({ path, status: r.status, ok: r.ok, noteCount, sample: r.json ? JSON.parse(redact(JSON.stringify(r.json))) : r.raw });
      console.log(`  ${r.ok ? '✓' : '·'} ${path} → HTTP ${r.status}${noteCount != null ? `, ${noteCount} notes` : ''}`);
    }
  } else {
    console.log('\n(no company id available to probe notes)');
  }

  fs.writeFileSync('keap_probe.json', JSON.stringify(out, null, 2));
  console.log('\n✓ Wrote keap_probe.json — safe to share (data only, no token).');
  console.log('  Tell Claude it\'s ready.');
})();
