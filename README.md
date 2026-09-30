# NexusOS

A gaming desktop on Debian 13 with NVIDIA graphics, Steam and Discord from a built-in App Store, and security on from the start.

## How updates work
1. Change the code, then bump `VERSION`, `app/package.json` and `NOTES.md`.
2. Push a tag matching the version, e.g. `git tag v1.5.0 && git push origin v1.5.0`.
3. GitHub Actions (`.github/workflows/release.yml`) builds `nexusos-update.tar.gz`, writes `manifest.json`
   (version, SHA-256, engine, notes) and signs it with the `NEXUS_SIGNING_KEY` secret (Ed25519).
   It also attaches a fresh `NexusOS-ISO-Kit.zip`.
4. NexusOS checks `releases/latest` every few hours. It only accepts a manifest signed by the key in
   `system/usr/share/nexusos/update-key.pem`, installs beside the running version, and can go back.
   If a new version fails to start 3 times, the session starts the previous one by itself.

## Layout
- `app/` — the NexusOS desktop (Electron app)
- `system/` — NexusOS's system files (session, helpers, polkit, sysctl, NetworkManager, lightdm, …)
- `migrate.sh` — one-time fixes run as root when an update installs
- `iso-kit/` — builds the bootable ISO on Windows through WSL (`tools/make-kit.sh` assembles the zip)
- `tools/` — `make-update.sh`, `make-kit.sh`

## Security notes
- The private signing key is only in the repository secret (and your offline backup). Never commit it.
- Keep two-factor authentication on for this GitHub account: it controls what your computers install.
