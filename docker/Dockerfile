# Sentinel container image (docs/SPEC.md §9 Phase 9). Build context is the repo root
# (`docker build -f docker/Dockerfile .`, or `docker compose -f docker/docker-compose.yml
# build`), since the build needs package.json/pnpm-lock.yaml/src at the repo root.
#
# Three stages: install everything (deps), compile TypeScript and strip
# devDependencies back out with `pnpm prune --prod` (build), then copy only the
# compiled output and production node_modules into a fresh, smaller runtime image —
# keeps typescript/vitest/eslint and friends out of what actually runs in production.

FROM node:22-bookworm-slim AS deps
# build-essential/python3: better-sqlite3 falls back to compiling its native addon
# from source if no prebuilt binary matches this exact node/arch/libc combination —
# safe to keep even when a prebuild is used (postinstall just skips the compile step).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# package.json's "prepare" script (scripts/install-git-hooks.sh) runs during install;
# it no-ops cleanly here since there's no .git in the build context (.dockerignore).
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
RUN corepack enable \
    && groupadd --system sentinel \
    && useradd --system --gid sentinel --home-dir /app --shell /usr/sbin/nologin sentinel
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config/sentinel.example.yaml ./config/sentinel.example.yaml

# /data holds the SQLite database (and its WAL/SHM siblings) and backups — mount a
# volume here so it survives container recreation (docs/RUNBOOK.md).
RUN mkdir -p /data /app/reports /app/backups && chown -R sentinel:sentinel /app /data
USER sentinel

ENV NODE_ENV=production
# Matches config/sentinel.example.yaml's ops.metricsPort default — override both
# together if you change one.
EXPOSE 9469

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["watch", "--config", "/app/config/sentinel.yaml", "--db", "/data/sentinel.sqlite"]
