'use strict';

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_DIR  = process.env.DB_DIR  || '/data';
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'dormbook.db');

function initDb() {
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  } catch (err) {
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

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  return db;
}

/**
 * Safe migrations — adds new columns to existing tables.
 * Each checks if column exists. Fully idempotent.
 */
function runMigrations(db) {
  const getColumns = (table) =>
    db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(c => c.name);

  // v2.1: bed base rate
  const bedCols = getColumns('beds');
  if (!bedCols.includes('base_rate_paise')) {
    db.exec("ALTER TABLE beds ADD COLUMN base_rate_paise INTEGER NOT NULL DEFAULT 0");
    console.log('[MIGRATION] Added beds.base_rate_paise');
  }
  if (!bedCols.includes('daily_rate_paise')) {
    db.exec("ALTER TABLE beds ADD COLUMN daily_rate_paise INTEGER NOT NULL DEFAULT 0");
    console.log('[MIGRATION] Added beds.daily_rate_paise');
  }

  // v3: daily rate model on residents
  const resCols = getColumns('residents');
  if (!resCols.includes('rate_type')) {
    db.exec("ALTER TABLE residents ADD COLUMN rate_type TEXT NOT NULL DEFAULT 'monthly'");
    console.log('[MIGRATION] Added residents.rate_type');
  }
  if (!resCols.includes('rate_paise')) {
    db.exec("ALTER TABLE residents ADD COLUMN rate_paise INTEGER NOT NULL DEFAULT 0");
    // Backfill: existing residents get rate_paise = monthly_rent_paise
    db.exec("UPDATE residents SET rate_paise = monthly_rent_paise WHERE rate_paise = 0 AND monthly_rent_paise > 0");
    console.log('[MIGRATION] Added residents.rate_paise (backfilled from monthly_rent_paise)');
  }

  // v3: Sync daily_rate_paise from base_rate_paise for existing beds
  db.exec("UPDATE beds SET daily_rate_paise = base_rate_paise WHERE daily_rate_paise = 0 AND base_rate_paise > 0");

  console.log('[DB] Migrations complete');
}

module.exports = { initDb, DB_PATH };
