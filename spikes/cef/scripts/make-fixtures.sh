#!/bin/sh
set -eu
dir=$(cd "$(dirname "$0")/../fixtures" && pwd)
ffmpeg -y -f lavfi -i testsrc2=size=640x360:rate=30 -t 10 -c:v libvpx -b:v 1M "$dir/video.webm"
