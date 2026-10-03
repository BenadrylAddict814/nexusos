# Working on NexusOS: a handover guide

Read this first if you're picking NexusOS up later, whether that's a future Claude session or anyone else.
`README.md` covers the basics. This file explains how it fits together and what was learned the hard way.

## Who it's for

- The owner runs NexusOS on a **Gigabyte G5 MF5** laptop (i5-13500H, RTX 4050, 39% battery health)
  with **Windows on the same drive** for uni and Adobe work ("Restart into Windows" uses `efibootmgr`).
- Keyboard: **Portuguese layout**, plus Russian since 2.0.2. When you give terminal commands, avoid quote
  marks and backslashes where you can: `"` is Shift+2, `'` is the key right of 0, `$` is Shift+4 and `@` is AltGr+2.
- The simple "Terminal" app only works inside the home folder. Real shell commands go in **System terminal**
  (lxterminal) from Start.
- Uni Wi-Fi is eduroam (enterprise sign-in was added in 1.8.3).
- They like playful anime features (Nexa), but **Nexa stays wholesome**: no undressing or "less clothes"
  outfits, no sexual content. Affectionate things (head pats, blushing, a blown kiss) are fine. Every outfit
  is a recolour of the one source picture; new art can't be drawn, only added if they supply it.

## Releasing an update

1. Change the code.
2. Bump **all three**: `VERSION`, `"version"` in `app/package.json`, and a new top entry in `NOTES.md`.
   Keep the "From x.y.z:" chain going: NOTES is shown to people who skip versions.
3. Commit and push to `main`. `.github/workflows/release.yml` checks the scripts, builds
   `nexusos-update.tar.gz` and `manifest.json`, signs the manifest with the `NEXUS_SIGNING_KEY` secret
   (Ed25519), and publishes a GitHub release with the ISO kit.
4. Check it went out: download
   `https://github.com/BenadrylAddict814/nexusos/releases/latest/download/manifest.json` (and `.sig`), then
   `openssl pkeyutl -verify -pubin -inkey system/usr/share/nexusos/update-key.pem -rawin -in manifest.json -sigfile manifest.json.sig`.

Updates install beside the running version (`/opt/nexusos` is a symlink). The session falls back to the
previous version if a new one crashes 3 times. `migrate.sh` runs **as root on every update** and is
**cumulative**: anyone might jump from 1.4 to the latest, so keep every old step and make each one safe to repeat.
`nexus-system install_system_files` only copies an allow-list of paths (`/usr/lib/nexusos/*`,
`/usr/share/nexusos/*`, `/etc/nexusos/*`, `/usr/share/applications/nexusos*`, lightdm/polkit/xsessions bits…).
A file anywhere else gets skipped, so either use an allowed path or have `migrate.sh` / `nexus-system` write it.

## How it's built

**`app/` is one Electron app** (`main.js`, `preload.js`, `index.html`). Started with `--session`, it is the
whole desktop (`OS_MODE`), running under **Openbox** from `system/usr/bin/nexusos-session`.

- **Windows.** The desktop (wallpaper and icons), the taskbar (`view=panel`), Start and quick settings
  (`view=popup`), notifications (`view=toasts`), the speech bubble, the on-screen note and most apps are
  separate windows. To save memory, most are **child windows of the desktop opened with `window.open`**, so
  they share one renderer (`makeChild`). The Browser and Nexa get their own process. A child window must be
  allowed its first navigation, or it stays on about:blank.
- **index.html** holds every view and app. `VIEW` comes from the URL. Apps live in the `APPS` object
  (`mount(b, api, arg)`). Settings pages live in the object with `wifi(c)`, `sound(c)`, `gaming(c)` and so on.
  Helpers: `h()` (makes elements), `sec()` / `srow()` / `sswitch()` (Settings rows), `toast()`, `ask()`, `menu()`.
  The "fresh look" CSS layer for 2.0 sits at the end of the `<style>` block.
- **IPC.** Use `handle(channel, fn)` (checks the sender is a NexusOS page), or `handleS` when the handler
  needs to know which window asked. System features go in the **`LX` object** and are called from the page as
  `HX.lx('name', ...args)`. `broadcast('sys-changed', 'what')` tells every window to refresh something.
