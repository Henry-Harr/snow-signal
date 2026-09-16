import type { Detector, DetectorContext, MarketContext } from './types.js';
import type { ProtocolEvent, Signal } from '../core/types.js';

/**
 * D13 — Vault allocation drift into new or risky markets (docs/SPEC.md #7,
 * governance family).
 *
 * Purpose: a vault position (Morpho vault/MetaMorpho) is only as safe as the
 * underlying markets its curator allocates into — a vault can silently drift into a
 * new, unvetted, or already-risky market through a routine cap/queue/reallocation
 * change, with no action on my part and nothing showing up in the vault's own
 * top-line numbers yet.
 *
 * Inputs: `MarketContext.governanceEvents` for the vault, filtered to the allocation
 * subset (`SetSupplyQueue`, `SetWithdrawQueue`, `SubmitCap`, `SetCap`,
 * `ReallocateSupply`, `ReallocateWithdraw`) — the vault-role/timelock events from the
 * same stream (`SetGuardian`, `SetTimelock`, …) are D12's, not this detector's.
 * `SetSupplyQueue`/`SetWithdrawQueue` reference every market in the new queue
 * (`bytes32[]`); the rest reference one market each via an `id` field.
 *
 * Formula: each referenced Morpho Blue market id is looked up against
 * `DetectorContext.markets` (matching the id as a suffix of `MarketContext.marketId`,
 * since `MorphoBlueAdapter` builds that string as `morpho-blue:<chain>:<rawId>`) to
 * see whether it's a market Sentinel already has data for. **Known limitation**: this
 * detector has no persistent state across evaluation runs (Phase 4 is synthetic-data-
 * only per spec §7), so it can't yet tell "a market newly added to the vault's queue
 * this run" from "a market that's always been in the queue and just got
 * reallocated into again" — every allocation event fires `watch`, unconditionally.
 * True new-vs-existing diffing needs the vault's queue from the *previous*
 * evaluation, which is a Phase 5/6 concern (comparing against stored history) once
 * the pipeline actually runs repeatedly. Escalation to `danger` ("the new market
 * triggers collateral detectors," spec's own wording) only works when the referenced
 * market happens to be one `DetectorContext.markets` already covers: if
 * `DetectorContext.priorSignals` contains a `collateral`-family signal for that exact
 * market (from the registry's first pass — see ADR 0007's two-pass structure, the
 * same mechanism D14 uses), the vault allocating into it escalates to `danger`.
 *
 * Default severities: `watch` for every allocation event; `danger` when the
 * referenced market already has a `collateral`-family signal this same evaluation.
 *
 * Known false-positive sources: routine reallocation *within* a curator's existing,
 * already-vetted set of markets looks identical to a genuine drift into new territory
 * — see the "known limitation" above. A market referenced by `id` that Sentinel
 * doesn't track anywhere (the common case for a vault's markets that aren't also
 * directly-held positions) can never escalate past `watch`, not because it's safe,
 * but because there's no data to check it against.
 */
export const D13_ID = 'D13_vault_allocation_drift';

const SINGLE_MARKET_EVENTS = new Set([
  'SubmitCap',
  'SetCap',
  'ReallocateSupply',
  'ReallocateWithdraw',
]);
const QUEUE_EVENTS = new Set(['SetSupplyQueue', 'SetWithdrawQueue']);

function isBytes32Array(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Every Morpho Blue market id (bytes32 hex string) an allocation event references.
 * Exported for direct unit testing. */
export function referencedMarketIds(event: ProtocolEvent): string[] {
  if (SINGLE_MARKET_EVENTS.has(event.eventName)) {
    const id = event.args['id'];
    return typeof id === 'string' ? [id] : [];
  }
  if (QUEUE_EVENTS.has(event.eventName)) {
    const key = event.eventName === 'SetSupplyQueue' ? 'newSupplyQueue' : 'newWithdrawQueue';
    const queue = event.args[key];
    return isBytes32Array(queue) ? queue : [];
  }
  return [];
}

function findTrackedMarket(marketId: string, markets: MarketContext[]): MarketContext | undefined {
  return markets.find((m) => m.marketId.endsWith(marketId));
}

export function createD13Detector(): Detector {
  return {
    id: D13_ID,
    family: 'governance',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const vault of ctx.markets) {
        for (const event of vault.governanceEvents) {
          for (const marketId of referencedMarketIds(event)) {
            const tracked = findTrackedMarket(marketId, ctx.markets);
            const triggeredCollateralSignal =
              tracked &&
              ctx.priorSignals.some(
                (s) => s.family === 'collateral' && s.subject.id === tracked.marketId,
              );

            signals.push({
              detectorId: D13_ID,
              family: 'governance',
              subject: { kind: 'vault', id: vault.marketId },
              severity: triggeredCollateralSignal ? 'danger' : 'watch',
              value: triggeredCollateralSignal ? 1 : 0,
              threshold: 1,
              evidence: {
                eventName: event.eventName,
                referencedMarketId: marketId,
                trackedMarketId: tracked?.marketId,
                event,
              },
            });
          }
        }
      }
      return signals;
    },
  };
}
