import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runLabel } from '../../../src/cli/label.js';
import { openDatabase } from '../../../src/storage/db.js';
import { DecisionLabelRepository } from '../../../src/storage/decision-label-repository.js';
import { DecisionRecordRepository } from '../../../src/storage/decision-record-repository.js';
import type { Decision } from '../../../src/risk/types.js';

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-label-test-'));
  return join(dir, 'sentinel.sqlite');
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    positionId: 'aave-v3:ethereum:core:USDC',
    at: new Date('2026-01-01T00:00:00.000Z'),
    blockNumber: 1n,
    previousLevel: 'NORMAL',
    level: 'WATCH',
    rawLevel: 'WATCH',
    signals: [],
    rule: 'test',
    action: { kind: 'alert' },
    standingAlert: false,
    configHash: 'hash',
    ...overrides,
  };
}

describe('runLabel', () => {
  it('labels an existing decision and persists notes', () => {
    const dbPath = tempDbPath();
    const db = openDatabase(dbPath);
    const id = new DecisionRecordRepository(db).record(decision());
    db.close();

    const result = runLabel({ dbPath, decisionId: id, label: 'true', notes: 'a real exit' });
    expect(result).toEqual({ ok: true, positionId: 'aave-v3:ethereum:core:USDC', level: 'WATCH' });

    const db2 = openDatabase(dbPath);
    const stored = new DecisionLabelRepository(db2).get(id);
    db2.close();
    expect(stored?.label).toBe('true');
    expect(stored?.notes).toBe('a real exit');
  });

  it('overwrites a label when re-labeled (upsert)', () => {
    const dbPath = tempDbPath();
    const db = openDatabase(dbPath);
    const id = new DecisionRecordRepository(db).record(decision());
    db.close();

    runLabel({ dbPath, decisionId: id, label: 'false' });
    runLabel({ dbPath, decisionId: id, label: 'unsure', notes: 'changed my mind' });

    const db2 = openDatabase(dbPath);
    const stored = new DecisionLabelRepository(db2).get(id);
    db2.close();
    expect(stored?.label).toBe('unsure');
    expect(stored?.notes).toBe('changed my mind');
  });

  it('returns ok:false for a decision id that does not exist', () => {
    const dbPath = tempDbPath();
    const result = runLabel({ dbPath, decisionId: 999, label: 'false' });
    expect(result).toEqual({ ok: false, reason: 'No decision found with id 999.' });
  });
});
