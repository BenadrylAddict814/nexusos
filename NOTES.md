NexusOS 1.9.7

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
