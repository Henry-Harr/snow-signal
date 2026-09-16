import { runPaperExecution, type PaperExecutorPosition } from '../actions/paper-executor.js';
import { normalizeAaveOraclePrice, buildAssetExposure } from '../risk/context.js';
import { decide } from '../risk/state-machine.js';
import { initialPositionRiskState, type PositionRiskState } from '../risk/types.js';
import { evaluateAll } from '../signals/registry.js';
import type { AssetContext, Detector, DetectorContext, MarketContext } from '../signals/types.js';
import {
  aaveGovernanceTarget,
  fetchGovernanceEvents,
  morphoVaultGovernanceTarget,
  resolveAaveConfiguratorAddress,
} from '../watchers/governance.js';
import {
  aavePoolFlowTarget,
  computeHolderLedger,
  extractAaveMovement,
  extractMorphoVaultMovement,
  fetchAaveBorrowerHealth,
  fetchPoolFlowEvents,
  morphoVaultPoolFlowTarget,
  type HolderBalance,
} from '../watchers/large-holders.js';
import { AaveV3Adapter } from '../protocols/aave-v3/adapter.js';
import { AAVE_V3_MARKETS } from '../protocols/aave-v3/addresses.js';
import { MorphoVaultAdapter } from '../protocols/morpho-vault/adapter.js';
import { ChainlinkPriceSource } from '../prices/chainlink.js';
import { CoinbasePriceSource, KrakenPriceSource } from '../prices/cex.js';
import { UniswapV3PriceSource } from '../prices/uniswap-v3.js';
import { fetchDexDepthSnapshot } from '../prices/uniswap-v3-depth.js';
import type { AlertDispatcher } from '../notify/dispatcher.js';
import { blockExplorerUrl } from '../notify/types.js';
import { resolveAssetSymbol } from './known-assets.js';
import type { SentinelConfig } from './config.js';
import type { Clock } from './clock.js';
import type { Logger } from './logger.js';
import type { Address, BlockRef, ChainId, Position } from './types.js';
import type { ContractReadClient } from '../chain/client.js';
import type { RpcPool } from '../chain/rpc-pool.js';
import type { DecisionRecordRepository } from '../storage/decision-record-repository.js';
import type { MarketSnapshotRepository } from '../storage/market-snapshot-repository.js';
import type { PaperExecutionRepository } from '../storage/paper-execution-repository.js';
import type { ProtocolEventRepository } from '../storage/protocol-event-repository.js';
import type { RiskStateRepository } from '../storage/risk-state-repository.js';
import type { WithdrawalCampaignRepository } from '../storage/withdrawal-campaign-repository.js';

/**
 * The live pipeline (docs/ARCHITECTURE.md #1: "a single `runOnce(blockRef)` pipeline
 * function drives every stage in order"). This is the piece Phase 4's ADR 0007
 * deliberately deferred (Phase 4 tested every detector on synthetic data only) — it
 * assembles a real `DetectorContext` from live chain reads + stored history, runs
 * the detector registry, the risk engine, and dispatches alerts, for one chain's one
 * newly-confirmed block at a time.
 *
 * **Scope honestly stated**: wired for the two protocols `config/sentinel.yaml`
 * actually configures (`aave-v3`, `morpho-vault`) — a direct `morpho-blue` position
 * would need the same treatment but isn't exercised here since none is configured,
 * and adding one untested would be worse than not supporting it yet. `AssetContext`
 * is only assembled for assets `src/core/known-assets.ts` can resolve (today: WETH)
 * — collateral assets in Aave's reserve list beyond that are real data
 * `collateralExposure` still reports, just without D06–D09 coverage for them (no
 * price/DEX data collected for anything else configured). Pool-flow/governance event
 * windows are exactly the one new confirmed block per call (respecting the
 * `eth_getLogs` 10-block cap documented in `src/watchers/governance.ts`) — history
 * accumulates naturally as the pipeline runs over time, the same restartable model
 * `docs/ARCHITECTURE.md` #2 describes for everything else.
 */

const HISTORY_LOOKBACK_BLOCKS = 200_000n;
const AAVE_ASSET_SYMBOLS = ['USDC'] as const;
const PRICED_ASSETS = ['USDC', 'WETH'] as const;

