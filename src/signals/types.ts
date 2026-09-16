import type {
  Address,
  BlockRef,
  ChainId,
  CollateralExposure,
  MarketSnapshot,
  Position,
  ProtocolEvent,
  Signal,
  SignalFamily,
} from '../core/types.js';
import type { PriceQuote } from '../prices/types.js';

/**
 * Detector context shapes (docs/SPEC.md #5.3, #7). Detectors (`src/signals/**`) are
 * pure — no I/O, and per CLAUDE.md, no imports from `chain/`, `storage/`, or
 * `notify/`. That rule is why the holder/health/supply shapes below are declared
 * fresh here instead of imported from `src/watchers/large-holders.ts` /
 * `src/watchers/token-supply.ts`: both transitively import `src/chain/**`, and a
 * type-only import doesn't change that those modules exist to do I/O. `PriceQuote`
 * from `src/prices/types.ts` is safe to import directly — that file is pure data, no
 * I/O of its own.
 *
 * Assembling a real `DetectorContext` from stored snapshots for a live block is
 * deliberately **not** built in this phase (Phase 4 scope is the detectors themselves,
 * tested on synthetic contexts per docs/SPEC.md #7's own instruction) — that wiring is
 * Phase 5's risk-engine job, which is the first consumer that actually needs a live
 * context. See docs/PROGRESS.md's Phase 4 session note for the reasoning.
 */

export interface Detector {
  id: string;
  family: SignalFamily;
  evaluate(ctx: DetectorContext): Signal[];
}

/** Per-holder ledger balances — same shape as `HolderBalance` in
 * `src/watchers/large-holders.ts`, redeclared per this file's header comment. */
export interface HolderSnapshot {
  holder: Address;
  supply: bigint;
  borrow: bigint;
  collateral: bigint;
  lastMovementBlock: bigint;
}

/** Same shape as `BorrowerHealth` in `src/watchers/large-holders.ts`. Aave-only for
 * now (see that module's doc comment on why Morpho Blue health is computed directly
 * by D15 instead of a shared collector). */
export interface BorrowerHealthSnapshot {
  holder: Address;
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  /** Scaled by 1e18 (Aave's convention); `2n**256n-1n` means "no debt." */
  healthFactor: bigint;
}

export interface TokenSupplySnapshotLike {
  totalSupply: bigint;
  block: BlockRef;
}

/** Minimal Uniswap v3 pool state D09 needs to estimate swap depth at a given
 * slippage, without importing anything from `src/prices/uniswap-v3*.ts` (which is
 * collector code, not forbidden by the chain/storage/notify rule, but kept out of
 * signals/ anyway to avoid coupling a detector to one specific DEX's pool shape). */
export interface DexDepthSnapshot {
  pool: Address;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  decimals0: number;
  decimals1: number;
  baseIsToken0: boolean;
}

export interface MarketContext {
  marketId: string;
  chainId: ChainId;
  protocol: string;
  current: MarketSnapshot;
  /** Oldest → newest, strictly *before* `current` (does not include it). Length and
   * spacing are the caller's choice — detectors that need a specific window (D02's 1
   * hour, D04's 5m/1h/6h) filter `history` by `block.timestamp` themselves rather than
   * assuming a fixed sample rate, since real block times vary and vary by chain. */
  history: MarketSnapshot[];
  collateralExposure: CollateralExposure[];
  /** My own position in this market, if I hold one. */
  position?: Position;
  /** Independent market quotes (Chainlink, DEX, CEX) for `position.asset` itself —
   * D10's peg check. Distinct from any `AssetContext` entry (which prices *collateral*
   * assets against a market's own oracle) since a peg check compares against a fixed
   * $1.00, not another market's oracle reading, and only matters for the specific
   * asset I actually hold. Empty when there's no `position` or no quotes yet. */
  positionAssetQuotes: PriceQuote[];
  /** Current holder ledger for this market (supply/borrow/collateral balances) —
   * see `src/watchers/large-holders.ts`'s `computeHolderLedger`. */
  holders: HolderSnapshot[];
  /** The same ledger as of the start of D05's lookback window (~1 hour before
   * `current`, exact window is D05's own configured threshold) — a second full
   * snapshot rather than a generic time series, since D05 is the only detector that
   * needs holder-level history and a single earlier reference point is enough for
   * "did a top-10 holder withdraw ≥25% within the window." */
  holdersHistory: HolderSnapshot[];
  /** Health data for this market's largest borrowers, where computable. Empty for
   * protocols/markets where it isn't (see `BorrowerHealthSnapshot`'s doc comment). */
  borrowerHealth: BorrowerHealthSnapshot[];
  /** Recent governance-category events for this market, oldest → newest. */
  governanceEvents: ProtocolEvent[];
}

