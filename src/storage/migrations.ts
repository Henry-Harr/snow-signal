import type { SentinelDatabase } from './db.js';
import { StorageError } from '../core/errors.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: SentinelDatabase) => void;
}

/**
 * Versioned, numbered, forward-only migrations (docs/SPEC.md #4). Defined as code
 * rather than external .sql files so they ship correctly through the TypeScript build
 * without a separate asset-copy step. Never edit an already-applied migration —
 * add a new one instead, the same way you would with file-based migrations.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    up: (db) => {
      db.exec(`
        CREATE TABLE chain_state (
          chain_id INTEGER PRIMARY KEY,
          last_processed_block TEXT NOT NULL,
          last_processed_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE processed_blocks (
          chain_id INTEGER NOT NULL,
          block_number TEXT NOT NULL,
          block_hash TEXT NOT NULL,
          parent_hash TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          PRIMARY KEY (chain_id, block_number)
        );
      `);
    },
  },
];

function ensureMigrationsTable(db: SentinelDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/** Applies every migration whose version isn't yet recorded in `schema_migrations`,
 * in ascending version order, each inside its own transaction. Idempotent: safe to
 * call on every startup (docs/SPEC.md #13 Phase 1 acceptance criteria). */
export function runMigrations(db: SentinelDatabase): void {
  ensureMigrationsTable(db);

  const appliedVersions = new Set(
    db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[],
  );
  const appliedVersionNumbers = new Set([...appliedVersions].map((row) => row.version));

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of sorted) {
    if (appliedVersionNumbers.has(migration.version)) continue;

    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });

    try {
      apply();
    } catch (cause) {
      throw new StorageError(`Migration ${migration.version} (${migration.name}) failed to apply`, {
        cause,
      });
    }
  }
}
