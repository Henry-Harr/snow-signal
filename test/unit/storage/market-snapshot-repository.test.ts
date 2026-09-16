import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { MarketSnapshotRepository } from '../../../src/storage/market-snapshot-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { MarketSnapshot } from '../../../src/core/types.js';

function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    marketId: 'aave-v3:ethereum:core',
    block: { chainId: 1, number: 100n, hash: '0xblock', timestamp: 1_700_000_000 },
    totalSupplied: 1_000_000n,
    totalBorrowed: 500_000n,
    availableLiquidity: 500_000n,
    utilization: 0.5,
    supplyRate: 0.02,
    borrowRate: 0.04,
    flags: { paused: false, frozen: false },
    oraclePrices: { '0xasset': 100_000_000n },
    raw: { extra: 'data' },
    ...overrides,
  };
}

describe('MarketSnapshotRepository', () => {
  let repo: MarketSnapshotRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new MarketSnapshotRepository(db);
  });

  it('round-trips a snapshot exactly, including bigints, flags, and oraclePrices', () => {
    const s = snapshot();
    repo.record('aave-v3', s);
    const [found] = repo.findHistory(s.marketId, 0n);
    expect(found).toEqual(s);
  });

  it('round-trips badDebt when present, and omits it when absent', () => {
    repo.record(
      'aave-v3',
      snapshot({ block: { ...snapshot().block, number: 100n }, badDebt: 42n }),
    );
    repo.record('aave-v3', snapshot({ block: { ...snapshot().block, number: 200n } }));
    const history = repo.findHistory('aave-v3:ethereum:core', 0n);
    expect(history[0]?.badDebt).toBe(42n);
    expect(history[1]?.badDebt).toBeUndefined();
  });

  it('is idempotent for the same market/block (INSERT OR IGNORE)', () => {
    repo.record('aave-v3', snapshot());
    repo.record('aave-v3', snapshot());
    expect(repo.findHistory('aave-v3:ethereum:core', 0n)).toHaveLength(1);
  });

  it('findHistory returns entries at or above sinceBlock, oldest first', () => {
    repo.record('aave-v3', snapshot({ block: { ...snapshot().block, number: 300n } }));
    repo.record('aave-v3', snapshot({ block: { ...snapshot().block, number: 100n } }));
    repo.record('aave-v3', snapshot({ block: { ...snapshot().block, number: 200n } }));

    const found = repo.findHistory('aave-v3:ethereum:core', 150n);
    expect(found.map((s) => s.block.number)).toEqual([200n, 300n]);
  });

  it('findLatest returns the most recent snapshot, or undefined when none exist', () => {
    expect(repo.findLatest('aave-v3:ethereum:core')).toBeUndefined();
    repo.record('aave-v3', snapshot({ block: { ...snapshot().block, number: 100n } }));
    repo.record('aave-v3', snapshot({ block: { ...snapshot().block, number: 300n } }));
    repo.record('aave-v3', snapshot({ block: { ...snapshot().block, number: 200n } }));
    expect(repo.findLatest('aave-v3:ethereum:core')?.block.number).toBe(300n);
  });
});
