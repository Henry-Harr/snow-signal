import type {
  AssetContext,
  AssetPricePoint,
  BorrowerHealthSnapshot,
  DetectorContext,
  DexDepthSnapshot,
  HolderSnapshot,
  InfraChainSnapshot,
  MarketContext,
  TokenSupplySnapshotLike,
} from '../../../src/signals/types.js';
import type {
  Address,
  BlockRef,
  CollateralExposure,
  MarketSnapshot,
  Position,
  ProtocolEvent,
  Signal,
} from '../../../src/core/types.js';
import type { PriceQuote } from '../../../src/prices/types.js';

/** Synthetic-context builders shared by every `src/signals/**` unit test suite —
 * detectors are pure functions over `DetectorContext`, so every test in Phase 4
 * constructs one of these rather than mocking a chain client (there is no chain
 * client involved at all). Every builder takes sensible defaults and an `overrides`
 * object, matching the pattern already used for storage-repository test fixtures. */

export function addr(seed: string): Address {
  return `0x${seed.repeat(40).slice(0, 40)}`;
}

const BASE_TIME = 1_700_000_000;

export function block(overrides: Partial<BlockRef> = {}): BlockRef {
  return {
    chainId: 1,
    number: 1000n,
    hash: '0xblock',
    timestamp: BASE_TIME,
    ...overrides,
  };
}

export function marketSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    marketId: 'aave-v3:ethereum:core',
    block: block(),
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

export function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 'aave-v3:ethereum:core:USDC',
    protocol: 'aave-v3',
    chainId: 1,
    marketId: 'aave-v3:ethereum:core',
    owner: addr('5a'),
    asset: addr('a5'),
    balance: 100_000n,
    ...overrides,
  };
}

export function collateralExposure(
  overrides: Partial<CollateralExposure> = {},
): CollateralExposure {
  return {
    marketId: 'aave-v3:ethereum:core',
    asset: addr('e7'),
    shareOfCollateralBase: 0.5,
    method: 'approximate',
    raw: {},
    ...overrides,
  };
}

export function holder(overrides: Partial<HolderSnapshot> = {}): HolderSnapshot {
  return {
    holder: addr('01'),
    supply: 0n,
    borrow: 0n,
    collateral: 0n,
    lastMovementBlock: 1000n,
    ...overrides,
  };
}

export function borrowerHealth(
  overrides: Partial<BorrowerHealthSnapshot> = {},
): BorrowerHealthSnapshot {
  return {
    holder: addr('01'),
    totalCollateralBase: 1000n,
    totalDebtBase: 500n,
    healthFactor: 2_000_000_000_000_000_000n,
    ...overrides,
  };
}

export function protocolEvent(
  overrides: Partial<ProtocolEvent> & { eventName: string; args?: Record<string, unknown> },
): ProtocolEvent {
  return {
    protocol: 'aave-v3',
    chainId: 1,
    marketId: 'aave-v3:ethereum:core',
    blockNumber: 1000n,
    transactionHash: '0xabc',
    logIndex: 0,
    args: {},
    ...overrides,
  };
}

export function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    detectorId: 'D06_oracle_market_deviation',
    family: 'collateral',
    subject: { kind: 'asset', id: 'WETH' },
    severity: 'danger',
    value: 0.1,
    threshold: 0.05,
    evidence: {},
    ...overrides,
  };
}

export function marketContext(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    marketId: 'aave-v3:ethereum:core',
    chainId: 1,
    protocol: 'aave-v3',
    current: marketSnapshot(),
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

export function priceQuote(overrides: Partial<PriceQuote> = {}): PriceQuote {
  return {
    source: 'chainlink:ethereum',
    asset: 'WETH',
    quoteAsset: 'USD',
    price: 2400,
    fetchedAt: BASE_TIME,
    chainId: 1,
    blockNumber: 1000n,
    raw: {},
    ...overrides,
  };
}

export function assetPricePoint(overrides: Partial<AssetPricePoint> = {}): AssetPricePoint {
  return {
    block: block(),
    oraclePrice: 2400,
    marketQuotes: [priceQuote()],
    ...overrides,
  };
}

export function tokenSupplySnapshot(
  overrides: Partial<TokenSupplySnapshotLike> = {},
): TokenSupplySnapshotLike {
  return {
    totalSupply: 1_000_000n,
    block: block(),
    ...overrides,
  };
}

export function dexDepthSnapshot(overrides: Partial<DexDepthSnapshot> = {}): DexDepthSnapshot {
  return {
    pool: addr('d3'),
    liquidity: 1_000_000n,
    sqrtPriceX96: 2n ** 96n, // sqrtP = 1
    decimals0: 0,
    decimals1: 0,
    baseIsToken0: true,
    ...overrides,
  };
}

export function assetContext(overrides: Partial<AssetContext> = {}): AssetContext {
  return {
    symbol: 'WETH',
    marketId: 'aave-v3:ethereum:core',
    current: assetPricePoint(),
    history: [],
    supplyHistory: [],
    ...overrides,
  };
}

export function infraChainSnapshot(
  overrides: Partial<InfraChainSnapshot> = {},
): InfraChainSnapshot {
  return {
    chainId: 1,
    headLagBlocks: 0,
    providerDisagreementCount: 0,
    reorgDepth: 0,
    staleSources: [],
    ...overrides,
  };
}

export function detectorContext(overrides: Partial<DetectorContext> = {}): DetectorContext {
  return {
    at: block(),
    markets: [],
    assets: [],
    infra: [],
    priorSignals: [],
    assetExposure: {},
    ...overrides,
  };
}
