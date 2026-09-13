const sqlite3 = require('better-sqlite3');
const db = new sqlite3('./data/coach.db');

// Find clients with completed visit notes
const result = db.prepare(`
  SELECT DISTINCT
    c.id,
    v.client,
    c.start_date,
    c.program,
    COUNT(v.id) as completed_with_notes
  FROM visits v
  LEFT JOIN contracts c ON v.contract_id = c.id
  WHERE v.completed = 1
    AND (v.notes_wins IS NOT NULL OR v.notes_issues IS NOT NULL OR v.notes_focus IS NOT NULL OR v.notes_commitments IS NOT NULL)
  GROUP BY c.id
  LIMIT 5
`).all();

console.log('Clients with completed visit notes:');
result.forEach(r => {
  console.log(`Contract ID: ${r.id} | Client: ${r.client} | start_date: ${r.start_date} | program: ${r.program} | notes: ${r.completed_with_notes}`);
});

// Get a sample visit with notes
console.log('\n\nSample visit with notes:');
const sample = db.prepare(`
  SELECT 
    v.id, v.client, v.completed_date, v.cycle, v.program, v.contract_id,
    v.notes_wins, v.notes_issues, v.notes_focus, v.notes_commitments,
    c.start_date, c.program as contract_program
  FROM visits v
  LEFT JOIN contracts c ON v.contract_id = c.id
  WHERE v.completed = 1 AND v.notes_wins IS NOT NULL
  LIMIT 1
`).get();

if (sample) {
  console.log(`Visit ID: ${sample.id}`);
  console.log(`Client: ${sample.client}`);
  console.log(`Completed: ${sample.completed_date}`);
  console.log(`Cycle: ${sample.cycle}`);
  console.log(`Program: ${sample.program}`);
  console.log(`Contract start_date: ${sample.start_date}`);
  console.log(`Wins: ${sample.notes_wins}`);
}
