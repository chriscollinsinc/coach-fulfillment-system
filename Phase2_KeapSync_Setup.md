# Phase 2 — Live Keap Sync: Setup Guide

**What this adds:** the app now has a webhook receiver and a churn/new-client pipeline.

- **Churn/cancel** — when a subscription in Keap goes inactive or is deleted, the matching
  contract flips to `cancelled` automatically, and the client's status rolls up to
  `cancelled` if they have no other active contracts. This does **not** delete any
  scheduled visits — a lead reviews the LID Inventory and removes/reassigns them by hand,
  so nothing vanishes off the board without a human seeing it.
- **New subscriptions** — a new Keap subscription lands in a new **Unassigned Clients**
  screen (admin/lead only, badge count on the nav and a banner on the Dashboard). A lead
  confirms the client name, program cadence, and picks a **team**, then clicks
  "Create contract" — same visit-generation logic as today's "New contract" button, just
  pre-filled from Keap's subscription data.

## Why this requires a hosting change

Keap can only push webhooks to a **public HTTPS URL**. The app currently runs locally on
your Mac only (`http://localhost:3000`), which Keap's servers can't reach. So step 1 below
moves the app to Render (~$7/mo) — the same "next hosting step" already called out in the
original handoff doc, just done now instead of later.

## Setup steps

### 1. Push the updated app to GitHub
The three changed files are `db.js`, `server.js`, `app.js`, plus new `render.yaml`. If the
app isn't already in a GitHub repo, create one and push this folder to it (ask if you want
help with this part).

### 2. Deploy to Render
- New → Blueprint → connect the repo → Render reads `render.yaml` and provisions the
  service + a 1GB persistent disk for `data/coach.db`.
- In the Render dashboard, set the `KEAP_TOKEN` environment variable to your Keap API
  token (marked `sync: false` in render.yaml on purpose — never commit tokens to git).
- Once deployed you'll have a URL like `https://coach-fulfillment-system.onrender.com`.
- Update `data/coach.db`: copy your current live database from your Mac to the Render
  disk (or just let it re-seed if you're OK re-importing — ask before doing this, it's
  your live data).

### 3. Register the Keap webhooks
Run once, from your Mac, after the app is live on Render:
```
cd /Users/mikedonesoc/Downloads/coach-fulfillment-app
KEAP_TOKEN='KeapAK-your-full-token' APP_URL='https://your-app.onrender.com' node keap_register_hooks.js
```
This repoints your account's existing `subscription.add` / `.edit` / `.delete` hooks
(currently inactive, pointed at an old integration) to the new app instead of creating
duplicates. Keap will send a verification ping, which the app auto-confirms.

### 4. Verify
- Run `keap_register_hooks.js` again — all three should show `status: Verified`.
- Add a test subscription in Keap (or wait for the next real one) and confirm it shows
  up under **Unassigned Clients** in the app within a few seconds.
- Cancel a test subscription and confirm the matching client's status flips.

## Notes / limits
- Webhook signature verification uses Keap's key-echo handshake (`GET /v1/hooks` →
  find our hook → `PUT /v1/hooks/{id}/verify`) per Keap's documented mechanism. If the
  verification ping's exact payload shape differs from what we expect, it's logged
  raw to the new `keap_events` table for a quick fix — nothing is lost, just re-run
  the registration script after the fix.
- Only `subscription.*` events are wired up right now. `contact.*`, `order.*`,
  `invoice.*` events are logged (in `keap_events`) but not acted on — easy to extend
  later if useful (e.g. auto-updating a client's billing contact).
- The assign step always requires a human — no fully-automatic contract creation, per
  your call to keep scheduling human-driven.
