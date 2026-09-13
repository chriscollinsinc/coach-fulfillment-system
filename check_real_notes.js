const sqlite3 = require('better-sqlite3');
const db = new sqlite3('./data/coach.db');

// Check ALL visits with ANY note data
const withData = db.prepare(`
  SELECT COUNT(*) as count FROM visits 
  WHERE completed = 1 AND (
    notes_wins IS NOT NULL AND LENGTH(TRIM(notes_wins)) > 0
    OR notes_issues IS NOT NULL AND LENGTH(TRIM(notes_issues)) > 0
    OR notes_focus IS NOT NULL AND LENGTH(TRIM(notes_focus)) > 0
  )
`).get();

console.log(`Visits with actual note content: ${withData.count}`);

// Show any example
if (withData.count > 0) {
  const example = db.prepare(`
    SELECT id, client, completed_date, notes_wins, notes_issues, notes_focus
    FROM visits 
    WHERE completed = 1 AND (
      notes_wins IS NOT NULL AND LENGTH(TRIM(notes_wins)) > 0
      OR notes_issues IS NOT NULL AND LENGTH(TRIM(notes_issues)) > 0
      OR notes_focus IS NOT NULL AND LENGTH(TRIM(notes_focus)) > 0
    )
    LIMIT 1
  `).get();
  console.log('\nExample note:', example);
}

// Check the Gallatin Ford visit specifically
console.log('\n\nGallatin Ford Semi-Monthly visit (Mar 1, 2026):');
const gallatin = db.prepare(`
  SELECT 
    v.id, v.client, v.completed_date, v.program, v.cycle,
    v.notes_wins, v.notes_issues, v.notes_focus, v.notes_commitments,
    c.start_date
  FROM visits v
  LEFT JOIN contracts c ON v.contract_id = c.id
  WHERE v.completed_date IS NOT NULL AND v.program = 'Semi-Monthly'
  LIMIT 1
`).get();

if (gallatin) {
  console.log('ID:', gallatin.id);
  console.log('Client:', gallatin.client);
  console.log('Completed:', gallatin.completed_date);
  console.log('Program:', gallatin.program);
  console.log('Cycle:', gallatin.cycle);
  console.log('Notes Wins:', gallatin.notes_wins);
  console.log('Notes Issues:', gallatin.notes_issues);
  console.log('Notes Focus:', gallatin.notes_focus);
  console.log('Contract Start:', gallatin.start_date);
}