export interface AssetPricePoint {
  block: BlockRef;
  /** The price the lending market's own oracle reports for this asset, already
   * decimal-normalized to a plain USD number (from `MarketSnapshot.oraclePrices`,
   * which is a raw scaled `bigint` — normalizing it is the context assembler's job,
   * not a detector's, since detectors don't know each protocol's oracle decimals). */
  oraclePrice: number;
  /** Independent cross-check quotes (Chainlink, DEX, CEX) — never includes the
   * lending market's own oracle reading, which is `oraclePrice` above. */
  marketQuotes: PriceQuote[];
}

export interface AssetContext {
  symbol: string;
  /** Which market's oracle `current`/`history` were read from — a collateral asset's
   * oracle price is scoped to the market that reads it, not global. */
  marketId: string;
  current: AssetPricePoint;
  /** Oldest → newest, strictly before `current`. */
  history: AssetPricePoint[];
  /** Oldest → newest, current snapshot last. */
  supplyHistory: TokenSupplySnapshotLike[];
  dexDepth?: DexDepthSnapshot;
  /** How much of this asset sits as collateral in `marketId`, in whole-token units
   * (not raw/wei) — D09's own "liquidation depth" comparison. Derived from the
   * protocol's actual collateral accounting (e.g. Aave's reserve totals, Morpho
   * Blue's market collateral), not from `CollateralExposure.shareOfCollateralBase`
   * alone (that's a *fraction* of the pool's collateral base, not an absolute
   * amount) — the context assembler's job, not any detector's. */
  collateralAmount?: number;
}

export interface InfraChainSnapshot {
  chainId: ChainId;
  /** How many blocks behind this evaluation's pinned block is vs. this chain's
   * current head at evaluation time. */
  headLagBlocks: number;
  /** Count of recent quorum/best-effort read disagreements across configured RPC
   * providers for this chain (docs/SPEC.md #6.1). */
  providerDisagreementCount: number;
  /** Depth of the most recently detected reorg on this chain; 0 if none recently. */
  reorgDepth: number;
  staleSources: { sourceId: string; ageSeconds: number }[];
}

export interface DetectorContext {
  at: BlockRef;
  markets: MarketContext[];
  assets: AssetContext[];
  infra: InfraChainSnapshot[];
  /** Every signal every other detector raised in this same evaluation pass — empty
   * during the registry's first pass, populated for its second pass (D14 only; see
   * ADR 0007 for why contagion needs a two-pass registry). */
  priorSignals: Signal[];
  /** Which markets/vaults are exposed to each collateral asset symbol, and how much
   * — D14's (contagion) join table, keyed by the same `symbol` strings
   * `AssetContext`/asset-family `Signal.subject.id`s use. Built by the (not-yet-
   * built, Phase 5) context assembler from each protocol's own `CollateralExposure`
   * (address-keyed) plus, for vaults, which markets they currently allocate into
   * ("look-through") — resolving *that* join is deliberately not a detector's job,
   * matching how `collateralAmount`/`dexDepth` are also precomputed rather than
   * derived in-detector (see this file's header comment). */
  assetExposure: Record<string, AssetExposureEntry[]>;
}

export interface AssetExposureEntry {
  marketId: string;
  shareOfCollateralBase: number;
}
