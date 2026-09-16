import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { ChainStateRepository } from '../../../src/storage/chain-state-repository.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { BlockRef } from '../../../src/core/types.js';

function block(number: bigint, hash: string): BlockRef {
  return { chainId: 1, number, hash: hash as `0x${string}`, timestamp: Number(number) };
}

describe('ChainStateRepository', () => {
  let repo: ChainStateRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new ChainStateRepository(db);
  });

  it('returns undefined for a chain with no recorded blocks', () => {
    expect(repo.getLastProcessed(1)).toBeUndefined();
  });

  it('records a processed block and reports it as last processed', () => {
    repo.recordProcessed(block(10n, '0xabc'), '0xparent');
    const last = repo.getLastProcessed(1);
    expect(last).toEqual({ number: 10n, hash: '0xabc' });
    expect(repo.getBlockHash(1, 10n)).toBe('0xabc');
  });

  it('advances last processed across multiple blocks', () => {
    repo.recordProcessed(block(10n, '0xa'), '0x0');
    repo.recordProcessed(block(11n, '0xb'), '0xa');
    expect(repo.getLastProcessed(1)).toEqual({ number: 11n, hash: '0xb' });
  });

  it('rollbackFrom removes blocks at or above the given number and resets the cursor', () => {
    repo.recordProcessed(block(10n, '0xa'), '0x0');
    repo.recordProcessed(block(11n, '0xb'), '0xa');
    repo.recordProcessed(block(12n, '0xc'), '0xb');

    repo.rollbackFrom(1, 11n);

    expect(repo.getBlockHash(1, 12n)).toBeUndefined();
    expect(repo.getBlockHash(1, 11n)).toBeUndefined();
    expect(repo.getBlockHash(1, 10n)).toBe('0xa');
    expect(repo.getLastProcessed(1)).toEqual({ number: 10n, hash: '0xa' });
  });

  it('rollbackFrom(0) clears chain_state entirely', () => {
    repo.recordProcessed(block(0n, '0xgenesis'), '0x0');
    repo.rollbackFrom(1, 0n);
    expect(repo.getLastProcessed(1)).toBeUndefined();
  });
});
