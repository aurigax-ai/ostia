#!/usr/bin/env bash
set -euo pipefail

url=$1
want=$2
from=${3:-}
export DEBIAN_FRONTEND=noninteractive

. /etc/os-release
echo "== $PRETTY_NAME: install ${from:-$want}${from:+, then upgrade to $want}"
apt-get update -qq
apt-get install -y -qq curl ca-certificates >/dev/null
install -d -m 0755 /etc/apt/keyrings
curl -fsSL "$url/ostia.gpg" -o /etc/apt/keyrings/ostia.gpg
echo "deb [signed-by=/etc/apt/keyrings/ostia.gpg] $url ./" > /etc/apt/sources.list.d/ostia.list
apt-get update

version() { dpkg-query -W -f '${Version}' ostia; }

if [ -n "$from" ]; then
  apt-get install -y "ostia=$from"
  test "$(version)" = "$from"
  apt-get install -y --only-upgrade ostia
else
  apt-get install -y ostia
fi

echo "installed: $(version), wanted: $want"
test "$(version)" = "$want"
test -x /opt/Ostia/ostia
test "$(readlink -f /usr/bin/ostia)" = /opt/Ostia/resources/bin/ostia
ostia --help | grep -q '^usage: ostia'
test -f /usr/share/applications/ostia.desktop
missing=$(ldd /opt/Ostia/ostia | grep 'not found' || true)
if [ -n "$missing" ]; then
  echo "missing libraries:" >&2
  echo "$missing" >&2
  exit 1
fi
apt-get remove -y ostia >/dev/null
test ! -e /usr/bin/ostia
echo "ok: ostia $want on $PRETTY_NAME"