export interface PipelineDeps {
  chain: string;
  chainId: ChainId;
  pool: RpcPool<ContractReadClient>;
  config: SentinelConfig;
  clock: Clock;
  logger?: Logger;
  detectors: Detector[];
  dispatcher: AlertDispatcher;
  repos: {
    marketSnapshots: MarketSnapshotRepository;
    protocolEvents: ProtocolEventRepository;
    decisionRecords: DecisionRecordRepository;
    riskState: RiskStateRepository;
    /** Phase 7 paper executor state — absent for callers that never run paper mode
     * (e.g. the replay engine, which only ever exercises `execution.mode: 'off'`
     * scenarios and would never want to spawn real Anvil forks mid-replay). When
     * both are present and `config.execution.mode === 'paper'`, a DANGER/CRITICAL
     * decision's `partial_withdraw`/`full_exit` action recommendation triggers
     * `runPaperExecution` (`src/actions/paper-executor.ts`). */
    campaigns?: WithdrawalCampaignRepository;
    paperExecutions?: PaperExecutionRepository;
  };
  killSwitchActive: boolean;
  dwellSeconds: number;
  configHash: string;
  /** Replay-only (docs/adr/0009): a synthetic `Position` per market id, used instead
   * of live `discoverPositions` when present. `undefined`/absent for a market means
   * "use live discovery," so live callers (`sentinel watch`) never need to set this
   * at all. */
  positionOverrides?: Record<string, Position>;
  /** Replay-only (docs/adr/0009 addendum below): the first block to scan for
   * governance/pool-flow events, instead of always just `at.number`. Live callers
   * process every confirmed block in sequence, so a single-block window
   * (`[at.number, at.number]`) never has a gap; a strided replay does skip blocks
   * between samples, and without this override those skipped blocks' events (large-
   * holder movements, governance changes) would silently never be recorded, quietly
   * breaking D05/D12/D13 for any scenario with a stride wider than one block. Absent
   * for live, so `sentinel watch`'s behavior is completely unchanged. */
  eventsFromBlock?: bigint;
}

export interface ChainPosition {
  positionId: string;
  protocol: 'aave-v3' | 'morpho-vault';
  marketId: string;
  assetSymbol: string;
}

/** Exported so the CLI (`sentinel watch`) can compute the full cross-chain position
 * id list for Telegram's `/status`/`/positions` without duplicating this id-
 * construction logic. */
export function positionsForChain(config: SentinelConfig, chain: string): ChainPosition[] {
  const result: ChainPosition[] = [];
  for (const p of config.positions) {
    if (p.chain !== chain) continue;
    if (p.protocol === 'aave-v3') {
      result.push({
        positionId: `aave-v3:${p.chain}:${p.market}:${p.asset}`,
        protocol: 'aave-v3',
        marketId: `aave-v3:${p.chain}:${p.market}:${p.asset}`,
        assetSymbol: p.asset,
      });
    } else if (p.protocol === 'morpho-vault') {
      result.push({
        positionId: `morpho-vault:${p.chain}:${p.vault}`,
        protocol: 'morpho-vault',
        marketId: `morpho-vault:${p.chain}:${p.vault}`,
        assetSymbol: 'USDC', // every currently configured vault position is USDC-denominated
      });
    }
    // A direct `morpho-blue` position would be added here the same way, once one is
    // actually configured — see this file's header comment.
  }
  return result;
}

