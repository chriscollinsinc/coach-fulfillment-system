const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database('coach.db');

// Read migration SQL
const migrationSQL = `
ALTER TABLE coaches ADD COLUMN is_launch_certified INTEGER DEFAULT 1;
ALTER TABLE coaches ADD COLUMN is_advisor_only INTEGER DEFAULT 0;
ALTER TABLE coaches ADD COLUMN is_handoff_capable INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings(key, value) VALUES ('handoff_mode_enabled', '0');
`;

try {
  // Split by semicolon and execute each statement
  const statements = migrationSQL.split(';').filter(s => s.trim());
  
  for (const statement of statements) {
    console.log(`Executing: ${statement.trim().substring(0, 50)}...`);
    db.exec(statement);
  }
  
  console.log('✅ Migration completed successfully!');
  
  // Verify the changes
  const coaches = db.prepare('PRAGMA table_info(coaches)').all();
  console.log('\nCoaches table structure:');
  coaches.forEach(col => console.log(`  - ${col.name}: ${col.type}`));
  
  const settings = db.prepare('SELECT * FROM settings').all();
  console.log('\nSettings:');
  settings.forEach(s => console.log(`  - ${s.key}: ${s.value}`));
  
} catch (e) {
  console.error('❌ Migration failed:', e.message);
  process.exit(1);
}

db.close();
