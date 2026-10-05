#!/usr/bin/env bash
set -euo pipefail

want=$1
app=/Applications/Ostia.app
got=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")
echo "installed $got, wanted $want"
test "$got" = "$want"
spctl -a -vvv -t exec "$app"
