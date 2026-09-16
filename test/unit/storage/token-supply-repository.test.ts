import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { TokenSupplyRepository } from '../../../src/storage/token-supply-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { TokenSupplySnapshot } from '../../../src/watchers/token-supply.js';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;

function snapshot(overrides: Partial<TokenSupplySnapshot> = {}): TokenSupplySnapshot {
  return {
    asset: USDC,
    chainId: 1,
    totalSupply: 25_000_000_000_000n,
    blockNumber: 100n,
    fetchedAt: 1_700_000_000,
    ...overrides,
  };
}

describe('TokenSupplyRepository', () => {
  let repo: TokenSupplyRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new TokenSupplyRepository(db);
  });

  it('round-trips a snapshot, including a large bigint totalSupply', () => {
    const s = snapshot();
    repo.record(s);
    const [found] = repo.findRecent(USDC, 1, 0n);
    expect(found).toEqual(s);
  });

  it('is idempotent for the same asset/chain/block', () => {
    repo.record(snapshot());
    repo.record(snapshot());
    expect(repo.findRecent(USDC, 1, 0n)).toHaveLength(1);
  });

  it('findRecent filters by asset/chain and minimum block, oldest first', () => {
    repo.record(snapshot({ blockNumber: 300n, totalSupply: 3n }));
    repo.record(snapshot({ blockNumber: 100n, totalSupply: 1n }));
    repo.record(snapshot({ blockNumber: 200n, totalSupply: 2n }));
    repo.record(snapshot({ chainId: 8453, blockNumber: 150n, totalSupply: 99n }));

    const found = repo.findRecent(USDC, 1, 150n);
    expect(found.map((s) => s.totalSupply)).toEqual([2n, 3n]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(repo.findRecent(USDC, 1, 0n)).toEqual([]);
  });
});
