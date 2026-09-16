import Database from 'better-sqlite3';

import { runMigrations } from './migrations.js';

export type SentinelDatabase = Database.Database;

/**
 * Opens (creating if needed) the Sentinel SQLite database, enables WAL mode (spec
 * docs/SPEC.md #4 — better concurrent read/write behavior for a process that's
 * writing snapshots while a CLI command might read them), and applies any pending
 * migrations before returning.
 */
export function openDatabase(path: string): SentinelDatabase {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
