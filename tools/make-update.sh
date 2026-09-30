#!/bin/bash
# Builds a NexusOS update: dist/nexusos-update.tar.gz + dist/manifest.json (+ .sig when a key is given)
#   tools/make-update.sh [private-key.pem]
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(tr -d '[:space:]' < VERSION)
EV=$(sed -n 's/^version=//p' ENGINE); ES=$(sed -n 's/^sha256=//p' ENGINE)
[ "$(python3 -c 'import json;print(json.load(open("app/package.json"))["version"])')" = "$VER" ] || { echo "app/package.json version doesn't match VERSION ($VER)" >&2; exit 1; }
rm -rf dist; mkdir -p dist/pkg
cp -a app dist/pkg/app; cp -a system dist/pkg/system; cp migrate.sh dist/pkg/migrate.sh
# reproducible-ish archive: fixed owner, sorted names
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01' -C dist/pkg -czf dist/nexusos-update.tar.gz app system migrate.sh
SHA=$(sha256sum dist/nexusos-update.tar.gz | cut -d' ' -f1); SIZE=$(stat -c %s dist/nexusos-update.tar.gz)
python3 - "$VER" "$SHA" "$SIZE" "$EV" "$ES" > dist/manifest.json <<'PY'
import json, sys, datetime
v, sha, size, ev, es = sys.argv[1:6]
print(json.dumps({"version": v, "sha256": sha, "size": int(size), "date": datetime.date.today().isoformat(),
                  "engine": {"version": ev, "sha256": es}, "notes": open("NOTES.md").read().strip()}, indent=1))
PY
if [ -n "${1:-}" ]; then
  openssl pkeyutl -sign -inkey "$1" -rawin -in dist/manifest.json -out dist/manifest.json.sig
  openssl pkeyutl -verify -pubin -inkey system/usr/share/nexusos/update-key.pem -rawin -in dist/manifest.json -sigfile dist/manifest.json.sig \
    || { echo "The signing key doesn't match system/usr/share/nexusos/update-key.pem" >&2; exit 1; }
fi
rm -rf dist/pkg
ls -l dist
