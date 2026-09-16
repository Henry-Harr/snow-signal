import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeDailyReport } from '../../../src/reports/write.js';
import { generateDailyReport } from '../../../src/reports/daily-report.js';
import { dataQuality, position } from './helpers.js';

describe('writeDailyReport', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sentinel-reports-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the reports directory and writes both .md and .json files', () => {
    const report = generateDailyReport({
      date: '2026-01-01',
      generatedAt: new Date('2026-01-02T00:00:00Z'),
      positions: [position()],
      decisions: [],
      labels: new Map(),
      dataQuality: [dataQuality()],
      exitDrillResults: [],
      gasSpentWei: 0n,
    });

    const nestedDir = join(dir, 'reports');
    const { mdPath, jsonPath } = writeDailyReport(report, '2026-01-01', nestedDir);

    expect(mdPath).toBe(join(nestedDir, '2026-01-01.md'));
    expect(jsonPath).toBe(join(nestedDir, '2026-01-01.json'));
    expect(readFileSync(mdPath, 'utf-8')).toContain('# Daily report — 2026-01-01');
    expect(JSON.parse(readFileSync(jsonPath, 'utf-8'))).toMatchObject({ date: '2026-01-01' });
  });
});