async function assembleAaveMarketContext(
  deps: PipelineDeps,
  position: ChainPosition,
  safeAddress: Address,
  at: BlockRef,
): Promise<MarketContext> {
  const [, chain, market] = position.marketId.split(':');
  const adapter = new AaveV3Adapter({
    chain: chain!,
    market: market!,
    chainId: deps.chainId,
    watchedAssets: [...AAVE_ASSET_SYMBOLS],
    pool: deps.pool,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  const [current] = await adapter.snapshotMarkets([position.assetSymbol], at);
  if (!current) throw new Error(`${position.marketId}: snapshotMarkets returned nothing`);
  deps.repos.marketSnapshots.record('aave-v3', current);

  const collateralExposure = await adapter.collateralExposure(position.marketId, at);
  const override = deps.positionOverrides?.[position.marketId];
  const myPosition: Position | undefined =
    override ??
    (await adapter.discoverPositions(safeAddress, at)).find(
      (p) => p.marketId === position.marketId,
    );

  const poolAddress = AAVE_V3_MARKETS[chain!]![market!]!.pool;
  const configuratorAddress = await resolveAaveConfiguratorAddress(deps.pool, poolAddress, at);
  const eventsFromBlock = deps.eventsFromBlock ?? at.number;
  const governanceEvents = await fetchGovernanceEvents(
    deps.pool,
    [aaveGovernanceTarget(adapter, configuratorAddress)],
    eventsFromBlock,
    at.number,
    deps.logger,
  );
  const poolFlowEvents = await fetchPoolFlowEvents(
    deps.pool,
    [aavePoolFlowTarget(adapter, poolAddress)],
    eventsFromBlock,
    at.number,
    deps.logger,
  );
  deps.repos.protocolEvents.recordAll('governance', governanceEvents);
  deps.repos.protocolEvents.recordAll('large-holder', poolFlowEvents);

  const allPoolFlowEvents = deps.repos.protocolEvents.findByMarket(position.marketId, 0n);
  const ledger = computeHolderLedger(allPoolFlowEvents, extractAaveMovement);
  const oneHourAgoEvents = allPoolFlowEvents.filter(
    (e) => e.blockNumber <= at.number - blocksPerHour(deps.chain),
  );
  const historicLedger = computeHolderLedger(oneHourAgoEvents, extractAaveMovement);

  const topBorrowers = [...ledger.values()]
    .filter((h) => h.borrow > 0n)
    .sort((a, b) => (b.borrow > a.borrow ? 1 : -1))
    .slice(0, 10)
    .map((h) => h.holder);
  const borrowerHealth = await fetchAaveBorrowerHealth(deps.pool, poolAddress, topBorrowers, at);

  const history = deps.repos.marketSnapshots.findHistory(
    position.marketId,
    at.number > HISTORY_LOOKBACK_BLOCKS ? at.number - HISTORY_LOOKBACK_BLOCKS : 0n,
  );

  return {
    marketId: position.marketId,
    chainId: deps.chainId,
    protocol: 'aave-v3',
    current,
    history: history.slice(0, -1), // exclude `current` itself, already the last entry
    collateralExposure,
    ...(myPosition ? { position: myPosition } : {}),
    holders: ledgerValues(ledger),
    holdersHistory: ledgerValues(historicLedger),
    borrowerHealth,
    governanceEvents,
    positionAssetQuotes: [], // filled in by the caller once quotes are fetched
  };
}

async function assembleMorphoVaultMarketContext(
  deps: PipelineDeps,
  position: ChainPosition,
  safeAddress: Address,
  at: BlockRef,
): Promise<MarketContext> {
  const [, chain, vaultAddress] = position.marketId.split(':');
  const adapter = new MorphoVaultAdapter({
    chain: chain!,
    chainId: deps.chainId,
    vaultAddress: vaultAddress as Address,
    pool: deps.pool,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  const [current] = await adapter.snapshotMarkets([position.marketId], at);
  if (!current) throw new Error(`${position.marketId}: snapshotMarkets returned nothing`);
  deps.repos.marketSnapshots.record('morpho-vault', current);

  const collateralExposure = await adapter.collateralExposure(position.marketId, at);
  const override = deps.positionOverrides?.[position.marketId];
  const myPosition =
    override ??
    (await adapter.discoverPositions(safeAddress, at)).find(
      (p) => p.marketId === position.marketId,
    );

  const eventsFromBlock = deps.eventsFromBlock ?? at.number;
  const governanceEvents = await fetchGovernanceEvents(
    deps.pool,
    [morphoVaultGovernanceTarget(adapter, vaultAddress as Address)],
    eventsFromBlock,
    at.number,
    deps.logger,
  );
  const poolFlowEvents = await fetchPoolFlowEvents(
    deps.pool,
    [morphoVaultPoolFlowTarget(adapter, vaultAddress as Address)],
    eventsFromBlock,
    at.number,
    deps.logger,
  );
  deps.repos.protocolEvents.recordAll('governance', governanceEvents);
  deps.repos.protocolEvents.recordAll('large-holder', poolFlowEvents);

  const allPoolFlowEvents = deps.repos.protocolEvents.findByMarket(position.marketId, 0n);
  const ledger = computeHolderLedger(allPoolFlowEvents, extractMorphoVaultMovement);
  const oneHourAgoEvents = allPoolFlowEvents.filter(
    (e) => e.blockNumber <= at.number - blocksPerHour(deps.chain),
  );
  const historicLedger = computeHolderLedger(oneHourAgoEvents, extractMorphoVaultMovement);

  const history = deps.repos.marketSnapshots.findHistory(
    position.marketId,
    at.number > HISTORY_LOOKBACK_BLOCKS ? at.number - HISTORY_LOOKBACK_BLOCKS : 0n,
  );

  return {
    marketId: position.marketId,
    chainId: deps.chainId,
    protocol: 'morpho-vault',
    current,
    history: history.slice(0, -1),
    collateralExposure,
    ...(myPosition ? { position: myPosition } : {}),
    holders: ledgerValues(ledger),
    holdersHistory: ledgerValues(historicLedger),
    borrowerHealth: [], // vaults have no borrowers of their own to rank
    governanceEvents,
    positionAssetQuotes: [],
  };
}

function ledgerValues(ledger: Map<Address, HolderBalance>) {
  return [...ledger.values()];
}

/** Rough, conservative blocks-per-hour estimate per chain — only used to pick D05's
 * "1 hour ago" reference point for the holder ledger, not for anything decision-
 * critical (D05's own severity math only cares about the balance delta, not exact
 * timing precision). Ethereum ~12s/block, Base ~2s/block. */
function blocksPerHour(chain: string): bigint {
  return chain === 'base' ? 1800n : 300n;
}

async function fetchAssetContext(
  deps: PipelineDeps,
  chain: string,
  symbol: string,
  marketId: string,
  oraclePriceRaw: bigint | undefined,
  at: BlockRef,
): Promise<AssetContext | undefined> {
  if (oraclePriceRaw === undefined) return undefined;

  const chainlink = new ChainlinkPriceSource({ chain, chainId: deps.chainId, pool: deps.pool });
  const uniswap = new UniswapV3PriceSource({ chain, chainId: deps.chainId, pool: deps.pool });
  const [chainlinkQuotes, uniswapQuotes] = await Promise.all([
    chainlink.fetchQuotes([symbol], at),
    uniswap.fetchQuotes([symbol], at),
  ]);
  const marketQuotes = [...chainlinkQuotes, ...uniswapQuotes];

  const dexDepth = await fetchDexDepthSnapshot(deps.pool, chain, symbol, at);

  return {
    symbol,
    marketId,
    current: { block: at, oraclePrice: normalizeAaveOraclePrice(oraclePriceRaw), marketQuotes },
    history: [], // Phase 5 doesn't yet persist a dedicated oracle-price time series (see docs/PROGRESS.md)
    supplyHistory: [],
    ...(dexDepth ? { dexDepth } : {}),
  };
}

/** Runs the full pipeline once for one chain's newly-confirmed block: collect,
 * store, assemble, detect, decide, dispatch. Positions/markets outside this chain
 * are untouched — the caller runs this once per chain per confirmed block, matching
 * `LiveBlockSource`'s own per-chain design. */
export async function runOnce(deps: PipelineDeps, at: BlockRef): Promise<void> {
  const positions = positionsForChain(deps.config, deps.chain);
  if (positions.length === 0) return;

  const safeAddress = deps.config.safe.address as Address;

  const marketContexts: MarketContext[] = [];
  for (const position of positions) {
    const ctx =
      position.protocol === 'aave-v3'
        ? await assembleAaveMarketContext(deps, position, safeAddress, at)
        : await assembleMorphoVaultMarketContext(deps, position, safeAddress, at);
    marketContexts.push(ctx);
  }

  // Peg quotes for every position's own asset (D10) — independent sources only,
  // reused as the asset's "market quotes" input for D10's per-position field.
  const cexSources = [
    new CoinbasePriceSource({ clock: deps.clock }),
    new KrakenPriceSource({ clock: deps.clock }),
  ];
  const cexQuotes = (
    await Promise.all(cexSources.map((s) => s.fetchQuotes([...PRICED_ASSETS], at)))
  ).flat();
  const chainlinkForPeg = new ChainlinkPriceSource({
    chain: deps.chain,
    chainId: deps.chainId,
    pool: deps.pool,
  });
  const chainlinkPegQuotes = await chainlinkForPeg.fetchQuotes([...PRICED_ASSETS], at);
  const allPegQuotes = [...cexQuotes, ...chainlinkPegQuotes];

  for (const mc of marketContexts) {
    if (!mc.position) continue;
    const symbol = resolveAssetSymbol(deps.chain, mc.position.asset);
    mc.positionAssetQuotes = allPegQuotes.filter((q) => q.asset === symbol);
  }

  const assetContexts: AssetContext[] = [];
  for (const mc of marketContexts) {
    const wethOracle = mc.current.oraclePrices['WETH'];
    const assetCtx = await fetchAssetContext(deps, deps.chain, 'WETH', mc.marketId, wethOracle, at);
    if (assetCtx) assetContexts.push(assetCtx);
  }

  const assetExposure = buildAssetExposure(
    deps.chain,
    marketContexts.map((mc) => ({
      marketId: mc.marketId,
      collateralExposure: mc.collateralExposure,
    })),
  );

  const infra = [
    {
      chainId: deps.chainId,
      headLagBlocks: 0, // this call is already for a confirmed block; see this file's header comment
      providerDisagreementCount: 0, // not yet tracked as a running counter — see docs/PROGRESS.md
      reorgDepth: 0, // reorg handling lives in the block source layer, upstream of this call
      staleSources: [],
    },
  ];

  const detectorContext: DetectorContext = {
    at,
    markets: marketContexts,
    assets: assetContexts,
    infra,
    priorSignals: [],
    assetExposure,
  };

  const signals = evaluateAll(deps.detectors, detectorContext);

  for (const position of positions) {
    const marketOrVaultId = position.marketId;
    const existingState = deps.repos.riskState.get(position.positionId);
    const state: PositionRiskState =
      existingState ?? initialPositionRiskState(position.positionId, deps.clock.now());

    const result = decide({
      positionId: position.positionId,
      marketOrVaultId,
      signals,
      state,
      now: deps.clock.now(),
      blockNumber: at.number,
      configHash: deps.configHash,
      policy: deps.config.policy,
      killSwitchActive: deps.killSwitchActive,
      dwellSeconds: deps.dwellSeconds,
    });

    deps.repos.riskState.save(result.state, deps.clock.now());
    const decisionId = deps.repos.decisionRecords.record(result.decision);

    if (result.decision.level === 'NORMAL' && !result.decision.standingAlert) continue;

    const marketContext = marketContexts.find((mc) => mc.marketId === marketOrVaultId);
    const positionAsset = marketContext?.position?.asset;
    await deps.dispatcher.dispatch(
      {
        decisionId,
        positionId: position.positionId,
        protocol: position.protocol,
        chainId: deps.chainId,
        asset: positionAsset ? resolveAssetSymbol(deps.chain, positionAsset) : position.assetSymbol,
        level: result.decision.level,
        previousLevel: result.decision.previousLevel,
        rawLevel: result.decision.rawLevel,
        signals: result.decision.signals,
        rule: result.decision.rule,
        blockNumber: at.number,
        blockExplorerUrl: blockExplorerUrl(deps.chainId, at.number),
        action: result.decision.action,
        standingAlert: result.decision.standingAlert,
        at: result.decision.at,
      },
      !!(state.manualControls.mutedUntil && state.manualControls.mutedUntil > deps.clock.now()),
      state.manualControls.ackedDecisionId === String(decisionId),
    );

    const actionKind = result.decision.action.kind;
    if (
      deps.config.execution.mode === 'paper' &&
      deps.repos.campaigns &&
      deps.repos.paperExecutions &&
      (actionKind === 'partial_withdraw' || actionKind === 'full_exit')
    ) {
      const paperPosition: PaperExecutorPosition = {
        positionId: position.positionId,
        protocol: position.protocol,
        marketId: position.marketId,
        assetSymbol: position.assetSymbol,
      };
      try {
        const outcome = await runPaperExecution({
          chain: deps.chain,
          chainId: deps.chainId,
          config: deps.config,
          clock: deps.clock,
          ...(deps.logger ? { logger: deps.logger } : {}),
          campaigns: deps.repos.campaigns,
          forkUrl: deps.config.chains[deps.chain]!.rpc[0]!.url,
          position: paperPosition,
          safeAddress,
          action: result.decision.action,
          at,
        });
        if (outcome.kind !== 'none') {
          deps.repos.paperExecutions.record({
            positionId: position.positionId,
            at: deps.clock.now(),
            blockNumber: at.number,
            outcome,
          });
        }
        deps.logger?.info(
          { positionId: position.positionId, outcome: outcome.kind },
          'paper execution completed',
        );
      } catch (error) {
        deps.logger?.error(
          { positionId: position.positionId, err: error },
          'paper execution failed — will retry next block',
        );
      }
    }
  }
}
