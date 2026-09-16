import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cacheKey, DiskCache } from '../../../src/replay/cache.js';

function tempCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'sentinel-replay-cache-test-'));
}

describe('cacheKey', () => {
  it('is deterministic for the same inputs', () => {
    const a = cacheKey(1, 'multicall', { blockNumber: 100n, calls: ['x'] });
    const b = cacheKey(1, 'multicall', { blockNumber: 100n, calls: ['x'] });
    expect(a).toBe(b);
  });

  it('differs when the block number, method, or chain id differs', () => {
    const base = cacheKey(1, 'multicall', { blockNumber: 100n });
    expect(cacheKey(1, 'multicall', { blockNumber: 101n })).not.toBe(base);
    expect(cacheKey(1, 'getLogs', { blockNumber: 100n })).not.toBe(base);
    expect(cacheKey(8453, 'multicall', { blockNumber: 100n })).not.toBe(base);
  });
});

describe('DiskCache', () => {
  it('returns undefined for a key that was never set', async () => {
    const cache = new DiskCache(tempCacheDir());
    expect(await cache.get('does-not-exist')).toBeUndefined();
  });

  it('round-trips a value, including nested bigints', async () => {
    const cache = new DiskCache(tempCacheDir());
    const key = cacheKey(1, 'test', { a: 1 });
    await cache.set(key, { number: 123n, nested: { amount: 456n }, text: 'hello' });

    const result = await cache.get<{ number: bigint; nested: { amount: bigint }; text: string }>(
      key,
    );
    expect(result).toEqual({ number: 123n, nested: { amount: 456n }, text: 'hello' });
  });

  it('persists across separate DiskCache instances pointed at the same directory', async () => {
    const dir = tempCacheDir();
    const key = cacheKey(1, 'test', {});
    await new DiskCache(dir).set(key, { value: 42n });

    const result = await new DiskCache(dir).get<{ value: bigint }>(key);
    expect(result).toEqual({ value: 42n });
  });
});
