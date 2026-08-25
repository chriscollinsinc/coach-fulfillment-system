const Database = require('better-sqlite3');

const DB_PATH = '/tmp/coach_test.db';
const db = new Database(DB_PATH);

console.log(`🔧 Initializing test database at ${DB_PATH}...`);

db.exec('CREATE TABLE coaches(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
db.exec('CREATE TABLE clients(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
db.exec('CREATE TABLE contracts(id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, program TEXT, visits INTEGER)');
db.exec('CREATE TABLE visits(coach_id TEXT, week TEXT, kind TEXT, client_id INTEGER, contract_id INTEGER, PRIMARY KEY(coach_id, week))');

console.log('✅ Test database created');
db.close();
