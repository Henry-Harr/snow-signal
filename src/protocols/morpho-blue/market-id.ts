import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';

import type { Address } from '../../core/types.js';

export interface MorphoMarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

const MARKET_PARAMS_TYPES = parseAbiParameters('address,address,address,address,uint256');

/**
 * Reproduces Morpho Blue's `MarketParamsLib.id()`: `keccak256(marketParams,
 * MARKET_PARAMS_BYTES_LENGTH)`, i.e. keccak256 of the struct's 160-byte in-memory
 * encoding — identical to `keccak256(abi.encode(...))` of its five static fields,
 * since Solidity's memory layout for a struct of only static-size fields matches
 * `abi.encode`'s word-per-field packing exactly.
 *
 * Source: https://github.com/morpho-org/morpho-blue/blob/main/src/libraries/MarketParamsLib.sol
 */
export function computeMorphoMarketId(params: MorphoMarketParams): `0x${string}` {
  const encoded = encodeAbiParameters(MARKET_PARAMS_TYPES, [
    params.loanToken,
    params.collateralToken,
    params.oracle,
    params.irm,
    params.lltv,
  ]);
  return keccak256(encoded);
}
