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
  {
    version: 5,
    name: 'market_snapshots',
    up: (db) => {
      db.exec(`
        -- MarketSnapshot history (docs/SPEC.md #6, #5.1) — Phase 2/3 adapters produce
        -- these but nothing stored them across time until now; Phase 4's detectors
        -- need real history (D02's velocity window, D04's baseline windows, D08's
        -- borrow-growth check, …), which is exactly what this table exists to serve
        -- up via the Phase 5 context assembler (src/risk/context.ts). Append-only —
        -- never overwritten, so a detector's "history" is always the real recorded
        -- series, not a value recomputed after the fact.
        CREATE TABLE market_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          market_id TEXT NOT NULL,
          protocol TEXT NOT NULL,
          chain_id INTEGER NOT NULL,
          block_number TEXT NOT NULL,
          block_hash TEXT NOT NULL,
          block_timestamp INTEGER NOT NULL,
          total_supplied TEXT NOT NULL,
          total_borrowed TEXT NOT NULL,
          available_liquidity TEXT NOT NULL,
          utilization REAL NOT NULL,
          supply_rate REAL NOT NULL,
          borrow_rate REAL NOT NULL,
          paused INTEGER NOT NULL,
          frozen INTEGER NOT NULL,
          oracle_prices TEXT NOT NULL,
          bad_debt TEXT,
          raw TEXT NOT NULL,
          UNIQUE (market_id, block_number)
        );

        CREATE INDEX idx_market_snapshots_market_block
          ON market_snapshots (market_id, block_number DESC);
      `);
    },
  },
  {
    version: 6,
    name: 'decision_records',
    up: (db) => {
      db.exec(`
        -- The risk engine's explainable decision log (docs/SPEC.md #5.1, #8.1: "every
        -- transition writes a DecisionRecord containing the inputs, detector outputs,
        -- the rule that fired, block numbers, and the config hash"). Append-only,
        -- written on every decide() call (not just on a level change) — see
        -- src/risk/state-machine.ts and docs/adr/0008 for exactly what's recorded and
        -- why the id lives only here (decide() itself is a pure function and returns
        -- a Decision with no id — the AUTOINCREMENT id is assigned on insert, same
        -- pattern as every other table in this file).
        CREATE TABLE decision_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          position_id TEXT NOT NULL,
          at TEXT NOT NULL,
          block_number TEXT NOT NULL,
          previous_level TEXT NOT NULL,
          level TEXT NOT NULL,
          raw_level TEXT NOT NULL,
          signals TEXT NOT NULL,
          rule TEXT NOT NULL,
          action TEXT NOT NULL,
          standing_alert INTEGER NOT NULL,
          config_hash TEXT NOT NULL
        );

        CREATE INDEX idx_decision_records_position_at
          ON decision_records (position_id, at DESC);
      `);
    },
  },
  {
    version: 7,
    name: 'risk_state',
    up: (db) => {
      db.exec(`
        -- Current per-position risk-engine state (docs/SPEC.md #8.1) — unlike every
        -- table above, this one is mutated in place (UPSERT), not append-only: it's
        -- "where things stand right now," the same way chain_state (migration 1) is.
        -- The full history of how it got here lives in decision_records instead.
        -- Persisting this is what makes the risk engine idempotent/restartable
        -- (docs/ARCHITECTURE.md #2) — a restart resumes hysteresis dwell timers and
        -- manual controls (ack/mute/force) exactly where they left off.
        CREATE TABLE risk_state (
          position_id TEXT PRIMARY KEY,
          level TEXT NOT NULL,
          since TEXT NOT NULL,
          pending_deescalation_level TEXT,
          pending_deescalation_since TEXT,
          acked_decision_id INTEGER,
          muted_until TEXT,
          forced_level TEXT,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 8,
    name: 'global_controls',
    up: (db) => {
      db.exec(`
        -- A tiny key/value table for system-wide (not per-position) controls — today
        -- just the kill switch (docs/SPEC.md #8.4), kept as its own table rather than
        -- a magic row in risk_state since it isn't position-scoped at all.
        CREATE TABLE global_controls (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 9,
    name: 'decision_labels',
    up: (db) => {
      db.exec(`
        -- Human-assigned labels on decisions (docs/SPEC.md #5.1 "Labeling CLI
        -- (sentinel label)", Phase 5) — ground truth for Phase 6's replay scoring
        -- (false positive vs. real incident) and shown as a decision's "current
        -- label" in the daily report (spec §10.2). One label per decision, mutable
        -- (a label can be corrected), so this is UPSERT like risk_state, not
        -- append-only — the point is "what do we currently believe this was," not a
        -- history of label edits.
        CREATE TABLE decision_labels (
          decision_id INTEGER PRIMARY KEY REFERENCES decision_records (id),
          label TEXT NOT NULL,
          notes TEXT,
          labeled_at TEXT NOT NULL
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
