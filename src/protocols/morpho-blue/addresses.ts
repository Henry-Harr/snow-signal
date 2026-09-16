import type { Address } from '../../core/types.js';

/**
 * The Morpho Blue singleton contract. Safety rule 6 (docs/SPEC.md #2): verified
 * directly against Morpho's own GraphQL API (`api.morpho.org/graphql`, a `markets`
 * query filtered per chain, reading each result's `morphoBlue.address`) on
 * 2026-09-16 — the same address on both Ethereum and Base, resolving the "could not
 * confirm" flag left in docs/SOURCES.md by an earlier session (CREATE2-deterministic
 * deployment, as that session's third-party sources claimed but couldn't verify
 * directly at the time).
 */
export const MORPHO_BLUE_ADDRESS: Record<string, Address> = {
  ethereum: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  base: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
};

export function resolveMorphoBlueAddress(chain: string): Address {
  const address = MORPHO_BLUE_ADDRESS[chain];
  if (!address) {
    throw new Error(`No known Morpho Blue address for chain=${chain}`);
  }
  return address;
}
