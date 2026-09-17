# Deployment

Two ways to run Sentinel in production; pick one. Both are covered in more detail,
including day-to-day operation and incident response, in `docs/RUNBOOK.md`.

## Docker (recommended)

```
cp .env.example .env        # fill in real RPC URLs / bot tokens
cp config/sentinel.example.yaml config/sentinel.yaml   # fill in your real Safe, etc.
docker compose -f docker/docker-compose.yml --env-file ../.env build
docker compose -f docker/docker-compose.yml --env-file ../.env up -d
docker compose -f docker/docker-compose.yml logs -f
```

The database, reports, and backups live in named Docker volumes
(`sentinel-data`/`sentinel-reports`/`sentinel-backups`), so they survive
`docker compose down` (but not `docker compose down -v`).

Backups aren't scheduled automatically — Compose has no built-in cron. Run one
on-demand:

```
docker compose -f docker/docker-compose.yml run --rm sentinel-backup
```

and schedule that same command from host cron or a systemd timer for regular backups.

## systemd (no Docker)

See `docker/systemd/sentinel.service`'s header comment for the full install steps —
build once with `pnpm build`, then run the compiled `dist/cli/index.js` directly as a
dedicated `sentinel` system user. `docker/systemd/sentinel-backup.service` +
`.timer` give you the same daily-backup schedule Docker doesn't provide out of the box.

## Notes that apply to both

- **Metrics/health** (`GET /health`, `GET /metrics`, `src/ops/health-server.ts`) bind
  to `config.ops.metricsHost`, which defaults to `127.0.0.1` — not reachable from
  outside the container/host at all by default (docs/THREAT_MODEL.md §1). Widen it
  deliberately if you're scraping from elsewhere on the same machine or network.
- **Graceful shutdown**: `SIGTERM` stops the poll loop after the in-flight iteration
  finishes and closes the database cleanly (`src/cli/watch.ts`). Both the Compose
  service (`stop_grace_period`) and the systemd unit (`TimeoutStopSec`) give it 30s
  before a hard kill.
- **Resume after a restart is automatic** — `src/chain/block-source.ts`'s
  `LiveBlockSource` resumes from the last block it recorded processing
  (`ChainStateRepository`, SQLite) and walks forward to catch up, so a restart never
  loses or skips blocks; there's nothing separate to run.
- **Never** put real secrets (RPC keys, bot tokens, the live-execution bot's private
  key) in `docker-compose.yml`, the systemd unit, or any file under `config/` — they
  come only from `.env` / `/etc/sentinel/sentinel.env` (safety rule 1,
  `docs/SPEC.md` §2).
