const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = './data/coach.db';
const SCHEMA_FILE = './schema_migration_phase1.sql';

// Read schema file
const schema = fs.readFileSync(SCHEMA_FILE, 'utf-8');

// Connect to database
const db = new Database(DB_PATH);

// Split by semicolon and execute each statement
const statements = schema.split(';').filter(s => s.trim());

console.log(`📝 Applying schema from ${SCHEMA_FILE}...`);
console.log(`📊 Database: ${DB_PATH}`);
console.log(`\n`);

let count = 0;
for (const stmt of statements) {
  const trimmed = stmt.trim();
  if (!trimmed) continue;
  
  try {
    db.exec(trimmed);
    count++;
  } catch (err) {
    console.error(`❌ Error executing statement:`);
    console.error(trimmed.substring(0, 100) + '...');
    console.error(err.message);
    process.exit(1);
  }
}

console.log(`✅ Successfully applied ${count} schema statements`);

// Verify tables were created
const tables = db.prepare(`
  SELECT name FROM sqlite_master 
  WHERE type='table' AND name NOT LIKE 'sqlite_%'
  ORDER BY name
`).all();

console.log(`\n📋 Tables created:`);
tables.forEach(t => console.log(`   - ${t.name}`));

db.close();
