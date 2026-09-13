const sqlite3 = require('better-sqlite3');
const db = new sqlite3('./data/coach.db');

// Get table info
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

// Check contracts table
console.log('\nContracts columns:');
db.prepare("PRAGMA table_info(contracts)").all().forEach(col => {
  console.log(`  ${col.name}: ${col.type}`);
});

// Check visits table
console.log('\nVisits columns:');
db.prepare("PRAGMA table_info(visits)").all().forEach(col => {
  console.log(`  ${col.name}: ${col.type}`);
});
