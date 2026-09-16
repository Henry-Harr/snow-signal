import { erc20Abi } from 'viem';

import { runExitDrill } from '../actions/exit-drill.js';
import { createViemContractReadClient, type ContractReadClient } from '../chain/client.js';
import { RpcPool } from '../chain/rpc-pool.js';
import { SystemClock, type Clock } from '../core/clock.js';
import { loadConfig, type SentinelConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { Address, BlockRef, ChainId } from '../core/types.js';
import { AaveV3Adapter } from '../protocols/aave-v3/adapter.js';
import { MorphoVaultAdapter } from '../protocols/morpho-vault/adapter.js';
import { generateDailyReport } from '../reports/daily-report.js';
import type { DailyReportInput, DataQualitySummary, PositionSummary } from '../reports/types.js';
import { writeDailyReport } from '../reports/write.js';
import { openDatabase } from '../storage/db.js';
import { DecisionLabelRepository } from '../storage/decision-label-repository.js';
import { DecisionRecordRepository } from '../storage/decision-record-repository.js';

/**
 * `sentinel report` (docs/SPEC.md §10.2). Unlike `sentinel watch`, which only ever
 * reads what the pipeline has already stored, a daily report needs *current*
 * balances/rates ("positions, balances, and yield earned") that nothing persists
 * today — `src/core/pipeline.ts` reads a position's balance from
 * `ProtocolAdapter.discoverPositions` transiently and never stores it (only the
 * *market*-wide snapshot is persisted, via `MarketSnapshotRepository`). So this
 * command does its own light live read per configured position (balance, asset
 * decimals, current supply rate) rather than inventing a number — see
 * `generateDailyReport`'s own doc comment for which report sections are genuinely
 * real vs. still a placeholder in Phase 5.
 *
 * Everything else (alerts, transitions, actions, labels) comes straight out of
 * `decision_records`/`decision_labels` for the requested UTC date — no live reads
 * needed, since a `DecisionRecord` already carries everything it needs.
 */

export interface ReportOptions {
  configPath: string;
  dbPath: string;
  reportsDir?: string;
  /** UTC calendar date, `YYYY-MM-DD` — defaults to today (per `clock`). */
  date?: string;
  logger: Logger;
  clock?: Clock;
}

export interface ReportResult {
  mdPath: string;
  jsonPath: string;
}

async function readDecimals(
  pool: RpcPool<ContractReadClient>,
  asset: Address,
  at: BlockRef,
): Promise<number> {
  return pool.bestEffortRead(async (client) => {
    const [result] = await client.multicall(
      [{ address: asset, abi: erc20Abi, functionName: 'decimals' }],
      at.number,
    );
    if (!result || result.status === 'failure') {
      throw new Error(`decimals() read failed for ${asset}`);
    }
    return Number(result.result);
  });
}

/** Kind `'pool_base_rate'` doesn't have a separate data source: nothing collected so
 * far tracks a "base" rate distinct from the position's own current supply rate (e.g.
 * excluding temporary incentives) — so rather than fabricate a number, the benchmark
 * is honestly reported as unavailable (see `PositionSummary.benchmarkApr`'s own doc
 * comment on this same convention). Kind `'vault'` looks up the configured benchmark
 * vault on the *same chain* as the position being reported (comparing across chains
 * wouldn't be meaningful) — best-effort, `undefined` if that read fails or no vault is
 * configured for this chain.
 */
async function resolveBenchmark(
  benchmark: SentinelConfig['reports']['benchmark'],
  chain: string,
  chainId: ChainId,
  pool: RpcPool<ContractReadClient>,
  at: BlockRef,
  logger: Logger,
): Promise<{ label: string; apr: number | undefined }> {
  if (benchmark.kind === 'pool_base_rate') {
    return { label: 'pool base rate (not separately tracked yet)', apr: undefined };
  }

  if (!benchmark.vault) {
    return { label: 'benchmark vault (none configured)', apr: undefined };
  }

  try {
    const adapter = new MorphoVaultAdapter({
      chain,
      chainId,
      vaultAddress: benchmark.vault as Address,
      pool,
      logger,
    });
    const [snapshot] = await adapter.snapshotMarkets(
      [`morpho-vault:${chain}:${benchmark.vault}`],
      at,
    );
    return { label: `vault ${benchmark.vault}`, apr: snapshot?.supplyRate };
  } catch (error) {
    logger.warn({ err: error, vault: benchmark.vault }, 'benchmark vault read failed');
    return { label: `vault ${benchmark.vault}`, apr: undefined };
  }
}

async function fetchPositionSummary(
  config: SentinelConfig,
  position: SentinelConfig['positions'][number],
  pools: Map<string, RpcPool<ContractReadClient>>,
  ats: Map<string, BlockRef>,
  safeAddress: Address,
  logger: Logger,
): Promise<PositionSummary | undefined> {
  const pool = pools.get(position.chain);
  const at = ats.get(position.chain);
  const chainConfig = config.chains[position.chain];
  if (!pool || !at || !chainConfig) return undefined;

  try {
    if (position.protocol === 'aave-v3') {
      const adapter = new AaveV3Adapter({
        chain: position.chain,
        market: position.market,
        chainId: chainConfig.chainId,
        watchedAssets: [position.asset],
        pool,
        logger,
      });
      const [snapshot] = await adapter.snapshotMarkets([position.asset], at);
      const positions = await adapter.discoverPositions(safeAddress, at);
      const marketId = `aave-v3:${position.chain}:${position.market}:${position.asset}`;
      const myPosition = positions.find((p) => p.marketId === marketId);
      if (!snapshot || !myPosition) {
        logger.info(
          { marketId, safeAddress },
          'configured position has no discoverable balance right now, omitting from report',
        );
        return undefined;
      }

      const decimals = await readDecimals(pool, myPosition.asset, at);
      const benchmark = await resolveBenchmark(
        config.reports.benchmark,
        position.chain,
        chainConfig.chainId,
        pool,
        at,
        logger,
      );

      return {
        positionId: marketId,
        protocol: 'aave-v3',
        chainId: chainConfig.chainId,
        asset: myPosition.asset,
        assetSymbol: position.asset,
        balance: myPosition.balance,
        balanceDecimals: decimals,
        supplyRateApr: snapshot.supplyRate,
        benchmarkAprLabel: benchmark.label,
        benchmarkApr: benchmark.apr,
      };
    }

    if (position.protocol === 'morpho-vault') {
      const marketId = `morpho-vault:${position.chain}:${position.vault}`;
      const adapter = new MorphoVaultAdapter({
        chain: position.chain,
        chainId: chainConfig.chainId,
        vaultAddress: position.vault as Address,
        pool,
        logger,
      });
      const [snapshot] = await adapter.snapshotMarkets([marketId], at);
      const positions = await adapter.discoverPositions(safeAddress, at);
      const myPosition = positions.find((p) => p.marketId === marketId);
      if (!snapshot || !myPosition) {
        logger.info(
          { marketId, safeAddress },
          'configured position has no discoverable balance right now, omitting from report',
        );
        return undefined;
      }

      const decimals = await readDecimals(pool, myPosition.asset, at);
      const benchmark = await resolveBenchmark(
        config.reports.benchmark,
        position.chain,
        chainConfig.chainId,
        pool,
        at,
        logger,
      );

      return {
        positionId: marketId,
        protocol: 'morpho-vault',
        chainId: chainConfig.chainId,
        asset: myPosition.asset,
        assetSymbol: 'USDC', // every currently configured vault position is USDC-denominated
        balance: myPosition.balance,
        balanceDecimals: decimals,
        supplyRateApr: snapshot.supplyRate,
        benchmarkAprLabel: benchmark.label,
        benchmarkApr: benchmark.apr,
      };
    }
  } catch (error) {
    logger.warn(
      { err: error, protocol: position.protocol, chain: position.chain },
      'live position read failed, omitting from report rather than showing a stale/fabricated figure',
    );
    return undefined;
  }

  // A direct morpho-blue position would be handled here the same way, once one is
  // actually configured — same scope note as src/core/pipeline.ts.
  return undefined;
}

export async function runReport(options: ReportOptions): Promise<ReportResult> {
  const logger = options.logger;
  const { config } = loadConfig(options.configPath);
  const db = openDatabase(options.dbPath);
  const clock = options.clock ?? new SystemClock();

  const now = clock.now();
  const date = options.date ?? now.toISOString().slice(0, 10);
  const sinceIso = `${date}T00:00:00.000Z`;
  const untilIso = `${date}T23:59:59.999Z`;

  const decisionRecordRepo = new DecisionRecordRepository(db);
  const decisionLabelRepo = new DecisionLabelRepository(db);

  const decisions = decisionRecordRepo
    .findSince(sinceIso)
    .filter((d) => d.at.toISOString() <= untilIso);
  const labels = decisionLabelRepo.findForDecisions(decisions.map((d) => d.id));

  const pools = new Map<string, RpcPool<ContractReadClient>>();
  const ats = new Map<string, BlockRef>();
  for (const [chain, chainConfig] of Object.entries(config.chains)) {
    const providers = chainConfig.rpc.map((rpc) => ({
      name: rpc.name,
      client: createViemContractReadClient(rpc.url, chainConfig.chainId),
    }));
    const pool = new RpcPool<ContractReadClient>(providers, logger);
    pools.set(chain, pool);
    try {
      const number = await pool.getConservativeHead();
      ats.set(chain, {
        chainId: chainConfig.chainId,
        number,
        hash: '0x0',
        timestamp: Math.floor(now.getTime() / 1000),
      });
    } catch (error) {
      logger.warn(
        { err: error, chain },
        'could not reach chain quorum, omitting its positions from the report',
      );
    }
  }

  const safeAddress = config.safe.address as Address;
  const positions: PositionSummary[] = [];
  for (const position of config.positions) {
    const summary = await fetchPositionSummary(config, position, pools, ats, safeAddress, logger);
    if (summary) positions.push(summary);
  }

  let exitDrillResults: DailyReportInput['exitDrillResults'] = [];
  try {
    exitDrillResults = await runExitDrill({ config, clock, logger });
  } catch (error) {
    logger.warn({ err: error }, 'exit drill failed, omitting its results from the report');
  }

  const dataQuality: DataQualitySummary[] = Object.values(config.chains).map((chainConfig) => ({
    chainId: chainConfig.chainId,
    providerUptime: undefined, // not yet tracked as a running counter — see docs/PROGRESS.md
    averageHeadLagBlocks: 0,
    disagreementCount: 0,
    staleSourceCount: 0,
  }));

  const input: DailyReportInput = {
    date,
    generatedAt: now,
    positions,
    decisions,
    labels,
    dataQuality,
    exitDrillResults,
    gasSpentWei: 0n, // execution mode is always 'off' in Phase 5
  };

  const report = generateDailyReport(input);
  const { mdPath, jsonPath } = writeDailyReport(report, date, options.reportsDir ?? 'reports');
  db.close();
  return { mdPath, jsonPath };
}
