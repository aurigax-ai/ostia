#!/usr/bin/env bash
set -euo pipefail

action=${1:?usage: electron-headers.sh restore|publish <cache dir> <electron version>}
cache=${2:?cache dir}
version=${3:?electron version}
own="$HOME/.electron-gyp/$version"
cached="$cache/$version"

case $action in
  restore)
    [ -f "$cached/installVersion" ] || exit 1
    if [ ! -e "$own" ]; then
      mkdir -p "$(dirname "$own")"
      cp -a "$cached" "$own"
    fi
    ;;
  publish)
    [ -f "$own/installVersion" ] || {
      echo "no complete headers at $own" >&2
      exit 1
    }
    [ ! -e "$cached" ] || exit 0
    mkdir -p "$cache"
    staging=$(mktemp -d "$cache/.$version.XXXXXX")
    trap 'rm -rf "$staging"' EXIT
    cp -a "$own/." "$staging/"
    chmod 755 "$staging"
    mv -T "$staging" "$cached" 2>/dev/null || true
    ;;
  *)
    echo "unknown action: $action" >&2
    exit 2
    ;;
esac
