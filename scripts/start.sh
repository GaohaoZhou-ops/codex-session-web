#!/usr/bin/env bash
set -euo pipefail

READER_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec bash "$READER_ROOT/scripts/control.sh" start "$@"
