import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

// Allocation links are unauthenticated, so ids double as capability tokens
// and must be unguessable.
export function makeId(prefix) {
  return prefix + randomBytes(9).toString('base64url');
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function openDb(dbPath) {
  ensureDir(dbPath);
  if (process.env.PACT_RESET_DB === '1') {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Databases created before the raise → pact rename carry the old table name.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('raises', 'pacts')").all().map(row => row.name);
  if (tables.includes('raises') && !tables.includes('pacts')) {
    db.exec('ALTER TABLE raises RENAME TO pacts');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS pacts (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

export function readPact(db, id) {
  const row = db.prepare('SELECT data FROM pacts WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : null;
}

export function readAllPacts(db) {
  return db.prepare('SELECT data FROM pacts ORDER BY created_at DESC').all().map(row => JSON.parse(row.data));
}

export function writePact(db, pact) {
  const now = Date.now();
  pact.updatedAt = now;
  db.prepare(`
    INSERT INTO pacts (id, data, created_at, updated_at)
    VALUES (@id, @data, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run({
    id: pact.id,
    data: JSON.stringify(pact),
    createdAt: pact.createdAt || now,
    updatedAt: now,
  });
  return pact;
}
