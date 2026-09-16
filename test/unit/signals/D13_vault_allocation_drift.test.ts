import { describe, expect, it } from 'vitest';

import {
  createD13Detector,
  D13_ID,
  referencedMarketIds,
} from '../../../src/signals/D13_vault_allocation_drift.js';
import { detectorContext, marketContext, protocolEvent } from './helpers.js';

const MARKET_HEX_ID = '0xaaaa000000000000000000000000000000000000000000000000000000aa';

describe('referencedMarketIds', () => {
  it('extracts the single id from SetCap/SubmitCap/Reallocate* events', () => {
    for (const eventName of ['SubmitCap', 'SetCap', 'ReallocateSupply', 'ReallocateWithdraw']) {
      expect(
        referencedMarketIds(protocolEvent({ eventName, args: { id: MARKET_HEX_ID } })),
      ).toEqual([MARKET_HEX_ID]);
    }
  });

  it('extracts every id from a queue-set event', () => {
    const event = protocolEvent({
      eventName: 'SetSupplyQueue',
      args: { newSupplyQueue: [MARKET_HEX_ID, '0xbbbb'] },
    });
    expect(referencedMarketIds(event)).toEqual([MARKET_HEX_ID, '0xbbbb']);
  });

  it('returns an empty array for an unrelated event (e.g. SetGuardian, D12s territory)', () => {
    expect(referencedMarketIds(protocolEvent({ eventName: 'SetGuardian' }))).toEqual([]);
  });
});

describe('D13 vault allocation drift', () => {
  const detector = createD13Detector();

  it('emits watch on a SetCap allocation event', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          marketId: 'morpho-vault:base:0xVAULT',
          governanceEvents: [protocolEvent({ eventName: 'SetCap', args: { id: MARKET_HEX_ID } })],
        }),
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({
      detectorId: D13_ID,
      family: 'governance',
      subject: { kind: 'vault', id: 'morpho-vault:base:0xVAULT' },
      severity: 'watch',
    });
  });

  it('escalates to danger when the referenced market already has a collateral-family signal', () => {
    const trackedMarketId = `morpho-blue:base:${MARKET_HEX_ID}`;
    const ctx = detectorContext({
      markets: [
        marketContext({
          marketId: 'morpho-vault:base:0xVAULT',
          governanceEvents: [protocolEvent({ eventName: 'SetCap', args: { id: MARKET_HEX_ID } })],
        }),
        marketContext({ marketId: trackedMarketId }),
      ],
      priorSignals: [
        {
          detectorId: 'D11_bad_debt',
          family: 'collateral',
          subject: { kind: 'market', id: trackedMarketId },
          severity: 'critical',
          value: 1,
          threshold: 1,
          evidence: {},
        },
      ],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.severity).toBe('danger');
  });

  it('stays at watch when the referenced market is tracked but has no collateral signal (false-positive guard)', () => {
    const trackedMarketId = `morpho-blue:base:${MARKET_HEX_ID}`;
    const ctx = detectorContext({
      markets: [
        marketContext({
          marketId: 'morpho-vault:base:0xVAULT',
          governanceEvents: [protocolEvent({ eventName: 'SetCap', args: { id: MARKET_HEX_ID } })],
        }),
        marketContext({ marketId: trackedMarketId }),
      ],
      priorSignals: [],
    });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.severity).toBe('watch');
  });

  it('emits no signal for non-allocation governance events on the vault', () => {
    const ctx = detectorContext({
      markets: [marketContext({ governanceEvents: [protocolEvent({ eventName: 'SetGuardian' })] })],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits one signal per referenced market in a queue-set event', () => {
    const ctx = detectorContext({
      markets: [
        marketContext({
          governanceEvents: [
            protocolEvent({
              eventName: 'SetSupplyQueue',
              args: { newSupplyQueue: [MARKET_HEX_ID, '0xbbbb'] },
            }),
          ],
        }),
      ],
    });
    expect(detector.evaluate(ctx)).toHaveLength(2);
  });
});
