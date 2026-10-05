#!/usr/bin/env bash
set -euo pipefail

case ${1%%.*} in
  11) echo big_sur ;;
  12) echo monterey ;;
  13) echo ventura ;;
  14) echo sonoma ;;
  15) echo sequoia ;;
  26) echo tahoe ;;
  *)
    echo "no Homebrew name for macOS ${1:-<empty>}" >&2
    exit 1
    ;;
esac
