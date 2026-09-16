import { describe, expect, it } from 'vitest';

import { createD05Detector, D05_ID } from '../../../src/signals/D05_large_holder_exits.js';
import { addr, detectorContext, holder, marketContext } from './helpers.js';

const ALICE = addr('a1');
const BOB = addr('b2');
const SMALL_FRY = addr('c3');

describe('D05 large-holder exits', () => {
  const detector = createD05Detector();

  it('emits no signal when top holders have not withdrawn', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          holdersHistory: [holder({ holder: ALICE, supply: 1000n })],
          holders: [holder({ holder: ALICE, supply: 1000n })],
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits watch at the borderline 25% withdrawal', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          holdersHistory: [holder({ holder: ALICE, supply: 1000n })],
          holders: [holder({ holder: ALICE, supply: 750n })],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({
      detectorId: D05_ID,
      family: 'pool_flow',
      severity: 'watch',
      value: 0.25,
    });
    expect(signal?.evidence['holder']).toBe(ALICE);
  });

  it('emits critical for a near-total exit (holder no longer present at all)', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          holdersHistory: [holder({ holder: ALICE, supply: 1000n })],
          holders: [], // Alice withdrew everything and is gone from the current ledger
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({ severity: 'critical', value: 1 });
    expect(signal?.evidence['currentBalance']).toBe(0n);
  });

  it('does not fire when a holder increases their balance (a deposit, not a withdrawal)', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          holdersHistory: [holder({ holder: ALICE, supply: 1000n })],
          holders: [holder({ holder: ALICE, supply: 1500n })],
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('only considers the top N historical suppliers (false-positive guard: a small holder fully exiting is not a "large-holder" event)', () => {
    const detectorTop1 = createD05Detector(undefined, 1);
    const ctx = detectorContext({
      markets: [
        marketContext({
          holdersHistory: [
            holder({ holder: ALICE, supply: 10_000n }),
            holder({ holder: SMALL_FRY, supply: 100n }),
          ],
          holders: [
            holder({ holder: ALICE, supply: 10_000n }), // Alice (top-1) unchanged
            // SMALL_FRY fully exited, but isn't in the top-1 ranking
          ],
        }),
      ],
    });
    expect(detectorTop1.evaluate(ctx)).toEqual([]);
  });

  it('emits a separate signal per triggering holder', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          holdersHistory: [
            holder({ holder: ALICE, supply: 1000n }),
            holder({ holder: BOB, supply: 2000n }),
          ],
          holders: [
            holder({ holder: ALICE, supply: 700n }), // 30% withdrawn -> watch
            holder({ holder: BOB, supply: 900n }), // 55% withdrawn -> danger
          ],
        }),
      ],
    });
    const signals = detector.evaluate(ctx);
    expect(signals).toHaveLength(2);
    expect(signals.find((s) => s.evidence['holder'] === ALICE)?.severity).toBe('watch');
    expect(signals.find((s) => s.evidence['holder'] === BOB)?.severity).toBe('danger');
  });
});
