#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unpacked="$root/dist/linux-unpacked"
old_name=pine
data="${XDG_DATA_HOME:-$HOME/.local/share}"
old_dest="$data/$old_name/app"
apps="$data/applications"
icons="$data/icons/hicolor"
bin="$HOME/.local/bin"

if [ ! -x "$unpacked/ostia" ]; then
  echo "no packaged build at $unpacked; run: pnpm package" >&2
  exit 1
fi

sh "$unpacked/resources/user-install.sh"

if [ -x "$old_dest/$old_name" ]; then
  rm -rf "$old_dest"
  rmdir "$(dirname "$old_dest")" 2>/dev/null || true
  rm -f "$apps/$old_name.desktop"
fi
rm -f "$icons"/*/apps/"$old_name".png "$icons/scalable/apps/$old_name.svg"
if [ -L "$bin/$old_name" ] || grep -qs "/$old_name/app/" "$bin/$old_name"; then
  rm -f "$bin/$old_name"
fi
