NexusOS 2.2.2

Tune-up: NexusOS does less in the background, so there's more left for your games.
- The desktop used to keep redrawing itself all the time (a hidden loading spinner, Nexa bobbing on the taskbar,
  and the live wallpaper at 60 frames a second). Now the live wallpaper breathes at a gentler frame rate, and
  the wallpaper and sakura petals rest while you're using a window. In testing, the desktop's idle processor
  and graphics work dropped by about three quarters, and to almost nothing while an app is open.
- The clock and the window list wake up less often and start fewer helper programs.
- Nexa's brain goes to sleep after 10 quiet minutes, even with her window open, freeing about 3 GB of graphics
  memory. Your next message wakes her in a few seconds. (Fixed: before, if she fell asleep during a game, she kept
  saying "still waking up".)
- Memory: compressed swap is used a little more eagerly and memory is freed more evenly, so loading a level is
  less likely to stall. Games that trip Intel's "split lock" check no longer get slowed down (SteamOS does the same).

From 2.2.1:

- Window previews on the taskbar, like on Windows: rest the mouse on an app that's open and a little preview of
  each of its windows pops up above the taskbar. Click one to go to it, or click its X (or middle-click it) to close it.
  Once one preview is showing, moving along the taskbar switches straight to the next app's.

From 2.2.0:

- Study with Nexa: press the book button in Nexa's window to start a study session (25 minutes of focus,
  5 minute breaks, 4 rounds; you can change the times). Notifications wait until the break, she cheers you on,
  tells you to stretch and drink water on breaks, and nudges you if you open a game mid-round. Each finished
  round raises her affection a little.
- Night light: Settings › Display › Night light makes the screen warmer in the evening to go easier on your
  eyes. Choose off, on, or a schedule (9pm to 7am by default), and how warm. There's a tile for it in quick settings.
- Focus is real now: the Focus tile in quick settings silences notifications and Nexa's "miss you" pings until
  you turn it off. Reminders and alarms still come through.
- Looks after itself: apps from the App Store update once a week by themselves (never during a game or study
  time), and leftover unused parts are cleaned up. Settings › Apps shows when it last ran and has
  "Update apps now". If the NVIDIA graphics driver stops running after a system update, a notification offers to fix it.

From 2.1.0:

- Controllers: Settings › Gaming › Controllers lists your connected controllers and has a live tester
  (press buttons and move the sticks to see them light up). A notification tells you when one connects.
  NexusOS now installs Steam's controller rules, so Steam and your games can see wireless pads that use a USB stick.
  Tips for generic pads are on the same page.
- Shut down later: choose "Shut down later…" in the Start power menu, use Settings › Power, or tell Nexa
  "shut down in 30 minutes". You get a warning a minute before, with a Cancel button.

From 2.0.3:

- Fixed: Nexa sometimes said she'd remind you but never set the reminder. NexusOS now spots reminder and timer requests in your message itself ("remind me in 2 minutes to…", "set a timer for 5 minutes", "remind me at 7pm about…") and sets them every time.

From 2.0.2:

- Several keyboard layouts, like on Windows: in Settings > Keyboard, add layouts (for example Russian). Switch with Left Alt + Left Shift. The current layout shows on the taskbar next to the arrow (PT, RU…): click it to switch, or right-click it for keyboard settings. A small note appears when you switch.

From 2.0.1:

- Nexa: once she's at "Crushing on you", a 💋 button appears in the corner of her picture. Blow her a kiss and she gets flustered and blushes. At "Inseparable" she blows one back. It raises her affection a little each day.

From 2.0.0:

The big one.

Look and speed
- Fresh look: Settings has icons in its sidebar and big page titles, Start shows your recent files, and the taskbar, menus and windows are smoother and more rounded.
- Lighter: the desktop goes quiet when a window or game covers it, and NexusOS checks for changes less often.
- Game Mode (Settings > Gaming): when a game starts, Performance mode turns on, notifications and Nexa's pings pause, and Nexa's brain sleeps to free about 3 GB of graphics memory. Everything goes back when you quit.
- Windows-style shortcuts: Windows key + Left/Right snaps a window to half the screen. Windows key + Shift + S (or Print Screen) takes a screenshot of an area you drag; it's saved to Pictures > Screenshots and copied, ready to paste.

