#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="$(node -p "require('$root/package.json').name")"
exe=ostia
unpacked="$root/dist/linux-unpacked"
data_name=ostia
legacy_data_name=pine
dest="${XDG_DATA_HOME:-$HOME/.local/share}/$data_name/app"
legacy_dest="${XDG_DATA_HOME:-$HOME/.local/share}/$legacy_data_name/app"
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
if [ "$legacy_dest" != "$dest" ] && [ -x "$legacy_dest/$name" ]; then
  rm -rf "$legacy_dest"
fi

icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
for png in "$root"/resources/icons/*x*.png; do
  size="$(basename "$png" .png)"
  mkdir -p "$icons/$size/apps"
  cp "$png" "$icons/$size/apps/$name.png"
done
mkdir -p "$icons/scalable/apps"
cp "$root/resources/icon.svg" "$icons/scalable/apps/$name.svg"
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
legacy_cli=pine
mkdir -p "$bin"
cat > "$bin/$cli" <<LAUNCHER
#!/bin/sh
export OSTIA_APP_BIN='$dest/$exe'
export PINE_APP_BIN="\$OSTIA_APP_BIN"
ELECTRON_RUN_AS_NODE=1 exec "\$OSTIA_APP_BIN" '$dest/resources/app.asar/out/cli/index.js' "\$@"
LAUNCHER
chmod 755 "$bin/$cli"
if [ "$legacy_cli" != "$cli" ]; then
  ln -sf "$cli" "$bin/$legacy_cli"
fi
echo "installed $name to $dest"
echo "launcher: $apps/$name.desktop"
echo "cli: $bin/$cli (run '$cli <agent>' from a terminal outside the app; '$legacy_cli' is the old name and still works)"
