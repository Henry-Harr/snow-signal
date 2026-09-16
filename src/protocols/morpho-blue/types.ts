import { z } from 'zod';

import type { Address } from '../../core/types.js';

function addressSchema() {
  return z.string().regex(/^0x[a-fA-F0-9]{40}$/) as unknown as z.ZodType<Address>;
}

export function bytes32Schema() {
  return z.string().regex(/^0x[a-fA-F0-9]{64}$/) as unknown as z.ZodType<`0x${string}`>;
}

const nonNegativeBigint = z.bigint().nonnegative();

/** `Market` struct field order (src/interfaces/IMorpho.sol, verified 2026-09-16).
 * Shared between the Morpho Blue adapter and the Morpho vault adapter, which reads
 * the same struct for every market a watched vault allocates into. */
export const marketSchema = z.object({
  totalSupplyAssets: nonNegativeBigint,
  totalSupplyShares: nonNegativeBigint,
  totalBorrowAssets: nonNegativeBigint,
  totalBorrowShares: nonNegativeBigint,
  lastUpdate: nonNegativeBigint,
  fee: nonNegativeBigint,
});
export type MarketData = z.infer<typeof marketSchema>;

/** `MarketParams` struct field order, same source. */
export const marketParamsSchema = z.object({
  loanToken: addressSchema(),
  collateralToken: addressSchema(),
  oracle: addressSchema(),
  irm: addressSchema(),
  lltv: nonNegativeBigint,
});
export type MarketParamsData = z.infer<typeof marketParamsSchema>;

// Unlike `market`/`idToMarketParams` (each a single named struct return, which viem
// decodes to a plain object), `position` is declared in the ABI as three separate
// top-level named outputs (matching the multi-output pattern in
// src/protocols/aave-v3/abi.ts) — viem decodes that shape as a positional tuple, not
// an object, confirmed directly against a real fork call (2026-09-16). Same
// ABI-encoded bytes either way (all fields are static-size), just a different
// decoded JS shape depending on how the ABI groups the outputs.
export const positionSchema = z.tuple([nonNegativeBigint, nonNegativeBigint, nonNegativeBigint]);
