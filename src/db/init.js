'use strict';

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

// Railway volumes mount at /data by convention.
// Fallback: ./data relative to project root (local dev).
const DB_DIR  = process.env.DB_DIR  || '/data';
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'dormbook.db');

function initDb() {
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  } catch (err) {
    // /data may not be writable without a volume — fall back to ./data
    const fallback = path.join(__dirname, '..', '..', 'data');
    console.warn(`[DB] Cannot write to ${DB_DIR} (${err.message}), falling back to ${fallback}`);
    if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
    return openDb(path.join(fallback, 'dormbook.db'));
  }
  return openDb(DB_PATH);
}

function openDb(dbPath) {
  console.log(`[DB] Opening database at: ${dbPath}`);
  const db     = new Database(dbPath);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Performance tuning
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Run safe migrations for existing databases
  runMigrations(db);

  return db;
}

/**
 * Safe migrations — adds new columns to existing tables.
 * Each migration checks if the column exists before ALTER TABLE.
 * This runs on every startup and is fully idempotent.
 */
function runMigrations(db) {
  const getColumns = (table) =>
    db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(c => c.name);

  // v2.1: Add base_rate_paise to beds (owner-set bed price)
  const bedCols = getColumns('beds');
  if (!bedCols.includes('base_rate_paise')) {
    db.exec("ALTER TABLE beds ADD COLUMN base_rate_paise INTEGER NOT NULL DEFAULT 0");
    console.log('[MIGRATION] Added beds.base_rate_paise');
  }

  console.log('[DB] Migrations complete');
}

module.exports = { initDb, DB_PATH };
