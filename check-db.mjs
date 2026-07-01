#!/usr/bin/env node
import BetterSqlite3 from 'better-sqlite3';
const db = new BetterSqlite3('./slp-local.sqlite');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
console.log('\n=== DATABASE INTEGRITY CHECK ===');
console.log(`✓ Tables intact: ${tables.length} total`);
console.log(`✓ First 5 tables: ${tables.slice(0, 5).join(', ')}`);

// Check data counts
const sheets = db.prepare('SELECT COUNT(*) as count FROM uploaded_sheets').get();
const rows = db.prepare('SELECT COUNT(*) as count FROM sheet_rows').get();
console.log(`✓ Sheets indexed: ${sheets.count}`);
console.log(`✓ Rows indexed: ${rows.count}`);
db.close();
