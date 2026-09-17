#!/usr/bin/env bash
# Points git at the repo's tracked hooks (.githooks/), so the pre-commit secret scan
# runs for every contributor without needing a separate hook-manager dependency.
# `pnpm install`'s "prepare" lifecycle script runs this unconditionally, including in
# contexts with no .git at all (a Docker build — docker/Dockerfile's build context
# deliberately excludes .git via .dockerignore; a tarball install) — a no-op there,
# not an error, since there's nothing to configure.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ ! -d .git ]; then
  echo "no .git directory found (not a git checkout) — skipping git hooks install"
  exit 0
fi
git config core.hooksPath .githooks
echo "git hooks installed (core.hooksPath = .githooks)"
