import { decide } from '../risk/state-machine.js';
import {
  initialPositionRiskState,
  riskLevelRank,
  type Decision,
  type RiskLevel,
} from '../risk/types.js';
import type { SentinelConfig } from '../core/config.js';
import type { Address, BlockRef, MarketSnapshot, Position, Signal } from '../core/types.js';
import { defaultDetectors, evaluateAll } from '../signals/registry.js';
import type { AssetContext, Detector, DetectorContext, MarketContext } from '../signals/types.js';

/**
 * Synthetic fault-injection scenarios (docs/SPEC.md §9.2 item 5: "utilization spike,
 * frozen oracle, depeg, whale exit, RPC outage, provider disagreement, reorg, gas
 * spike, and paused withdrawals"). Structurally different from `src/replay/scenario.ts`
 * (real historical block ranges): most of these faults aren't about market data at
 * all, so there's no archived chain state to replay against.
 *
 * **Scope decision, made explicitly rather than forcing all nine into one shape**:
 * - `utilization_spike`, `frozen_oracle`, `depeg`, `whale_exit`, `paused_withdrawals`
 *   are synthetic *market conditions* — this file builds a hand-crafted
 *   `DetectorContext` for each and runs it through the real detector registry and
 *   risk engine (`src/signals/registry.ts`, `src/risk/state-machine.ts`) — the same
 *   detection/decision code every other path uses, just fed synthetic input instead
 *   of a live or archived chain read (the same "one code path" principle
 *   docs/ARCHITECTURE.md #2 states for live vs. replay, applied one layer down: only
 *   the *source* of the context differs, not what's done with it).
 * - `RPC outage`, `provider disagreement`, and `reorg` are about the infra layer's
 *   own behavior (`RpcPool`, `LiveBlockSource`), not market data — already covered by
 *   dedicated tests (`test/property/chain/rpc-pool-quorum.test.ts`,
 *   `test/unit/chain/block-source.test.ts`'s reorg scenarios) rather than duplicated
 *   here as a "scenario."
 * - `gas spike` needs a real withdrawal planner with gas estimation, which doesn't
 *   exist until Phase 7 — there is nothing to inject a gas spike *into* yet. Not
 *   attempted; revisit once Phase 7 exists.
 *
 * A synthetic scenario deliberately expects at most `WATCH` for every single-detector
 * fault below (none of D01/D05/D07/D10 is `standaloneCritical`-eligible) — reaching
 * that cap *is* the state machine working as designed (ADR 0008's single-family cap),
 * not a limitation of the scenario. `paused_withdrawals` is the one exception: no
 * detector reads `MarketSnapshot.flags.paused` at all (found while building this file
 * — see docs/PROGRESS.md's Known Issues), so it's included anyway with the level a
 * correctly-behaving Sentinel *should* reach, so running it documents the gap
 * honestly (spec §9.1: "results documented including honest misses") rather than
 * silently dropping the one fault type Sentinel can't actually detect yet.
 */

const AT: BlockRef = {
  chainId: 1,
  number: 1_000_000n,
  hash: '0xsynthetic',
  timestamp: 1_700_000_000,
};
// `positionId` and `MarketContext.marketId` are the *same* string for a position-
// bearing market, exactly matching `src/core/pipeline.ts`'s real convention (both are
// built from `protocol:chain:market:asset` — see that file's `positionsForChain`) —
// D03/D10's `kind:'position'` signal subjects are matched against `decide()`'s
// `positionId` input via this same string (see the Phase 6 fix in
// `src/signals/D03_exit_coverage.ts`/`D10_peg_deviation.ts`).
const POSITION_ID = 'aave-v3:ethereum:core:USDC';
const MARKET_ID = POSITION_ID;
const ASSET_ADDRESS = '0x000000000000000000000000000000000000A5' as Address;

function baseSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    marketId: MARKET_ID,
    block: AT,
    totalSupplied: 1_000_000n,
    totalBorrowed: 500_000n,
    availableLiquidity: 500_000n,
    utilization: 0.5,
    supplyRate: 0.02,
    borrowRate: 0.04,
    flags: { paused: false, frozen: false },
    oraclePrices: {},
    raw: {},
    ...overrides,
  };
}

function baseMarketContext(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    marketId: MARKET_ID,
    chainId: 1,
    protocol: 'aave-v3',
    current: baseSnapshot(),
    history: [],
    collateralExposure: [],
    holders: [],
    holdersHistory: [],
    borrowerHealth: [],
    governanceEvents: [],
    positionAssetQuotes: [],
    ...overrides,
  };
}

function syntheticPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: `${MARKET_ID}:0x000000000000000000000000000000000000dEaD`,
    protocol: 'aave-v3',
    chainId: 1,
    marketId: MARKET_ID,
    owner: '0x000000000000000000000000000000000000dEaD',
    asset: ASSET_ADDRESS,
    balance: 1_000_000_000n,
    ...overrides,
  };
}

export interface SyntheticScenario {
  id: string;
  description: string;
  buildContext(): DetectorContext;
  /** The `RiskLevel` a correctly-behaving Sentinel should reach for this injected
   * fault — the pass/fail bar `runSyntheticScenario` checks against. */
  expectedMinLevel: RiskLevel;
}

const UTILIZATION_SPIKE: SyntheticScenario = {
  id: 'utilization-spike',
  description: "Injects utilization at 97% (between D01's danger and critical thresholds).",
  expectedMinLevel: 'WATCH',
  buildContext: () => ({
    at: AT,
    markets: [baseMarketContext({ current: baseSnapshot({ utilization: 0.97 }) })],
    assets: [],
    infra: [],
    priorSignals: [],
    assetExposure: {},
  }),
};

const FROZEN_ORACLE: SyntheticScenario = {
  id: 'frozen-oracle',
  description:
    'Oracle reports the same $2400 WETH price for 3 consecutive readings while the real market moves to ~$2000 (~17% deviation) — the xUSD pattern D07 exists for.',
  expectedMinLevel: 'WATCH',
  buildContext: () => {
    const flatOraclePrice = 2400;
    const asset: AssetContext = {
      symbol: 'WETH',
      marketId: MARKET_ID,
      current: {
        block: AT,
        oraclePrice: flatOraclePrice,
        marketQuotes: [
          {
            source: 'chainlink:ethereum',
            asset: 'WETH',
            quoteAsset: 'USD',
            price: 2000,
            fetchedAt: AT.timestamp,
            chainId: 1,
            blockNumber: AT.number,
            raw: {},
          },
        ],
      },
      history: [0, 1, 2].map((i) => ({
        block: { ...AT, number: AT.number - BigInt(3 - i) },
        oraclePrice: flatOraclePrice,
        marketQuotes: [
          {
            source: 'chainlink:ethereum',
            asset: 'WETH',
            quoteAsset: 'USD',
            price: flatOraclePrice,
            fetchedAt: AT.timestamp,
            chainId: 1,
            blockNumber: AT.number - BigInt(3 - i),
            raw: {},
          },
        ],
      })),
      supplyHistory: [],
    };
    return {
      at: AT,
      markets: [baseMarketContext()],
      assets: [asset],
      infra: [],
      priorSignals: [],
      // D07's signal is asset-subject (`kind:'asset'`) — per docs/adr/0002, it only
      // reaches this market's decision via D14 (contagion) projecting it here, which
      // needs to know this market is exposed to WETH. Full exposure share (≥0.5) so
      // D14 doesn't demote the severity, keeping this scenario's story simple.
      assetExposure: { WETH: [{ marketId: MARKET_ID, shareOfCollateralBase: 0.6 }] },
    };
  },
};

