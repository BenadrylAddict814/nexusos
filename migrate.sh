#!/bin/bash
# One-time fixes that run (as root) when this NexusOS update is installed.
# $CHANGED_FILES lists the system files this update changed.
set -u
changed() { grep -qx "$1" "${CHANGED_FILES:-/dev/null}" 2>/dev/null; }
say() { echo "$*"; }

# 1.4: make sure the NVIDIA driver, not nouveau, gets the graphics card
if [ -e /usr/bin/nvidia-smi ] || ls /lib/modules/*/updates/dkms/nvidia* >/dev/null 2>&1; then
  if command -v update-glx >/dev/null 2>&1; then update-glx --auto glx >/dev/null 2>&1 || true; fi
  if changed /etc/modprobe.d/nexusos-no-nouveau.conf; then
    say "Updating the startup files for the NVIDIA driver (about a minute)..."
    update-initramfs -u -k all >/dev/null 2>&1 || say "  (couldn't update the startup files; Settings > Security has a fix button)"
  fi
fi
# 1.4.3: the NexusOS window-frame theme (older updaters didn't know this folder, so copy it here)
HERE=$(cd "$(dirname "$0")" && pwd)
if [ -f "$HERE/system/usr/share/themes/NexusOS/openbox-3/themerc" ]; then
  install -D -o root -g root -m 0644 "$HERE/system/usr/share/themes/NexusOS/openbox-3/themerc" /usr/share/themes/NexusOS/openbox-3/themerc
fi
if changed /etc/default/grub.d/nexusos.cfg && command -v update-grub >/dev/null 2>&1; then update-grub >/dev/null 2>&1 || true; fi
if changed /etc/sysctl.d/90-nexusos.conf; then sysctl --system >/dev/null 2>&1 || true; fi
if ls /etc/NetworkManager/conf.d/*nexusos* >/dev/null 2>&1 && grep -q NetworkManager "${CHANGED_FILES:-/dev/null}" 2>/dev/null; then
  systemctl reload NetworkManager >/dev/null 2>&1 || true
fi
exit 0
