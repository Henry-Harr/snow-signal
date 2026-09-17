import type { ChainClient } from './client.js';
import { retryWithBackoff, type RetryOptions } from './retry.js';
import { QuorumError, RpcError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

export interface NamedProvider<TClient extends ChainClient = ChainClient> {
  name: string;
  client: TClient;
}

interface HealthState {
  consecutiveFailures: number;
  lastLatencyMs: number | undefined;
  lastError: string | undefined;
}

const DEFAULT_RETRY: RetryOptions = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5_000 };

/** `Promise.allSettled`'s type signature computes `Awaited<R>` for each settled
 * result, which for an unconstrained generic `R` containing a nested generic
 * property confuses TS into distributing `Awaited` into that property instead of
 * treating the (non-thenable) wrapper object as already-resolved. The values passed
 * in here are always already-awaited plain objects, so this cast is safe. */
function settleAll<R>(promises: Promise<R>[]): Promise<PromiseSettledResult<R>[]> {
  return Promise.allSettled(promises);
}

/**
 * Holds every configured RPC provider for one chain (docs/SPEC.md #6.1: at least two
 * independent providers, health scoring, retries with jittered backoff, failover).
 * `quorumRead` is the safety-critical path: decision-critical values must be
 * confirmed by at least two providers at the same result before Sentinel trusts them
 * (docs/adr/0003).
 */
export class RpcPool<TClient extends ChainClient = ChainClient> {
  private readonly health = new Map<string, HealthState>();

  constructor(
    private readonly providers: NamedProvider<TClient>[],
    private readonly logger?: Logger,
    private readonly retryOptions: RetryOptions = DEFAULT_RETRY,
  ) {
    if (providers.length < 2) {
      throw new RpcError('RpcPool requires at least two providers (docs/SPEC.md #6.1)');
    }
    for (const provider of providers) {
      this.health.set(provider.name, {
        consecutiveFailures: 0,
        lastLatencyMs: undefined,
        lastError: undefined,
      });
    }
  }

  /** Providers ordered healthiest-first: fewest consecutive failures, then lowest
   * last-observed latency. Used to pick a failover order, never to skip quorum. */
  private orderedByHealth(): NamedProvider<TClient>[] {
    return [...this.providers].sort((a, b) => {
      const healthA = this.health.get(a.name)!;
      const healthB = this.health.get(b.name)!;
      if (healthA.consecutiveFailures !== healthB.consecutiveFailures) {
        return healthA.consecutiveFailures - healthB.consecutiveFailures;
      }
      return (healthA.lastLatencyMs ?? 0) - (healthB.lastLatencyMs ?? 0);
    });
  }

