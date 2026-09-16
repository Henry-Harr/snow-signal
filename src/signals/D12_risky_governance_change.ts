import type { Detector, DetectorContext } from './types.js';
import type { ProtocolEvent, Signal, SignalSeverity } from '../core/types.js';

/**
 * D12 — Risky governance or config change (docs/SPEC.md #7, governance family).
 *
 * Purpose: a market can become materially riskier through a config change alone,
 * with no price movement or liquidity drain to show for it yet — a loosened
 * liquidation threshold, a removed supply cap, or an ownership transfer are all
 * "the ground shifted under me" events a pure market-data detector would miss
 * entirely.
 *
 * Inputs: `MarketContext.governanceEvents` — every event `src/watchers/governance.ts`
 * classifies as governance for that market (Aave `PoolConfigurator` events, Morpho
 * Blue's owner-level events, every MetaMorpho vault event). D12 only reacts to a
 * fixed subset by event name (below); D13 reacts to the vault allocation-queue
 * subset of that same event stream, and both simply ignore events outside their own
 * subset rather than double-classifying.
 *
 * Formula: each recognized event name maps to a fixed category/severity (spec's own
 * examples — new collateral, oracle/rate-model change, role change, pause/freeze —
 * don't have a graduated "how risky" reading, unlike most other detectors, so this is
 * a lookup table, not threshold math). The one exception is `BorrowCapChanged`/
 * `SupplyCapChanged` ("cap jump"), which *does* have a natural magnitude: the event
 * itself carries both `oldCap` and `newCap`, so the severity is computed from the
 * fractional increase (`capJumpThresholds`) rather than fixed — removing a cap
 * entirely (`newCap === 0`, Aave's "no cap" sentinel) is always `danger` regardless
 * of magnitude, and *lowering* or newly *adding* a cap (protective changes) never
 * fires at all.
 *
 * Default severities (spec placeholders, all watch/danger — no config change is
 * standalone-critical, since a config change alone, however risky-looking, hasn't
 * yet produced a loss the way D06/D11 have): role changes and cap removal are
 * `danger`; new markets, fee changes, oracle/rate-model changes, and pause/freeze
 * toggles are `watch`. `capJumpThresholds` (fractional increase): watch ≥ 50%,
 * danger ≥ 200%.
 *
 * Known false-positive sources: a routine, pre-announced parameter tuning (e.g. a
 * scheduled risk-parameter review that *tightens* an LTV) looks identical in this
 * table to a hostile change — `CollateralConfigurationChanged` doesn't carry the old
 * values to compare direction against, unlike the cap events, so every occurrence
 * fires regardless of whether it made the market safer or riskier. Reading the alert
 * (which config values changed) is necessary context a human still needs to add.
 */
export const D12_ID = 'D12_risky_governance_change';

export type D12EventCategory =
  | 'collateral_param'
  | 'cap_removed'
  | 'cap_jump'
  | 'pause_freeze'
  | 'role_change'
  | 'fee_change'
  | 'rate_model_or_oracle'
  | 'new_market';

interface FixedClassification {
  category: D12EventCategory;
  severity: SignalSeverity;
}

/** Event names D12 reacts to with a fixed severity (everything else — including
 * BorrowCapChanged/SupplyCapChanged, handled specially below, and every event D13
 * owns — is silently ignored). */
const FIXED_CLASSIFICATIONS: Record<string, FixedClassification> = {
  // Aave PoolConfigurator (src/protocols/aave-v3/abi.ts)
  CollateralConfigurationChanged: { category: 'collateral_param', severity: 'danger' },
  ReserveFrozen: { category: 'pause_freeze', severity: 'watch' },
  ReservePaused: { category: 'pause_freeze', severity: 'watch' },
  ReserveActive: { category: 'pause_freeze', severity: 'watch' },
  // Morpho Blue (src/protocols/morpho-blue/abi.ts)
  SetOwner: { category: 'role_change', severity: 'danger' },
  SetFee: { category: 'fee_change', severity: 'watch' },
  SetFeeRecipient: { category: 'fee_change', severity: 'watch' },
  EnableIrm: { category: 'rate_model_or_oracle', severity: 'watch' },
  EnableLltv: { category: 'rate_model_or_oracle', severity: 'watch' },
  CreateMarket: { category: 'new_market', severity: 'watch' },
  // MetaMorpho vault role/timelock events (src/protocols/morpho-vault/abi.ts) — the
  // allocation-queue events from the same ABI (SetSupplyQueue, SetCap, …) are D13's.
  SetGuardian: { category: 'role_change', severity: 'danger' },
  SetCurator: { category: 'role_change', severity: 'danger' },
  SetIsAllocator: { category: 'role_change', severity: 'danger' },
  SetTimelock: { category: 'rate_model_or_oracle', severity: 'watch' },
};

export interface D12CapJumpThresholds {
  watch: number;
  danger: number;
}

export const D12_DEFAULT_CAP_JUMP_THRESHOLDS: D12CapJumpThresholds = { watch: 0.5, danger: 2.0 };

function classifyCapChange(
  event: ProtocolEvent,
  thresholds: D12CapJumpThresholds,
): { severity: SignalSeverity; value: number } | undefined {
  const isSupply = event.eventName === 'SupplyCapChanged';
  const isBorrow = event.eventName === 'BorrowCapChanged';
  if (!isSupply && !isBorrow) return undefined;

  const oldCap = event.args[isSupply ? 'oldSupplyCap' : 'oldBorrowCap'];
  const newCap = event.args[isSupply ? 'newSupplyCap' : 'newBorrowCap'];
  if (typeof oldCap !== 'bigint' || typeof newCap !== 'bigint') return undefined;

  if (newCap === 0n && oldCap !== 0n) return { severity: 'danger', value: Infinity }; // cap removed entirely
  if (oldCap === 0n || newCap <= oldCap) return undefined; // protective change, or nothing to compare

  const jumpFraction = Number(newCap - oldCap) / Number(oldCap);
  if (jumpFraction >= thresholds.danger) return { severity: 'danger', value: jumpFraction };
  if (jumpFraction >= thresholds.watch) return { severity: 'watch', value: jumpFraction };
  return undefined;
}

export function createD12Detector(
  capJumpThresholds: D12CapJumpThresholds = D12_DEFAULT_CAP_JUMP_THRESHOLDS,
): Detector {
  return {
    id: D12_ID,
    family: 'governance',
    evaluate(ctx: DetectorContext): Signal[] {
      const signals: Signal[] = [];
      for (const market of ctx.markets) {
        for (const event of market.governanceEvents) {
          const capChange = classifyCapChange(event, capJumpThresholds);
          const fixed = FIXED_CLASSIFICATIONS[event.eventName];

          if (capChange) {
            signals.push({
              detectorId: D12_ID,
              family: 'governance',
              subject: { kind: 'market', id: market.marketId },
              severity: capChange.severity,
              value: capChange.value,
              threshold:
                capChange.severity === 'danger'
                  ? capJumpThresholds.danger
                  : capJumpThresholds.watch,
              evidence: {
                category: 'cap_jump',
                eventName: event.eventName,
                args: event.args,
                event,
              },
            });
          } else if (fixed) {
            signals.push({
              detectorId: D12_ID,
              family: 'governance',
              subject: { kind: 'market', id: market.marketId },
              severity: fixed.severity,
              value: 1,
              threshold: 1,
              evidence: {
                category: fixed.category,
                eventName: event.eventName,
                args: event.args,
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
