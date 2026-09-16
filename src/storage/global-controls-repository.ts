import type { SentinelDatabase } from './db.js';

const KILL_SWITCH_KEY = 'kill_switch_active';

/** System-wide controls (docs/SPEC.md #8.4) — today just the kill switch. A tiny
 * key/value table (migration 8) rather than a single-row table, so a future global
 * flag doesn't need its own migration. */
export class GlobalControlsRepository {
  constructor(private readonly db: SentinelDatabase) {}

  isKillSwitchActive(): boolean {
    const row = this.db
      .prepare(`SELECT value FROM global_controls WHERE key = ?`)
      .get(KILL_SWITCH_KEY) as { value: string } | undefined;
    return row?.value === '1';
  }

  activateKillSwitch(now: Date): void {
    this.setKillSwitch(true, now);
  }

  /** Per spec §8.4 ("re-enabling requires the CLI with an explicit confirmation")
   * and docs/adr/0008, this repository method is the mechanism, not the policy — it
   * applies the change unconditionally. Enforcing "explicit confirmation" is the
   * caller's job (the Phase 8 `sentinel resume --confirm` CLI command, once a live
   * executor exists for the switch to gate); nothing in Phase 5 calls this. */
  deactivateKillSwitch(now: Date): void {
    this.setKillSwitch(false, now);
  }

  private setKillSwitch(active: boolean, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO global_controls (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KILL_SWITCH_KEY, active ? '1' : '0', now.toISOString());
  }
}
