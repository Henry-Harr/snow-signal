import { randomUUID } from 'node:crypto';

/**
 * Generates a sortable, prefixed id: `<prefix>_<26-char base32 ULID-like suffix>`.
 * We don't pull in a ULID dependency for this — a millisecond timestamp prefix plus a
 * random suffix gives us "roughly sorts by creation time, globally unique, cheap"
 * without adding a package to a path (ids for alerts/decisions) that doesn't need one.
 */
export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36).padStart(9, '0');
  const random = randomUUID().replace(/-/g, '').slice(0, 16);
  return `${prefix}_${timestamp}${random}`;
}
