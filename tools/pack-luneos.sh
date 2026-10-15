#!/bin/bash
# Packages the app for LuneOS, as "LuneOS Explorer": "Topaz" was the
# TouchPad's name while it was being made and means nothing there. The
# package is laid out as palm-package lays it out, so the same installer
# takes it. appinfo.json differs in its title and in being trusted, without
# which LuneOS's web runtime shows no pictures; the legacy webOS 7za is left
# out. Needs python3, tar, ar.
#
#   tools/pack-luneos.sh [out dir]        (default: build/)
#
# Install it on the device with appInstallService:
#   luna-send -i luna://com.webos.appInstallService/install \
#       '{"id":"com.palm.stark.files","ipkUrl":"/tmp/<ipk>","subscribe":true}'
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${1:-$ROOT/build}" && cd "${1:-$ROOT/build}" && pwd)
TITLE="LuneOS Explorer"

field() { python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$ROOT/app/appinfo.json" "$1"; }
ID=$(field id)
VER=$(field version)
IPK=$OUT/${ID}_${VER}_all.ipk
W=$(mktemp -d "$OUT/pack.XXXXXX")
trap 'rm -rf "$W"' EXIT

APP=$W/data/usr/palm/applications/$ID
mkdir -p "$W/control" "$APP" "$W/data/usr/palm/services/$ID.service" "$W/data/usr/palm/packages/$ID"
cp -r "$ROOT/app/." "$APP/"
cp -r "$ROOT/service/." "$W/data/usr/palm/services/$ID.service/"
cp "$ROOT/package/packageinfo.json" "$W/data/usr/palm/packages/$ID/"
# The 7za for legacy webOS cannot run on LuneOS, which has its own 7-Zip.
rm -rf "$W/data/usr/palm/services/$ID.service/bin"

python3 -I - "$APP/appinfo.json" "$W/data/usr/palm/packages/$ID/packageinfo.json" "$TITLE" <<'PY'
import json, sys
appinfo, packageinfo, title = sys.argv[1:]
a = json.load(open(appinfo))
old = a["title"]
a["title"] = title
a["keywords"] = [title if k == old else k for k in a.get("keywords", [])]
# LuneOS's web runtime lets only trusted apps load files from /media
# (/etc/wam/security_policy.conf), and the pictures are shown from there.
a["trustLevel"] = "trusted"
json.dump(a, open(appinfo, "w"), indent="\t")
p = json.load(open(packageinfo))
if p.get("loc_name") == old:
    p["loc_name"] = title
json.dump(p, open(packageinfo, "w"), indent="\t")
PY
sed -i "s/<title>.*<\/title>/<title>$TITLE<\/title>/" "$APP/index.html"

cat > "$W/control/control" <<C
Package: $ID
Version: $VER
Section: misc
Priority: optional
Architecture: all
Installed-Size: $(du -sk "$W/data" | cut -f1)
Maintainer: N/A <nobody@example.com>
Description: This is a webOS application.
webOS-Package-Format-Version: 2
webOS-Packager-Version: 3.0.5b38
C
echo "2.0" > "$W/debian-binary"
T="--owner=0 --group=0 --numeric-owner --sort=name"
tar $T -czf "$W/control.tar.gz" -C "$W/control" ./control
tar $T -czf "$W/data.tar.gz" -C "$W/data" ./usr
rm -f "$IPK"
(cd "$W" && ar rc "$IPK" debian-binary control.tar.gz data.tar.gz)
echo "$IPK"
