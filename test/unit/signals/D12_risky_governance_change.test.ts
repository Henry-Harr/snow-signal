import { describe, expect, it } from 'vitest';

import { createD12Detector, D12_ID } from '../../../src/signals/D12_risky_governance_change.js';
import { detectorContext, marketContext, protocolEvent } from './helpers.js';

describe('D12 risky governance change', () => {
  const detector = createD12Detector();

  it('emits no signal for an unrelated event (e.g. a pool-flow event, not governance)', () => {
    const ctx = detectorContext({
      markets: [marketContext({ governanceEvents: [protocolEvent({ eventName: 'Supply' })] })],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits danger for a role change (SetOwner)', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          marketId: 'm1',
          governanceEvents: [protocolEvent({ eventName: 'SetOwner' })],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({
      detectorId: D12_ID,
      family: 'governance',
      subject: { kind: 'market', id: 'm1' },
      severity: 'danger',
    });
    expect(signal?.evidence['category']).toBe('role_change');
  });

  it('emits watch for a low-severity change (CreateMarket)', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({ governanceEvents: [protocolEvent({ eventName: 'CreateMarket' })] }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.severity).toBe('watch');
  });

  describe('cap jump (BorrowCapChanged/SupplyCapChanged)', () => {
    it('emits watch for a moderate cap increase', () => {
      const ctx = detectorContext({
        markets: [
          marketContext({
            governanceEvents: [
              protocolEvent({
                eventName: 'SupplyCapChanged',
                args: { oldSupplyCap: 1000n, newSupplyCap: 1600n }, // +60%
              }),
            ],
          }),
        ],
      });
      const [signal] = detector.evaluate(ctx);
      expect(signal).toMatchObject({ severity: 'watch' });
      expect(signal?.evidence['category']).toBe('cap_jump');
    });

    it('emits danger for a large cap increase', () => {
      const ctx = detectorContext({
        markets: [
          marketContext({
            governanceEvents: [
              protocolEvent({
                eventName: 'BorrowCapChanged',
                args: { oldBorrowCap: 1000n, newBorrowCap: 5000n }, // +400%
              }),
            ],
          }),
        ],
      });
      const [signal] = detector.evaluate(ctx);
      expect(signal?.severity).toBe('danger');
    });

    it('emits danger when a cap is removed entirely, regardless of magnitude', () => {
      const ctx = detectorContext({
        markets: [
          marketContext({
            governanceEvents: [
              protocolEvent({
                eventName: 'SupplyCapChanged',
                args: { oldSupplyCap: 1000n, newSupplyCap: 0n },
              }),
            ],
          }),
        ],
      });
      const [signal] = detector.evaluate(ctx);
      expect(signal?.severity).toBe('danger');
    });

    it('does not fire on a cap decrease (false-positive guard: protective change)', () => {
      const ctx = detectorContext({
        markets: [
          marketContext({
            governanceEvents: [
              protocolEvent({
                eventName: 'SupplyCapChanged',
                args: { oldSupplyCap: 1000n, newSupplyCap: 500n },
              }),
            ],
          }),
        ],
      });
      expect(detector.evaluate(ctx)).toEqual([]);
    });

    it('does not fire when a cap is newly added where none existed (false-positive guard)', () => {
      const ctx = detectorContext({
        markets: [
          marketContext({
            governanceEvents: [
              protocolEvent({
                eventName: 'SupplyCapChanged',
                args: { oldSupplyCap: 0n, newSupplyCap: 1000n },
              }),
            ],
          }),
        ],
      });
      expect(detector.evaluate(ctx)).toEqual([]);
    });
  });

  it('emits one signal per governance event, across multiple events', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          governanceEvents: [
            protocolEvent({ eventName: 'SetFee' }),
            protocolEvent({ eventName: 'SetGuardian' }),
          ],
        }),
      ],
    });
    const signals = detector.evaluate(ctx);
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.severity)).toEqual(['watch', 'danger']);
  });
});
