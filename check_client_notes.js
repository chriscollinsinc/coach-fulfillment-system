const sqlite3 = require('better-sqlite3');
const db = new sqlite3('./data/coach.db');

// Check the client_notes table
console.log('Client notes table:');
const notes = db.prepare(`
  SELECT id, client_id, note_date, note_type, author_name, wins, issues, focus, body
  FROM client_notes
  LIMIT 5
`).all();

if (notes.length > 0) {
  notes.forEach(n => {
    console.log(`ID: ${n.id} | Client: ${n.client_id} | Date: ${n.note_date} | Author: ${n.author_name} | Type: ${n.note_type}`);
    console.log(`  Wins: ${n.wins ? 'Yes' : 'No'} | Issues: ${n.issues ? 'Yes' : 'No'} | Focus: ${n.focus ? 'Yes' : 'No'}`);
  });
} else {
  console.log('No client notes found');
}

// Check if there are any notes at all
const noteCount = db.prepare('SELECT COUNT(*) as count FROM client_notes').get();
console.log(`\nTotal client notes: ${noteCount.count}`);

// Check clients table
const clientCount = db.prepare('SELECT COUNT(*) as count FROM clients').get();
console.log(`Total clients: ${clientCount.count}`);

// Try to find the client ID for Gallain Ford
const clients = db.prepare(`
  SELECT id, name FROM clients WHERE name LIKE '%Gallain%' OR name LIKE '%Ford%'
  LIMIT 5
`).all();

console.log('\nClients matching "Gallain" or "Ford":');
clients.forEach(c => {
  console.log(`  ID: ${c.id} | Name: ${c.name}`);
});
