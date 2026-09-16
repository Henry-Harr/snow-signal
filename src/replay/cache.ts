import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Content-addressed disk cache for archive RPC responses (docs/SPEC.md §9.1: "caches
 * responses on disk (content-addressed and git-ignored), so reruns are fast and work
 * offline"). Keys are a sha256 of the request shape (chain id, method, and arguments),
 * not of the response — so re-requesting the same read always resolves to the same
 * cache slot regardless of when it was first fetched. Bigints are round-tripped
 * through the same `"123n"`-suffix string convention used everywhere else in this
 * codebase (`src/storage/*-repository.ts`) rather than losing precision to JSON's
 * lack of a native bigint type.
 */

function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value.toString()}n` : value;
}

function reviver(_key: string, value: unknown): unknown {
  return typeof value === 'string' && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value;
}

export function cacheKey(chainId: number, method: string, payload: unknown): string {
  const json = JSON.stringify(payload, replacer);
  return createHash('sha256').update(`${chainId}:${method}:${json}`).digest('hex');
}

export class DiskCache {
  constructor(private readonly dir: string) {}

  private pathFor(key: string): string {
    // Two-level fan-out (first 2 hex chars as a subdirectory) so a large cache
    // doesn't put tens of thousands of files in one directory.
    return join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await readFile(this.pathFor(key), 'utf-8');
      return JSON.parse(raw, reviver) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, replacer), 'utf-8');
  }
}