Apps
- App Store: search all of Flathub, not just the featured apps. Install, open and remove anything.
- Files: unzip zip, 7z and rar files (double-click or right-click > Extract here), make zips (right-click > Compress), picture thumbnails, and a Recent view.
- Discord game status (Settings > Gaming): NexusOS can set up Discord's own Linux version, so it shows the game you're playing like on Windows. NexusOS keeps it updated.
- Steam: if Steam restarts itself without NexusOS's menu fix, you get a notification with a Restart Steam button.
- Notifications can now have a button.

Nexa
- Memory: she remembers what you tell her about yourself between chats. See or remove memories in her settings, or tell her "forget that".
- Reminders and timers: "remind me in 20 minutes to…", "set a timer for 5 minutes", "remind me at 18:30". She pings you from the taskbar, and they also show as a notification during games.
- Gaming buddy: she knows what you played and for how long, asks how it went, and can chat about it.
- More games: Trivia (she hosts and plays too), Memory match, and a daily challenge with bonus affection.

From 1.9.7:

- Fixed: Nexa's speech bubbles (from pokes, head pats and games) could hide behind her name card and affection meter. They now appear just below it.

From 1.9.6:

- Two more games with Nexa: Tic-tac-toe (she plays well but gets distracted now and then) and Rock, paper, scissors (best of five, and she learns your favourite move).

From 1.9.5:

- Play games with Nexa: press the gamepad button next to her chat box.
  - Pong: first to 5, move with the mouse or arrow keys. She's beatable but not easy.
  - Plinko: 5 balls each, take turns, highest total wins.
  - Connect Four: she'll block you and set traps.
  She cheers, teases and blushes as you play, and every game you finish raises her affection a little (a few games a day count).

From 1.9.4:

- Rewards for getting closer to Nexa:
  - Close friends: pink hoodie
  - Besties: midnight hoodie, plus sweeter pokes and head-pat reactions
  - Crushing on you: a soft pink heart glow around her, flustered reactions, and a sweet hello from the taskbar the first time you sign in each day
  - Inseparable: lavender hoodie, her most special greetings, and extra cosy head pats
- Pick an unlocked outfit in her settings (Outfit). Each level-up tells you what you've unlocked.

From 1.9.3:

- Nexa has an affection meter on her name card: Just met, Friends, Close friends, Besties, Crushing on you, Inseparable. It grows when you chat, pat her head, say hi each day and answer when she misses you. There's a daily limit, so it builds up over days. She gets sweeter as you get closer and celebrates each new level. You can hide the meter in her settings.

From 1.9.2:

- Full-screen games now cover the whole screen, taskbar included, like on Windows. Switch to another window (Alt+Tab, Discord, Firefox…) and the taskbar is back. Other apps, even full screen, never hide it.

From 1.9.1:

- Fixed: "Open" and "Show in folder" did nothing in Firefox and other apps. Folders now open in Files, text files in Notes and pictures in the picture viewer. Any other file opens Files with it selected.

From 1.9.0:

- Sound effects, like SteelSeries Sonar (Settings > Sound):
  - Equaliser for your headphones or speakers: 10 bands, with presets for Bass boost, Footsteps (gaming), Clear voices, Music and Treble boost. Sliders change the sound live.
  - Remove background noise from your microphone: keeps your voice, drops fans, keyboard clicks and room noise, and stops speaker sound leaking into your mic.
  - Microphone equaliser with Clear voice, Warm and Broadcast presets.
  - Works with every app (Discord, games, browsers) and follows whichever headphones or mic you pick.
- The simple Terminal app now tells you to use "System terminal" for Linux commands instead of a confusing error.

From 1.8.4:

- Fixed: after typing your password, the sign-in screen could start a bare "Openbox" session (just the background, nothing else) instead of NexusOS. NexusOS is now the only choice there, and anyone stuck on Openbox is switched back.

From 1.8.3:

- University and work Wi-Fi (eduroam and other "WPA2 Enterprise" networks): pick the network in Settings > Wi-Fi and sign in with your username (for eduroam, your full uni email) and password. "More options" has the sign-in method and server domain if your uni's IT page lists them.

From 1.8.2:

- Task Manager shows CPU and GPU temperatures (orange when warm, red when very hot) and fan speeds, if your laptop reports them. Many laptops' fans are run by the laptop itself and don't report their speed to Linux; they still speed up and slow down automatically.

