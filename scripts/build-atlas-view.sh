#!/usr/bin/env bash
# Build the viewer as one executable: ./atlas-view <server.sqlite>
# Usage: scripts/build-atlas-view.sh [outfile]   (default: ./atlas-view; --target=... is passed through)
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-atlas-view}"
shift || true
bun build --compile --minify "$@" bin/atlas-view.ts --outfile "$out"
ls -lh "$out"
