import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { executeStopLoss } from '../../../src/stoploss/executor.js';
import type { StopLossTrigger } from '../../../src/stoploss/engine.js';
import type { ClobRestClient } from '../../../src/polymarket/rest-client.js';
import type { WatchedPosition } from '../../../src/core/types.js';

const TEST_PRIVATE_KEY = '0x9c7bdea98d189da26c52932d09cec3020ec7132a3ff7a3d715ece84b0d65c9d4';
const account = privateKeyToAccount(TEST_PRIVATE_KEY);

function trigger(overrides: Partial<StopLossTrigger> = {}): StopLossTrigger {
  const position: WatchedPosition = {
    label: 'test',
    tokenId: '123',
    negRisk: false,
    shares: 1_000_000n,
    stopPrice: 0.5,
  };
  return { position, triggerPrice: 0.5, sellShares: 1_000_000n, ...overrides };
}

describe('executeStopLoss (paper mode)', () => {
  it('never calls a rest client and reports kind "paper"', async () => {
    const outcome = await executeStopLoss(trigger(), { mode: 'paper' });
    expect(outcome.kind).toBe('paper');
    expect(outcome.orderId).toBeUndefined();
  });

  it('computes a limit price below the trigger price by the slippage tolerance', async () => {
    const outcome = await executeStopLoss(trigger({ triggerPrice: 0.5 }), {
      mode: 'paper',
      slippageTolerance: 0.1,
    });
    expect(outcome.limitPrice).toBeCloseTo(0.45, 5);
  });

  it('sizes makerAmount to exactly the triggered sellShares', async () => {
    const outcome = await executeStopLoss(trigger({ sellShares: 500_000n }), { mode: 'paper' });
    expect(outcome.makerAmount).toBe(500_000n);
  });
});

describe('executeStopLoss (live mode)', () => {
  it('signs and submits a real order, reporting "submitted" on success', async () => {
    const postOrder = vi.fn().mockResolvedValue({ success: true, orderId: 'order-123' });
    const restClient = { postOrder } as unknown as ClobRestClient;

    const outcome = await executeStopLoss(trigger(), {
      mode: 'live',
      account,
      makerAddress: account.address,
      restClient,
    });

    expect(outcome.kind).toBe('submitted');
    expect(outcome.orderId).toBe('order-123');
    expect(postOrder).toHaveBeenCalledTimes(1);
    const [call] = postOrder.mock.calls[0] as [{ order: { side: number }; orderType: string }];
    expect(call.orderType).toBe('FAK'); // stop-loss sells must fill-or-kill-immediately, never sit as GTC
    expect(call.order.side).toBe(1); // SELL
  });

  it('reports "rejected" (not a thrown error) when the exchange rejects the order', async () => {
    const postOrder = vi.fn().mockResolvedValue({ success: false, errorMsg: 'insufficient balance' });
    const restClient = { postOrder } as unknown as ClobRestClient;

    const outcome = await executeStopLoss(trigger(), {
      mode: 'live',
      account,
      makerAddress: account.address,
      restClient,
    });

    expect(outcome.kind).toBe('rejected');
    expect(outcome.errorMsg).toBe('insufficient balance');
  });
});
