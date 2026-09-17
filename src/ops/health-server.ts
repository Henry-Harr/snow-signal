import { createServer, type Server } from 'node:http';
import type { Logger } from '../core/logger.js';
import { registry } from './metrics.js';

/**
 * The metrics/health HTTP server (docs/SPEC.md §9 Phase 9,
 * docs/THREAT_MODEL.md §1: "no inbound ports beyond the metrics/health endpoint
 * (bind to localhost or an internal network by default)"). Two routes only:
 *
 * - `GET /health` — liveness: 200 once the process can answer HTTP at all. Not a
 *   readiness check against live chain data (nothing here calls out to an RPC) —
 *   that's what the individual `sentinel_rpc_provider_*` metrics are for.
 * - `GET /metrics` — Prometheus text exposition format, from the shared registry
 *   (`src/ops/metrics.ts`).
 *
 * Binds to `127.0.0.1` unless explicitly told otherwise, matching the threat
 * model's own stated default — a caller passing a non-loopback `host` is making an
 * explicit, visible choice, not something this module defaults to.
 */
export interface HealthServerOptions {
  port: number;
  host?: string;
  logger?: Logger;
}

export function startHealthServer(options: HealthServerOptions): Server {
  const host = options.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ status: 'ok' }),
      );
      return;
    }
    if (req.url === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': registry.contentType }).end(body);
        })
        .catch((error: unknown) => {
          options.logger?.error({ err: error }, 'failed to render metrics');
          res.writeHead(500).end();
        });
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(options.port, host, () => {
    options.logger?.info(
      { host, port: options.port },
      'metrics/health server listening (GET /health, GET /metrics)',
    );
  });

  return server;
}
