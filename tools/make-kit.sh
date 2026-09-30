#!/bin/bash
# Assembles dist/NexusOS-ISO-Kit.zip (the Windows kit that builds the bootable ISO)
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(tr -d '[:space:]' < VERSION); VER=${VER%.0}
EV=$(sed -n 's/^version=//p' ENGINE); ES=$(sed -n 's/^sha256=//p' ENGINE)
rm -rf dist/kit; mkdir -p dist/kit
cp -a iso-kit dist/kit/NexusOS-ISO-Kit
K=dist/kit/NexusOS-ISO-Kit/kit
mkdir -p "$K/app" "$K/config/includes.chroot"
cp -a app/. "$K/app/"
cp -a system/. "$K/config/includes.chroot/"
cp system/usr/lib/nexusos/flip-fuses.py "$K/flip-fuses.py"
sed -i "s/^VERSION=.*/VERSION=$VER/; s/^ELECTRON=.*/ELECTRON=$EV/; s/^ELECTRON_SHA256=.*/ELECTRON_SHA256=$ES/" "$K/build.sh"
(cd dist/kit && rm -f ../NexusOS-ISO-Kit.zip && zip -qr ../NexusOS-ISO-Kit.zip NexusOS-ISO-Kit)
rm -rf dist/kit
ls -l dist/NexusOS-ISO-Kit.zip
