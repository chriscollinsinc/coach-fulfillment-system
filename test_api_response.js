const sqlite3 = require('better-sqlite3');
const db = new sqlite3('./data/coach.db');

// Run the EXACT API query from server.js for client 25
const clientId = 25;
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

console.log(`API Query returned: ${notes.length} notes for client ${clientId}`);

if (notes.length === 0) {
  console.log('\n⚠️  NO NOTES FOUND BY API QUERY');
  console.log('\nBUT there ARE completed visits for this client:');
  
  const allVisits = db.prepare(`
    SELECT id, completed_date, program, cycle, completed_by_coach_id, 
           notes_wins, notes_issues, notes_focus
    FROM visits 
    WHERE client_id = ? AND completed = 1
    LIMIT 3
  `).all(clientId);
  
  allVisits.forEach(v => {
    console.log(`\nVisit ${v.id}:`);
    console.log(`  Date: ${v.completed_date}`);
    console.log(`  Program/Cycle: ${v.program} - ${v.cycle}`);
    console.log(`  Completed by: ${v.completed_by_coach_id}`);
    console.log(`  wins=${v.notes_wins ? 'SET' : 'NULL'}, issues=${v.notes_issues ? 'SET' : 'NULL'}, focus=${v.notes_focus ? 'SET' : 'NULL'}`);
  });
}
