#!/usr/bin/env bash
# Points git at the repo's tracked hooks (.githooks/), so the pre-commit secret scan
# runs for every contributor without needing a separate hook-manager dependency.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
git config core.hooksPath .githooks
echo "git hooks installed (core.hooksPath = .githooks)"
