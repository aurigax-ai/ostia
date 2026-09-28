#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="$(node -p "require('$root/package.json').name")"
unpacked="$root/dist/linux-unpacked"
dest="${XDG_DATA_HOME:-$HOME/.local/share}/$name/app"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

if [ ! -x "$unpacked/$name" ]; then
  echo "no packaged build at $unpacked; run: pnpm package" >&2
  exit 1
fi

rm -rf "$dest.new"
mkdir -p "$(dirname "$dest")" "$apps"
cp -a "$unpacked" "$dest.new"
rm -rf "$dest"
mv "$dest.new" "$dest"

cat > "$apps/$name.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$name
Comment=Terminal-first workspace for agents
Exec=$dest/$name %U
Icon=utilities-terminal
Terminal=false
Categories=Development;TerminalEmulator;
StartupWMClass=$name
DESKTOP

command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
echo "installed $name to $dest"
echo "launcher: $apps/$name.desktop"
