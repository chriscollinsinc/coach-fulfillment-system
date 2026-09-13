const sqlite3 = require('better-sqlite3');
const db = new sqlite3('./data/coach.db');

// Check what visits exist
const visitStats = db.prepare(`
  SELECT 
    completed,
    COUNT(*) as count,
    SUM(CASE WHEN notes_wins IS NOT NULL THEN 1 ELSE 0 END) as with_wins,
    SUM(CASE WHEN notes_issues IS NOT NULL THEN 1 ELSE 0 END) as with_issues,
    SUM(CASE WHEN notes_focus IS NOT NULL THEN 1 ELSE 0 END) as with_focus
  FROM visits
  GROUP BY completed
`).all();

console.log('Visit statistics:');
visitStats.forEach(stat => {
  console.log(`Completed: ${stat.completed} | Total: ${stat.count} | With wins: ${stat.with_wins} | With issues: ${stat.with_issues} | With focus: ${stat.with_focus}`);
});

// Check Gallain Ford's visits specifically
console.log('\n\nGallain Ford visits:');
const gallain = db.prepare(`
  SELECT 
    v.id, v.completed, v.cycle, v.completed_date, v.notes_wins, v.notes_issues, v.contract_id,
    c.id as cid, c.start_date, c.program
  FROM visits v
  LEFT JOIN contracts c ON v.contract_id = c.id
  WHERE v.client = 'Gallain Ford'
  LIMIT 10
`).all();

gallain.forEach(v => {
  console.log(`ID: ${v.id} | Completed: ${v.completed} | Cycle: ${v.cycle} | Date: ${v.completed_date} | HasNotes: ${!!v.notes_wins} | Contract: ${v.cid} | Start: ${v.start_date}`);
});
