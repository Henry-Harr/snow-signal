import { describe, expect, it } from 'vitest';

import {
  averageLiquidityInflowPerBlock,
  createD03Detector,
  D03_ID,
  estimateBlocksToExit,
} from '../../../src/signals/D03_exit_coverage.js';
import { block, detectorContext, marketContext, marketSnapshot, position } from './helpers.js';

describe('averageLiquidityInflowPerBlock', () => {
  it('computes the average rate across the first and last history entries', () => {
    const history = [
      marketSnapshot({ block: block({ number: 100n }), availableLiquidity: 1000n }),
      marketSnapshot({ block: block({ number: 200n }), availableLiquidity: 1000n }),
      marketSnapshot({ block: block({ number: 300n }), availableLiquidity: 1200n }),
    ];
    expect(averageLiquidityInflowPerBlock(history)).toBeCloseTo(1, 5); // 200 over 200 blocks
  });

  it('returns undefined with fewer than 2 points', () => {
    expect(averageLiquidityInflowPerBlock([marketSnapshot()])).toBeUndefined();
    expect(averageLiquidityInflowPerBlock([])).toBeUndefined();
  });
});

describe('estimateBlocksToExit', () => {
  it('is 0 when there is no shortfall', () => {
    expect(estimateBlocksToExit(0n, [])).toBe(0);
    expect(estimateBlocksToExit(-10n, [])).toBe(0);
  });

  it('is Infinity when liquidity is not recovering', () => {
    const history = [
      marketSnapshot({ block: block({ number: 100n }), availableLiquidity: 1000n }),
      marketSnapshot({ block: block({ number: 200n }), availableLiquidity: 900n }),
    ];
    expect(estimateBlocksToExit(500n, history)).toBe(Infinity);
  });

  it('ceils the shortfall divided by the recovery rate', () => {
    const history = [
      marketSnapshot({ block: block({ number: 100n }), availableLiquidity: 0n }),
      marketSnapshot({ block: block({ number: 200n }), availableLiquidity: 1000n }),
    ];
    // rate = 1000/100 = 10 per block; 1005/10 = 100.5, ceils to 101.
    expect(estimateBlocksToExit(1005n, history)).toBe(101);
  });
});

describe('D03 exit coverage', () => {
  const detector = createD03Detector();

  it('emits no signal for well-covered position', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          current: marketSnapshot({ availableLiquidity: 10_000_000n }),
          position: position({ balance: 100_000n }),
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('skips markets with no position held', () => {
    const ctx = detectorContext({
      markets: [marketContext({ current: marketSnapshot({ availableLiquidity: 1n }) })],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits watch at the borderline 20x coverage', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          current: marketSnapshot({ availableLiquidity: 2_000_000n }),
          position: position({ balance: 100_000n }),
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({ detectorId: D03_ID, severity: 'watch', value: 20 });
  });

  it('emits critical when coverage is below 1.5x and estimates blocks-to-exit', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          current: marketSnapshot({ availableLiquidity: 100_000n, block: block({ number: 200n }) }),
          position: position({ balance: 200_000n }),
          history: [
            marketSnapshot({ availableLiquidity: 50_000n, block: block({ number: 100n }) }),
            marketSnapshot({ availableLiquidity: 100_000n, block: block({ number: 200n }) }),
          ],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.severity).toBe('critical');
    expect(signal?.evidence['blocksToExit']).toBe(200); // shortfall 100_000 / rate 500/block
  });

  it('does not fire on a position whose balance is effectively zero (false-positive guard: fresh deposit)', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          current: marketSnapshot({ availableLiquidity: 1n }),
          position: position({ balance: 0n }),
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });
});
