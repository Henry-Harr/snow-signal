import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/storage/migrations.js';

describe('runMigrations', () => {
  it('creates the expected tables on a fresh database', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'chain_state',
        'processed_blocks',
        'price_quotes',
        'protocol_events',
        'token_supply_snapshots',
        'market_snapshots',
        'decision_records',
        'risk_state',
        'global_controls',
        'decision_labels',
        'schema_migrations',
      ]),
    );
    db.close();
  });

  it('is idempotent: running twice does not error or duplicate migration rows', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const afterFirstRun = db.prepare('SELECT version FROM schema_migrations').all();

    runMigrations(db);
    const afterSecondRun = db.prepare('SELECT version FROM schema_migrations').all();

    expect(afterSecondRun).toEqual(afterFirstRun);
    db.close();
  });
});
