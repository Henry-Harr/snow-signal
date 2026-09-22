import { type Address, type Hex, hashTypedData, keccak256, toBytes } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  ORDER_EIP712_TYPES,
  ORDER_SIDE_UINT8,
  POLYGON_CHAIN_ID,
  SIGNATURE_TYPE_EOA,
  ZERO_BYTES32,
  exchangeAddressFor,
} from './constants.js';
import type { OrderSide } from '../core/types.js';

export interface UnsignedOrderInput {
  maker: Address;
  tokenId: string; // decimal uint256 string
  makerAmount: bigint;
  takerAmount: bigint;
  side: OrderSide;
  negRisk: boolean;
}

export interface SignedOrder {
  salt: string;
  maker: Address;
  signer: Address;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: 0 | 1;
  signatureType: number;
  timestamp: string;
  metadata: Hex;
  builder: Hex;
  expiration: string;
  signature: Hex;
}

/** A cryptographically random uint256, as required by the `Order` struct's
 * `salt` field ("Unique salt to ensure entropy", `Structs.sol`) — not derived
 * from anything predictable. */
function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  return salt & ((1n << 252n) - 1n); // keep well under 2^256, avoids any edge-case overflow
}

/**
 * Builds and EIP-712-signs a Polymarket V2 order, entirely offline (no network
 * call) — separated from `rest-client.ts`'s actual submission so the signature
 * construction is independently unit-testable without a live API.
 *
 * `metadata`/`builder` are set to the zero `bytes32` sentinel: no requirement
 * for a specific non-zero value was found in the sources this was verified
 * against (`src/polymarket/constants.ts`'s doc comment) — both are described as
 * associated/origin metadata a caller may optionally set, not something this
 * bot needs to populate to place a valid order.
 */
export async function buildSignedOrder(
  account: PrivateKeyAccount,
  input: UnsignedOrderInput,
): Promise<SignedOrder> {
  const message = {
    salt: randomSalt(),
    maker: input.maker,
    signer: account.address,
    tokenId: BigInt(input.tokenId),
    makerAmount: input.makerAmount,
    takerAmount: input.takerAmount,
    side: ORDER_SIDE_UINT8[input.side],
    signatureType: SIGNATURE_TYPE_EOA,
    timestamp: BigInt(Date.now()),
    metadata: ZERO_BYTES32,
    builder: ZERO_BYTES32,
  } as const;

  const domain = {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: POLYGON_CHAIN_ID,
    verifyingContract: exchangeAddressFor(input.negRisk),
  } as const;

  const signature = await account.signTypedData({
    domain,
    types: ORDER_EIP712_TYPES,
    primaryType: 'Order',
    message,
  });

  return {
    salt: message.salt.toString(),
    maker: message.maker,
    signer: message.signer,
    tokenId: message.tokenId.toString(),
    makerAmount: message.makerAmount.toString(),
    takerAmount: message.takerAmount.toString(),
    side: message.side,
    signatureType: message.signatureType,
    timestamp: message.timestamp.toString(),
    metadata: message.metadata,
    builder: message.builder,
    expiration: '0', // immediate (FAK/FOK) orders don't need a future expiration
    signature,
  };
}

/** Exposed for tests: the EIP-712 struct hash a given order message would
 * produce, independent of any signature — lets a test assert two orders that
 * should be identical except for `salt` really do hash differently, and that
 * the domain/type wiring matches `hashTypedData`'s own computation. */
export interface OrderMessage {
  salt: bigint;
  maker: Address;
  signer: Address;
  tokenId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
  side: 0 | 1;
  signatureType: number;
  timestamp: bigint;
  metadata: Hex;
  builder: Hex;
}

export function orderStructHash(message: OrderMessage, negRisk: boolean): Hex {
  return hashTypedData({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: POLYGON_CHAIN_ID,
      verifyingContract: exchangeAddressFor(negRisk),
    },
    types: ORDER_EIP712_TYPES,
    primaryType: 'Order',
    message,
  });
}

/** Not currently used by the signing path itself (viem's `hashTypedData`
 * handles this internally) — kept as a documented, independently-testable
 * building block should a future caller need the raw type hash. */
export function orderTypeHash(): Hex {
  return keccak256(
    toBytes(
      'Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)',
    ),
  );
}
