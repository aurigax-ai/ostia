#!/bin/sh
PROTOCOL=1
MAX_PAYLOAD=8388608
TAB=$(printf '\t')
NL='
'

home=${0%/*}
user_umask=$(umask)
umask 077
for stale in "$home"/run.*; do
  [ -d "$stale" ] || continue
  kill -0 "${stale##*.}" 2>/dev/null || rm -rf -- "$stale"
done
stage_dir="$home/run.$$"
rm -rf -- "$stage_dir"
mkdir -- "$stage_dir" || {
  echo "PINE-HELPER failed stage"
  exit 1
}
stage="$stage_dir/payload"
trap 'rm -rf -- "$stage_dir"' EXIT
trap 'exit 0' HUP INT TERM
umask "$user_umask"

reply() {
  printf '%s %s %s %s\n' "$1" "$2" "$3" "$4"
}

fail() {
  reply "$id" err 0 "$1"
}

size_of() {
  printf '%s\n' "$(($(wc -c <"$1")))"
}

version_of() {
  set -- $(cksum <"$1" 2>/dev/null)
  [ $# -ge 2 ] || return 1
  printf '%s-%s\n' "$1" "$2"
}

canonical_dir() {
  (CDPATH= cd -P -- "$1" 2>/dev/null && pwd -P)
}

resolve_link() {
  if command -v realpath >/dev/null 2>&1; then
    realpath -- "$1" 2>/dev/null
  elif command -v readlink >/dev/null 2>&1; then
    readlink -f -- "$1" 2>/dev/null
  else
    return 1
  fi
}

canonical() {
  if [ -d "$1" ]; then
    canonical_dir "$1"
    return
  fi
  if [ -L "$1" ]; then
    resolve_link "$1" || return 2
    return
  fi
  parent=${1%/*}
  [ -n "$parent" ] || parent=/
  parent=$(canonical_dir "$parent") || return 1
  if [ "$parent" = / ]; then
    printf '/%s\n' "${1##*/}"
  else
    printf '%s/%s\n' "$parent" "${1##*/}"
  fi
}

inside() {
  [ "$1" = / ] && return 0
  case $2 in
  "$1" | "$1"/*) return 0 ;;
  esac
  return 1
}

locate() {
  root_real=$(canonical_dir "$root") || {
    fail not-found
    return 1
  }
  target=$(canonical "$path")
  case $? in
  0) ;;
  2)
    fail symlink
    return 1
    ;;
  *)
    fail not-found
    return 1
    ;;
  esac
  [ -n "$target" ] || {
    fail not-found
    return 1
  }
  inside "$root_real" "$target" || {
    fail outside
    return 1
  }
}

receive() {
  : >"$stage"
  got=0
  while [ "$got" -lt "$1" ]; do
    dd bs="$(($1 - got))" count=1 2>/dev/null >>"$stage"
    now=$(size_of "$stage")
    [ "$now" -gt "$got" ] || return 1
    got=$now
  done
}

op_list() {
  locate || return 0
  [ -d "$target" ] || {
    fail not-dir
    return 0
  }
  if [ ! -r "$target" ] || [ ! -x "$target" ]; then
    fail denied
    return 0
  fi
  count=0
  meta=full
  : >"$stage"
  for entry in "$target"/* "$target"/.[!.]* "$target"/..?*; do
    name=${entry##*/}
    case $name in
    *"$NL"* | *"$TAB"*) continue ;;
    esac
    if [ -d "$entry" ]; then
      kind=d
    elif [ -f "$entry" ]; then
      kind=f
    else
      continue
    fi
    if [ "$count" -ge "$num" ]; then
      meta=truncated
      break
    fi
    count=$((count + 1))
    printf '%s %s\n' "$kind" "$name" >>"$stage"
  done
  reply "$id" ok "$(size_of "$stage")" "$meta"
  cat "$stage"
}

op_stat() {
  locate || return 0
  if [ -d "$target" ]; then
    reply "$id" ok 0 d
  elif [ -f "$target" ]; then
    [ -r "$target" ] || {
      fail denied
      return 0
    }
    size=$(size_of "$target")
    if [ "$size" -gt "$num" ]; then
      reply "$id" ok 0 "f:$size:-"
    else
      reply "$id" ok 0 "f:$size:$(version_of "$target")"
    fi
  else
    fail not-found
  fi
}

op_read() {
  locate || return 0
  if [ -d "$target" ]; then
    fail not-file
    return 0
  fi
  [ -f "$target" ] || {
    fail not-found
    return 0
  }
  [ -r "$target" ] || {
    fail denied
    return 0
  }
  [ "$(size_of "$target")" -le "$num" ] || {
    fail too-large
    return 0
  }
  cat -- "$target" >"$stage" 2>/dev/null || {
    fail failed
    return 0
  }
  size=$(size_of "$stage")
  [ "$size" -le "$num" ] || {
    fail too-large
    return 0
  }
  reply "$id" ok "$size" "$(version_of "$stage")"
  cat "$stage"
}

op_write() {
  locate || return 0
  if [ -d "$target" ]; then
    fail not-file
    return 0
  fi
  if [ -e "$target" ]; then
    [ -f "$target" ] || {
      fail not-file
      return 0
    }
    current=$(version_of "$target") || {
      fail denied
      return 0
    }
  else
    current=new
  fi
  if [ "$ver" != any ] && [ "$ver" != "$current" ]; then
    fail changed
    return 0
  fi
  dir=${target%/*}
  [ -n "$dir" ] || dir=/
  tmp="$dir/.${target##*/}.pine-$$.tmp"
  if [ "$current" != new ]; then
    cp -p -- "$target" "$tmp" 2>/dev/null || {
      rm -f -- "$tmp"
      fail denied
      return 0
    }
  fi
  cat "$stage" >"$tmp" 2>/dev/null || {
    rm -f -- "$tmp"
    fail denied
    return 0
  }
  mv -f -- "$tmp" "$target" 2>/dev/null || {
    rm -f -- "$tmp"
    fail failed
    return 0
  }
  reply "$id" ok 0 "$(version_of "$target")"
}

printf 'PINE-HELPER ready %s\n' "$PROTOCOL"

while IFS= read -r line; do
  id=${line%% *}
  rest=${line#* }
  op=${rest%% *}
  rest=${rest#* }
  num=${rest%% *}
  rest=${rest#* }
  ver=${rest%% *}
  rest=${rest#* }
  root=${rest%%"$TAB"*}
  path=${rest#*"$TAB"}
  case $id in
  '' | *[!0-9]*) exit 2 ;;
  esac
  case $num in
  '' | *[!0-9]* | ??????????*) exit 2 ;;
  esac
  if [ "$op" = write ]; then
    [ "$num" -le "$MAX_PAYLOAD" ] || exit 2
    receive "$num" || exit 0
  fi
  case $root in
  /*) ;;
  *)
    fail bad-request
    continue
    ;;
  esac
  case $path in
  /*) ;;
  *)
    fail bad-request
    continue
    ;;
  esac
  case $op in
  list) op_list ;;
  stat) op_stat ;;
  read) op_read ;;
  write) op_write ;;
  *) fail bad-request ;;
  esac
done