  private async callWithHealthTracking<T>(
    provider: NamedProvider<TClient>,
    fn: (client: TClient) => Promise<T>,
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await retryWithBackoff(() => fn(provider.client), this.retryOptions);
      this.health.set(provider.name, {
        consecutiveFailures: 0,
        lastLatencyMs: Date.now() - start,
        lastError: undefined,
      });
      return result;
    } catch (error) {
      const previous = this.health.get(provider.name)!;
      this.health.set(provider.name, {
        consecutiveFailures: previous.consecutiveFailures + 1,
        lastLatencyMs: previous.lastLatencyMs,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Calls `fn` against the healthiest available provider, failing over to the next
   * one on error. For reads that don't need cross-provider confirmation (e.g. polling
   * for a new head to decide *when* to look more closely — not a decision input by
   * itself). */
  async bestEffortRead<T>(fn: (client: TClient) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (const provider of this.orderedByHealth()) {
      try {
        return await this.callWithHealthTracking(provider, fn);
      } catch (error) {
        lastError = error;
        this.logger?.warn(
          { provider: provider.name, err: error },
          'provider read failed, failing over',
        );
      }
    }
    throw new RpcError('All providers failed', { cause: lastError });
  }

  /**
   * Reads a decision-critical value from at least two independent providers and
   * requires them to agree (per `isEqual`, default `===`... well, structural JSON
   * equality since values are often objects/bigints). Throws `QuorumError` — never
   * silently picks one provider's answer — if fewer than two providers succeed, or if
   * the successful providers disagree (docs/SPEC.md #6.1, docs/adr/0003).
   */
  async quorumRead<T>(
    fn: (client: TClient) => Promise<T>,
    isEqual: (a: T, b: T) => boolean = (a, b) => quorumEquals(a, b),
  ): Promise<T> {
    const results = await settleAll<{ provider: string; value: T }>(
      this.providers.map(async (provider) => ({
        provider: provider.name,
        value: await this.callWithHealthTracking(provider, fn),
      })),
    );

    const succeeded = results.filter(
      (r): r is PromiseFulfilledResult<{ provider: string; value: T }> => r.status === 'fulfilled',
    );

    if (succeeded.length < 2) {
      throw new QuorumError(
        `Quorum read needs at least 2 successful providers, got ${succeeded.length}/${this.providers.length}`,
      );
    }

    const [first, ...rest] = succeeded;
    for (const candidate of rest) {
      if (!isEqual(first!.value.value, candidate.value.value)) {
        throw new QuorumError(
          `Providers disagree: ${first!.value.provider}=${stringifyForError(first!.value.value)} vs ` +
            `${candidate.value.provider}=${stringifyForError(candidate.value.value)}`,
        );
      }
    }

    return first!.value.value;
  }

  healthSnapshot(): Record<string, HealthState> {
    return Object.fromEntries(this.health.entries());
  }

  /**
   * Head-lag monitoring (docs/SPEC.md #6.1): queries every provider's current block
   * number and returns the *minimum* of the successful ones — the most conservative
   * answer, so a lagging provider can never cause Sentinel to act on a block number
   * ahead of what that provider can actually serve data for. Requires at least two
   * providers to succeed, same discipline as `quorumRead`. Providers disagreeing by
   * more than `maxDisagreementBlocks` are logged as a warning (this becomes the D16
   * infra-health signal once detectors exist in Phase 4).
   */
  async getConservativeHead(maxDisagreementBlocks = 5): Promise<bigint> {
    const results = await settleAll<{ provider: string; head: bigint }>(
      this.providers.map(async (provider) => ({
        provider: provider.name,
        head: await this.callWithHealthTracking(provider, (client) => client.getBlockNumber()),
      })),
    );

    const succeeded = results.filter(
      (r): r is PromiseFulfilledResult<{ provider: string; head: bigint }> =>
        r.status === 'fulfilled',
    );
    if (succeeded.length < 2) {
      throw new QuorumError(
        `Head check needs at least 2 successful providers, got ${succeeded.length}/${this.providers.length}`,
      );
    }

    const heads = succeeded.map((r) => r.value.head);
    const min = heads.reduce((a, b) => (a < b ? a : b));
    const max = heads.reduce((a, b) => (a > b ? a : b));
    if (max - min > BigInt(maxDisagreementBlocks)) {
      this.logger?.warn(
        {
          heads: succeeded.map((r) => ({
            provider: r.value.provider,
            head: r.value.head.toString(),
          })),
        },
        'providers disagree on head block by more than expected',
      );
    }
    return min;
  }

  /** Read-only snapshot of each provider's current health, for metrics
   * (`src/ops/metrics.ts`, Phase 9) — never mutated by the caller. */
  getHealthSnapshot(): { provider: string; consecutiveFailures: number; lastLatencyMs: number | undefined }[] {
    return this.providers.map((provider) => {
      const health = this.health.get(provider.name)!;
      return {
        provider: provider.name,
        consecutiveFailures: health.consecutiveFailures,
        lastLatencyMs: health.lastLatencyMs,
      };
    });
  }
}

function quorumEquals(a: unknown, b: unknown): boolean {
  return stringifyForError(a) === stringifyForError(b);
}

function stringifyForError(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}
