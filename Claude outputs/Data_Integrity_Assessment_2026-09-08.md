# Coach Fulfillment System — Data Integrity Assessment

**Date:** September 8, 2026
**Supersedes / corrects:** `Architecture_Analysis_2026-09-08.md` (see Correction below)
**Question asked:** The data has been reconciled as accurate across the calendar, LID inventory, coach/team profiles, and current/former coaches. What in the code actually protects it?

---

## Correction to the earlier Architecture Analysis

The earlier report ranked "double-booking under concurrency" as the top risk and proposed wrapping visit placement in a transaction as Quick Win #1. That was overstated. `db.js` opens the database with `node:sqlite`'s `DatabaseSync`, which is synchronous, and Node is single-threaded. In `POST /api/visits/:id/place` there is no `await` between `cellFree()` and the `UPDATE`, so no other request can interleave. The second of two simultaneous placements correctly receives 409. The same holds for the block/visit collision check in `PUT /api/blocks`. The earlier report also claimed `log()` swallows errors in a try/catch; it does not — it is a plain insert that throws, and the route wrapper returns 500.

The remaining findings from that report (no FK enforcement, incomplete audit coverage on client/contract edits, loose week validation) still stand.

---

## What is protecting the data today

**Storage.** `render.yaml` mounts a persistent 1 GB disk at `/opt/render/project/src/data` and sets `DB_PATH` there. Redeploys do not lose data. `PRAGMA journal_mode=WAL` is set.

**Destructive paths are guarded and logged.**
- Coach permanent delete requires `active=0` first; `completed_by_coach_id` on historical visits is intentionally left intact (server.js ~822).
- Contract delete detaches completed visits (`contract_id=NULL`) and removes only never-completed generated visits (server.js ~1425).
- Client delete is a soft delete (`deleted_at`) with a 30-day window; `purgeOldSoftDeletes()` runs nightly only and is not exposed as a route.
- Every path above writes an `audit` row via `log()`, which throws on failure.

**Keap integration is conservative by design.**
- Program guesses from billing cycle are suggest-only; never written by webhook or bulk sync.
- `sweepRollingSchedule` is hard-coded `{dryRun:true}` pending manual review.
- The only visits Keap sync inserts are next-cycle generations, guarded by `findExistingVisit`, `validateCycleSequence`, `findOrCreateVisit` in db.js.

**Reconciliation tooling exists (admin-only, read-only):** duplicate-visits-audit, phantom-contracts-audit, orphaned-visits-audit, contract-splits-audit, sheet-recon-2026, resync-preview, cadence-change-audit, keap-events.

**Backups run nightly** (`runNightlyMaintenance` → `takeBackupAndEmail`), with a startup catch-up if the last successful backup is >36h old, plus on-demand `backup-now` and `backup-download` routes.

---

## Finding 1 — HIGH: backups are incomplete under WAL

`takeBackupAndEmail()` and `GET /api/admin/backup-download` copy the database with `fs.readFileSync(DB_PATH)`. In WAL mode, committed writes live in `coach.db-wal` until a checkpoint (default ~4 MB of WAL / 1000 pages). Reading `coach.db` alone yields the state as of the last checkpoint.

Evidence in the local repo `data/` folder:

```
coach.db       507,904 bytes   modified Aug 27 17:10
coach.db-wal 4,132,392 bytes   modified Aug 29 04:34
```

Two days of committed writes exist only in the WAL. A backup from this folder restores to Aug 27. Production has the same code path. `coach.db.old_corrupted` (Aug 25) shows a recovery has already been needed once.

**Fix (in `takeBackupAndEmail` and `backup-download`):**

```js
const tmp = path.join(path.dirname(DB_PATH), `backup-${Date.now()}.db`);
db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);   // consistent standalone copy, WAL-safe
// optional verification before emailing:
const check = new DatabaseSync(tmp, { readOnly: true });
const ok = check.prepare('PRAGMA integrity_check').get();
check.close();
if (ok.integrity_check !== 'ok') { fs.unlinkSync(tmp); return { ok:false, error:'integrity_check failed: '+ok.integrity_check }; }
const raw = fs.readFileSync(tmp); fs.unlinkSync(tmp);
```

Include the integrity result in the nightly digest so a bad backup is reported, not discovered at restore time.

---

## Finding 2 — MEDIUM: multi-statement writes outside transactions

Single-threaded execution prevents interleaving, but a crash or Render restart mid-sequence leaves partial state. Affected:

- `purgeOldSoftDeletes()` — 5 deletes + 1 update per client
- `DELETE /api/contracts/:id` — detach, delete visits, delete contract
- `POST /api/visits/:id/complete` — update visit, insert note, update action_items, insert commitments
- `createContractAndVisits()` — insert contract + N visit inserts

**Fix:** wrap each in `db.exec('BEGIN')` / `COMMIT` / `ROLLBACK` as already done in six other places (server.js 546, 908, 1555, 1703, 1928, 2055).

---

## Finding 3 — MEDIUM: foreign keys not enforced

`PRAGMA foreign_keys` is never enabled. `visits.cal_coach`, `visits.contract_id`, `visits.client_id`, `contracts.client_id` are unenforced. Audit routes catch orphans after the fact; FKs would prevent them at write time.

**Caution:** enabling requires a migration (SQLite can't `ALTER TABLE ADD CONSTRAINT`; needs table rebuild), and `completed_by_coach_id` must remain *un*-constrained or use `ON DELETE SET NULL` to preserve the intended history-keeping on coach deletion. Do this after Findings 1 and 2, with a fresh VACUUM INTO backup first.

---

## Finding 4 — LOW: repo hygiene

Root contains `server.js.backup*`, `server.js.fresh3–7`, `server.js.clean1`, `db.js.backup_pre_discipline`, `db.js.fresh3–6`, `.fuse_hidden*` in `data/`. Not a data risk; a wrong-file-edit risk. Move to a `_archive/` folder or delete after confirming git history has them.

---

## Recommended order

1. Backup fix + integrity check (Finding 1) — this week
2. Transactions on the four paths above (Finding 2)
3. Audit logging on client/contract PATCH routes (from earlier report)
4. Foreign keys with migration (Finding 3) — after a verified backup
5. Repo cleanup (Finding 4)
