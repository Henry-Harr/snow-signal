import { z } from 'zod';

import { resolveChainlinkFeed } from './chainlink-addresses.js';
import type { PriceQuote, PriceSource } from './types.js';
import type { ContractCall, ContractCallResult, ContractReadClient } from '../chain/client.js';
import type { RpcPool } from '../chain/rpc-pool.js';
import { AdapterError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { BlockRef, ChainId } from '../core/types.js';

/** Standard `AggregatorV3Interface`, confirmed directly against every feed in
 * `chainlink-addresses.ts` this session (each responded correctly to both calls via
 * `cast call` against the live RPC) — this is the same interface every Chainlink push
 * feed implements, not something specific to our chosen feeds. */
const aggregatorV3Abi = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

function unwrap(result: ContractCallResult | undefined, context: string): unknown {
  if (!result) throw new AdapterError(`${context}: missing multicall result`);
  if (result.status === 'failure') throw new AdapterError(`${context}: ${result.error.message}`);
  return result.result;
}

const roundDataSchema = z.tuple([
  z.bigint(), // roundId
  z.bigint(), // answer — signed, but a healthy feed's answer is always positive; checked below
  z.bigint(), // startedAt
  z.bigint(), // updatedAt
  z.bigint(), // answeredInRound
]);

export interface ChainlinkPriceSourceOptions {
  chain: string;
  chainId: ChainId;
  pool: RpcPool<ContractReadClient>;
  logger?: Logger;
}

/** Chainlink price source (docs/SPEC.md #6.5). Reads `latestRoundData()` for every
 * requested asset that has a known feed on this chain (`chainlink-addresses.ts`);
 * assets without one are silently skipped, not errored — a caller asking for prices
 * across every watched collateral asset shouldn't fail just because Chainlink doesn't
 * cover one of them (DEX/CEX sources may still cover it). */
export class ChainlinkPriceSource implements PriceSource {
  readonly id: string;
  private readonly chain: string;
  private readonly chainId: ChainId;
  private readonly pool: RpcPool<ContractReadClient>;
  private readonly logger: Logger | undefined;

  constructor(options: ChainlinkPriceSourceOptions) {
    this.id = `chainlink:${options.chain}`;
    this.chain = options.chain;
    this.chainId = options.chainId;
    this.pool = options.pool;
    this.logger = options.logger;
  }

  async fetchQuotes(assets: string[], at: BlockRef): Promise<PriceQuote[]> {
    const known = assets
      .map((asset) => ({ asset, feed: resolveChainlinkFeed(this.chain, asset) }))
      .filter((entry): entry is { asset: string; feed: NonNullable<typeof entry.feed> } => {
        if (!entry.feed) {
          this.logger?.debug({ chain: this.chain, asset: entry.asset }, 'no Chainlink feed known');
          return false;
        }
        return true;
      });
    if (known.length === 0) return [];

    const calls: ContractCall[] = known.flatMap(({ feed }) => [
      { address: feed.address, abi: aggregatorV3Abi, functionName: 'latestRoundData' },
      { address: feed.address, abi: aggregatorV3Abi, functionName: 'decimals' },
    ]);

    // Prices are decision-critical (docs/SPEC.md #6.1) — quorum-read.
    const results = await this.pool.quorumRead((client) => client.multicall(calls, at.number));

    return known.map(({ asset, feed }, i) => {
      const base = i * 2;
      const ctx = `${this.id}:${asset}`;
      const [roundId, answer, startedAt, updatedAt, answeredInRound] = roundDataSchema.parse(
        unwrap(results[base], `${ctx} latestRoundData()`),
      );
      // `decimals()` returns `uint8` — small enough that viem decodes it as a plain
      // JS `number`, not `bigint` (unlike every other field here, which is `uint256`/
      // `int256`/`uint80` and decodes to `bigint`). Confirmed directly against a real
      // fork call (2026-09-16) after this schema first rejected the real shape.
      const decimals = z
        .number()
        .int()
        .nonnegative()
        .parse(unwrap(results[base + 1], `${ctx} decimals()`));

      if (answer <= 0n) {
        throw new AdapterError(`${ctx}: feed returned a non-positive answer (${answer})`);
      }

      return {
        source: this.id,
        asset,
        quoteAsset: 'USD',
        price: Number(answer) / 10 ** decimals,
        fetchedAt: Number(updatedAt),
        chainId: this.chainId,
        blockNumber: at.number,
        raw: {
          feedAddress: feed.address,
          description: feed.description,
          roundId,
          answer,
          startedAt,
          updatedAt,
          answeredInRound,
          decimals,
        },
      };
    });
  }
}
