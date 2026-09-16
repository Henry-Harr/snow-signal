import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { ProtocolEventRepository } from '../../../src/storage/protocol-event-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { ProtocolEvent } from '../../../src/core/types.js';

function event(overrides: Partial<ProtocolEvent> = {}): ProtocolEvent {
  return {
    protocol: 'aave-v3',
    chainId: 1,
    marketId: 'aave-v3:ethereum:core',
    eventName: 'ReserveFrozen',
    blockNumber: 100n,
    transactionHash: '0xabc',
    logIndex: 1,
    args: { asset: '0xUSDC', frozen: true },
    ...overrides,
  };
}

describe('ProtocolEventRepository', () => {
  let repo: ProtocolEventRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new ProtocolEventRepository(db);
  });

  it('round-trips an event, including a bigint blockNumber and args', () => {
    const e = event();
    repo.record('governance', e);
    const [found] = repo.findByMarket('aave-v3:ethereum:core', 0n);
    expect(found).toEqual(e);
  });

  it('is idempotent for the same chain/tx/logIndex (INSERT OR IGNORE)', () => {
    repo.record('governance', event());
    repo.record('governance', event()); // re-scan of an overlapping block range
    expect(repo.findByMarket('aave-v3:ethereum:core', 0n)).toHaveLength(1);
  });

  it('does not dedupe two different events in the same transaction', () => {
    repo.record('governance', event({ logIndex: 1 }));
    repo.record('governance', event({ logIndex: 2 }));
    expect(repo.findByMarket('aave-v3:ethereum:core', 0n)).toHaveLength(2);
  });

  it('findByMarket filters by market and minimum block, oldest first', () => {
    repo.recordAll('governance', [
      event({ blockNumber: 300n, logIndex: 1 }),
      event({ blockNumber: 100n, logIndex: 2 }),
      event({ blockNumber: 200n, logIndex: 3 }),
      event({ marketId: 'aave-v3:base:core', blockNumber: 150n, logIndex: 4 }),
    ]);

    const found = repo.findByMarket('aave-v3:ethereum:core', 150n);
    expect(found.map((e) => e.blockNumber)).toEqual([200n, 300n]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(repo.findByMarket('nope', 0n)).toEqual([]);
  });
});
