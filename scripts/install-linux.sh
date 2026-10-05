#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="$(node -p "require('$root/package.json').name")"
exe=ostia
unpacked="$root/dist/linux-unpacked"
data_name=ostia
old_name=pine
dest="${XDG_DATA_HOME:-$HOME/.local/share}/$data_name/app"
old_dest="${XDG_DATA_HOME:-$HOME/.local/share}/$old_name/app"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

if [ ! -x "$unpacked/$exe" ]; then
  echo "no packaged build at $unpacked; run: pnpm package" >&2
  exit 1
fi

rm -rf "$dest.new"
mkdir -p "$(dirname "$dest")" "$apps"
cp -a "$unpacked" "$dest.new"
rm -rf "$dest"
mv "$dest.new" "$dest"
if [ -x "$old_dest/$old_name" ]; then
  rm -rf "$old_dest"
  rmdir "$(dirname "$old_dest")" 2>/dev/null || true
  rm -f "$apps/$old_name.desktop"
fi

icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
for png in "$root"/resources/icons/*x*.png; do
  size="$(basename "$png" .png)"
  mkdir -p "$icons/$size/apps"
  cp "$png" "$icons/$size/apps/$name.png"
done
mkdir -p "$icons/scalable/apps"
cp "$root/resources/icon.svg" "$icons/scalable/apps/$name.svg"
rm -f "$icons"/*/apps/"$old_name".png "$icons/scalable/apps/$old_name.svg"
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$icons" || true

cat > "$apps/$name.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$name
Comment=Terminal-first workspace for agents
Exec=$dest/$exe %U
Icon=$name
Terminal=false
Categories=Development;TerminalEmulator;
StartupWMClass=$name
DESKTOP

command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true

bin="$HOME/.local/bin"
cli=ostia
mkdir -p "$bin"
cat > "$bin/$cli" <<LAUNCHER
#!/bin/sh
export OSTIA_APP_BIN='$dest/$exe'
ELECTRON_RUN_AS_NODE=1 exec "\$OSTIA_APP_BIN" '$dest/resources/app.asar/out/cli/index.js' "\$@"
LAUNCHER
chmod 755 "$bin/$cli"
if [ -L "$bin/$old_name" ] || grep -qs "/$old_name/app/" "$bin/$old_name"; then
  rm -f "$bin/$old_name"
fi
echo "installed $name to $dest"
echo "launcher: $apps/$name.desktop"
echo "cli: $bin/$cli (run '$cli <agent>' from a terminal outside the app)"
