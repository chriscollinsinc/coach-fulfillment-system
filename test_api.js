const sqlite3 = require('better-sqlite3');
const db = new sqlite3('./data/coach.db');

// Simulate the API endpoint for client 25 (Gallatin Ford)
const clientId = 25;

console.log(`\nTesting API query for client ${clientId}:`);

try {
  // This is the exact query from server.js lines 3082-3094
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
  
  console.log(`Found ${notes.length} notes`);
  
  if (!notes.length) {
    console.log('No notes, returning empty cycles array');
  } else {
    // Simulate the grouping logic
    function formatCycleDate(date) {
      // This is from server.js, need to check if function exists
      return date.toISOString().slice(0, 10);
    }
    
    const contractMap = {};
    for (const note of notes) {
      const contractId = note.contract_id || 'standalone';
      const cycleLabel = note.cycle || 'Unassigned';
      const startDate = note.start_date ? formatCycleDate(new Date(note.start_date)) : 'Unknown date';
      
      const tabLabel = `${startDate} • ${note.program || 'Program'}`;
      
      if (!contractMap[contractId]) {
        contractMap[contractId] = {
          contract_id: contractId,
          cycle_label: tabLabel,
          program: note.program || null,
          start_date: note.start_date,
          notes: []
        };
      }
      
      contractMap[contractId].notes.push({
        id: note.id,
        date: note.note_date,
        type: note.note_type,
        cycle: cycleLabel,
        wins: note.wins,
        issues: note.issues,
        focus: note.focus,
        author: note.author_name || note.author_email,
        created: note.created
      });
    }
    
    const cycles = Object.values(contractMap).sort((a, b) => {
      const dateA = new Date(a.start_date || 0);
      const dateB = new Date(b.start_date || 0);
      return dateB - dateA;
    });
    
    console.log('Cycles:', JSON.stringify(cycles, null, 2));
  }
} catch (err) {
  console.error('ERROR:', err.message);
  console.error('Stack:', err.stack);
}

// Let's also check if formatCycleDate function is defined in server.js
