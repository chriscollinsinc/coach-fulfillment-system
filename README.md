# Coach Fulfillment System

The Chris Collins Inc. LID inventory, coach scheduling, capacity, and sales-availability
system — replaces the Coach Master File spreadsheet.

Multi-user web app with logins, roles, and a full audit trail. **Zero dependencies** —
it needs nothing but Node.js 22 or newer. No `npm install`, no database server.

---

## Run it

```
node server.js
```

Then open http://localhost:3000

**First run:** the app creates the database (`data/coach.db`), imports everything from the
Coach Master File extract (`seed_data.json` — 20 coaches, 679 visits, the full 2026
schedule), and prints an admin login to the terminal:

```
email:    mike@chriscollinsinc.com
password: Bulldog!XXXX   <- shown once, in the terminal
```

Sign in, change your password (top-right → password), then create accounts for the team
under **Admin → Users**.

## Roles

| Role  | Can do |
|-------|--------|
| admin | Everything: all teams, users, teams/coaches, audit log |
| lead  | Schedule board + inventory for **their own team** only |
| sales | Availability tool + dashboard (read-only) |
| coach | Their own upcoming schedule (link the account to a coach in Admin → Users) |

## How it fits together

- **LID Inventory** is the master record. "New contract" generates the whole cycle of due
  visits (client + program + count + first due date) — no more hand-typing "2 of 4" rows.
- **Schedule Board** is where leads work: one team, one month at a time. Click
  **Place on calendar** on a due visit, then click any open week. Click a placed visit to
  move / unschedule / complete it. Click any other week to mark Home, Off, Training, etc.
- **Capacity and the Availability tool are computed** from the board — never typed.
  Every week with nothing scheduled and nothing blocked counts as open.
- Every change is logged with who/what/when (**Admin → Audit log**).

## Hosting it for the team

The app is one process with a SQLite file database — it runs anywhere Node runs.

**Option A — office machine / existing server.** Run `node server.js` on any always-on
machine; the team uses `http://<that-machine>:3000`. To keep it running across reboots
use a process manager (`pm2 start server.js`) or a systemd service.

**Option B — cloud (Render, Railway, Fly.io, a $6 VPS).** Deploy this folder as a Node
web service with start command `node server.js`. One requirement: **the `data/` folder
must be on a persistent disk** (on Render: add a Disk mounted at `/opt/render/project/src/data`;
free tiers without disks lose the database on every restart). Set env var `DB_PATH` if
you want the database somewhere specific.

**If the team will access it over the public internet**, put it behind HTTPS — either the
platform does this for you (Render/Railway/Fly all do), or use Caddy/nginx in front on a VPS.

## Backups

Everything lives in one file: `data/coach.db`. Copy that file anywhere (nightly cron,
Dropbox folder, etc.) and you have a full backup. To start over, delete it and restart —
the app re-seeds from `seed_data.json`.

## Notes & known limits

- The imported plan covers 2026. Months after that read as fully open until leads block
  out Home/Off weeks — the Availability tool labels those estimates.
- One visit per coach per week (matches how scheduling works today). Conflicts are
  rejected server-side, so two leads can't double-book a week.
- "Legacy visit (from sheet)" blocks are 2026 calendar entries that had no matching
  inventory row in the import — they count as booked weeks and can be cleaned up over time.
- `node:sqlite` prints an "experimental" warning on startup — harmless on Node 22/23/24.
