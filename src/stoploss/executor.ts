import type { PrivateKeyAccount } from 'viem/accounts';

import { buildSignedOrder } from '../polymarket/eip712.js';
import type { ClobRestClient } from '../polymarket/rest-client.js';
import type { StopLossTrigger } from './engine.js';

/**
 * Turns a triggered stop-loss into either a logged no-op ('paper') or a real,
 * signed sell order actually submitted to the CLOB ('live'). `executionMode`
 * defaults to 'paper' in config (`src/core/config.ts`) — the same
 * default-to-safe pattern used throughout this project's history: a mode this
 * explicit has to be deliberately opted into, never assumed.
 *
 * Sells via a FAK ("fill and kill") order — executes whatever's immediately
 * available against the current book and cancels the rest, rather than FOK
 * (all-or-nothing) or GTC (could sit unfilled while the price keeps falling).
 * A stop-loss's whole purpose is getting out now; a partial immediate fill is
 * strictly better than a full fill that might never come.
 */
export interface ExecutionOutcome {
  kind: 'paper' | 'submitted' | 'rejected';
  trigger: StopLossTrigger;
  limitPrice: number;
  makerAmount: bigint;
  takerAmount: bigint;
  orderId?: string;
  errorMsg?: string;
}

export interface PaperExecuteOptions {
  mode: 'paper';
  slippageTolerance?: number;
}

export interface LiveExecuteOptions {
  mode: 'live';
  account: PrivateKeyAccount;
  makerAddress: `0x${string}`;
  restClient: ClobRestClient;
  /** Fraction below the triggering bid to accept, to make an immediate FAK
   * fill likely even if the book has moved by the time the order lands —
   * default 3%. */
  slippageTolerance?: number;
}

export type ExecuteStopLossOptions = PaperExecuteOptions | LiveExecuteOptions;

export async function executeStopLoss(
  trigger: StopLossTrigger,
  options: ExecuteStopLossOptions,
): Promise<ExecutionOutcome> {
  const slippage = options.slippageTolerance ?? 0.03;
  const limitPrice = Math.max(0, trigger.triggerPrice * (1 - slippage));
  const makerAmount = trigger.sellShares;
  const takerAmount = (makerAmount * BigInt(Math.round(limitPrice * 1_000_000))) / 1_000_000n;

  if (options.mode === 'paper') {
    return { kind: 'paper', trigger, limitPrice, makerAmount, takerAmount };
  }

  const signedOrder = await buildSignedOrder(options.account, {
    maker: options.makerAddress,
    tokenId: trigger.position.tokenId,
    makerAmount,
    takerAmount,
    side: 'SELL',
    negRisk: trigger.position.negRisk,
  });

  const response = await options.restClient.postOrder({ order: signedOrder, orderType: 'FAK' });
  if (!response.success) {
    return {
      kind: 'rejected',
      trigger,
      limitPrice,
      makerAmount,
      takerAmount,
      ...(response.errorMsg !== undefined ? { errorMsg: response.errorMsg } : {}),
    };
  }
  return {
    kind: 'submitted',
    trigger,
    limitPrice,
    makerAmount,
    takerAmount,
    ...(response.orderId !== undefined ? { orderId: response.orderId } : {}),
  };
}
