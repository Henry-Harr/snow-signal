/**
 * Everything downstream of the pipeline entry point reads time through this interface,
 * never `Date.now()` directly (docs/ARCHITECTURE.md #2) — that's what lets the replay
 * harness (Phase 6) run the exact same code against historical timestamps.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Deterministic clock for tests and replay: advances only when told to. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  set(date: Date): void {
    this.current = date;
  }
}
