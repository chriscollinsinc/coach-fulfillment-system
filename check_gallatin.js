const sqlite3 = require('better-sqlite3');
const db = new sqlite3('./data/coach.db');

// Check notes for Gallatin Ford (client ID 25)
console.log('All client notes and their associated clients:');
const allNotes = db.prepare(`
  SELECT 
    n.id, n.client_id, c.name, n.note_date, n.note_type, n.author_name, 
    n.wins, n.issues, n.focus, n.body
  FROM client_notes n
  LEFT JOIN clients c ON n.client_id = c.id
`).all();

allNotes.forEach(n => {
  console.log(`Note ID: ${n.id} | Client ${n.client_id}: ${n.name} | Date: ${n.note_date} | Author: ${n.author_name}`);
});

// Check what the API endpoint returns for client 25
console.log('\n\nCalling API query for client 25 (Gallatin Ford):');
const apiResult = db.prepare(`
  SELECT
    v.id, v.completed_date as note_date, 'Visit Note' as note_type,
    v.notes_wins as wins, v.notes_issues as issues, v.notes_focus as focus,
    v.completed_by_email as author_email, v.completed_by_coach_id as author_name,
    v.completed_date as created, v.cycle, v.program, v.contract_id,
    c.start_date, c.status
  FROM visits v
  LEFT JOIN contracts c ON v.contract_id = c.id
  WHERE v.client_id = 25 AND v.completed = 1
    AND (v.notes_wins IS NOT NULL OR v.notes_issues IS NOT NULL OR v.notes_focus IS NOT NULL OR v.notes_commitments IS NOT NULL)
  ORDER BY c.start_date DESC, v.cycle DESC, v.completed_date DESC
`).all();

console.log(`Results for client 25: ${apiResult.length} rows`);
