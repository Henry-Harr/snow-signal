import { describe, expect, it } from 'vitest';

import { createD16Detector, D16_ID } from '../../../src/signals/D16_infra_health.js';
import { detectorContext, infraChainSnapshot } from './helpers.js';

describe('D16 infra health', () => {
  const detector = createD16Detector();

  it('emits no signal when everything is healthy', () => {
    const ctx = detectorContext({ infra: [infraChainSnapshot()] });
    expect(detector.evaluate(ctx)).toEqual([]);
  });

  it('emits watch at the borderline head-lag threshold', () => {
    const ctx = detectorContext({ infra: [infraChainSnapshot({ headLagBlocks: 5 })] });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({
      detectorId: D16_ID,
      family: 'infra',
      subject: { kind: 'infra', id: 'chain:1:head_lag' },
      severity: 'watch',
      standaloneCritical: false,
    });
  });

  it('emits danger for a large head lag', () => {
    const ctx = detectorContext({ infra: [infraChainSnapshot({ headLagBlocks: 25 })] });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.severity).toBe('danger');
  });

  it('emits a signal for provider disagreement', () => {
    const ctx = detectorContext({ infra: [infraChainSnapshot({ providerDisagreementCount: 1 })] });
    const [signal] = detector.evaluate(ctx);
    expect(signal?.subject.id).toBe('chain:1:provider_disagreement');
  });

  it('emits a signal for a detected reorg', () => {
    const ctx = detectorContext({ infra: [infraChainSnapshot({ reorgDepth: 2 })] });
    const [signal] = detector.evaluate(ctx);
    expect(signal).toMatchObject({ subject: { id: 'chain:1:reorg' }, severity: 'watch' });
  });

  it('emits a signal per stale source', () => {
    const ctx = detectorContext({
      infra: [
        infraChainSnapshot({
          staleSources: [
            { sourceId: 'chainlink:ethereum', ageSeconds: 400 },
            { sourceId: 'coinbase', ageSeconds: 2000 },
          ],
        }),
      ],
    });
    const signals = detector.evaluate(ctx);
    expect(signals).toHaveLength(2);
    expect(signals.find((s) => s.subject.id === 'source:chainlink:ethereum')?.severity).toBe(
      'watch',
    );
    expect(signals.find((s) => s.subject.id === 'source:coinbase')?.severity).toBe('danger');
  });

  it('never emits standaloneCritical or a critical severity, however extreme the values', () => {
    const ctx = detectorContext({
      infra: [
        infraChainSnapshot({
          headLagBlocks: 100_000,
          providerDisagreementCount: 100,
          reorgDepth: 50,
          staleSources: [{ sourceId: 'x', ageSeconds: 1_000_000 }],
        }),
      ],
    });
    const signals = detector.evaluate(ctx);
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal.severity).not.toBe('critical');
      expect(signal.standaloneCritical).toBe(false);
    }
  });

  it('does not fire on ordinary single-block noise (false-positive guard)', () => {
    const ctx = detectorContext({
      infra: [
        infraChainSnapshot({ headLagBlocks: 1, reorgDepth: 0, providerDisagreementCount: 0 }),
      ],
    });
    expect(detector.evaluate(ctx)).toEqual([]);
  });
});
