import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Spawns a local `anvil` fork (Foundry) pinned to a specific block and waits until it
 * answers RPC calls. Fork integration tests run adapters against this local fork
 * rather than the live public RPC directly, so runs are deterministic (always the
 * same pinned block) and don't burn the configured provider's rate limit on every
 * test run.
 *
 * This is a read-only fork used for read-only adapter tests — nothing here signs or
 * broadcasts a transaction (safety rules 2–3, docs/SPEC.md #2 — those rules are about
 * *execution*, which doesn't exist yet; Phase 2 has nothing to sign).
 */
export interface AnvilFork {
  rpcUrl: string;
  process: ChildProcess;
  stop: () => Promise<void>;
}

export async function startAnvilFork(options: {
  forkUrl: string;
  forkBlockNumber: bigint;
  port?: number;
}): Promise<AnvilFork> {
  const port = options.port ?? 8500 + Math.floor(Math.random() * 500);
  const rpcUrl = `http://127.0.0.1:${port}`;

  const child = spawn(
    'anvil',
    [
      '--fork-url',
      options.forkUrl,
      '--fork-block-number',
      options.forkBlockNumber.toString(),
      '--port',
      String(port),
      '--silent',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

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