const DEPEG: SyntheticScenario = {
  id: 'depeg',
  description:
    "The held asset (USDC) trades at $0.90 (10% below peg, above D10's critical threshold) — verifies ADR 0005: even a critical-severity D10 signal never reaches CRITICAL on its own (never standaloneCritical).",
  expectedMinLevel: 'WATCH',
  buildContext: () => ({
    at: AT,
    markets: [
      baseMarketContext({
        // Ample liquidity relative to the position (coverage well above D03's watch
        // threshold) so this scenario isolates D10 alone, rather than incidentally
        // also tripping D03 (exit coverage) and corroborating past the single-family
        // cap this scenario means to demonstrate.
        current: baseSnapshot({ availableLiquidity: 100_000_000_000n }),
        position: syntheticPosition(),
        positionAssetQuotes: [
          {
            source: 'coinbase',
            asset: 'USDC',
            quoteAsset: 'USD',
            price: 0.9,
            fetchedAt: AT.timestamp,
            chainId: 1,
            blockNumber: AT.number,
            raw: {},
          },
          {
            source: 'kraken',
            asset: 'USDC',
            quoteAsset: 'USD',
            price: 0.9,
            fetchedAt: AT.timestamp,
            chainId: 1,
            blockNumber: AT.number,
            raw: {},
          },
        ],
      }),
    ],
    assets: [],
    infra: [],
    priorSignals: [],
    assetExposure: {},
  }),
};

const WHALE_EXIT: SyntheticScenario = {
  id: 'whale-exit',
  description:
    "A top holder with $1M supplied one hour ago has fully exited (100% withdrawn) — D05's own critical band.",
  expectedMinLevel: 'WATCH',
  buildContext: () => {
    const whale = '0x0000000000000000000000000000000000bEEF' as Address;
    return {
      at: AT,
      markets: [
        baseMarketContext({
          holdersHistory: [
            {
              holder: whale,
              supply: 1_000_000n,
              borrow: 0n,
              collateral: 0n,
              lastMovementBlock: AT.number - 300n,
            },
          ],
          holders: [],
        }),
      ],
      assets: [],
      infra: [],
      priorSignals: [],
      assetExposure: {},
    };
  },
};

const PAUSED_WITHDRAWALS: SyntheticScenario = {
  id: 'paused-withdrawals',
  description:
    'The market flips MarketSnapshot.flags.paused to true. Expected to fail: no detector currently reads this flag (found while building this file — see docs/PROGRESS.md Known Issues) — included anyway so a replay run documents the miss rather than silently omitting it.',
  expectedMinLevel: 'WATCH',
  buildContext: () => ({
    at: AT,
    markets: [
      baseMarketContext({ current: baseSnapshot({ flags: { paused: true, frozen: false } }) }),
    ],
    assets: [],
    infra: [],
    priorSignals: [],
    assetExposure: {},
  }),
};

export const SYNTHETIC_SCENARIOS: SyntheticScenario[] = [
  UTILIZATION_SPIKE,
  FROZEN_ORACLE,
  DEPEG,
  WHALE_EXIT,
  PAUSED_WITHDRAWALS,
];

export interface SyntheticScenarioResult {
  scenario: SyntheticScenario;
  signals: Signal[];
  decision: Decision;
  passed: boolean;
}

export function runSyntheticScenario(
  scenario: SyntheticScenario,
  policy: SentinelConfig['policy'],
  detectors: Detector[] = defaultDetectors(),
): SyntheticScenarioResult {
  const ctx = scenario.buildContext();
  const signals = evaluateAll(detectors, ctx);
  const now = new Date(ctx.at.timestamp * 1000);
  const state = initialPositionRiskState(POSITION_ID, now);

  const { decision } = decide({
    positionId: POSITION_ID,
    marketOrVaultId: MARKET_ID,
    signals,
    state,
    now,
    blockNumber: ctx.at.number,
    configHash: `synthetic:${scenario.id}`,
    policy,
    killSwitchActive: false,
    dwellSeconds: 0,
  });

  return {
    scenario,
    signals,
    decision,
    passed: riskLevelRank(decision.level) >= riskLevelRank(scenario.expectedMinLevel),
  };
}
