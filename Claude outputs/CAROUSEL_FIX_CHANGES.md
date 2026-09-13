# 🔧 Critical Carousel Fix: Visit Dates Now Display

## Problem Identified
The carousel wasn't showing visit dates because `completed_date` was being set to **NULL** when visits were completed. This column was added recently but all existing visits have NULL values.

## Solution: Two-Part Fix

### Change 1: Line 520 in server.js
**Set default completed_date to today instead of NULL when visit is completed**

**OLD:**
```javascript
  const completedDate = body && body.completed_date ? String(body.completed_date).trim() : null;
```

**NEW:**
```javascript
  const completedDate = body && body.completed_date ? String(body.completed_date).trim() : new Date().toISOString().slice(0,10);
```

**Why:** When coaches complete visits, they might not explicitly provide a completed_date. Instead of NULL, we default to today's date. This ensures all NEW visits will have a date to display.

---

### Change 2: Lines 3083-3095 in server.js
**Use COALESCE to fallback to visit due date if completed_date is NULL**

**OLD:**
```javascript
    // Query notes from completed visits (where notes are stored on visits table)
    const notes = db.prepare(`
      SELECT
        v.id, v.completed_date as note_date, 'Visit Note' as note_type,
        v.notes_wins as wins, v.notes_issues as issues, v.notes_focus as focus,
        v.completed_by_email as author_email, v.completed_by_coach_id as author_name,
        v.completed_date as created, v.cycle, v.program, v.contract_id,
        c.start_date, c.status
      FROM visits v
      LEFT JOIN contracts c ON v.contract_id = c.id
      WHERE v.client_id = ? AND v.completed = 1
        AND (v.notes_wins IS NOT NULL OR v.notes_issues IS NOT NULL OR v.notes_focus IS NOT NULL OR v.notes_commitments IS NOT NULL)
      ORDER BY c.start_date DESC, v.cycle DESC, v.completed_date DESC
    `).all(clientId);
```

**NEW:**
```javascript
    // Query notes from completed visits (where notes are stored on visits table)
    // Use COALESCE to fallback to due date if completed_date is NULL (for historical visits)
    const notes = db.prepare(`
      SELECT
        v.id, COALESCE(v.completed_date, v.due) as note_date, 'Visit Note' as note_type,
        v.notes_wins as wins, v.notes_issues as issues, v.notes_focus as focus,
        v.completed_by_email as author_email, v.completed_by_coach_id as author_name,
        COALESCE(v.completed_date, v.due) as created, v.cycle, v.program, v.contract_id,
        c.start_date, c.status
      FROM visits v
      LEFT JOIN contracts c ON v.contract_id = c.id
      WHERE v.client_id = ? AND v.completed = 1
        AND (v.notes_wins IS NOT NULL OR v.notes_issues IS NOT NULL OR v.notes_focus IS NOT NULL OR v.notes_commitments IS NOT NULL)
      ORDER BY c.start_date DESC, v.cycle DESC, COALESCE(v.completed_date, v.due) DESC
    `).all(clientId);
```

**Why:** This ensures that EXISTING visits (which have NULL completed_date) will display their due date in the carousel instead of being blank. This is the immediate fix for historical data.

---

## How to Deploy

1. **Make these two edits in your server.js file**
2. **Run the syntax check:**
   ```bash
   node -c server.js
   ```
3. **Commit and push:**
   ```bash
   git add server.js
   git commit -m "Fix carousel visit dates: set completed_date default and add fallback"
   git push origin main
   ```
4. **Render will auto-deploy** within 2-5 minutes

## What This Fixes
- ✅ Visit dates will now display in the carousel
- ✅ New visits completed after this deployment will automatically have the current date
- ✅ Existing visits will show their due date if no completed_date is set
- ✅ Carousel sorting will work correctly by date

## Expected Result
The carousel will now show the visit date prominently at the top of each note:
```
📅 Jan 15, 2026
Cycle: Jan 15, 2026 • Quarterly
By: Coach Name

✓ Wins: [note content]
⚠ Issues: [note content]
→ Focus: [note content]
```
