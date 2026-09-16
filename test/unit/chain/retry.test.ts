import { describe, expect, it, vi } from 'vitest';

import { retryWithBackoff } from '../../../src/chain/retry.js';

describe('retryWithBackoff', () => {
  it('returns the result immediately on first success without sleeping', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      sleep,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on failure and eventually succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 3) return Promise.reject(new Error('transient'));
      return Promise.resolve('ok');
    });

    const result = await retryWithBackoff(fn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
      sleep,
      random: () => 0.5,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after exhausting maxAttempts', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new Error('permanent'));

    await expect(
      retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep }),
    ).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('caps delay at maxDelayMs', async () => {
    const delays: number[] = [];
    const sleep = vi.fn().mockImplementation((ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    });
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 6,
        baseDelayMs: 100,
        maxDelayMs: 250,
        sleep,
        random: () => 1, // no jitter reduction, worst case
      }),
    ).rejects.toThrow();

    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(250);
    }
  });
});
