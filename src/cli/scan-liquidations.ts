import { createViemContractReadClient, type ContractReadClient } from '../chain/client.js';
import { RpcPool } from '../chain/rpc-pool.js';
import { loadConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { BlockRef } from '../core/types.js';
import { resolveAaveV3Market } from '../protocols/aave-v3/addresses.js';
import { scanMarketForLiquidations } from '../liquidations/scanner.js';
import { LiquidationOpportunityRepository } from '../storage/liquidation-opportunity-repository.js';
import { openDatabase } from '../storage/db.js';

/**
 * `sentinel scan-liquidations` (docs/adr/0014-liquidation-scanner.md). Detection
 * only — finds and logs theoretical Aave v3 liquidation opportunities on the
 * configured markets, never signs or sends anything. A one-shot scan (not a
 * long-running watch loop like `sentinel watch`); run it periodically (cron, or
 * repeated manual runs) while gathering the real evidence this module exists to
 * produce.
 */
export interface ScanLiquidationsOptions {
  configPath: string;
  dbPath: string;
  chain: 'ethereum' | 'base';
  market: string;
  logger: Logger;
}

export async function runScanLiquidations(options: ScanLiquidationsOptions) {
  const { config } = loadConfig(options.configPath);
  const chainConfig = config.chains[options.chain];
  if (!chainConfig) {
    throw new Error(`No configured chain "${options.chain}" in ${options.configPath}`);
  }

  const apiKey = process.env['GRAPH_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'GRAPH_API_KEY not set — create a free API key at thegraph.com/studio and add it to .env (see docs/adr/0014-liquidation-scanner.md).',
    );
  }
  const subgraphId = process.env[`AAVE_SUBGRAPH_ID_${options.chain.toUpperCase()}`];
  if (!subgraphId) {
    throw new Error(
      `AAVE_SUBGRAPH_ID_${options.chain.toUpperCase()} not set — the official Aave v3 subgraph deployment id for this chain (docs/SOURCES.md).`,
    );
  }

  const providers = chainConfig.rpc.map((rpc) => ({
    name: rpc.name,
    client: createViemContractReadClient(rpc.url, chainConfig.chainId),
  }));
  const pool = new RpcPool<ContractReadClient>(providers, options.logger);

  const blockNumber = await pool.getConservativeHead();
  const at: BlockRef = {
    chainId: chainConfig.chainId,
    number: blockNumber,
    hash: '0x0',
    timestamp: Math.floor(Date.now() / 1000),
  };

  const { pool: poolAddress, poolDataProvider } = resolveAaveV3Market(options.chain, options.market);

  const opportunities = await scanMarketForLiquidations(pool, {
    chain: options.chain,
    market: options.market,
    poolAddress,
    poolDataProviderAddress: poolDataProvider,
    subgraph: { apiKey, subgraphId },
    at,
  });

  const db = openDatabase(options.dbPath);
  try {
    const repo = new LiquidationOpportunityRepository(db);
    for (const opportunity of opportunities) repo.record(opportunity);
  } finally {
    db.close();
  }

  return opportunities;
}
