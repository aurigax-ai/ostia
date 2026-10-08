#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unpacked="$root/dist/linux-unpacked"

if [ ! -x "$unpacked/ostia" ]; then
  echo "no packaged build at $unpacked; run: pnpm package" >&2
  exit 1
fi

sh "$unpacked/resources/user-install.sh"