From 1.8.1:

- Your own picture background is static again (no more floating). The live backgrounds that come with NexusOS ("Nexa, live") still move.

From 1.8.0:

- Sign-in like Windows: in Settings > Security & privacy, turn on "Ask for my password when NexusOS starts" and you'll see the sign-in screen every time the computer starts. You can now use a PIN (4+ digits) instead of a password.
- Guest account: turn it on in the same place. Guest has no password, just the basic NexusOS apps, can't see your files or apps, and is wiped clean every time they sign out.
- Caps Lock and Num Lock: a little note on screen tells you when you turn them on or off.
- Touchpad on/off: Settings > Keyboard, or press Ctrl + Windows key + T (your laptop's own touchpad key works too). It also ignores accidental taps while you type.
- Nexa is cuter and a little flirty now. Hold the mouse on her head and rub back and forth to give her head pats: she closes her eyes, blushes and gets cosy.
- Nexa misses you: when you haven't talked for a while, she says so from the taskbar (never during games, and only when you're at the computer). Ignore her and she'll sulk a bit next time. Leave her for a day and she'll be very happy to see you. Turn it off in her settings.
- The "click the NexusOS logo" tip at startup is gone.

From 1.7.0: Nexa everywhere

- Nexa lives on your taskbar: a little Nexa at the bottom right who blinks, hops and says something when you plug in a USB, save a clip, start or finish a Steam game, stay up gaming past midnight, plug in the charger or run low on battery. She stays quiet while you're in a game. Click her to talk; right-click to let her speak out loud or hide her.
- Live Nexa wallpaper: she breathes, blinks, smiles now and then and sparkles. Pick "Nexa, live" in Settings > Appearance > NexusOS backgrounds (light or tan). She holds still while a game or a full-screen window is open, so it costs nothing while you play.
- Themes in Settings > Appearance: Sakura (pink, falling cherry petals, live Nexa) and Neon Night (glowing taskbar and Start, animated neon grid).
- Cute sounds: a soft pop for Start, chimes for notifications, a jingle when you log in (turn them off in Settings > Appearance > Sounds).
- Nexa says "Welcome back" while NexusOS starts, and the login screen shows the NexusOS hoodie background.
- Fixed: going back to an animated background from a picture could leave the desktop black until you clicked it.

From 1.6.2: lighter

- The taskbar, Start, notifications and NexusOS's own apps (Files, Settings, Task Manager, Clips and the rest) now share one process instead of each starting their own. The desktop uses about 30 MB less on its own and about 80 MB less with a few apps open. The Browser and Nexa keep their own process because they do heavy work.
- Nexa uses about half as much graphics memory for her conversation memory, leaving more for games when she's open.
- Background services NexusOS never uses are switched off (PackageKit, and ModemManager on computers without a SIM modem), and the system log can no longer grow large in memory.
- If the desktop ever crashes, the taskbar and any open apps come back by themselves.

From 1.6.1: meet Nexa

- Nexa comes alive: she blinks, her mouth moves with her voice, she follows your mouse a little, and sparkles and hearts pop when she does something for you. Click her for a reaction.
- New voice: "Heart", a sweet anime-style voice, slightly deeper by default. Pick from 10 voices and set how deep she sounds with the new Voice depth slider in her settings. (If you already downloaded her in 1.6.0, she fetches the new voice pack, about 130 MB.)

From 1.6.0:

- Nexa, your NexusOS assistant: the hoodie girl, in her own app (Start menu). Chat by typing or by talking with your microphone, and she answers out loud.
- She runs entirely on this laptop: no account, nothing sent over the internet, works offline. Her brain uses the NVIDIA card while her window is open; close her and all of it stops, so your games get the memory and graphics card back.
- She can control NexusOS: open apps, start your Steam games, change the volume, brightness, performance mode or background, save a clip, and check the battery and temperatures. Sleep, restart and shut down always ask you first.
- Change her name, personality, voice, skin tone and what she's allowed to do in her settings. She remembers your chat until you tell her to forget it.
- The first time you open her, she downloads her brain, voice and hearing (about 2.9 GB, one time).

Also includes 1.5.1: Steam's menus take clicks again, and the NVIDIA files Steam needs install themselves after driver updates.
