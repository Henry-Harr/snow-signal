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
  {
    version: 2,
    name: 'price_quotes',
    up: (db) => {
      db.exec(`
        -- Every raw quote from every price source, kept forever (docs/SPEC.md #6.5:
        -- "store every raw quote with its timestamp") — never overwritten or
        -- aggregated in place, so a later median/outlier recomputation can always
        -- replay from the same raw inputs. One row per (source, asset, fetch).
        CREATE TABLE price_quotes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          asset TEXT NOT NULL,
          quote_asset TEXT NOT NULL,
          chain_id INTEGER,
          price REAL NOT NULL,
          fetched_at INTEGER NOT NULL,
          block_number TEXT,
          raw TEXT NOT NULL
        );

        -- The query shape detectors/aggregation need: "every quote for this asset
        -- around this time," newest first.
        CREATE INDEX idx_price_quotes_asset_time
          ON price_quotes (asset, quote_asset, fetched_at DESC);
      `);
    },
  },
  {
    version: 3,
    name: 'protocol_events',
    up: (db) => {
      db.exec(`
        -- Decoded protocol events from every watcher (docs/SPEC.md #6.6), reusing
        -- each adapter's own decodeEvents() — one row per on-chain event, never
        -- overwritten. The UNIQUE constraint makes re-scanning an overlapping block
        -- range (the normal, safe way to poll for new events) idempotent rather than
        -- duplicating rows.
        CREATE TABLE protocol_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          protocol TEXT NOT NULL,
          chain_id INTEGER NOT NULL,
          market_id TEXT NOT NULL,
          event_name TEXT NOT NULL,
          block_number TEXT NOT NULL,
          transaction_hash TEXT NOT NULL,
          log_index INTEGER NOT NULL,
          args TEXT NOT NULL,
          UNIQUE (chain_id, transaction_hash, log_index)
        );

        CREATE INDEX idx_protocol_events_market
          ON protocol_events (market_id, block_number DESC);
      `);
    },
  },
  {
    version: 4,
    name: 'token_supply_snapshots',
    up: (db) => {
      db.exec(`
        -- Point-in-time totalSupply() readings for the token-supply watcher (docs/
        -- SPEC.md #6.6) — a time series, not an event, so it gets its own table
        -- rather than reusing protocol_events (which mint events, a real event, do
        -- reuse — see src/watchers/token-supply.ts). Never overwritten, so a later
        -- pass can always recompute "how fast did supply change" from the raw series.
        CREATE TABLE token_supply_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asset TEXT NOT NULL,
          chain_id INTEGER NOT NULL,
          total_supply TEXT NOT NULL,
          block_number TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          UNIQUE (asset, chain_id, block_number)
        );

        CREATE INDEX idx_token_supply_asset_time
          ON token_supply_snapshots (asset, chain_id, block_number DESC);
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
