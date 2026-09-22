import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';

import { buildSignedOrder, orderStructHash } from '../../../src/polymarket/eip712.js';
import {
  CTF_EXCHANGE_V2,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  NEG_RISK_CTF_EXCHANGE_V2,
  ORDER_EIP712_TYPES,
  POLYGON_CHAIN_ID,
  SIGNATURE_TYPE_EOA,
} from '../../../src/polymarket/constants.js';

// A throwaway test-only private key (freshly generated for this test file,
// never a real/funded account) — never a real signing key.
const TEST_PRIVATE_KEY = '0x9c7bdea98d189da26c52932d09cec3020ec7132a3ff7a3d715ece84b0d65c9d4';
const account = privateKeyToAccount(TEST_PRIVATE_KEY);

describe('buildSignedOrder', () => {
  it('produces a signature that recovers back to the signer address', async () => {
    const order = await buildSignedOrder(account, {
      maker: account.address,
      tokenId: '123456789',
      makerAmount: 1_000_000n,
      takerAmount: 500_000n,
      side: 'SELL',
      negRisk: false,
    });

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: EIP712_DOMAIN_NAME,
        version: EIP712_DOMAIN_VERSION,
        chainId: POLYGON_CHAIN_ID,
        verifyingContract: CTF_EXCHANGE_V2,
      },
      types: ORDER_EIP712_TYPES,
      primaryType: 'Order',
      message: {
        salt: BigInt(order.salt),
        maker: order.maker,
        signer: order.signer,
        tokenId: BigInt(order.tokenId),
        makerAmount: BigInt(order.makerAmount),
        takerAmount: BigInt(order.takerAmount),
        side: order.side,
        signatureType: order.signatureType,
        timestamp: BigInt(order.timestamp),
        metadata: order.metadata,
        builder: order.builder,
      },
      signature: order.signature,
    });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('signs SELL as 1 and BUY as 0, per the real Side enum', async () => {
    const sell = await buildSignedOrder(account, {
      maker: account.address,
      tokenId: '1',
      makerAmount: 1n,
      takerAmount: 1n,
      side: 'SELL',
      negRisk: false,
    });
    const buy = await buildSignedOrder(account, {
      maker: account.address,
      tokenId: '1',
      makerAmount: 1n,
      takerAmount: 1n,
      side: 'BUY',
      negRisk: false,
    });
    expect(sell.side).toBe(1);
    expect(buy.side).toBe(0);
  });

  it('always signs with signatureType EOA (0) — this bot never uses a proxy/Safe wallet', async () => {
    const order = await buildSignedOrder(account, {
      maker: account.address,
      tokenId: '1',
      makerAmount: 1n,
      takerAmount: 1n,
      side: 'SELL',
      negRisk: false,
    });
    expect(order.signatureType).toBe(SIGNATURE_TYPE_EOA);
  });

  it('generates a different salt on every call', async () => {
    const a = await buildSignedOrder(account, {
      maker: account.address,
      tokenId: '1',
      makerAmount: 1n,
      takerAmount: 1n,
      side: 'SELL',
      negRisk: false,
    });
    const b = await buildSignedOrder(account, {
      maker: account.address,
      tokenId: '1',
      makerAmount: 1n,
      takerAmount: 1n,
      side: 'SELL',
      negRisk: false,
    });
    expect(a.salt).not.toBe(b.salt);
    expect(a.signature).not.toBe(b.signature);
  });
});

describe('orderStructHash', () => {
  const baseMessage = {
    salt: 1n,
    maker: account.address,
    signer: account.address,
    tokenId: 1n,
    makerAmount: 1n,
    takerAmount: 1n,
    side: 1 as const,
    signatureType: 0,
    timestamp: 1n,
    metadata: `0x${'0'.repeat(64)}` as const,
    builder: `0x${'0'.repeat(64)}` as const,
  };

  it('produces a different hash for a regular market vs. a neg-risk market (different verifyingContract)', () => {
    const regular = orderStructHash(baseMessage, false);
    const negRisk = orderStructHash(baseMessage, true);
    expect(regular).not.toBe(negRisk);
  });

  it('is deterministic for the same message and market type', () => {
    expect(orderStructHash(baseMessage, false)).toBe(orderStructHash(baseMessage, false));
  });
});

describe('exchange addresses', () => {
  it('routes neg-risk markets to the neg-risk exchange, others to the standard one', () => {
    expect(CTF_EXCHANGE_V2).not.toBe(NEG_RISK_CTF_EXCHANGE_V2);
  });

  it('signs a negRisk order against the neg-risk exchange contract, not the standard one', async () => {
    const order = await buildSignedOrder(account, {
      maker: account.address,
      tokenId: '1',
      makerAmount: 1n,
      takerAmount: 1n,
      side: 'SELL',
      negRisk: true,
    });

    // A signature valid against the standard exchange's domain would NOT recover
    // to the signer if the order was actually signed against the neg-risk
    // domain (different verifyingContract -> different EIP-712 hash) — this
    // would surface as a silently-invalid order on-chain if ever gotten wrong.
    const recoveredAgainstWrongDomain = await recoverTypedDataAddress({
      domain: {
        name: EIP712_DOMAIN_NAME,
        version: EIP712_DOMAIN_VERSION,
        chainId: POLYGON_CHAIN_ID,
        verifyingContract: CTF_EXCHANGE_V2, // wrong on purpose
      },
      types: ORDER_EIP712_TYPES,
      primaryType: 'Order',
      message: {
        salt: BigInt(order.salt),
        maker: order.maker,
        signer: order.signer,
        tokenId: BigInt(order.tokenId),
        makerAmount: BigInt(order.makerAmount),
        takerAmount: BigInt(order.takerAmount),
        side: order.side,
        signatureType: order.signatureType,
        timestamp: BigInt(order.timestamp),
        metadata: order.metadata,
        builder: order.builder,
      },
      signature: order.signature,
    });
    expect(recoveredAgainstWrongDomain.toLowerCase()).not.toBe(account.address.toLowerCase());

    const recoveredAgainstRightDomain = await recoverTypedDataAddress({
      domain: {
        name: EIP712_DOMAIN_NAME,
        version: EIP712_DOMAIN_VERSION,
        chainId: POLYGON_CHAIN_ID,
        verifyingContract: NEG_RISK_CTF_EXCHANGE_V2,
      },
      types: ORDER_EIP712_TYPES,
      primaryType: 'Order',
      message: {
        salt: BigInt(order.salt),
        maker: order.maker,
        signer: order.signer,
        tokenId: BigInt(order.tokenId),
        makerAmount: BigInt(order.makerAmount),
        takerAmount: BigInt(order.takerAmount),
        side: order.side,
        signatureType: order.signatureType,
        timestamp: BigInt(order.timestamp),
        metadata: order.metadata,
        builder: order.builder,
      },
      signature: order.signature,
    });
    expect(recoveredAgainstRightDomain.toLowerCase()).toBe(account.address.toLowerCase());
  });
});
