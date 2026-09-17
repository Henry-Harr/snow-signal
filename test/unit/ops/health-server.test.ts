import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { startHealthServer } from '../../../src/ops/health-server.js';
import { blocksProcessedTotal } from '../../../src/ops/metrics.js';

/**
 * `startHealthServer` (`src/ops/health-server.ts`, docs/SPEC.md §9 Phase 9) is the
 * only place `GET /health`/`GET /metrics` are actually served — this test drives it
 * with real HTTP requests rather than just reading the code. `port: 0` asks the OS
 * for an ephemeral free port, so this test can't collide with another test or a real
 * running `sentinel watch` on the default port 9469.
 */
function listeningPort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.on('listening', () => resolve((server.address() as AddressInfo).port));
  });
}

describe('startHealthServer', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('serves GET /health as 200 {status: "ok"}', async () => {
    server = startHealthServer({ port: 0 });
    const port = await listeningPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('serves GET /metrics in Prometheus text format, including our own metrics', async () => {
    server = startHealthServer({ port: 0 });
    const port = await listeningPort(server);
    blocksProcessedTotal.inc({ chain: 'health-server-test' });

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('sentinel_blocks_processed_total');
    expect(body).toContain('chain="health-server-test"');
  });

  it('returns 404 for an unknown path', async () => {
    server = startHealthServer({ port: 0 });
    const port = await listeningPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it('returns 405 for a non-GET method', async () => {
    server = startHealthServer({ port: 0 });
    const port = await listeningPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
