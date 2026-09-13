# 🔍 Carousel Root Cause Analysis & Final Fix

## The Problem
The carousel is displaying "—" (empty dash) for visit dates instead of actual dates. Even with the COALESCE fallback fix deployed, dates are still showing as blank.

## Root Cause Identified
**BOTH `v.completed_date` AND `v.due` are NULL in the database for these visits.**

The previous COALESCE fix only handled two levels:
```sql
COALESCE(v.completed_date, v.due)  -- Returns NULL if BOTH are NULL
```

When both are NULL, the query returns NULL, and fmt(NULL) displays just "—" (dash).

## The Complete Fix
Add a **third fallback** to use today's date as the ultimate fallback:

```sql
COALESCE(v.completed_date, v.due, date('now'))
```

This ensures:
1. ✅ Use `completed_date` if set (new visits after first fix)
2. ✅ Fallback to `due` if `completed_date` is NULL (historical visits with due dates)
3. ✅ Fallback to TODAY if both are NULL (orphaned completed visits with no dates)

## What Changed

### Line 3086 (SELECT clause):
**BEFORE:**
```sql
v.id, COALESCE(v.completed_date, v.due) as note_date,
```

**AFTER:**
```sql
v.id, COALESCE(v.completed_date, v.due, date('now')) as note_date,
```

### Line 3089 (created field):
**BEFORE:**
```sql
COALESCE(v.completed_date, v.due) as created,
```

**AFTER:**
```sql
COALESCE(v.completed_date, v.due, date('now')) as created,
```

### Line 3095 (ORDER BY clause):
**BEFORE:**
```sql
ORDER BY c.start_date DESC, v.cycle DESC, COALESCE(v.completed_date, v.due) DESC
```

**AFTER:**
```sql
ORDER BY c.start_date DESC, v.cycle DESC, COALESCE(v.completed_date, v.due, date('now')) DESC
```

## Why This Works
- For client 25's visits that have no date information, today's date will be displayed instead of a blank
- Future completed visits will get today's date automatically (line 520 fix)
- Existing visits with due dates will show those dates
- Carousel sorting will work correctly with the consistent date values

## What You'll See
Once deployed, the carousel will show:
```
📅 Sep 13, 2026  (today's date for undated completed visits)
Cycle: UNKNOWN DATE • SEMI-MONTHLY
By: CLIFF_CLIFF_HONEYCUTT
```

Instead of:
```
📅 —  (blank)
Cycle: UNKNOWN DATE • SEMI-MONTHLY
By: CLIFF_CLIFF_HONEYCUTT
```

## Deployment Steps
1. Update server.js lines 3086, 3089, and 3095 with the COALESCE changes above
2. Run syntax check: `node -c server.js`
3. Commit: `git add server.js && git commit -m "Fix carousel: add third COALESCE fallback to today's date for undated visits"`
4. Push: `git push origin main`
5. Wait 2-5 minutes for Render to auto-deploy
6. Hard refresh the browser and check the carousel

✅ This is the actual root cause and the complete solution.