- **Running commands.** Always use `run(cmd, args)` (execFile, no shell, `LC_ALL=C`). Anything that needs
  root goes through `pkexec /usr/lib/nexusos/nexus-system <verb>`. Polkit rules in
  `system/etc/polkit-1/rules.d/50-nexusos.rules` let some verbs run without a password.
- **Sections of `main.js`** (search for the banner comments): updates, `LX` system integration, Task
  Manager, App Store (`STORE`, Flathub search), windows, downloads, startup (`handleArgs`: URLs, `--open=`,
  `--snip`, file paths), screenshots, Discord with game status, Steam's menus, tray, USB chime, Clips,
  **Nexa** (llama.cpp server, Kokoro voice, Whisper hearing, tools, memory, reminders, gaming buddy, Game
  Mode), buddy, lock-key notes and keyboard layouts, "misses you", affection meter, sound effects
  (PipeWire filters).

### Nexa in one paragraph

A local `llama-server` (Vulkan, Qwen3-4B GGUF) is downloaded to `~/.local/share/nexusos/nexa`. It starts
only while her window is open (or a message needs it), and Game Mode stops it to free graphics memory.
Her personality, memory, recent games, reminders and closeness level all go into `nexaSystemPrompt()`.
Tools in `NEXA_TOOLS_ALWAYS` (remember, forget, reminders) always work. `NEXA_TOOLS` (opening apps, volume,
power…) only work when "Let her control NexusOS" is on. Affection (`AFF_*`) has a daily cap per source and
never drops below Friends once reached. All her state is in the config file (`nexaMood`, `nexaMemory`,
`nexaReminders`, `nexaGames`, `nexaDaily`).

## Lessons learned (don't relearn these)

- **No compositor.** Openbox draws nothing on top, so Steam's menus only take clicks when Steam starts with
  `-cef-disable-gpu`. NexusOS adds the flag, and a watchdog offers "Restart Steam" if Steam comes back without it.
  Steam's own setting "Context menu focus compatibility mode" also helps.
- **Hidden windows don't run `requestAnimationFrame`.** Use `setTimeout` in anything that has to work while hidden.
- **`storage` events don't fire between windows** that share a renderer. Broadcast through the main process instead.
- **LightDM** once started bare Openbox after sign-in (a blank screen). Since 1.8.4, `sessions-directory`
  offers only the NexusOS session, and the session writes `~/.dmrc`.
- **Flatpak sandboxes** stop the App Store's Discord from seeing games, so 2.0 installs Discord's own tarball
  to `~/.local/share/nexusos/discord` and updates it before launch. Discord's screen-share crash is fixed by
  turning off its hardware acceleration.
- **Full-screen games and the taskbar:** `gameBar()` hides the taskbar while the active window is a game
  that covers the screen (Steam `steam_app_*` windows, or windows that aren't a known app).
- **Kernel anti-cheat** games (WARDOGS, Valorant…) can't run on Linux at all. Send people to Windows.
- **Wi-Fi:** Steam downloads look choppy on Linux even when the connection is fine. It isn't a NexusOS bug.
- **Fan control:** the G5 MF5 has the Clevo `CLV0001` hook, but TUXEDO's driver refuses 13th-gen
  non-TUXEDO laptops. Shipping a patched copy of external kernel code was declined, and the owner said to
  drop it. The fans stay on the laptop's own automatic control.
- **Testing tips.** Never `pkill -f` a pattern that also appears in your own command line (it kills your shell).
  Never `rm -rf` with a relative glob after a `cd`.

## Testing without the real laptop

There's no test suite in the repo. Changes were tested in a throwaway harness:

- Electron 44 under `Xvfb` (`xvfb-run`), started as an unprivileged user with `--session` and
  `--remote-debugging-port=9333`.
- Fake versions of `nmcli`, `pactl`, `flatpak`, `wmctrl`, `xprop`, `powerprofilesctl`, `pipewire`,
  `pw-cli`, `setxkbmap` and friends, put first on `PATH`. Each logs its arguments to a file and prints canned output.
- A small Node script per feature that connects to `http://localhost:9333/json` and drives a window through
  the Chrome DevTools Protocol (`Runtime.evaluate`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`).

Rebuild this whenever you need it. Look at screenshots, not just return values: several bugs (stacking,
hidden bubbles, white patches in recolours) only showed up in pictures. Two hooks exist only for local testing
and accept only 127.0.0.1 URLs: `NEXUS_UPDATE_BASE` and `NEXUS_DISCORD_BASE`.
