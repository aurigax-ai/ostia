#!/bin/sh
set -eu

name=ostia
repository=aurigax-ai/ostia
checksums=SHA256SUMS
installer=resources/user-install.sh

fail() {
  echo "$name install: $1" >&2
  exit 1
}

usage() {
  cat <<USAGE
usage: install.sh [--version vX.Y.Z] [--uninstall]

Installs $name for the current user, without sudo:
  app       \${XDG_DATA_HOME:-~/.local/share}/$name/app
  command   ~/.local/bin/$name

  --version vX.Y.Z   install that release instead of the latest one
  --uninstall        remove the app, its launcher, icons and command;
                     settings and data are kept
USAGE
}

parse() {
  version=
  uninstall=0
  while [ $# -gt 0 ]; do
    case $1 in
      --version)
        [ $# -ge 2 ] || fail "--version needs a value, for example --version v0.5.10"
        version=${2#v}
        shift 2
        ;;
      --version=*)
        version=${1#--version=}
        version=${version#v}
        shift
        ;;
      --uninstall)
        uninstall=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
  done
  if [ -n "$version" ] && ! is_version "$version"; then
    fail "'$version' is not a version; use for example --version v0.5.10"
  fi
}

is_version() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found; install it and run this again"
}

check_system() {
  [ -n "${HOME:-}" ] || fail "HOME is not set"
  os=$(uname -s)
  [ "$os" = Linux ] || fail "this script installs on Linux only, and this is $os; see https://github.com/$repository#install"
  arch=$(uname -m)
  case $arch in
    x86_64 | amd64) ;;
    *) fail "only x64 builds are published, and this machine is $arch" ;;
  esac
}

locate() {
  dest=${XDG_DATA_HOME:-$HOME/.local/share}/$name/app
  releases=${OSTIA_RELEASE_DOWNLOAD_BASE_URL:-https://github.com}/$repository/releases
}

refuse_if_running() {
  [ -d "$dest" ] || return 0
  real=$(cd "$dest" && pwd -P)
  for exe in /proc/[0-9]*/exe; do
    target=$(readlink "$exe" 2>/dev/null) || continue
    case $target in
      "$real"/*) fail "$name is running from $dest; quit it and run this again" ;;
    esac
  done
}

fetch() {
  curl --fail --silent --show-error --location --proto '=https,file' --retry 3 --output "$2" "$1" ||
    fail "could not download $1"
}

sums_entry() {
  while read -r sum file; do
    file=${file#\*}
    case $file in
      "$name"-*-linux-x64.tar.gz) ;;
      *) continue ;;
    esac
    [ -z "$version" ] || [ "$file" = "$wanted" ] || continue
    printf '%s %s\n' "$sum" "$file"
    return 0
  done < "$tmp/$checksums"
  return 1
}

download() {
  if [ -n "$version" ]; then
    from=$releases/download/v$version
    wanted=$name-$version-linux-x64.tar.gz
  else
    from=$releases/latest/download
    wanted="a $name-<version>-linux-x64.tar.gz"
  fi
  fetch "$from/$checksums" "$tmp/$checksums"
  entry=$(sums_entry) || fail "$from/$checksums lists no $wanted; nothing was installed"
  expected=${entry%% *}
  archive=${entry#* }
  version=${archive#"$name"-}
  version=${version%-linux-x64.tar.gz}
  is_version "$version" || fail "$from/$checksums names an unexpected archive: $archive"
  echo "downloading $name $version"
  fetch "$releases/download/v$version/$archive" "$tmp/$archive"
  actual=$(sha256sum < "$tmp/$archive")
  actual=${actual%% *}
  [ "$actual" = "$expected" ] ||
    fail "checksum mismatch for $archive (expected $expected, got $actual); nothing was installed"
}

install_app() {
  need curl
  need tar
  need sha256sum
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/$name-install.XXXXXX")
  staged=$dest.new
  trap 'rm -rf "$tmp" "$staged"' EXIT
  trap 'exit 1' INT TERM HUP
  download
  mkdir -p "$(dirname "$dest")"
  rm -rf "$staged"
  mkdir "$staged"
  tar -xzf "$tmp/$archive" -C "$staged" --strip-components=1 --no-same-owner ||
    fail "could not extract $archive"
  [ -f "$staged/$installer" ] ||
    fail "$name $version cannot be installed by this script; pick a newer release with --version"
  sh "$staged/$installer"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "add $HOME/.local/bin to your PATH to run '$name' from a terminal" ;;
  esac
}

uninstall() {
  [ -f "$dest/$installer" ] || fail "nothing to remove: no install made by this script at $dest"
  sh "$dest/$installer" --uninstall
}

main() {
  parse "$@"
  check_system
  locate
  refuse_if_running
  if [ "$uninstall" = 1 ]; then
    uninstall
  else
    install_app
  fi
}

main "$@"
