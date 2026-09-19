import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/storage/migrations.js';
import { LiquidationOpportunityRepository } from '../../../src/storage/liquidation-opportunity-repository.js';
import type { LiquidationOpportunity } from '../../../src/liquidations/types.js';

describe('LiquidationOpportunityRepository', () => {
  let repo: LiquidationOpportunityRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new LiquidationOpportunityRepository(db);
  });

  function opportunity(overrides: Partial<LiquidationOpportunity> = {}): LiquidationOpportunity {
    return {
      chain: 'ethereum',
      market: 'core',
      user: '0x1111111111111111111111111111111111111111',
      atBlock: 26_000_000n,
      atTimestamp: 1_789_000_000,
      healthFactor: 900_000_000_000_000_000n,
      debtAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      debtSymbol: 'USDC',
      debtToCoverBase: 50_000_000_000n,
      collateralAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      collateralSymbol: 'WETH',
      collateralSeizedBase: 52_500_000_000n,
      liquidationBonus: 0.05,
      grossProfitBase: 2_500_000_000n,
      ...overrides,
    };
  }

  it('records and reads back an opportunity with all bigint fields intact', () => {
    repo.record(opportunity());
    const [record] = repo.findRecent();
    expect(record).toMatchObject(opportunity());
    expect(record?.id).toBeTypeOf('number');
  });

  it('returns the most recent opportunities first', () => {
    repo.record(opportunity({ user: '0x1111111111111111111111111111111111111111', atTimestamp: 1_000 }));
    repo.record(opportunity({ user: '0x2222222222222222222222222222222222222222', atTimestamp: 2_000 }));

    const records = repo.findRecent();
    expect(records[0]?.user).toBe('0x2222222222222222222222222222222222222222');
    expect(records[1]?.user).toBe('0x1111111111111111111111111111111111111111');
  });
});
