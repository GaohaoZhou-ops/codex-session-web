#!/usr/bin/env bash
set -euo pipefail

READER_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
umask 077
mkdir -p -- "$READER_ROOT/.run"
exec flock --close --wait 30 "$READER_ROOT/.run/control.lock" \
  node "$READER_ROOT/scripts/service.mjs" status "$@"
