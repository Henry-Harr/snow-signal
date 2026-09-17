import { describe, expect, it } from 'vitest';

import { runLiveExecution } from '../../../src/actions/live-executor.js';
import type { Address } from '../../../src/core/types.js';

const SAFE: Address = '0x0000000000000000000000000000000000000011';
const ATTACKER: Address = '0x0000000000000000000000000000000000000022';

describe('runLiveExecution', () => {
  it('blocks a request whose recipient is not the configured Safe, before ever reading the bot key', async () => {
    const outcome = await runLiveExecution(
      {
        chain: 'ethereum',
        chainId: 1,
        liveRpcUrl: 'http://127.0.0.1:1', // unreachable — never touched, since the check below must short-circuit first
        forkSourceRpcUrl: 'http://127.0.0.1:1',
        safeAddress: SAFE,
        rolesModAddress: SAFE,
        roleKey: `0x${'0'.repeat(64)}`,
        botPrivateKeyEnvVar: 'SENTINEL_TEST_UNSET_BOT_KEY',
      },
      {
        recipient: ATTACKER,
        tx: { chainId: 1, to: SAFE, data: '0x', description: 'test' },
        assetAddress: SAFE,
        expectedAmount: 1n,
      },
    );

    expect(outcome.kind).toBe('blocked-recipient');
    if (outcome.kind !== 'blocked-recipient') throw new Error('expected blocked-recipient');
    expect(outcome.reason).toContain('is not the configured Safe');
  });
});
