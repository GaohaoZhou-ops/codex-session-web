#!/usr/bin/env bash
set -euo pipefail

READER_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
umask 077
mkdir -p -- "$READER_ROOT/.run"

# Keep one lock inode across invocations, including concurrent cold starts.
# The server spawned by Node inherits only its explicitly configured stdio.
case "$(uname -s)" in
  Darwin)
    exec /usr/bin/lockf -k -t 30 "$READER_ROOT/.run/control.lock" \
      node "$READER_ROOT/scripts/service.mjs" "$@"
    ;;
  Linux)
    if ! command -v flock >/dev/null 2>&1; then
      printf '缺少 flock，请在 WSL 中安装 util-linux 后重试。\n' >&2
      exit 1
    fi
    exec flock --close --wait 30 "$READER_ROOT/.run/control.lock" \
      node "$READER_ROOT/scripts/service.mjs" "$@"
    ;;
  *)
    printf '服务管理脚本目前仅支持 WSL 和 macOS。\n' >&2
    exit 1
    ;;
esac
