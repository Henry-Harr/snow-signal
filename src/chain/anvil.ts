import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Spawns a local `anvil` fork (Foundry) and waits until it answers RPC calls.
 * Production code, not a test helper — CLAUDE.md safety rule 2 requires every
 * signing code path to run only against a local Anvil fork, so the paper executor
 * and daily exit drill (`src/actions/**`) spawn real forks through this module, the
 * same way the fork integration test suite already does
 * (`test/integration/helpers/anvil.ts` re-exports this exact implementation, so
 * there's one spawn/wait/stop implementation, not two).
 *
 * `forkBlockNumber` omitted forks the chain's current head — used by the daily exit
 * drill ("fork the latest block," spec §8.6); a fixed value pins to a specific block
 * — used by fork integration tests (deterministic, reproducible) and by paper-mode
 * simulation of a specific already-confirmed block.
 */
export interface AnvilFork {
  rpcUrl: string;
  process: ChildProcess;
  stop: () => Promise<void>;
}

export async function startAnvilFork(options: {
  forkUrl: string;
  forkBlockNumber?: bigint;
  port?: number;
}): Promise<AnvilFork> {
  const port = options.port ?? 8500 + Math.floor(Math.random() * 500);
  const rpcUrl = `http://127.0.0.1:${port}`;

  const args = ['--fork-url', options.forkUrl, '--port', String(port), '--silent'];
  if (options.forkBlockNumber !== undefined) {
    args.push('--fork-block-number', options.forkBlockNumber.toString());
  }

  const child = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let exitedEarly: string | undefined;
  child.once('exit', (code) => {
    if (code !== 0 && code !== null)
      exitedEarly = `anvil exited early with code ${code}: ${stderr}`;
  });

  await waitForRpc(rpcUrl, () => exitedEarly);

  return {
    rpcUrl,
    process: child,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

async function waitForRpc(url: string, exitedEarly: () => string | undefined, maxWaitMs = 30_000) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const failure = exitedEarly();
    if (failure) throw new Error(failure);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      if (response.ok) return;
    } catch {
      // anvil not listening yet — retry
    }
    if (Date.now() > deadline) throw new Error('anvil did not become ready within 30s');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
