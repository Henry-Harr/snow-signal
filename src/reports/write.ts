import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DailyReport } from './types.js';

/** Writes a generated report to `reports/YYYY-MM-DD.{md,json}` (docs/SPEC.md #10.2)
 * — `reports/` is git-ignored (spec §5.2), created here if it doesn't exist yet. */
export function writeDailyReport(
  report: DailyReport,
  date: string,
  reportsDir: string,
): { mdPath: string; jsonPath: string } {
  mkdirSync(reportsDir, { recursive: true });
  const mdPath = join(reportsDir, `${date}.md`);
  const jsonPath = join(reportsDir, `${date}.json`);
  writeFileSync(mdPath, report.markdown, 'utf-8');
  writeFileSync(jsonPath, JSON.stringify(report.json, null, 2), 'utf-8');
  return { mdPath, jsonPath };
}
