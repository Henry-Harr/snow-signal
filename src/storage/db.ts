import Database from 'better-sqlite3';

export type StopLossDatabase = Database.Database;

export function openDatabase(path: string): StopLossDatabase {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS trigger_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      label TEXT NOT NULL,
      token_id TEXT NOT NULL,
      trigger_price REAL NOT NULL,
      limit_price REAL NOT NULL,
      maker_amount TEXT NOT NULL,
      taker_amount TEXT NOT NULL,
      kind TEXT NOT NULL,
      order_id TEXT,
      error_msg TEXT
    );
  `);
  return db;
}
