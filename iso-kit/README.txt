NEXUSOS 1.4 — ISO BUILD KIT
===========================

NexusOS is your own gaming OS: the NexusOS desktop on top of Debian 13, with the NVIDIA
driver for your RTX 4050, Steam and Discord from the built-in App Store, and security
switched on from the start. This kit builds the ISO on your PC.

WHAT YOU NEED
- Windows 10 or 11 with WSL (the kit tells you how to add it if it's missing).
- About 25 GB free on C:, a steady internet connection, and 30-90 minutes.
- A USB stick of 8 GB or more (it gets wiped).

1. BUILD THE ISO
   Double-click BUILD-NexusOS-ISO.bat and leave the window open.
   - First time only: if it says Debian for WSL isn't installed, open PowerShell as
     administrator, run   wsl --install -d Debian   , restart if asked, pick any username
     and password when Debian opens, then run the .bat again.
   - It downloads Debian packages and the official Electron engine (the fingerprint is checked),
     and saves NexusOS-1.4-amd64.iso plus a .sha256 fingerprint file in your Downloads folder.
   - If it stops, NexusOS-build-log.txt is in Downloads. Send me the last 50 lines.

2. PUT IT ON A USB STICK
   Use Rufus (rufus.ie) or balenaEtcher. In Rufus pick the ISO and press Start. If it asks,
   choose "Write in DD Image mode".

3. BOOT IT
   Plug the stick in, restart, and open the boot menu (usually F12, F2 or Esc while the logo shows)
   and pick the USB stick.
   - Secure Boot: for your first try, turn it OFF in the firmware settings (usually F2). The
     NVIDIA driver can't load with it on until NexusOS is installed and set up (see step 5).
   - Choose "Live system". If the screen stays black, restart and choose the fail-safe
     entry: it skips the NVIDIA driver and uses the Intel graphics.
   - The live session signs in by itself as "nexus". If anything asks for a password, it's: live
   - Nothing on your laptop changes until you choose to install.

4. INSTALL (optional)
   Settings > Install NexusOS (or "Install NexusOS" in Start).
   - Tick "Encrypt system". Without your password, nobody can read the disk if the laptop is lost.
   - "Install alongside" keeps Windows, and you pick which one to start at boot.
     If Windows uses BitLocker, suspend it in Windows first. Back up anything important either way.
   - Pick a strong password. It protects your account, updates and settings changes.

5. AFTER INSTALLING: SECURE BOOT BACK ON
   Settings > Security & privacy > "Turn on Secure Boot with NVIDIA…". It makes a signing key that
   belongs only to your laptop, signs the NVIDIA driver with it, and walks you through the
   one-time blue "Enroll MOK" screen. Then turn Secure Boot on in the firmware settings.

GAMES, DISCORD, SOUND
- App Store: Steam, Discord, Heroic (Epic/GOG), Prism (Minecraft), Spotify, OBS and more. Apps come
  from Flathub and each runs in its own sandbox.
- Steam games run on the RTX 4050 automatically. Windows-only games run through Steam's Proton:
  in Steam, Settings > Compatibility > "Enable Steam Play for all other titles".
  Honest limit: some games with kernel anti-cheat (Valorant, Fortnite, some Call of Duty) don't
  run on any Linux. Check protondb.com for a particular game.
- Controllers (Xbox, PlayStation, Steam) work over USB and Bluetooth.
- Settings > Sound picks your speakers or headphones, and your microphone, with level controls.
  Discord uses the same devices. Bluetooth headsets: Settings > Bluetooth > Find devices > Pair.

SECURITY, IN SHORT
- Firewall on: nothing on the network can connect in. No remote-login or sharing services run.
- Security updates install automatically every day. Settings > Updates checks now.
- AppArmor confinement, kernel hardening, sandboxed apps, and a sandboxed browser.
- Sites must ask for camera, microphone, location and notifications. USB/HID access is always blocked.
- Downloaded programs never run without asking. Downloaded .deb/.AppImage installers are refused.
  Apps come from the App Store instead.
- Wi-Fi privacy: a random hardware address while scanning and a different one on each network.
- The screen locks after 10 minutes away and before sleep (installed system).
- Full-disk encryption and Secure Boot, as above.

UPDATES
Settings > Updates keeps NexusOS itself, Debian, the NVIDIA driver and your apps up to date.
NexusOS updates come from your GitHub repository and are only installed when they're signed with
your own key. If a new version doesn't start, NexusOS goes back to the previous one by itself.

SHORTCUTS
Alt+Tab switch apps · Alt+F4 close app · Win+D show desktop · Ctrl+Alt+T Linux terminal

TRY IT IN A VIRTUAL MACHINE FIRST (optional)
Hyper-V or VirtualBox can boot the ISO. It runs on basic graphics there (no NVIDIA).

WHAT I COULD AND COULDN'T TEST
I ran the NexusOS desktop on the real engine against simulated Linux system tools: Wi-Fi,
Bluetooth, sound, display, power, updates, security, App Store, window list, crash-restart and
log out. I also checked every script. I couldn't run the full ISO build here, because my workspace
can't reach Debian's servers. So this kit's first real build happens on your PC. If anything goes
wrong, the log file tells us exactly where.
