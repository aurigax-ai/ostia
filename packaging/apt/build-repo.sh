#!/usr/bin/env bash
set -euo pipefail

dir=$1
keep=${KEEP_VERSIONS:-3}
key=${APT_GPG_FINGERPRINT:?set APT_GPG_FINGERPRINT}

cd "$dir"
shopt -s nullglob
debs=(ostia_*.deb)
if [ ${#debs[@]} -eq 0 ]; then
  echo "no ostia_*.deb in $dir" >&2
  exit 1
fi

mapfile -t sorted < <(
  for deb in "${debs[@]}"; do
    printf '%s %s\n' "$(dpkg-deb -f "$deb" Version)" "$deb"
  done | sort -k1,1V
)
excess=$(( ${#sorted[@]} - keep ))
for ((i = 0; i < excess; i++)); do
  rm -f -- "${sorted[$i]#* }"
done

rm -f Packages Packages.gz Release Release.gpg InRelease
apt-ftparchive packages . > Packages
gzip -9kn Packages
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=Ostia \
  -o APT::FTPArchive::Release::Label=Ostia \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=amd64 \
  -o "APT::FTPArchive::Release::Description=Ostia terminal workspace" \
  release . > Release
gpg --batch --yes --local-user "$key" --clearsign --output InRelease Release
gpg --batch --yes --local-user "$key" --armor --detach-sign --output Release.gpg Release
gpg --batch --verify InRelease

echo "repository in $dir:"
awk '/^Version:/ {print "  ostia " $2}' Packages
