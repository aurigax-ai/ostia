#!/bin/sh
set -eu

name=ostia
exe=ostia

locate() {
  here=$(cd "$(dirname "$0")" && pwd -P)
  src=$(dirname "$here")
  data=${XDG_DATA_HOME:-$HOME/.local/share}
  dest=$data/$name/app
  apps=$data/applications
  icons=$data/icons/hicolor
  bin=$HOME/.local/bin
}

physical() {
  (cd "$1" 2>/dev/null && pwd -P) || true
}

refresh_caches() {
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t "$icons" 2>/dev/null || true
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$apps" 2>/dev/null || true
  fi
}

place_app() {
  if [ ! -x "$src/$exe" ]; then
    echo "no app at $src" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dest")"
  if [ "$src" != "$(physical "$dest.new")" ]; then
    rm -rf "$dest.new"
    cp -a "$src" "$dest.new"
  fi
  rm -rf "$dest.old"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    mv "$dest" "$dest.old"
  fi
  mv "$dest.new" "$dest"
  rm -rf "$dest.old"
}

place_icons() {
  for png in "$dest"/resources/icons/*x*.png; do
    size=$(basename "$png" .png)
    mkdir -p "$icons/$size/apps"
    cp "$png" "$icons/$size/apps/$name.png"
  done
  mkdir -p "$icons/scalable/apps"
  cp "$dest/resources/icon.svg" "$icons/scalable/apps/$name.svg"
}

place_desktop_entry() {
  mkdir -p "$apps"
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
}

place_cli() {
  mkdir -p "$bin"
  cat > "$bin/$name" <<LAUNCHER
#!/bin/sh
export OSTIA_APP_BIN='$dest/$exe'
ELECTRON_RUN_AS_NODE=1 exec "\$OSTIA_APP_BIN" '$dest/resources/app.asar/out/cli/index.js' "\$@"
LAUNCHER
  chmod 755 "$bin/$name"
}

install_app() {
  place_app
  place_icons
  place_desktop_entry
  place_cli
  refresh_caches
  echo "installed $name to $dest"
  echo "launcher: $apps/$name.desktop"
  echo "cli: $bin/$name (run '$name <agent>' from a terminal outside the app)"
}

uninstall() {
  if [ "$src" != "$(physical "$dest")" ]; then
    echo "$src is not the installed app ($dest)" >&2
    exit 1
  fi
  for png in "$dest"/resources/icons/*x*.png; do
    rm -f "$icons/$(basename "$png" .png)/apps/$name.png"
  done
  rm -f "$icons/scalable/apps/$name.svg" "$apps/$name.desktop"
  if grep -qsF "'$dest/$exe'" "$bin/$name"; then
    rm -f "$bin/$name"
  fi
  rm -rf "$dest" "$dest.new" "$dest.old"
  rmdir "$(dirname "$dest")" 2>/dev/null || true
  refresh_caches
  echo "removed $name from $dest"
  echo "settings and data were kept"
}

main() {
  locate
  case ${1:-} in
    '') install_app ;;
    --uninstall) uninstall ;;
    *)
      echo "usage: $0 [--uninstall]" >&2
      exit 2
      ;;
  esac
}

main "$@"
