#!/usr/bin/env bash
set -euo pipefail

SESSION_ARCHIVE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SESSION_DAY="$(date +%F)"
umask 077
if [[ -L "$SESSION_ARCHIVE/$SESSION_DAY" ]]; then
  printf '当天目录不能是符号链接：%s\n' "$SESSION_ARCHIVE/$SESSION_DAY" >&2
  exit 1
fi
mkdir -p -- "$SESSION_ARCHIVE/$SESSION_DAY"
printf '%s\n' "$SESSION_DAY"
