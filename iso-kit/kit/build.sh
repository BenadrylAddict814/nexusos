#!/bin/bash
# NexusOS ISO builder. Runs inside WSL (Debian) as root; BUILD-NexusOS-ISO.bat starts it.
# It builds in a clean Debian 13 environment of its own, so it doesn't matter which Debian
# version your WSL has, and it never touches your Windows files except to save the ISO.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C.UTF-8 LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive

VERSION=1.3
ELECTRON=44.5.0
ELECTRON_SHA256=ee42d6f20b82f87b43bca7d5fec93557f93f2aecc47ae69f0e506503f8ea723c
MIRROR=http://deb.debian.org/debian

KIT=$(pwd)
WORK=/var/tmp/nexusos-build
ROOT=$WORK/builder
LOG=$WORK/build.log
OUT=""

say()  { printf '\n\033[1;36m  %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m  %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "Run this as root (the .bat file does that for you)."
[ -f "$KIT/config/package-lists/nexusos.list.chroot" ] || fail "Run this from the kit folder."
if [ -f "$KIT/out-dir.txt" ]; then OUT=$(wslpath -u "$(tr -d '\r\n' < "$KIT/out-dir.txt")" 2>/dev/null || true); fi
[ -n "$OUT" ] || OUT=$KIT
mkdir -p "$OUT"

mkdir -p "$WORK"
exec > >(tee -a "$LOG") 2>&1
echo "==== NexusOS $VERSION build started $(date)"

unmount_under() {   # unmount everything below a folder, deepest first
  awk '{print $2}' /proc/mounts | grep -E "^$1(/|$)" | sort -r | while read -r m; do umount -lf "$m" 2>/dev/null || true; done || true
}
cleanup() {
  unmount_under "$ROOT/build"
  for m in dev/pts dev sys proc; do umount -lf "$ROOT/$m" 2>/dev/null || true; done
  if [ -d "$OUT" ]; then cp -f "$LOG" "$OUT/NexusOS-build-log.txt" 2>/dev/null || true; fi
}
trap cleanup EXIT

# ---- checks
grep -qi microsoft /proc/version || echo "  (not WSL: that's fine on a normal Debian/Ubuntu PC too)"
[ -d /proc/sys/fs/binfmt_misc ] || true
FREE=$(df --output=avail -BG /var/tmp | tail -1 | tr -dc 0-9)
[ "${FREE:-0}" -ge 25 ] || fail "Need about 25 GB free inside WSL; there's ${FREE} GB."

# ---- tools on the WSL side
say "1/6  Getting build tools..."
apt-get update -qq
apt-get install -y -qq debootstrap curl ca-certificates unzip python3 >/dev/null

# ---- a clean Debian 13 build environment
# (first, let go of anything a stopped earlier build left mounted)
unmount_under "$ROOT/build"
for m in dev/pts dev sys proc; do umount -lf "$ROOT/$m" 2>/dev/null || true; done
if [ ! -x "$ROOT/usr/bin/lb" ]; then
  say "2/6  Making a clean Debian 13 build environment (one time, about 5 minutes)..."
  rm -rf --one-file-system "$ROOT"
  debootstrap --variant=minbase trixie "$ROOT" "$MIRROR"
else
  say "2/6  Reusing the build environment from last time."
fi
mount -t proc proc "$ROOT/proc"
mount --bind /sys "$ROOT/sys"
mount --bind /dev "$ROOT/dev"
mount --bind /dev/pts "$ROOT/dev/pts"
cp -L /etc/resolv.conf "$ROOT/etc/resolv.conf"
chroot "$ROOT" apt-get update -qq
chroot "$ROOT" apt-get install -y -qq live-build debootstrap xorriso squashfs-tools mtools dosfstools cpio wget ca-certificates >/dev/null

# ---- the desktop engine (official Electron build, fingerprint checked)
say "3/6  Downloading the desktop engine (Electron $ELECTRON)..."
ZIP=$WORK/electron-v$ELECTRON-linux-x64.zip
if [ ! -f "$ZIP" ] || ! echo "$ELECTRON_SHA256  $ZIP" | sha256sum -c --status; then
  curl -fL --retry 5 --retry-delay 3 -o "$ZIP" "https://github.com/electron/electron/releases/download/v$ELECTRON/electron-v$ELECTRON-linux-x64.zip"
fi
echo "$ELECTRON_SHA256  $ZIP" | sha256sum -c --status || { rm -f "$ZIP"; fail "The engine download doesn't match the official fingerprint. Nothing was built. Run the build again."; }
echo "  Fingerprint matches the official Electron $ELECTRON release."

# ---- configure live-build
say "4/6  Setting up NexusOS..."
B=$ROOT/build
unmount_under "$B"
rm -rf --one-file-system "$B"; mkdir -p "$B"
LIVE_ARGS="boot=live components quiet username=nexus hostname=nexusos locales=en_GB.UTF-8 keyboard-layouts=gb timezone=Europe/London user-default-groups=audio,cdrom,dip,floppy,video,plugdev,netdev,bluetooth,sudo,scanner,lpadmin nvidia-drm.modeset=1"
SAFE_ARGS="boot=live components username=nexus hostname=nexusos locales=en_GB.UTF-8 keyboard-layouts=gb timezone=Europe/London user-default-groups=audio,cdrom,dip,floppy,video,plugdev,netdev,bluetooth,sudo nomodeset modprobe.blacklist=nvidia,nvidia_drm,nvidia_modeset,nvidia_uvm"
chroot "$ROOT" /bin/bash -c "cd /build && lb config \
  --mode debian --distribution trixie --architectures amd64 \
  --archive-areas 'main contrib non-free non-free-firmware' \
  --mirror-bootstrap $MIRROR --mirror-binary $MIRROR \
  --binary-images iso-hybrid --debian-installer none \
  --linux-packages 'linux-image linux-headers' \
  --firmware-chroot true --firmware-binary true \
  --security true --updates true --apt-recommends true --memtest none \
  --iso-application NexusOS --iso-publisher NexusOS --iso-volume 'NexusOS $VERSION' \
  --bootappend-live '$LIVE_ARGS' \
  --bootappend-live-failsafe '$SAFE_ARGS'"
cp -a "$KIT/config/." "$B/config/"
# files copied from Windows arrive world-writable: give everything safe owners and permissions
chown -R root:root "$B/config"
find "$B/config" -type d -exec chmod 0755 {} +
find "$B/config" -type f -exec chmod 0644 {} +
find "$B/config" -type f -exec sed -i 's/\r$//' {} +      # Windows line endings would break names and scripts
find "$B/config/hooks" -type f -exec chmod 0755 {} +

# the desktop itself goes in /opt/nexusos
APP=$B/config/includes.chroot/opt/nexusos
mkdir -p "$APP"
unzip -q -o "$ZIP" -d "$APP"
mv "$APP/electron" "$APP/nexusos"
rm -f "$APP/resources/default_app.asar"
mkdir -p "$APP/resources/app"
cp -a "$KIT/app/." "$APP/resources/app/"
python3 "$KIT/flip-fuses.py" "$APP/nexusos"

# ---- build
say "5/6  Building the ISO. This is the long part: 30-90 minutes, depending on your internet."
chroot "$ROOT" /bin/bash -c "cd /build && lb build"
ISO=$(ls "$B"/*.iso 2>/dev/null | head -1 || true)
[ -n "$ISO" ] || fail "The build finished without an ISO. The log is saved next to where the ISO would go: NexusOS-build-log.txt"

say "6/6  Saving the ISO..."
NAME="NexusOS-$VERSION-amd64.iso"
cp -f "$ISO" "$OUT/$NAME"
( cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256" )
grep -h '^nvidia=' "$B"/chroot/etc/nexusos/build-info 2>/dev/null | sed 's/^/  NVIDIA driver: /' || true
say "Done: $OUT/$NAME ($(du -h "$OUT/$NAME" | cut -f1))"
echo "==== finished $(date)"
