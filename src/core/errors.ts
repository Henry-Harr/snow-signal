/** Base class for all Sentinel-specific errors, so callers can `instanceof SentinelError`
 * to distinguish "something we understand went wrong" from an unexpected bug. */
export class SentinelError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/** Config file missing, unparseable, or failing schema validation. */
export class ConfigError extends SentinelError {}

/** An RPC call failed after exhausting retries, or every provider for a chain is
 * unreachable. */
export class RpcError extends SentinelError {}

/** Two providers disagreed on a decision-critical value at the same block (docs/SPEC.md
 * #6.1 quorum reads) and no quorum could be reached. Callers must treat this as "we
 * don't know," never as either provider's answer (docs/adr/0003). */
export class QuorumError extends SentinelError {}

/** A reorg was detected (parent-hash mismatch) and derived data needs to be rolled
 * back before reprocessing. */
export class ReorgDetectedError extends SentinelError {
  constructor(
    message: string,
    public readonly chainId: number,
    public readonly atBlock: bigint,
  ) {
    super(message);
  }
}

/** A migration failed to apply, or the database schema is in an unexpected state. */
export class StorageError extends SentinelError {}
