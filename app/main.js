/*
 * NexusOS 1.3 — main process.
 * Runs two ways:
 *   - on Windows (or a normal Linux desktop) as a full-screen app on top of the host OS;
 *   - as the whole desktop of NexusOS (Linux, started by the "halcyon" session with --session).
 *
 * Security model
 *   - Every renderer is sandboxed (app.enableSandbox), with context isolation and no Node.js.
 *   - Only NexusOS's own page (file://…/index.html) may call the functions below; web pages in the
 *     Browser run in a separate, locked-down <webview> with no bridge at all.
 *   - NexusOS writes only inside its own drive; it can read elsewhere but never modifies it.
 *   - Websites must ask before using camera, microphone, location or notifications; USB/HID/serial
 *     access is always refused.
 *   - System commands are run directly (no shell), with fixed argument lists and timeouts.
 *   - Programs are never started without the person confirming it first.
 */
const { app, BrowserWindow, ipcMain, shell, dialog, session, Menu, screen, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const OS_MODE = IS_LINUX && (process.argv.includes('--session') || process.env.HALCYON_SESSION === '1');
const VERSION = String(require('./package.json').version || '0');

app.enableSandbox();
// 1.5: leave out Chromium parts NexusOS never uses, so the desktop takes less memory
if (IS_LINUX) {
  app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,MediaRouter,OptimizationHints,Translate,AutofillServerCommunication,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,BackForwardCache');
  app.commandLine.appendSwitch('disable-background-networking');
}
// NexusOS was renamed NexusOS in 1.3: carry the old drive and settings across once.
{
  const base = app.getPath('appData'), oldDir = path.join(base, 'NexusOS'), newDir = path.join(base, 'NexusOS');
  try { if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir); } catch (_) {}
}
app.setName('NexusOS');
// A second copy (for example a link opened from Discord) hands its address to the running NexusOS and exits.
const PRIMARY = app.requestSingleInstanceLock();
if (!PRIMARY) app.exit(0);

let win = null;

/* ---------------------------------------------------------------- the NexusOS drive */
// On NexusOS the drive is simply your home folder. On Windows it is kept apart from your Windows files.
const DRIVE = OS_MODE ? os.homedir() : path.join(app.getPath('userData'), 'Drive');
const FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos'];
function ensureDrive() {
  for (const f of FOLDERS) fs.mkdirSync(path.join(DRIVE, f), { recursive: true });
  const marker = path.join(OS_MODE ? app.getPath('userData') : DRIVE, '.nexusos');
  if (!fs.existsSync(marker)) {
    const welcome = path.join(DRIVE, 'Documents', 'Welcome.txt');
    if (!fs.existsSync(welcome)) fs.writeFileSync(welcome,
      'Welcome to NexusOS.\n\nDownloads from the Browser land in Downloads, Notes saves to Documents,\n' +
      'and Paint saves to Pictures. Anything in the Desktop folder shows up on the desktop.\n');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, VERSION);
  }
}
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
function insideDrive(p) {
  if (typeof p !== 'string' || !p) return false;
  // resolve symlinks of the existing part so a link can't point writes outside the drive
  let probe = path.resolve(p); const rest = [];
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) { rest.unshift(path.basename(probe)); probe = path.dirname(probe); }
  const full = path.join(real(probe), ...rest);
  const r = path.relative(real(DRIVE), full);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}
function mustBeInDrive(p) { if (!insideDrive(p)) throw new Error('NexusOS only changes files inside its own drive.'); return path.resolve(p); }
function uniquePath(dir, name) {
  const ext = path.extname(name), base = path.basename(name, ext);
  let p = path.join(dir, name), n = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${n++})${ext}`);
  return p;
}
function cleanName(name) {
  const n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  if (!n || n === '.' || n === '..') throw new Error('That name can’t be used.');
  return n.slice(0, 200);
}
function places() {
  if (OS_MODE) {
    const out = [{ label: 'Computer', path: '/' }];
    const media = path.join('/media', os.userInfo().username);
    try { for (const d of fs.readdirSync(media)) out.push({ label: d, path: path.join(media, d), removable: true }); } catch (_) {}
    return out;
  }
  const h = os.homedir();
  return [['Home', ''], ['Desktop', 'Desktop'], ['Documents', 'Documents'], ['Downloads', 'Downloads'], ['Pictures', 'Pictures']]
    .map(([label, sub]) => ({ label, path: sub ? path.join(h, sub) : h }));
}

/* ---------------------------------------------------------------- settings kept by the main process */
const CONFIG_FILE = path.join(app.getPath('userData'), 'system.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch (_) { config = {}; }
function saveConfig() { try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 1)); } catch (_) {} }
// 1.4.5: the NexusOS hoodie background becomes the default once, even for people who were on the animated one (a picture of your own stays)
if (!config.walls145) { if (!config.wallpaper) delete config.wallpaper; config.walls145 = true; saveConfig(); }

/* ---------------------------------------------------------------- running system tools safely */
function run(cmd, args, { timeout = 15000, input, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = cp.execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...env } },
        (err, stdout, stderr) => {
          if (err) {
            const msg = String(stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' ') || (err.code === 'ENOENT' ? `${cmd} isn’t installed` : err.message);
            const e = new Error(msg.replace(/^(Error:\s*)+/i, '')); e.code = err.code; return reject(e);
          }
          resolve(String(stdout));
        });
    } catch (e) { return reject(e); }
    if (input != null) child.stdin.end(input);
  });
}
const has = (cmd) => new Promise((r) => cp.execFile(IS_WIN ? 'where' : 'sh', IS_WIN ? [cmd] : ['-c', 'command -v "$0"', cmd], { windowsHide: true }, (e) => r(!e)));
// nmcli -t output separates fields with ':' and escapes literal ':' and '\'
function splitTerse(line) { const out = []; let cur = ''; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '\\' && i + 1 < line.length) { cur += line[++i]; } else if (c === ':') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; }
const isMac = (s) => /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(String(s));
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

/* ---------------------------------------------------------------- NexusOS updates: signed manifests from GitHub */
const crypto = require('crypto');
const UPDATE_KEY = '/usr/share/nexusos/update-key.pem';
const updateRepo = () => {
  let repo = 'BenadrylAddict814/nexusos';
  try { const m = /^repo=([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*$/m.exec(fs.readFileSync('/etc/nexusos/update.conf', 'utf8')); if (m) repo = m[1]; } catch (_) {}
  return repo;
};
// NEXUS_UPDATE_BASE is only for testing against a server on this computer
const releaseUrl = (name) => (/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.NEXUS_UPDATE_BASE || '') ? process.env.NEXUS_UPDATE_BASE : `https://github.com/${updateRepo()}/releases/latest/download`) + '/' + name;
const fmtMB = (n) => (n / 1048576).toFixed(1) + ' MB';
const verNum = (v) => String(v).split('.').map((x) => parseInt(x, 10) || 0).concat([0, 0, 0]).slice(0, 3);
const newerThan = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
function prevVersion() {
  try { const p = fs.readFileSync('/var/lib/nexusos/previous', 'utf8').trim(); return JSON.parse(fs.readFileSync(path.join(p, 'resources/app/package.json'), 'utf8')).version || null; } catch (_) { return null; }
}
async function download(url, max, onProgress) {
  const { net } = require('electron');
  const r = await net.fetch(url, { headers: { 'User-Agent': 'NexusOS/' + VERSION }, cache: 'no-store' });
  if (r.status === 404) throw new Error('No NexusOS updates have been published yet.');
  if (!r.ok) throw new Error(`The update server answered ${r.status}. Try again later.`);
  const chunks = []; let got = 0; const reader = r.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; if (got > max) throw new Error('The update is bigger than expected, so it was stopped.'); chunks.push(Buffer.from(value)); if (onProgress) onProgress(got); }
  return Buffer.concat(chunks);
}
async function fetchManifest() {
  if (!fs.existsSync(UPDATE_KEY)) throw new Error('This computer has no NexusOS update key yet.');
  const [raw, sig] = await Promise.all([download(releaseUrl('manifest.json'), 256 * 1024), download(releaseUrl('manifest.json.sig'), 4096)]);
  const ok = crypto.verify(null, raw, crypto.createPublicKey(fs.readFileSync(UPDATE_KEY)), sig);
  if (!ok) throw new Error('The update isn’t signed with your NexusOS key, so it was ignored.');
  const m = JSON.parse(raw.toString('utf8'));
  if (!/^\d+\.\d+(\.\d+)?$/.test(String(m.version)) || !/^[0-9a-f]{64}$/.test(String(m.sha256))) throw new Error('The update’s details don’t make sense, so it was ignored.');
  return { ...m, raw, sig };
}

/* ---------------------------------------------------------------- NexusOS: system integration */
const LX = {
  /* Wi-Fi and network (NetworkManager) */
  async netStatus() {
    const [radio, devs] = await Promise.all([run('nmcli', ['-t', '-f', 'WIFI', 'general']), run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device'])]);
    const list = devs.trim().split('\n').filter(Boolean).map(splitTerse).map(([device, type, state, connection]) => ({ device, type, state, connection }));
    const wifi = list.find((d) => d.type === 'wifi'), eth = list.find((d) => d.type === 'ethernet' && d.state === 'connected');
    return { wifiEnabled: radio.trim() === 'enabled', wifiDevice: wifi ? wifi.device : null, wifiConnected: wifi && wifi.state === 'connected' ? wifi.connection : null, ethernet: eth ? eth.connection : null };
  },
  async wifiList(rescan) {
    const out = await run('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', rescan ? 'yes' : 'auto'], { timeout: 25000 });
    const saved = new Set((await run('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show']).catch(() => '')).trim().split('\n').map(splitTerse).filter((r) => /wireless/.test(r[1] || '')).map((r) => r[0]));
    const best = new Map();
    for (const line of out.trim().split('\n').filter(Boolean)) {
      const [inUse, ssid, signal, security] = splitTerse(line);
      if (!ssid) continue;
      const cur = best.get(ssid); const s = Number(signal) || 0;
      if (!cur || s > cur.signal || inUse === '*') best.set(ssid, { ssid, signal: s, secure: !!security && security !== '--', security, active: inUse === '*' || (cur && cur.active), saved: saved.has(ssid) });
    }
    return [...best.values()].sort((a, b) => (b.active - a.active) || (b.signal - a.signal));
  },
  async wifiConnect(ssid, password, hidden) {
    ssid = String(ssid || '').slice(0, 64); if (!ssid) throw new Error('Choose a network first.');
    const args = ['device', 'wifi', 'connect', ssid];
    if (password) { if (String(password).length < 8) throw new Error('Wi-Fi passwords are at least 8 characters.'); args.push('password', String(password)); }
    if (hidden) args.push('hidden', 'yes');
    const had = (await run('nmcli', ['-t', '-f', 'NAME', 'connection', 'show']).catch(() => '')).split('\n').map((l) => splitTerse(l)[0]).includes(ssid);
    try { await run('nmcli', args, { timeout: 45000 }); }
    catch (e) {
      // don't leave a half-made profile behind with the wrong password in it
      if (!had) await run('nmcli', ['connection', 'delete', 'id', ssid]).catch(() => {});
      if (/secrets were required|802-1X|psk|password/i.test(e.message)) throw new Error('That password didn’t work. Check it and try again.');
      if (/No network with SSID/i.test(e.message)) throw new Error('That network isn’t in range any more.');
      throw e;
    }
    return true;
  },
  wifiDisconnect: async () => { const s = await LX.netStatus(); if (s.wifiDevice) await run('nmcli', ['device', 'disconnect', s.wifiDevice]); return true; },
  wifiForget: async (ssid) => { await run('nmcli', ['connection', 'delete', 'id', String(ssid)]); return true; },
  wifiRadio: async (on) => { await run('nmcli', ['radio', 'wifi', on ? 'on' : 'off']); return true; },

  /* Bluetooth (BlueZ). A background bluetoothctl keeps an agent registered so pairing works. */
  async btStatus() {
    const out = await run('bluetoothctl', ['show']).catch((e) => { if (/No default controller/i.test(e.message)) return ''; throw e; });
    if (!out.trim()) return { present: false };
    const get = (k) => { const m = new RegExp('^\\s*' + k + ':\\s*(.*)$', 'mi').exec(out); return m ? m[1].trim() : ''; };
    return { present: true, powered: get('Powered') === 'yes', name: get('Alias') || get('Name'), discovering: get('Discovering') === 'yes' };
  },
  async btPower(on) {
    if (on) await run('rfkill', ['unblock', 'bluetooth']).catch(() => {});
    await run('bluetoothctl', ['power', on ? 'on' : 'off']); return true;
  },
  async btDevices(scan) {
    btAgent();
    if (scan) await run('bluetoothctl', ['--timeout', '8', 'scan', 'on'], { timeout: 15000 }).catch(() => {});
    const lines = (await run('bluetoothctl', ['devices'])).trim().split('\n').filter(Boolean);
    const devs = [];
    for (const l of lines.slice(0, 40)) {
      const m = /^Device\s+([0-9A-F:]{17})\s+(.*)$/i.exec(l.trim()); if (!m) continue;
      const info = await run('bluetoothctl', ['info', m[1]]).catch(() => '');
      const g = (k) => { const r = new RegExp('^\\s*' + k + ':\\s*(.*)$', 'mi').exec(info); return r ? r[1].trim() : ''; };
      devs.push({ mac: m[1], name: g('Alias') || m[2], paired: g('Paired') === 'yes', connected: g('Connected') === 'yes', icon: g('Icon') });
    }
    return devs.sort((a, b) => (b.connected - a.connected) || (b.paired - a.paired) || a.name.localeCompare(b.name));
  },
  async btConnect(mac) {
    if (!isMac(mac)) throw new Error('That isn’t a Bluetooth device address.');
    btAgent();
    const info = await run('bluetoothctl', ['info', mac]).catch(() => '');
    if (!/Paired:\s*yes/.test(info)) await run('bluetoothctl', ['--timeout', '25', 'pair', mac], { timeout: 30000 });
    await run('bluetoothctl', ['trust', mac]).catch(() => {});
    await run('bluetoothctl', ['--timeout', '20', 'connect', mac], { timeout: 25000 });
    return true;
  },
  btDisconnect: async (mac) => { if (!isMac(mac)) throw new Error('Bad address'); await run('bluetoothctl', ['disconnect', mac]); return true; },
  btRemove: async (mac) => { if (!isMac(mac)) throw new Error('Bad address'); await run('bluetoothctl', ['remove', mac]); return true; },

  /* Sound (PipeWire through pactl) */
  async audio() {
    const [sinks, sources, defSink, defSource] = await Promise.all([
      run('pactl', ['-f', 'json', 'list', 'sinks']), run('pactl', ['-f', 'json', 'list', 'sources']),
      run('pactl', ['get-default-sink']).catch(() => ''), run('pactl', ['get-default-source']).catch(() => '')]);
    const vol = (d) => { const v = d.volume && Object.values(d.volume)[0]; return v ? parseInt(String(v.value_percent), 10) || 0 : 0; };
    const map = (arr, def) => JSON.parse(arr || '[]').filter((d) => !/\.monitor$/.test(d.name)).map((d) => ({ name: d.name, label: d.description || d.name, volume: vol(d), muted: !!d.mute, isDefault: d.name === def.trim() }));
    return { outputs: map(sinks, defSink), inputs: map(sources, defSource) };
  },
  setDefaultOutput: async (name) => { await run('pactl', ['set-default-sink', String(name)]); return true; },
  setDefaultInput: async (name) => { await run('pactl', ['set-default-source', String(name)]); return true; },
  setVolume: async (pct) => { await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', clampInt(pct, 0, 150) + '%']); return true; },
  setMute: async (m) => { await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', m ? '1' : '0']); return true; },
  setMicVolume: async (pct) => { await run('pactl', ['set-source-volume', '@DEFAULT_SOURCE@', clampInt(pct, 0, 150) + '%']); return true; },

  /* Screen brightness */
  async brightness() {
    const out = (await run('brightnessctl', ['-m', '-c', 'backlight']).catch(() => '')).trim();
    if (!out) return { present: false };
    const f = out.split('\n')[0].split(','); return { present: true, device: f[0], percent: parseInt(f[3], 10) || 0 };
  },
  setBrightness: async (pct) => { await run('brightnessctl', ['-c', 'backlight', 'set', clampInt(pct, 5, 100) + '%']); return true; },

  /* Displays (xrandr) */
  async displays() {
    const out = await run('xrandr', ['--query']);
    const outs = []; let cur = null;
    for (const line of out.split('\n')) {
      const m = /^(\S+) (connected|disconnected)( primary)?\s*(\d+x\d+\+\d+\+\d+)?/.exec(line);
      if (m) { cur = m[2] === 'connected' ? { name: m[1], primary: !!m[3], active: !!m[4], modes: [] } : null; if (cur) outs.push(cur); continue; }
      const mm = /^\s+(\d+x\d+)\S*\s+(.*)$/.exec(line);
      if (cur && mm) { const rates = mm[2].trim().split(/\s+/); const current = rates.some((r) => r.includes('*')); const preferred = rates.some((r) => r.includes('+'));
        cur.modes.push({ mode: mm[1], current, preferred, rate: (rates.find((r) => r.includes('*')) || rates[0] || '').replace(/[*+]/g, '') }); }
    }
    return { outputs: outs, zoom: config.zoom || 1 };
  },
  async setMode(output, mode) {
    if (!/^[\w.-]+$/.test(String(output)) || !/^\d+x\d+$/.test(String(mode))) throw new Error('Unknown display mode.');
    await run('xrandr', ['--output', output, '--mode', mode]); return true;
  },
  setZoom: async (z) => { config.zoom = Math.max(0.75, Math.min(2, Number(z) || 1)); saveConfig(); for (const wc of TRUSTED) if (!wc.isDestroyed()) wc.setZoomFactor(config.zoom); return config.zoom; },

  /* Power */
  async battery() {
    const list = (await run('upower', ['-e']).catch(() => '')).split('\n').filter((l) => /battery_/i.test(l));
    if (!list.length) return { present: false };
    const out = await run('upower', ['-i', list[0].trim()]);
    const g = (k) => { const m = new RegExp('^\\s*' + k + ':\\s*(.*)$', 'mi').exec(out); return m ? m[1].trim() : ''; };
    return { present: true, percent: parseFloat(g('percentage')) || 0, state: g('state'), timeToEmpty: g('time to empty'), timeToFull: g('time to full'), health: g('capacity') };
  },
  power: async (action) => {
    const a = { shutdown: 'poweroff', restart: 'reboot', sleep: 'suspend' }[action];
    if (action === 'logout') { setTimeout(() => app.exit(0), 50); return true; }
    if (action === 'windows') { await run('pkexec', ['/usr/lib/nexusos/nexus-system', 'reboot-windows'], { timeout: 60000 }); return true; }
    if (!a) throw new Error('Unknown power action');
    await run('systemctl', [a]); return true;
  },

  /* 1.5: is there a Windows to restart into? (the firmware's boot list, or GRUB's menu) */
  async canBootWindows() {
    if (!IS_LINUX) return false;
    const efi = await run('efibootmgr', [], { timeout: 5000 }).catch(() => '');
    if (/^Boot[0-9A-F]{4}\*?\s+Windows Boot Manager/mi.test(efi)) return true;
    try { return /^menuentry '[^']*Windows/m.test(await fs.promises.readFile('/boot/grub/grub.cfg', 'utf8')); } catch (_) { return false; }
  },
  /* 1.5: performance profiles (power-profiles-daemon) */
  async perfProfile() {
    const out = await run('powerprofilesctl', ['list'], { timeout: 5000 }).catch(() => null);
    if (out == null) return { available: false };
    const profiles = [...out.matchAll(/^\s*(\*)?\s*(power-saver|balanced|performance):/gm)].map((m) => ({ id: m[2], on: !!m[1] }));
    const deg = /degraded:\s*yes\s*\(([^)]*)\)/i.exec(out);
    return { available: profiles.length > 0, current: (profiles.find((p) => p.on) || {}).id || 'balanced', profiles: profiles.map((p) => p.id), degraded: deg ? deg[1] : null };
  },
  async setPerfProfile(p) {
    if (!['power-saver', 'balanced', 'performance'].includes(p)) throw new Error('Unknown profile');
    await run('powerprofilesctl', ['set', p], { timeout: 10000 }); broadcast('sys-changed', 'perf'); return true;
  },

  /* 1.5: game overlay (MangoHud) for Steam games: FPS, GPU temperature and load, Right Shift + F12 shows/hides it */
  async overlay() {
    const steam = await steamInstalled();
    const ov = steam ? await run('flatpak', ['override', '--user', '--show', STEAM_ID], { timeout: 10000 }).catch(() => '') : '';
    const layer = steam ? await mangoLayerInstalled() : false;
    const c = config.overlay || {};
    return { steam, layer, enabled: /^MANGOHUD=1$/m.test(ov), style: c.style === 'fps' ? 'fps' : 'full', position: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(c.position) ? c.position : 'top-left' };
  },
  async setOverlay(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const c = config.overlay = { ...(config.overlay || {}) };
    if (o.style !== undefined) c.style = o.style === 'fps' ? 'fps' : 'full';
    if (o.position !== undefined && ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(o.position)) c.position = o.position;
    saveConfig(); await writeMangoConfig();
    if (o.enabled === true) {
      if (!(await steamInstalled())) throw new Error('Install Steam first (App Store).');
      if (!(await mangoLayerInstalled())) {
        const br = await steamRuntimeBranch(); if (!br) throw new Error('Couldn’t read which runtime Steam uses.');
        await run('flatpak', ['remote-add', '--user', '--if-not-exists', 'flathub', 'https://dl.flathub.org/repo/flathub.flatpakrepo'], { timeout: 60000 });
        await streamJob('overlay', 'flatpak', ['install', '--user', '-y', '--noninteractive', 'flathub', 'org.freedesktop.Platform.VulkanLayer.MangoHud//' + br]);
      }
      await run('flatpak', ['override', '--user', '--env=MANGOHUD=1', STEAM_ID], { timeout: 20000 });
    } else if (o.enabled === false) {
      await run('flatpak', ['override', '--user', '--unset-env=MANGOHUD', STEAM_ID], { timeout: 20000 }).catch(() => {});
    }
    return LX.overlay();
  },

  /* Date and time */
  async time() {
    const [tz, ntp] = await Promise.all([run('timedatectl', ['show', '-p', 'Timezone', '--value']).catch(() => ''), run('timedatectl', ['show', '-p', 'NTP', '--value']).catch(() => '')]);
    return { timezone: tz.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone, ntp: ntp.trim() === 'yes', clock24: config.clock24 !== false };
  },
  timezones: async () => (await run('timedatectl', ['list-timezones'])).trim().split('\n'),
  setTimezone: async (tz) => { if (!/^[A-Za-z0-9_+\-/]+$/.test(String(tz))) throw new Error('Unknown time zone'); await run('timedatectl', ['set-timezone', tz], { timeout: 120000 }); return true; },
  setNtp: async (on) => { await run('timedatectl', ['set-ntp', on ? 'true' : 'false'], { timeout: 120000 }); return !!on; },
  async setDateTime(when) {
    when = String(when || '').trim().replace('T', ' ');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(when)) throw new Error('Pick a date and a time.');
    await run('timedatectl', ['set-time', when.length === 16 ? when + ':00' : when], { timeout: 120000 })
      .catch((e) => { throw new Error(/NTP|automatic/i.test(e.message) ? 'Turn off “Set time automatically” first.' : e.message); });
    return true;
  },
  setClock24: async (v) => { config.clock24 = !!v; saveConfig(); return config.clock24; },

  /* Keyboard layout */
  async keyboard() { const q = await run('setxkbmap', ['-query']).catch(() => ''); const m = /layout:\s*(\S+)/.exec(q); return { layout: m ? m[1] : (config.kbd || 'us') }; },
  async setKeyboard(layout) {
    if (!/^[a-z]{2,3}(\([a-z0-9_]+\))?$/.test(String(layout))) throw new Error('Unknown layout');
    const [l, v] = layout.replace(')', '').split('(');
    await run('setxkbmap', v ? ['-layout', l, '-variant', v] : ['-layout', l]);
    config.kbd = layout; saveConfig(); return true;
  },

  /* Security status */
  async security() {
    const [fw, uu, sb, blk] = await Promise.all([
      run('systemctl', ['is-active', 'ufw']).catch((e) => ''), run('systemctl', ['is-enabled', 'unattended-upgrades']).catch(() => ''),
      run('mokutil', ['--sb-state']).catch(() => ''), run('lsblk', ['-n', '-o', 'TYPE']).catch(() => '')]);
    let apparmor = false; try { apparmor = fs.readFileSync('/sys/module/apparmor/parameters/enabled', 'utf8').trim() === 'Y'; } catch (_) {}
    return { firewall: fw.trim() === 'active', autoUpdates: uu.trim() === 'enabled', secureBoot: /enabled/i.test(sb) ? true : /disabled/i.test(sb) ? false : null,
      encrypted: /\bcrypt\b/.test(blk), apparmor, live: fs.existsSync('/run/live/medium'), nvidiaInstalled: nvidiaInstalled(), nvidiaLoaded: nvidiaPresent() };
  },

  /* Updates: system packages (asks for your password) and apps */
  async updateSystem() {
    await streamJob('update', 'pkexec', ['/usr/lib/nexusos/nexus-update']);
    await streamJob('update', 'flatpak', ['update', '--user', '-y', '--noninteractive']).catch(() => {});
    return true;
  },

  /* Your password (asks for the current one first) */
  async changePassword(pw) {
    pw = String(pw || ''); if (pw.length < 8) throw new Error('Use at least 8 characters.'); if (/[\n\r:]/.test(pw)) throw new Error('Passwords can’t contain line breaks or colons.');
    await run('pkexec', ['/usr/lib/nexusos/nexus-passwd'], { input: pw + '\n', timeout: 120000 }); return true;
  },

  /* Install NexusOS from the live USB */
  installOS: async () => { const bin = ['/usr/bin/install-debian', '/usr/bin/calamares'].find((b) => fs.existsSync(b)); if (!bin) throw new Error('The installer isn’t on this system.'); cp.spawn(bin === '/usr/bin/calamares' ? 'pkexec' : bin, bin === '/usr/bin/calamares' ? [bin] : [], { detached: true, stdio: 'ignore' }).unref(); return true; },

  /* Drives: Windows partitions, USB sticks and SD cards (udisks2 mounts them under /media/you) */
  async drives() {
    const out = JSON.parse(await run('lsblk', ['-J', '-b', '-o', 'PATH,LABEL,FSTYPE,SIZE,MOUNTPOINT,RM,HOTPLUG,TYPE,PARTTYPENAME']));
    const flat = []; const walk = (list, parent) => { for (const d of list || []) { flat.push({ ...d, parent }); walk(d.children, d); } }; walk(out.blockdevices, null);
    const skipFs = new Set(['swap', 'crypto_LUKS', 'LVM2_member', 'iso9660', 'squashfs', 'linux_raid_member']);
    const system = (m) => m && (m === '/' || m === '[SWAP]' || /^\/(boot|home|usr|var)(\/|$)/.test(m) || m.startsWith('/run/live'));
    const res = [];
    for (const d of flat) {
      if (!['part', 'crypt', 'disk'].includes(d.type)) continue;
      const fstype = d.fstype || ''; const bitlocker = /bitlocker/i.test(fstype);
      if (!fstype || skipFs.has(fstype) || system(d.mountpoint)) continue;
      if (/EFI System|Microsoft reserved|Windows recovery|BIOS boot/i.test(d.parttypename || '')) continue;
      const removable = !!(d.rm || d.hotplug || (d.parent && (d.parent.rm || d.parent.hotplug)));
      if (!removable && fstype === 'vfat' && Number(d.size) < 2e9) continue;   // small FAT partitions are boot partitions
      if (d.type === 'disk' && flat.some((x) => x.parent === d && x.fstype)) continue;
      const windows = !removable && (fstype === 'ntfs' || bitlocker);
      res.push({ path: d.path, label: d.label || (windows ? 'Windows' : removable ? 'USB drive' : 'Drive'), fs: fstype, size: Number(d.size) || 0,
        mountpoint: d.mountpoint || null, removable, windows, locked: bitlocker, readOnly: !removable });
    }
    return res;
  },
  async mountDrive(dev) {
    const d = (await LX.drives()).find((x) => x.path === dev); if (!d) throw new Error('That drive isn’t connected any more.');
    if (d.locked) throw new Error('This drive is locked with BitLocker. Unlock it first.');
    if (d.mountpoint) return d.mountpoint;
    // drives inside the laptop open read-only, so nothing here can ever change Windows
    const args = ['mount', '-b', d.path]; if (d.readOnly) args.push('-o', 'ro');
    const outp = await run('udisksctl', args, { timeout: 120000 }).catch((e) => {
      if (/hibernat|unclean|fast restart/i.test(e.message)) throw new Error('Windows didn’t fully shut down (Fast Startup or hibernation), so the drive is locked. Start Windows, turn off Fast Startup, shut down, then try again.');
      if (/not authorized|dismissed|cancel/i.test(e.message)) throw new Error('Cancelled.');
      throw e; });
    const m = / at (.+?)\.?\s*$/.exec(outp.trim()); if (m) return m[1];
    const again = (await LX.drives()).find((x) => x.path === dev); return again && again.mountpoint;
  },
  async unmountDrive(dev) {
    const d = (await LX.drives()).find((x) => x.path === dev); if (!d) return true;
    await run('udisksctl', ['unmount', '-b', d.path], { timeout: 60000 }).catch((e) => { if (/busy/i.test(e.message)) throw new Error('Something is still using this drive. Close it and try again.'); throw e; });
    if (d.removable) await run('udisksctl', ['power-off', '-b', d.path]).catch(() => {});
    return true;
  },
  async renameDrive(dev, label) {
    const d = (await LX.drives()).find((x) => x.path === dev); if (!d) throw new Error('That drive isn’t connected any more.');
    if (!d.removable) throw new Error('Drives inside the laptop are read-only here. Rename them from Windows.');
    if (d.locked) throw new Error('Unlock the drive first.');
    label = String(label || '').trim();
    const max = { vfat: 11, exfat: 15, ntfs: 32, ext4: 16, ext3: 16, ext2: 16, btrfs: 255, xfs: 12 }[d.fs] || 11;
    if (!label || /['"\\\/\x00-\x1f]/.test(label)) throw new Error('That name can’t be used.');
    if (Buffer.byteLength(label) > max) throw new Error(`Names on this drive can be ${max} characters at most.`);
    if (d.fs === 'vfat') label = label.toUpperCase();
    let dev0 = d.path; try { dev0 = fs.realpathSync(d.path); } catch (_) {}
    const obj = '/org/freedesktop/UDisks2/block_devices/' + path.basename(dev0).replace(/[^A-Za-z0-9]/g, (c) => '_' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    await run('gdbus', ['call', '--system', '--dest', 'org.freedesktop.UDisks2', '--object-path', obj, '--method', 'org.freedesktop.UDisks2.Filesystem.SetLabel', `'${label}'`, '@a{sv} {}'], { timeout: 120000 })
      .catch((e) => { throw new Error(/busy|mounted/i.test(e.message) ? 'Eject the drive in Files, plug it back in without opening it, then rename it.' : /not authori[sz]ed|dismissed/i.test(e.message) ? 'Cancelled.' : e.message); });
    return label;
  },
  async unlockDrive(dev, key) {
    const d = (await LX.drives()).find((x) => x.path === dev); if (!d || !d.locked) throw new Error('That drive isn’t locked.');
    key = String(key || '').trim(); if (!key) throw new Error('Type the recovery key.');
    await run('udisksctl', ['unlock', '-b', d.path, '--key-file', '/dev/stdin'], { input: key, timeout: 120000 })
      .catch((e) => { throw new Error(/wrong|incorrect|failed to activate|no key/i.test(e.message) ? 'That key didn’t work. Check it and try again.' : e.message); });
    return true;
  },

  /* Other apps' windows (so they show in NexusOS's taskbar) */
  async windows() {
    const out = await run('wmctrl', ['-lpx']).catch(() => '');
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const m = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+\S+\s?(.*)$/i.exec(l); if (!m) return null;
      return { id: m[1], desktop: +m[2], pid: +m[3], cls: m[4], title: m[5] };
    }).filter((w) => w && w.pid !== process.pid && w.desktop >= 0 && !/^(nexusos|halcyon)/i.test(w.cls));
  },
  focusWindow: async (id) => { if (!/^0x[0-9a-f]+$/i.test(String(id))) throw new Error('Bad window'); await run('wmctrl', ['-ia', id]); return true; },
  closeWindow: async (id) => { if (!/^0x[0-9a-f]+$/i.test(String(id))) throw new Error('Bad window'); await run('wmctrl', ['-ic', id]); return true; },
  minimizeWindow: async (id) => { if (!/^0x[0-9a-f]+$/i.test(String(id))) throw new Error('Bad window'); await run('xdotool', ['windowminimize', String(parseInt(id, 16))]); return true; },
  secureBootSetup: async () => { if (!fs.existsSync('/usr/lib/nexusos/nexus-secureboot')) throw new Error('This isn’t available on this system.'); cp.spawn('lxterminal', ['--title=Secure Boot setup', '-e', 'sudo /usr/lib/nexusos/nexus-secureboot'], { detached: true, stdio: 'ignore' }).unref(); return true; },
  /* Task Manager */
  procs: () => taskSnapshot(),
  async endTask(pids, force) {
    const me = os.userInfo().uid; let n = 0;
    for (const raw of (Array.isArray(pids) ? pids : []).slice(0, 500)) {
      const pid = Number(raw); if (!Number.isInteger(pid) || pid <= 1) continue;
      if (pid === process.pid) throw new Error('That’s the NexusOS desktop itself. Use Log out instead.');
      let uid = -1; try { uid = +(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')) || [])[1]; } catch (_) { continue; }
      if (uid !== me) continue;   // only your own programs
      let comm = '', cmd = ''; try { comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]; } catch (_) { continue; }
      if (cmd === process.execPath || cmd.startsWith(process.execPath + ' ') || KEEP_ALIVE.test(comm)) continue;   // the desktop, window manager and sound/session services
      try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); n++; } catch (_) {}
    }
    if (!n) throw new Error('Nothing was ended. It may have closed already.');
    return n;
  },

  /* NexusOS's own updates (signed GitHub releases) */
  nexusUpdateState: async () => ({ version: VERSION, previous: prevVersion(), rolledBack: process.env.NEXUS_ROLLED_BACK === '1', canUpdate: fs.existsSync('/usr/lib/nexusos/nexus-system') && fs.existsSync(UPDATE_KEY) }),
  nexusUpdateCheck: async () => { const m = await fetchManifest(); return { available: newerThan(m.version, VERSION), version: m.version, notes: String(m.notes || '').slice(0, 4000), size: Number(m.size) || 0, date: m.date || '' }; },
  async nexusUpdateInstall() {
    const m = await fetchManifest();
    if (!newerThan(m.version, VERSION)) throw new Error('You already have the newest NexusOS.');
    const dir = path.join(app.getPath('userData'), 'updates', m.version); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const send = (line, pct) => broadcast('job', { id: 'nexus-update', line, pct });
    fs.writeFileSync(path.join(dir, 'manifest.json'), m.raw); fs.writeFileSync(path.join(dir, 'manifest.json.sig'), m.sig);
    send(`Downloading NexusOS ${m.version}...`, 5);
    const tar = await download(releaseUrl('nexusos-update.tar.gz'), 200 * 1024 * 1024, (got) => send(`Downloading NexusOS ${m.version}... ${fmtMB(got)} of ${fmtMB(m.size)}`, m.size ? Math.min(60, 5 + Math.round(got / m.size * 55)) : null));
    if (crypto.createHash('sha256').update(tar).digest('hex') !== m.sha256) throw new Error('The download is damaged (fingerprint doesn’t match). Try again.');
    fs.writeFileSync(path.join(dir, 'nexusos-update.tar.gz'), tar);
    send('Asking for your password to install...', 62);
    try { await streamJob('nexus-update', 'pkexec', ['/usr/lib/nexusos/nexus-system', 'apply-update', dir]); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
    return m.version;
  },
  nexusRollback: async () => { await streamJob('nexus-update', 'pkexec', ['/usr/lib/nexusos/nexus-system', 'rollback']); return true; },
  restartDesktop: async () => { setTimeout(() => app.exit(3), 100); return true; },
  fixNvidia: async () => { await streamJob('nvidia', 'pkexec', ['/usr/lib/nexusos/nexus-system', 'fix-nvidia']); return true; },
  wifiPowersave: async () => !fs.existsSync('/etc/NetworkManager/conf.d/nexusos-wifi-performance.conf'),
  setWifiPowersave: async (on) => { await run('pkexec', ['/usr/lib/nexusos/nexus-system', 'wifi-powersave', on ? 'on' : 'off'], { timeout: 120000 }); return !!on; },

  openTerminal: async (dir) => { const d = typeof dir === 'string' && dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? path.resolve(dir) : os.homedir(); cp.spawn('lxterminal', ['--working-directory=' + d], { detached: true, stdio: 'ignore' }).unref(); return true; },
  showDesktop: async () => { const on = (await run('wmctrl', ['-m']).catch(() => '')).includes('"showing the desktop" mode: ON'); await run('wmctrl', ['-k', on ? 'off' : 'on']); return !on; },
};

/* ---------------------------------------------------------------- Task Manager: what's running and what it uses */
const TICK = 100; const PAGE = 4096;
const KEEP_ALIVE = /^(nexusos.*|openbox|Xorg|X|systemd|\(sd-pam\)|dbus-daemon|dbus-broker.*|pipewire.*|wireplumber|lightdm.*|lxpolkit|polkit-.*|xss-lock|xdg-desktop-por.*|xdg-document-po.*|xdg-permission-.*|gvfsd.*|at-spi.*)$/;
let tmPrev = null;   // { t, cpuTotal, cpuIdle, procs: Map(pid -> ticks), net: {rx,tx}, disk: {r,w} }
let gpuCache = { t: 0, v: null };
function readCpu() { const l = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number); const idle = l[3] + (l[4] || 0); return { total: l.reduce((a, b) => a + b, 0), idle }; }
function readNet() { let rx = 0, tx = 0; try { for (const l of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) { const m = /^\s*([^:]+):\s*(.*)$/.exec(l); if (!m || m[1] === 'lo') continue; const f = m[2].trim().split(/\s+/).map(Number); rx += f[0]; tx += f[8]; } } catch (_) {} return { rx, tx }; }
function readDisk() { let r = 0, w = 0; try { for (const l of fs.readFileSync('/proc/diskstats', 'utf8').split('\n')) { const f = l.trim().split(/\s+/); if (f.length < 10 || !/^(nvme\d+n\d+|sd[a-z]+|mmcblk\d+|vd[a-z]+)$/.test(f[2])) continue; r += +f[5] * 512; w += +f[9] * 512; } } catch (_) {} return { r, w }; }
async function readGpu() {
  if (!nvidiaPresent()) return null;
  if (Date.now() - gpuCache.t < 1800) return gpuCache.v;
  const out = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits'], { timeout: 4000 }).catch(() => '');
  const f = out.trim().split('\n')[0]; let v = null;
  if (f) { const [name, util, mu, mt, temp, pw] = f.split(',').map((x) => x.trim()); v = { name, util: +util || 0, memUsed: (+mu || 0) * 1048576, memTotal: (+mt || 0) * 1048576, temp: +temp || 0, power: parseFloat(pw) || 0 }; }
  gpuCache = { t: Date.now(), v }; return v;
}
function groupOf(pid, comm, cmd) {
  let cg = ''; try { cg = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'); } catch (_) {}
  const fp = /app-flatpak-([A-Za-z0-9_.-]+?)-\d+\.scope/.exec(cg);
  if (fp) return { id: 'flatpak:' + fp[1], name: (wmClassMap().get(fp[1].toLowerCase()) || {}).name || fp[1].split('.').pop() };
  if (cmd.startsWith(process.execPath) || comm === 'nexusos') return { id: 'nexusos', name: 'NexusOS desktop' };
  if (KEEP_ALIVE.test(comm)) return { id: 'sys:' + comm, name: comm + ' (system)' };
  return { id: 'proc:' + comm, name: comm };
}
async function taskSnapshot() {
  const now = Date.now(), cpu = readCpu(), net = readNet(), disk = readDisk(), me = os.userInfo().uid;
  const cores = os.cpus().length || 1; const ticks = new Map(); const groups = new Map();
  const dt = tmPrev ? (now - tmPrev.t) / 1000 : 0;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue; const pid = +d;
    let stat, status; try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); status = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); } catch (_) { continue; }
    const r = stat.lastIndexOf(')'); const comm = stat.slice(stat.indexOf('(') + 1, r); const f = stat.slice(r + 2).split(' ');
    const t = (+f[11]) + (+f[12]); ticks.set(pid, t);
    const uid = +(/^Uid:\s+(\d+)/m.exec(status) || [])[1]; if (uid !== me) continue;
    const rss = (+(/^VmRSS:\s+(\d+)/m.exec(status) || [0, 0])[1]) * 1024; if (!rss) continue;   // kernel threads have no memory
    let cmd = ''; try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch (_) {}
    const prevT = tmPrev && tmPrev.procs.get(pid); const cpuPct = dt > 0 && prevT != null ? Math.max(0, (t - prevT) / TICK / dt / cores * 100) : 0;
    const g = groupOf(pid, comm, cmd); const e = groups.get(g.id) || { id: g.id, name: g.name, cpu: 0, mem: 0, pids: [] };
    e.cpu += cpuPct; e.mem += rss; e.pids.push(pid); groups.set(g.id, e);
  }
  const mem = fs.readFileSync('/proc/meminfo', 'utf8'); const kb = (k) => (+(new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(mem) || [0, 0])[1]) * 1024;
  const memTotal = kb('MemTotal'), memAvail = kb('MemAvailable');
  const res = {
    cpu: tmPrev ? Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - tmPrev.cpuIdle) / Math.max(1, cpu.total - tmPrev.cpuTotal)))) : 0,
    cores, cpuName: (os.cpus()[0] || {}).model || '', memUsed: memTotal - memAvail, memTotal,
    netRx: dt ? Math.max(0, (net.rx - tmPrev.net.rx) / dt) : 0, netTx: dt ? Math.max(0, (net.tx - tmPrev.net.tx) / dt) : 0,
    diskR: dt ? Math.max(0, (disk.r - tmPrev.disk.r) / dt) : 0, diskW: dt ? Math.max(0, (disk.w - tmPrev.disk.w) / dt) : 0,
    gpu: await readGpu(), uptime: os.uptime(),
    groups: [...groups.values()].map((g) => ({ ...g, cpu: Math.round(g.cpu * 10) / 10 })).sort((a, b) => (b.cpu - a.cpu) || (b.mem - a.mem)),
  };
  tmPrev = { t: now, cpuTotal: cpu.total, cpuIdle: cpu.idle, procs: ticks, net, disk };
  return res;
}

/* ---------------------------------------------------------------- App Store */
const CATALOG = [
  { key: 'discord', name: 'Discord', blurb: 'Voice, video and text chat with friends and communities.', flatpak: 'com.discordapp.Discord', winget: 'Discord.Discord', win: '%LOCALAPPDATA%\\Discord\\Update.exe|--processStart|Discord.exe', cat: 'Social' },
  { key: 'steam', name: 'Steam', blurb: 'Buy, download and play PC games.', flatpak: 'com.valvesoftware.Steam', winget: 'Valve.Steam', win: '%ProgramFiles(x86)%\\Steam\\steam.exe', cat: 'Games', gpu: true },
  { key: 'heroic', name: 'Heroic Games Launcher', blurb: 'Play your Epic Games and GOG libraries.', flatpak: 'com.heroicgameslauncher.hgl', winget: 'HeroicGamesLauncher.HeroicGamesLauncher', cat: 'Games', gpu: true },
  { key: 'prism', name: 'Prism Launcher', blurb: 'Launch and manage Minecraft: Java Edition.', flatpak: 'org.prismlauncher.PrismLauncher', winget: 'PrismLauncher.PrismLauncher', cat: 'Games', gpu: true },
  { key: 'spotify', name: 'Spotify', blurb: 'Music and podcasts.', flatpak: 'com.spotify.Client', winget: 'Spotify.Spotify', win: '%APPDATA%\\Spotify\\Spotify.exe', cat: 'Music & video' },
  { key: 'vlc', name: 'VLC', blurb: 'Plays almost any video or audio file.', flatpak: 'org.videolan.VLC', winget: 'VideoLAN.VLC', win: '%ProgramFiles%\\VideoLAN\\VLC\\vlc.exe', cat: 'Music & video' },
  { key: 'obs', name: 'OBS Studio', blurb: 'Record and stream your screen.', flatpak: 'com.obsproject.Studio', winget: 'OBSProject.OBSStudio', win: '%ProgramFiles%\\obs-studio\\bin\\64bit\\obs64.exe', cat: 'Music & video' },
  { key: 'firefox', name: 'Firefox', blurb: 'A full web browser, if you want one besides NexusOS’s.', flatpak: 'org.mozilla.firefox', winget: 'Mozilla.Firefox', win: '%ProgramFiles%\\Mozilla Firefox\\firefox.exe', cat: 'Internet' },
  { key: 'telegram', name: 'Telegram', blurb: 'Fast, simple messaging.', flatpak: 'org.telegram.desktop', winget: 'Telegram.TelegramDesktop', cat: 'Social' },
  { key: 'blender', name: 'Blender', blurb: '3D modelling, rigging and animation.', flatpak: 'org.blender.Blender', winget: 'BlenderFoundation.Blender', cat: 'Create', gpu: true },
  { key: 'gimp', name: 'GIMP', blurb: 'Edit photos and images.', flatpak: 'org.gimp.GIMP', winget: 'GIMP.GIMP.3', cat: 'Create' },
  { key: 'libreoffice', name: 'LibreOffice', blurb: 'Documents, spreadsheets and presentations.', flatpak: 'org.libreoffice.LibreOffice', winget: 'TheDocumentFoundation.LibreOffice', cat: 'Work' },
  { key: 'vscode', name: 'Visual Studio Code', blurb: 'Code editor.', flatpak: 'com.visualstudio.code', winget: 'Microsoft.VisualStudioCode', win: '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', cat: 'Work' },
];
const byKey = (k) => { const c = CATALOG.find((x) => x.key === k); if (!c) throw new Error('Unknown app'); return c; };
const expandEnv = (s) => s.replace(/%([^%]+)%/g, (_, v) => process.env[v] || '');
const nvidiaPresent = () => { try { return IS_LINUX && fs.readdirSync('/proc/driver/nvidia/gpus').length > 0; } catch (_) { return false; } };
const nvidiaInstalled = () => IS_LINUX && (fs.existsSync('/usr/bin/nvidia-smi') ||
  ['nvidia-current.ko', 'nvidia-current.ko.xz', 'nvidia.ko', 'nvidia.ko.xz'].some((f) => fs.existsSync(path.join('/lib/modules', os.release(), 'updates/dkms', f))));
const STORE = {
  async available() {
    if (IS_LINUX) return has('flatpak');
    if (IS_WIN) return has('winget');
    return false;
  },
  async installed() {
    if (IS_LINUX) {
      const out = await run('flatpak', ['list', '--app', '--columns=application,name,installation']).catch(() => '');
      return out.trim().split('\n').filter(Boolean).map((l) => { const [id, name, inst] = l.split('\t'); const c = CATALOG.find((x) => x.flatpak === id); return { id, name, key: c ? c.key : null, system: inst === 'system' }; });
    }
    if (IS_WIN) {
      const out = await run('winget', ['list', '--accept-source-agreements', '--disable-interactivity'], { timeout: 60000 }).catch(() => '');
      return CATALOG.filter((c) => out.includes(c.winget)).map((c) => ({ id: c.winget, name: c.name, key: c.key }));
    }
    return [];
  },
  async install(key) {
    const c = byKey(key);
    if (IS_LINUX) {
      await run('flatpak', ['remote-add', '--user', '--if-not-exists', 'flathub', 'https://dl.flathub.org/repo/flathub.flatpakrepo'], { timeout: 60000 });
      await streamJob('store:' + key, 'flatpak', ['install', '--user', '-y', '--noninteractive', 'flathub', c.flatpak]);
    } else if (IS_WIN) {
      await streamJob('store:' + key, 'winget', ['install', '--id', c.winget, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']);
    } else throw new Error('The App Store isn’t available here.');
    return true;
  },
  async uninstall(key) {
    const c = byKey(key);
    if (IS_LINUX) await streamJob('store:' + key, 'flatpak', ['uninstall', '--user', '-y', '--noninteractive', c.flatpak]);
    else if (IS_WIN) await streamJob('store:' + key, 'winget', ['uninstall', '--id', c.winget, '-e', '--silent', '--disable-interactivity']);
    return true;
  },
  async launch(idOrKey) {
    if (IS_LINUX) {
      const c = CATALOG.find((x) => x.key === idOrKey);
      const id = c ? c.flatpak : String(idOrKey);
      if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error('Unknown app');
      const env = { ...process.env };
      // On NVIDIA laptops, run games and 3D apps on the NVIDIA GPU
      const args = ['run'];
      if (c && c.gpu && nvidiaPresent()) args.push('--env=__NV_PRIME_RENDER_OFFLOAD=1', '--env=__GLX_VENDOR_LIBRARY_NAME=nvidia', '--env=__VK_LAYER_NV_optimus=NVIDIA_only');
      args.push(id);
      // Steam's menus take clicks only when its interface isn't drawn by the GPU on a desktop without a compositor
      // (NexusOS). Games still run on the graphics card.
      if (id === STEAM_ID) args.push('-cef-disable-gpu');
      cp.spawn('flatpak', args, { detached: true, stdio: 'ignore', env }).unref();
      return true;
    }
    if (IS_WIN) {
      const c = byKey(idOrKey); if (!c.win) throw new Error(`Open ${c.name} from the Windows Start menu.`);
      const [exe, ...args] = c.win.split('|'); const p = expandEnv(exe);
      if (!fs.existsSync(p)) throw new Error(`Couldn’t find ${c.name}. Open it from the Windows Start menu.`);
      cp.spawn(p, args, { detached: true, stdio: 'ignore' }).unref(); return true;
    }
    throw new Error('Not available here');
  },
  async icon(id) {
    if (!IS_LINUX || !/^[A-Za-z0-9_.-]+$/.test(String(id))) return null;
    const roots = [path.join(os.homedir(), '.local/share/flatpak/exports/share/icons/hicolor'), '/var/lib/flatpak/exports/share/icons/hicolor'];
    for (const r of roots) for (const s of ['128x128', '256x256', '64x64', '512x512']) {
      const p = path.join(r, s, 'apps', id + '.png'); if (fs.existsSync(p)) return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
    }
    const svg = roots.map((r) => path.join(r, 'scalable', 'apps', id + '.svg')).find((p) => fs.existsSync(p));
    return svg ? 'data:image/svg+xml;base64,' + fs.readFileSync(svg).toString('base64') : null;
  },
};

/* long-running commands stream their output to the page */
const jobs = new Map();
function streamJob(jobId, cmd, args) {
  if (jobs.has(jobId)) throw new Error('That’s already running.');
  return new Promise((resolve, reject) => {
    let child;
    try { child = cp.spawn(cmd, args, { windowsHide: true, env: { ...process.env, LC_ALL: 'C', DEBIAN_FRONTEND: 'noninteractive' } }); } catch (e) { return reject(e); }
    jobs.set(jobId, child);
    const send = (m) => broadcast('job', { id: jobId, ...m });
    let tail = '';
    const onData = (d) => { const s = String(d); tail = (tail + s).slice(-4000); s.split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean).slice(-3).forEach((line) => { const pct = /(\d{1,3})%/.exec(line); send({ line: line.slice(0, 200), pct: pct ? Math.min(100, +pct[1]) : null }); }); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', (e) => { jobs.delete(jobId); send({ done: true, ok: false }); reject(e.code === 'ENOENT' ? new Error(`${cmd} isn’t installed`) : e); });
    child.on('close', (code) => { jobs.delete(jobId); send({ done: true, ok: code === 0 });
      if (code === 0) resolve(true); else { const last = tail.trim().split('\n').filter(Boolean).slice(-2).join(' '); reject(new Error(code === 126 || code === 127 ? 'Cancelled.' : (last || `Failed (code ${code})`))); } });
  });
}

/* ---------------------------------------------------------------- Windows: settings pages NexusOS can open */
const WIN_SETTINGS = { wifi: 'ms-settings:network-wifi', bluetooth: 'ms-settings:bluetooth', sound: 'ms-settings:sound', display: 'ms-settings:display', power: 'ms-settings:powersleep', time: 'ms-settings:dateandtime', keyboard: 'ms-settings:keyboard', update: 'ms-settings:windowsupdate', security: 'windowsdefender:' };

/* ---------------------------------------------------------------- permissions websites can ask for */
const PERM_ALWAYS = new Set(['fullscreen', 'clipboard-sanitized-write']);
const PERM_ASK = new Set(['media', 'geolocation', 'notifications']);
const permMemo = new Map();
let permSeq = 0; const permWaiting = new Map();
function askPermission(info, wc) {
  return new Promise((resolve) => {
    // ask in the window that shows the site (the Browser), falling back to the desktop
    const host = wc && wc.hostWebContents && !wc.hostWebContents.isDestroyed() && TRUSTED.has(wc.hostWebContents) ? wc.hostWebContents : (anyWin() && anyWin().webContents);
    if (!host) return resolve(false);
    const id = ++permSeq; permWaiting.set(id, resolve);
    host.send('perm-ask', { id, ...info });
    setTimeout(() => { if (permWaiting.has(id)) { permWaiting.delete(id); resolve(false); } }, 60000);
  });
}
// only NexusOS's own Nexa window may use the microphone (for talking to her)
const isNexaPage = (wc) => { try { return !!wc && TRUSTED.has(wc) && /^file:\/\/.*[?&]app=nexa(&|$)/.test(wc.getURL()); } catch (_) { return false; } };
function lockDownSession(ses, isWeb) {
  ses.setPermissionRequestHandler((wc, perm, cb, details) => {
    if (PERM_ALWAYS.has(perm)) return cb(true);
    if (!isWeb && perm === 'media' && isNexaPage(wc) && (details.mediaTypes || []).length && details.mediaTypes.every((t) => t === 'audio')) return cb(true);
    if (!isWeb || !PERM_ASK.has(perm)) return cb(false);
    let origin = ''; try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch (_) { return cb(false); }
    if (!/^https:/.test(origin)) return cb(false); // only secure sites may even ask
    const media = (details.mediaTypes || []).slice().sort().join('+');
    const key = `${origin}|${perm}|${media}`;
    if (permMemo.has(key)) return cb(permMemo.get(key));
    askPermission({ origin, perm, media }, wc).then((ok) => { permMemo.set(key, ok); cb(ok); });
  });
  ses.setPermissionCheckHandler((wc, perm, origin) => {
    if (PERM_ALWAYS.has(perm)) return true;
    if (!isWeb && perm === 'media' && isNexaPage(wc)) return true;
    if (!isWeb) return false;
    for (const [k, v] of permMemo) if (v && k.startsWith(`${origin}|${perm === 'media' ? 'media' : perm}|`)) return true;
    return false;
  });
  ses.setDevicePermissionHandler(() => false); // no USB, HID or serial devices for websites
  ses.on('select-serial-port', (e, _ports, _wc, cb) => { e.preventDefault(); cb(''); });
  ses.on('select-hid-device', (e, _d, cb) => { e.preventDefault(); cb(); });
  ses.on('select-usb-device', (e, _d, cb) => { e.preventDefault(); cb(); });
}

/* ---------------------------------------------------------------- windows
 * On Windows (and in a normal Linux desktop) NexusOS is one full-screen window, as before.
 * As the NexusOS desktop it is several real windows, so they stack properly with other apps:
 *   desktop  – wallpaper, icons and the Bin (always at the bottom)
 *   panel    – the taskbar (always on top, except under full-screen games)
 *   popup    – Start and quick settings (on top of everything while open)
 *   toasts   – notifications and download cards (top right, never takes focus)
 *   app      – one window per NexusOS app (Files, Settings, ...), framed and stacked like any other app
 */
const TRUSTED = new Set();               // webContents of NexusOS's own pages
const appWins = new Map();               // BrowserWindow.id -> { key, win }
let menuOpen = false;   // a right-click menu is open (Start mustn't close under it)
let desktopWin = null, panelWin = null, popupWin = null, toastWin = null, popupWhich = null, popupPrevActive = 0;
const PANEL_H = 52;
const INDEX = path.join(__dirname, 'index.html');
const APP_SIZES = { nexa: [1000, 680], clips: [960, 640], files: [880, 560], notes: [640, 520], web: [1180, 760], calc: [320, 480], term: [700, 440], paint: [760, 560], mines: [340, 440], settings: [900, 620], about: [560, 600], store: [940, 640], bin: [760, 500], taskmgr: [900, 620] };
const APP_MULTI = new Set(['notes']);
const APP_TITLES = { files: 'Files', notes: 'Notes', web: 'Browser', calc: 'Calculator', term: 'Terminal', paint: 'Paint', mines: 'Mines', settings: 'Settings', about: 'About NexusOS', store: 'App Store', bin: 'Bin', taskmgr: 'Task Manager', clips: 'Clips', nexa: 'Nexa' };

function sendTo(w, ch, data) { if (w && !w.isDestroyed()) w.webContents.send(ch, data); }
function broadcast(ch, data) { for (const wc of TRUSTED) if (!wc.isDestroyed()) wc.send(ch, data); }
const anyWin = () => win || desktopWin || [...appWins.values()].map((a) => a.win).find((w) => !w.isDestroyed()) || null;

function guard(w, firstUrl) {
  const wc = w.webContents;
  TRUSTED.add(wc);
  wc.once('destroyed', () => TRUSTED.delete(wc));
  wc.setWindowOpenHandler(({ url }) => { const c = childOpenHandler(wc, url); if (c) return c; if (/^https?:\/\//i.test(url)) openUrl(url); return { action: 'deny' }; });
  wc.on('did-create-window', (child, d) => childCreated(child, d.url));
  let allow = firstUrl || null;   // a desktop child window may load its own page once, nothing else
  wc.on('will-navigate', (e, url) => { if (allow && url === allow) { allow = null; return; } e.preventDefault(); });
  wc.on('will-redirect', (e) => e.preventDefault());
  // Lock down the Browser's <webview>: no bridge, sandboxed, web addresses only
  wc.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload; delete prefs.preloadURL;
    Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, plugins: false, experimentalFeatures: false });
    if (params.partition !== 'persist:halcyon' || !/^(https?:\/\/|about:blank$)/i.test(params.src || '')) e.preventDefault();
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (!OS_MODE && input.key === 'F11' && win) { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (!OS_MODE && input.control && input.shift && input.key.toLowerCase() === 'q') { app.quit(); e.preventDefault(); }
  });
  wc.on('did-finish-load', () => { if (config.zoom && config.zoom !== 1) wc.setZoomFactor(config.zoom); });
}
const PREFS = () => ({ preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true, webSecurity: true, spellcheck: false, navigateOnDragDrop: false, safeDialogs: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' });
// 1.6.2: the taskbar, Start/quick settings and notifications are opened *by* the desktop window, the way a web page
// opens a pop-up, so Chromium runs them inside the desktop's process instead of starting a process for each one.
const INDEX_URL = require('url').pathToFileURL(INDEX).href;
const childWait = new Map(); let childSeq = 0, desktopLoaded = false;
function makeChild(opts, query) {
  return new Promise((resolve) => {
    if (!desktopWin || desktopWin.isDestroyed() || !desktopLoaded) return resolve(makeWin(opts, query));
    const t = 'c' + (++childSeq) + require('crypto').randomBytes(6).toString('hex');
    childWait.set(t, { opts, query, resolve });
    sendTo(desktopWin, 'open-child', { url: INDEX_URL + '?' + new URLSearchParams({ ...query, child: t }), name: t });
    setTimeout(() => { const w = childWait.get(t); if (w) { childWait.delete(t); resolve(makeWin(opts, query)); } }, 6000);   // fall back to a window of its own
  });
}
function childOpenHandler(wc, url) {
  if (!desktopWin || wc !== desktopWin.webContents || !url.startsWith(INDEX_URL + '?')) return null;
  const t = new URL(url).searchParams.get('child'); const w = t && childWait.get(t); if (!w) return null;
  return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: '#05060a', title: 'NexusOS', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, show: false, ...w.opts, webPreferences: PREFS() } };
}
function childCreated(child, url) {
  let t = ''; try { t = new URL(url).searchParams.get('child'); } catch (_) {}
  const w = childWait.get(t); if (!w) { child.destroy(); return; }
  childWait.delete(t); guard(child, url);
  let crashes = 0;
  child.webContents.on('render-process-gone', (_e, d) => { if (d.reason === 'clean-exit' || child.isDestroyed() || ++crashes > 5) return; setTimeout(() => { if (!child.isDestroyed() && desktopLoaded) child.loadFile(INDEX, { query: w.query }); }, 800); });
  w.resolve(child);
}
function makeWin(opts, query) {
  const w = new BrowserWindow({ backgroundColor: '#05060a', title: 'NexusOS', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, show: false, ...opts, webPreferences: PREFS() });
  guard(w);
  // if a desktop part's renderer ever crashes, bring it back instead of leaving a hole (no toasts, no taskbar…)
  let crashes = 0;
  w.webContents.on('render-process-gone', (_e, d) => { if (d.reason === 'clean-exit' || w.isDestroyed() || ++crashes > 5) return; setTimeout(() => { if (!w.isDestroyed()) w.loadFile(INDEX, { query }); }, 800); });
  w.loadFile(INDEX, { query });
  return w;
}
const xid = (w) => { try { const b = w.getNativeWindowHandle(); return b.length >= 4 ? b.readUInt32LE(0) : 0; } catch (_) { return 0; } };

function createWindow() {
  Menu.setApplicationMenu(null);
  if (!OS_MODE) {
    win = makeWin({ width: 1400, height: 900, fullscreen: true }, { view: 'main' });
    win.once('ready-to-show', () => win.show());
    return;
  }
  const b = screen.getPrimaryDisplay().bounds;
  desktopWin = makeWin({ type: 'desktop', frame: false, x: b.x, y: b.y, width: b.width, height: b.height, resizable: false, movable: false, skipTaskbar: true }, { view: 'desktop' });
  desktopWin.once('ready-to-show', () => desktopWin.show());
  const makeBars = async () => {
    const d = screen.getPrimaryDisplay().bounds;
    if (!panelWin || panelWin.isDestroyed()) {
      panelWin = await makeChild({ type: 'dock', frame: false, x: d.x, y: d.y + d.height - PANEL_H, width: d.width, height: PANEL_H, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false }, { view: 'panel' });
      panelWin.once('ready-to-show', () => panelWin.showInactive());
      const pw = panelWin; pw.on('closed', () => { if (panelWin === pw) panelWin = null; });
    }
    if (!popupWin || popupWin.isDestroyed()) {
      popupWin = await makeChild({ frame: false, width: 640, height: 600, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, minimizable: false, maximizable: false, fullscreenable: false }, { view: 'popup' });
      popupWin.on('blur', () => { if (!menuOpen) hidePopup(); });
      const qw = popupWin; qw.on('closed', () => { if (popupWin === qw) popupWin = null; });
    }
  };
  // (if the desktop's process ever restarts, its child windows go with it: open them again)
  let reopen = [];
  desktopWin.webContents.on('did-finish-load', () => {
    desktopLoaded = true;
    makeBars().then(() => { for (const [k, a] of reopen.splice(0)) try { openAppWindow(k, a); } catch (_) {} }).catch(() => {});
  });
  // the desktop's process also hosts the taskbar, Start, notifications and the light apps: if it ever dies,
  // close them all and open them again cleanly once the desktop is back
  desktopWin.webContents.on('render-process-gone', () => {
    desktopLoaded = false;
    for (const w of [panelWin, popupWin, toastWin]) if (w && !w.isDestroyed()) w.destroy();
    panelWin = popupWin = null; toastWin = null; toastReady = false; toastMaking = false;
    for (const a of [...appWins.values()]) if (a.shared && !a.win.isDestroyed()) { reopen.push([a.key, a.arg]); a.win.destroy(); }
  });
  win = desktopWin;   // dialogs belong to the desktop
  const fit = () => {
    const d = screen.getPrimaryDisplay().bounds;
    if (desktopWin && !desktopWin.isDestroyed()) desktopWin.setBounds(d);
    if (panelWin && !panelWin.isDestroyed()) panelWin.setBounds({ x: d.x, y: d.y + d.height - PANEL_H, width: d.width, height: PANEL_H });
    placeToasts();
  };
  screen.on('display-metrics-changed', fit); screen.on('display-added', fit); screen.on('display-removed', fit);
  startWindowWatch();
  startTray();
  startUsbWatch();
  sweepLeftovers();
  setTimeout(() => steamPreferNvidia().catch(() => {}).then(() => ensureNvidiaFlatpakGL()).catch(() => {}), 20000);
  run('openbox', ['--reconfigure']).catch(() => {});   // pick up new window-manager settings after an update
  try { globalShortcut.register('Control+Shift+Escape', () => openAppWindow('taskmgr')); } catch (_) {}
}

/* NexusOS apps as their own windows */
function openAppWindow(key, arg) {
  key = String(key);
  if (!Object.prototype.hasOwnProperty.call(APP_TITLES, key)) throw new Error('Unknown app');
  hidePopup();
  if (!APP_MULTI.has(key)) {
    for (const a of appWins.values()) if (a.key === key && !a.win.isDestroyed()) {
      if (a.win.isMinimized()) a.win.restore(); a.win.show(); a.win.focus();
      if (arg !== undefined && arg !== null) sendTo(a.win, 'app-arg', arg);
      return true;
    }
  }
  const [w0, h0] = APP_SIZES[key] || [720, 520];
  const wa = screen.getPrimaryDisplay().workArea, n = appWins.size % 6;
  const width = Math.min(w0, wa.width - 40), height = Math.min(h0, wa.height - 40);   // the work area already leaves room for the taskbar
  if (appPending.has(key) && !APP_MULTI.has(key)) return true;   // already opening
  const opts = { width, height, minWidth: 300, minHeight: 200, x: Math.round(wa.x + (wa.width - width) / 2 - 60 + n * 28), y: Math.round(wa.y + Math.max(10, (wa.height - height) / 2 - 30 + n * 28)), title: APP_TITLES[key] };
  const query = { view: 'app', app: key, arg: arg == null ? '' : JSON.stringify(arg) };
  // 1.6.2: NexusOS's own light apps run inside the desktop's process (about 25 MB less each);
  // the Browser and Nexa do heavy work, so they keep a process of their own
  const shared = !APP_OWN_PROCESS.has(key);
  appPending.add(key);
  Promise.resolve(shared ? makeChild(opts, query) : makeWin(opts, query)).then((w) => {
    appPending.delete(key);
    appWins.set(w.id, { key, win: w, shared, arg: arg == null ? undefined : arg });
    const id = w.id;
    w.on('closed', () => { appWins.delete(id); pushWindows(true); if (key === 'nexa' && ![...appWins.values()].some((a) => a.key === 'nexa')) nexaStop(); });
    let shown = false; const show = () => { if (shown || w.isDestroyed()) return; shown = true; w.show(); w.focus(); };
    w.once('ready-to-show', show); w.webContents.once('did-finish-load', () => setTimeout(show, 60)); setTimeout(show, 3000);
  }, () => appPending.delete(key));
  return true;
}
const APP_OWN_PROCESS = new Set(['web', 'nexa']); const appPending = new Set();
function openUrl(url) { if (OS_MODE) openAppWindow('web', url); else sendTo(win, 'open-url', url); }

/* Start and quick settings */
function showPopup(which, at) {
  if (!popupWin || popupWin.isDestroyed()) return;
  if (popupWin.isVisible() && popupWhich === which) return hidePopup();
  const d = screen.getPrimaryDisplay().bounds;
  const n = allTray().length, rows = Math.max(1, Math.ceil(n / 4));
  const [w, h] = which === 'quick' ? [380, 650] : which === 'tray' ? [320, Math.min(540, 132 + rows * 88)] : [660, 620];
  const ax = Number(at) || 0;
  const x = which === 'quick' ? d.x + d.width - w - 12 : which === 'tray' ? Math.max(d.x + 8, Math.min(d.x + d.width - w - 8, d.x + Math.round(ax - w / 2))) : Math.round(d.x + (d.width - w) / 2);
  popupWin.setBounds({ x, y: d.y + d.height - PANEL_H - h - 8, width: w, height: h });
  popupWhich = which; popupPrevActive = activeX;
  sendTo(popupWin, 'popup', which);
  popupWin.show(); popupWin.focus();
  sendTo(panelWin, 'popup-state', which);
}
function hidePopup() {
  if (!popupWin || popupWin.isDestroyed() || !popupWin.isVisible()) return;
  popupWin.hide(); popupWhich = null; sendTo(panelWin, 'popup-state', null);
}

/* notifications */
let toastH = 0;
// 1.5: the notifications window only exists while there's something to show (saves ~30 MB the rest of the time)
let toastReady = false, toastIdle = null, toastMaking = false; const toastQueue = [];
function toastSend(ch, data) {
  if (!OS_MODE) return sendTo(win, ch, data);
  clearTimeout(toastIdle);
  if ((!toastWin || toastWin.isDestroyed()) && !toastMaking) {
    const b = screen.getPrimaryDisplay().bounds; toastReady = false; toastH = 0; toastMaking = true;
    makeChild({ type: 'notification', frame: false, width: 380, height: 10, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, x: b.x + b.width - 396, y: b.y + 16 }, { view: 'toasts' }).then((w) => {
      toastWin = w; toastMaking = false;
      const ready = () => { if (toastWin !== w) return; toastReady = true; for (const [c, x] of toastQueue.splice(0)) sendTo(w, c, x); };
      if (!w.webContents.isLoading() && w.webContents.getURL()) ready(); else w.webContents.once('did-finish-load', ready);
      w.on('closed', () => { if (toastWin === w) { toastWin = null; toastReady = false; toastH = 0; } });
    });
  }
  if (toastReady && toastWin && !toastWin.isDestroyed()) sendTo(toastWin, ch, data); else toastQueue.push([ch, data]);
}
function placeToasts() {
  if (!toastWin || toastWin.isDestroyed()) return;
  const d = screen.getPrimaryDisplay().bounds;
  if (toastH <= 0) { toastWin.hide(); clearTimeout(toastIdle); toastIdle = setTimeout(() => { if (toastH <= 0 && toastWin && !toastWin.isDestroyed() && !toastQueue.length) toastWin.destroy(); }, 20000); return; }
  clearTimeout(toastIdle);
  toastWin.setBounds({ x: d.x + d.width - 396, y: d.y + 16, width: 380, height: Math.min(toastH, d.height - PANEL_H - 40) });
  if (!toastWin.isVisible()) toastWin.showInactive();
}

/* the taskbar's list of open windows (NexusOS's own and other apps'), pushed to the panel */
const WMCLASS_CACHE = { t: 0, map: new Map() };
function wmClassMap() {   // StartupWMClass / app-id -> flatpak app, from installed .desktop files
  if (Date.now() - WMCLASS_CACHE.t < 30000) return WMCLASS_CACHE.map;
  const map = new Map();
  for (const dir of [path.join(os.homedir(), '.local/share/flatpak/exports/share/applications'), '/var/lib/flatpak/exports/share/applications']) {
    let list = []; try { list = fs.readdirSync(dir).filter((f) => f.endsWith('.desktop')); } catch (_) {}
    for (const f of list) {
      const id = f.replace(/\.desktop$/, ''); let text = ''; try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) {}
      const name = (/^Name=(.*)$/m.exec(text) || [])[1] || id; const wm = (/^StartupWMClass=(.*)$/m.exec(text) || [])[1];
      const entry = { id, name: name.trim() };
      if (wm) map.set(wm.trim().toLowerCase(), entry);
      map.set(id.toLowerCase(), entry); map.set(id.split('.').pop().toLowerCase(), entry);
    }
  }
  WMCLASS_CACHE.t = Date.now(); WMCLASS_CACHE.map = map; return map;
}
let lastWinSig = '', activeX = 0, watchTimer = null, lastWinList = [];
async function listWindows() {
  const out = await run('wmctrl', ['-lpx'], { timeout: 4000 }).catch(() => '');
  const act = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { timeout: 3000 }).catch(() => '');
  const am = /window id # (0x[0-9a-f]+)/i.exec(act); activeX = am ? parseInt(am[1], 16) : 0;
  const own = new Map(); for (const a of appWins.values()) if (!a.win.isDestroyed()) own.set(xid(a.win), a);
  const skip = new Set([desktopWin, panelWin, popupWin, toastWin].filter((w) => w && !w.isDestroyed()).map(xid));
  const map = wmClassMap(); const res = [];
  for (const l of out.trim().split('\n').filter(Boolean)) {
    const m = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+\S+\s?(.*)$/i.exec(l); if (!m) continue;
    const x = parseInt(m[1], 16), desk = +m[2]; if (skip.has(x) || desk < 0) continue;
    const a = own.get(x); const cls = m[4];
    if (a) { res.push({ id: m[1], key: a.key, title: a.win.getTitle(), own: true, active: x === activeX }); continue; }
    if (/^(nexusos|halcyon)\./i.test(cls)) continue;
    const [inst, klass] = cls.split('.'); const hit = map.get((klass || '').toLowerCase()) || map.get((inst || '').toLowerCase());
    const steamGame = /^steam_app_\d+/i.test(inst || '');
    res.push({ id: m[1], app: hit && !steamGame ? hit.id : null, appName: hit && !steamGame ? hit.name : null, group: hit && !steamGame ? hit.id : (inst || cls).toLowerCase(), title: m[5], cls, active: x === activeX });
  }
  return res;
}
async function pushWindows(force) {
  if (!panelWin || panelWin.isDestroyed()) return;
  const list = await listWindows();
  const sig = JSON.stringify(list);
  lastWinList = list;
  if (force || sig !== lastWinSig) { lastWinSig = sig; sendTo(panelWin, 'windows', list); sendTo(desktopWin, 'windows', list); }
  // hide Start if the person clicked into another window
  // (only when a different window than before Start opened becomes active, so a slow focus change can't close it)
  if (!menuOpen && popupWin && popupWin.isVisible() && activeX && activeX !== xid(popupWin) && activeX !== popupPrevActive) hidePopup();
}
// 1.5: react to window changes as they happen (xprop -spy) instead of asking twice a second, so NexusOS
// wakes up far less while you play; a slow check still catches title changes
let spyProc = null, spyT = null;
function startWindowWatch() {
  clearInterval(watchTimer);
  const poke = () => { clearTimeout(spyT); spyT = setTimeout(() => pushWindows(false).catch(() => {}), 120); };
  try {
    spyProc = cp.spawn('xprop', ['-root', '-spy', '_NET_ACTIVE_WINDOW', '_NET_CLIENT_LIST'], { stdio: ['ignore', 'pipe', 'ignore'] });
    spyProc.stdout.on('data', poke);
    spyProc.on('error', () => { spyProc = null; });
    spyProc.on('exit', () => { spyProc = null; clearInterval(watchTimer); watchTimer = setInterval(() => pushWindows(false).catch(() => {}), 900); });
  } catch (_) { spyProc = null; }
  watchTimer = setInterval(() => pushWindows(false).catch(() => {}), spyProc ? 3000 : 900);
}
app.on('will-quit', () => { if (spyProc) try { spyProc.kill(); } catch (_) {} });
async function windowAction(id, action) {
  if (!/^0x[0-9a-f]+$/i.test(String(id))) throw new Error('Bad window');
  const x = parseInt(id, 16);
  const own = [...appWins.values()].find((a) => !a.win.isDestroyed() && xid(a.win) === x);
  if (action === 'toggle') action = x === activeX ? 'minimize' : 'activate';
  if (own) {
    if (action === 'activate') { if (own.win.isMinimized()) own.win.restore(); own.win.show(); own.win.focus(); }
    else if (action === 'minimize') own.win.minimize();
    else if (action === 'close') own.win.close();
  } else if (action === 'activate') await run('wmctrl', ['-ia', id]);
  else if (action === 'minimize') await run('xdotool', ['windowminimize', String(x)]);
  else if (action === 'close') await run('wmctrl', ['-ic', id]);
  setTimeout(() => pushWindows(true).catch(() => {}), 150);
  return true;
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) contents.loadURL(url); return { action: 'deny' }; });
  contents.on('will-navigate', (e, url) => { if (!/^(https?:|about:blank)/i.test(url)) e.preventDefault(); });
  contents.on('will-redirect', (e, url) => { if (!/^(https?:|about:blank)/i.test(url)) e.preventDefault(); });
});

/* ---------------------------------------------------------------- downloads */
let dlId = 0;
const RISKY_WIN = /\.(exe|msi|msix|appx|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|msc|jar|lnk|reg|iso|img|vhdx?)$/i;
const RISKY_LINUX = /\.(sh|run|bin|appimage|deb|rpm|desktop|py|pl|jar)$/i;
function isRisky(p) {
  if (IS_WIN) return RISKY_WIN.test(p);
  if (RISKY_LINUX.test(p)) return true;
  try { const st = fs.statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch (_) { return false; }
}
function setupDownloads() {
  session.fromPartition('persist:halcyon').on('will-download', (_e, item) => {
    const target = uniquePath(path.join(DRIVE, 'Downloads'), cleanName(item.getFilename() || 'download'));
    item.setSavePath(target);
    const id = ++dlId, name = path.basename(target);
    const send = (m) => toastSend('download', { id, name, path: target, risky: isRisky(target), ...m });
    send({ state: 'start', received: 0, total: item.getTotalBytes() });
    let last = 0;
    item.on('updated', (_ev, state) => {
      const now = Date.now(); if (now - last < 200 && state === 'progressing') return; last = now;
      send({ state: state === 'interrupted' ? 'interrupted' : 'progress', received: item.getReceivedBytes(), total: item.getTotalBytes() });
    });
    item.once('done', (_ev, state) => {
      // Mark the file as coming from the internet so Windows SmartScreen checks it before it runs
      if (state === 'completed' && IS_WIN) {
        let host = ''; try { const u = new URL(item.getURL()); if (/^https?:$/.test(u.protocol)) host = u.origin + '/'; } catch (_) {}
        try { fs.writeFileSync(target + ':Zone.Identifier', `[ZoneTransfer]\r\nZoneId=3\r\n${host ? 'HostUrl=' + host + '\r\n' : ''}`); } catch (_) {}
      }
      send({ state, received: item.getReceivedBytes(), total: item.getTotalBytes() });
    });
  });
}

/* ---------------------------------------------------------------- startup */
function urlFromArgs(argv) { return (argv || []).find((a) => /^https?:\/\//i.test(a)) || null; }
function handleArgs(argv) {
  const url = urlFromArgs(argv);
  const open = ((argv || []).find((a) => /^--open=[a-z]+$/.test(a)) || '').slice(7);
  if (OS_MODE) {
    if (url) openUrl(url);
    if (open && Object.prototype.hasOwnProperty.call(APP_TITLES, open)) openAppWindow(open);
    if ((argv || []).includes('--toggle-start')) { if (popupWin && popupWin.isVisible()) hidePopup(); else showPopup('start'); }
  } else if (url) openUrl(url);
}
app.on('second-instance', (_e, argv) => {
  if (!OS_MODE && win) { if (win.isMinimized()) win.restore(); win.focus(); }
  handleArgs(argv);
});
app.whenReady().then(() => {
  if (!PRIMARY) return;
  ensureDrive();
  try { app.configureHostResolver({ secureDnsMode: 'automatic' }); } catch (_) {} // encrypted DNS when your network supports it
  lockDownSession(session.defaultSession, false);
  lockDownSession(session.fromPartition('persist:halcyon'), true);
  setupDownloads();
  if (OS_MODE && config.kbd) LX.setKeyboard(config.kbd).catch(() => {});
  createWindow();
  const first = OS_MODE ? desktopWin : win; first.webContents.once('did-finish-load', () => setTimeout(() => handleArgs(process.argv), 400));
});
app.on('window-all-closed', () => app.quit());

/* ---------------------------------------------------------------- the only doors into the system */
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!TRUSTED.has(e.sender) || !e.senderFrame || !String(e.senderFrame.url).startsWith('file://')) throw new Error('Not allowed.');
    return fn(...args);
  });
}
ipcMain.on('perm-answer', (e, id, ok) => {
  if (!TRUSTED.has(e.sender)) return;
  const r = permWaiting.get(id); if (r) { permWaiting.delete(id); r(!!ok); }
});

handle('sys:info', () => {
  const cpus = os.cpus();
  return {
    user: os.userInfo().username, host: os.hostname(), platform: `${os.type()} ${os.release()}`, arch: os.arch(),
    cpu: cpus[0] ? cpus[0].model.trim() : 'Unknown', cores: cpus.length, memTotal: os.totalmem(), memFree: os.freemem(),
    appMem: process.memoryUsage().rss, uptime: os.uptime(), home: os.homedir(), sep: path.sep, drive: DRIVE, folders: FOLDERS,
    places: places(), osMode: OS_MODE, isWin: IS_WIN, isLinux: IS_LINUX, version: VERSION, electron: process.versions.electron,
    chrome: process.versions.chrome, nvidia: nvidiaPresent(), nvidiaInstalled: nvidiaInstalled(), live: IS_LINUX && fs.existsSync('/run/live/medium'), clock24: config.clock24 !== false,
  };
});
handle('drive:usage', async () => {
  let bytes = 0, files = 0;
  const skip = OS_MODE ? new Set(['.cache', '.local', '.var', '.config', '.mozilla']) : new Set();
  const walk = async (d, depth) => {
    let list; try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      if (files > 50000 || depth > 12) return;
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1); else if (e.isFile()) { try { bytes += (await fs.promises.stat(p)).size; files++; } catch (_) {} }
    }
  };
  await walk(DRIVE, 0);
  let free = null, total = null;
  try { const s = await fs.promises.statfs(DRIVE); free = s.bavail * s.bsize; total = s.blocks * s.bsize; } catch (_) {}
  return { bytes, files, free, total };
});

handle('fs:list', async (dir) => {
  const target = path.resolve(typeof dir === 'string' && dir ? dir : DRIVE);
  const entries = await fs.promises.readdir(target, { withFileTypes: true });
  const out = [];
  for (const d of entries) {
    if (d.name.startsWith('.') || d.name.startsWith('$')) continue;
    const full = path.join(target, d.name);
    let size = 0, mtime = 0, isDir = d.isDirectory();
    try { const s = await fs.promises.stat(full); size = s.size; mtime = s.mtimeMs; isDir = s.isDirectory(); } catch (_) { continue; }
    out.push({ name: d.name, path: full, dir: isDir, size, mtime });
  }
  out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parent = path.dirname(target) === target ? null : path.dirname(target);
  return { dir: target, parent, inDrive: insideDrive(target), entries: out };
});
handle('fs:readText', async (file) => {
  const s = await fs.promises.stat(file);
  if (!s.isFile()) throw new Error('That isn’t a file.');
  if (s.size > 2 * 1024 * 1024) throw new Error('File is larger than 2 MB');
  return fs.promises.readFile(file, 'utf8');
});
handle('fs:readDataUrl', async (file) => {
  const s = await fs.promises.stat(file);
  if (!s.isFile()) throw new Error('That isn’t a file.');
  if (s.size > 25 * 1024 * 1024) throw new Error('Image is larger than 25 MB');
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext];
  if (!mime) throw new Error('That isn’t an image NexusOS can open.');
  return `data:${mime};base64,` + (await fs.promises.readFile(file)).toString('base64');
});
handle('fs:writeText', async (file, text) => { await fs.promises.writeFile(mustBeInDrive(file), String(text), 'utf8'); return true; });
handle('fs:writeBinary', async (file, b64) => { await fs.promises.writeFile(mustBeInDrive(file), Buffer.from(String(b64), 'base64')); return true; });
handle('fs:unique', (dir, name) => uniquePath(mustBeInDrive(dir), cleanName(name)));
handle('fs:mkdir', async (dir, name) => { const p = uniquePath(mustBeInDrive(dir), cleanName(name || 'New folder')); await fs.promises.mkdir(p); return p; });
handle('fs:rename', async (p, name) => {
  const src = mustBeInDrive(p); if (src === path.resolve(DRIVE)) throw new Error('The drive itself can’t be renamed.');
  const target = mustBeInDrive(path.join(path.dirname(src), cleanName(name)));
  if (target === src) return src;
  if (fs.existsSync(target)) throw new Error('Something with that name is already here.');
  await fs.promises.rename(src, target); return target;
});
handle('fs:trash', async (p) => {
  const t = mustBeInDrive(p);
  if (t === path.resolve(DRIVE) || FOLDERS.some((f) => t === path.join(path.resolve(DRIVE), f))) throw new Error('NexusOS’s main folders can’t be deleted.');
  await shell.trashItem(t); broadcast('sys-changed', 'bin'); return true;
});
handle('fs:addFromPC', async (destDir) => {
  const dest = mustBeInDrive(destDir);
  const r = await dialog.showOpenDialog(win, { title: 'Add files to NexusOS', properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return 0;
  for (const f of r.filePaths) await fs.promises.copyFile(f, uniquePath(dest, path.basename(f)));
  return r.filePaths.length;
});
// Copy something from another drive into your own files (OS mode). Picks the folder by file type.
handle('fs:copyIn', async (src) => {
  const from = path.resolve(String(src || ''));
  const st = await fs.promises.lstat(from);
  if (!st.isFile() && !st.isDirectory()) throw new Error('Only files and folders can be copied.');
  const ext = path.extname(from).toLowerCase();
  const folder = st.isDirectory() ? 'Documents' : /^\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/.test(ext) ? 'Pictures' : /^\.(mp4|mkv|webm|mov|avi)$/.test(ext) ? 'Videos' : /^\.(mp3|flac|wav|ogg|m4a|aac|opus)$/.test(ext) ? 'Music' : 'Documents';
  const to = uniquePath(mustBeInDrive(path.join(DRIVE, folder)), path.basename(from));
  if (st.isDirectory()) await fs.promises.cp(from, to, { recursive: true, dereference: false, errorOnExist: true, force: false });
  else await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  return to;
});
handle('fs:copyToPC', async (file) => {
  const r = await dialog.showSaveDialog(win, { title: 'Copy to your PC', defaultPath: path.join(app.getPath('downloads'), path.basename(file)) });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.copyFile(file, r.filePath); return r.filePath;
});
// Opening files: programs and scripts need an explicit "yes" from the person first
handle('shell:open', async (p, confirmed) => {
  const t = path.resolve(String(p));
  if (!fs.existsSync(t)) throw new Error('That file isn’t there any more.');
  const st = fs.statSync(t);
  if (st.isFile() && isRisky(t) && !confirmed) return { needsConfirm: true, name: path.basename(t), fromInternet: t.startsWith(path.join(DRIVE, 'Downloads')) };
  if (IS_LINUX && /\.(deb|rpm|appimage)$/i.test(t)) throw new Error('Install apps from the App Store instead. It keeps them sandboxed and updated.');
  const err = await shell.openPath(t);
  if (err) throw new Error(err);
  return { opened: true };
});
handle('shell:reveal', (p) => shell.showItemInFolder(path.resolve(String(p))));
handle('shell:external', (url) => { if (/^https?:\/\//i.test(String(url))) return shell.openExternal(String(url)); throw new Error('Only web addresses can be opened.'); });
handle('win:settings', (page) => { if (!IS_WIN) throw new Error('Windows only'); const u = WIN_SETTINGS[page]; if (!u) throw new Error('Unknown page'); return shell.openExternal(u); });

handle('app:quit', () => { if (OS_MODE) throw new Error('Use Log out in the power menu.'); app.quit(); });
handle('app:isFullscreen', () => (win ? win.isFullScreen() : false));
handle('app:fullscreen', () => { if (OS_MODE) return true; const next = !win.isFullScreen(); win.setFullScreen(next); return next; });
const loginOpts = () => (app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(app.getAppPath())] });
handle('app:getLogin', () => (IS_WIN ? app.getLoginItemSettings(loginOpts()).openAtLogin : false));
handle('app:setLogin', (on) => { if (!IS_WIN) return false; app.setLoginItemSettings({ openAtLogin: !!on, ...loginOpts() }); return app.getLoginItemSettings(loginOpts()).openAtLogin; });
handle('app:clock24', (v) => { if (v !== undefined) { config.clock24 = !!v; saveConfig(); } return config.clock24 !== false; });

// NexusOS system settings (only when NexusOS is the desktop)
handle('lx', async (name, ...args) => {
  if (!OS_MODE) throw new Error('This setting is only on NexusOS.');
  if (!Object.prototype.hasOwnProperty.call(LX, name)) throw new Error('Unknown setting.');
  return LX[name](...args);
});
handle('store', async (name, ...args) => {
  if (!Object.prototype.hasOwnProperty.call(STORE, name)) throw new Error('Unknown action.');
  return STORE[name](...args);
});
handle('store:catalog', () => CATALOG.map(({ key, name, blurb, cat, flatpak, winget, gpu, win: w }) => ({ key, name, blurb, cat, id: IS_LINUX ? flatpak : winget, gpu: !!gpu, canLaunch: IS_LINUX || !!w })));

// btAgent: keep one bluetoothctl running as the pairing agent (NexusOS only)
let agentProc = null;
function btAgent() {
  if (!OS_MODE || (agentProc && agentProc.exitCode === null)) return;
  try {
    agentProc = cp.spawn('bluetoothctl', [], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, LC_ALL: 'C' } });
    agentProc.on('error', () => { agentProc = null; });
    agentProc.stdin.write('agent NoInputNoOutput\ndefault-agent\n');
  } catch (_) { agentProc = null; }
}
app.on('before-quit', () => { if (agentProc) try { agentProc.kill(); } catch (_) {} });

/* ---------------------------------------------------------------- 1.4.3: windows, menus, pins, Bin, wallpaper */
handle('win:open', (key, arg) => { if (!OS_MODE) throw new Error('Only on NexusOS'); return openAppWindow(key, arg); });
handle('win:popup', (which, at) => { if (!['start', 'quick', 'tray'].includes(which)) throw new Error('Unknown panel'); showPopup(which, at); return true; });
handle('win:popupHide', () => { hidePopup(); return true; });
handle('win:list', () => listWindows());
handle('win:act', (id, action) => { if (!['activate', 'minimize', 'close', 'toggle'].includes(action)) throw new Error('Unknown action'); return windowAction(id, action); });
handle('toast', (t, s) => { toastSend('toast', { t: String(t || '').slice(0, 120), s: String(s || '').slice(0, 300) }); return true; });
handle('toast:size', (h) => { toastH = Math.max(0, Math.min(2000, Number(h) || 0)); placeToasts(); return true; });
handle('dlg:confirm', async (title, text, ok) => {
  const r = await dialog.showMessageBox(null, { type: 'question', title: 'NexusOS', message: String(title || '').slice(0, 120), detail: String(text || '').slice(0, 400), buttons: [String(ok || 'OK').slice(0, 30), 'Cancel'], defaultId: 1, cancelId: 1, noLink: true });
  return r.response === 0;
});
handle('sys:changed', (what) => { broadcast('sys-changed', String(what || '')); return true; });

// native right-click menus: they draw above every window, like on Windows
ipcMain.handle('menu', (e, items) => {
  if (!TRUSTED.has(e.sender)) throw new Error('Not allowed.');
  const w = BrowserWindow.fromWebContents(e.sender);
  return new Promise((resolve) => {
    let picked = null;
    const build = (list, depth) => (Array.isArray(list) ? list : []).slice(0, 40).map((it) => {
      if (!it || it.type === 'separator') return { type: 'separator' };
      const o = { label: String(it.label || '').slice(0, 80), enabled: it.enabled !== false };
      if (it.type === 'checkbox') { o.type = 'checkbox'; o.checked = !!it.checked; }
      if (it.submenu && depth < 2) o.submenu = build(it.submenu, depth + 1);
      else o.click = () => { picked = String(it.id || ''); };
      return o;
    });
    const menu = Menu.buildFromTemplate(build(items, 0));
    menuOpen = true;
    menu.popup({ window: w || undefined, callback: () => setTimeout(() => { menuOpen = false; resolve(picked); }, 0) });
  });
});

// pinned taskbar apps
const DEFAULT_PINS = [{ type: 'app', key: 'web' }, { type: 'app', key: 'files' }, { type: 'app', key: 'store' }, { type: 'app', key: 'term' }, { type: 'app', key: 'settings' }];
const cleanPin = (p) => p && p.type === 'app' && Object.prototype.hasOwnProperty.call(APP_TITLES, p.key) ? { type: 'app', key: p.key }
  : p && p.type === 'flatpak' && /^[A-Za-z0-9_.-]{3,120}$/.test(p.id) ? { type: 'flatpak', id: p.id, name: String(p.name || p.id).slice(0, 60) } : null;
handle('pins:get', () => (Array.isArray(config.pins) ? config.pins : DEFAULT_PINS));
handle('pins:set', (list) => { config.pins = (Array.isArray(list) ? list : []).map(cleanPin).filter(Boolean).slice(0, 24); saveConfig(); broadcast('sys-changed', 'pins'); return config.pins; });

// the Bin (freedesktop Trash, which is where deleted files go)
const TRASH = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'Trash');
const binName = (n) => { n = String(n || ''); if (!n || n.includes('/') || n === '.' || n === '..') throw new Error('Unknown item'); return n; };
handle('bin:list', async () => {
  if (!OS_MODE) return { supported: false, items: [] };
  const T = TRASH(); let names = []; try { names = await fs.promises.readdir(path.join(T, 'files')); } catch (_) {}
  const items = [];
  for (const n of names.slice(0, 2000)) {
    let orig = '', date = ''; try { const info = await fs.promises.readFile(path.join(T, 'info', n + '.trashinfo'), 'utf8'); orig = decodeURIComponent((/^Path=(.*)$/m.exec(info) || [])[1] || ''); date = (/^DeletionDate=(.*)$/m.exec(info) || [])[1] || ''; } catch (_) {}
    let st = null; try { st = await fs.promises.lstat(path.join(T, 'files', n)); } catch (_) { continue; }
    items.push({ name: n, display: orig ? path.basename(orig) : n, from: orig ? path.dirname(orig) : '', date, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size });
  }
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { supported: true, items };
});
handle('bin:restore', async (n) => { if (!OS_MODE) throw new Error('The Bin is only on NexusOS.');
  n = binName(n); const T = TRASH(); const src = path.join(T, 'files', n);
  let orig = ''; try { orig = decodeURIComponent((/^Path=(.*)$/m.exec(await fs.promises.readFile(path.join(T, 'info', n + '.trashinfo'), 'utf8')) || [])[1] || ''); } catch (_) {}
  let destDir = orig && insideDrive(path.dirname(orig)) ? path.dirname(orig) : path.join(DRIVE, 'Documents');
  await fs.promises.mkdir(mustBeInDrive(destDir), { recursive: true });
  const dest = uniquePath(destDir, orig ? path.basename(orig) : n);
  await moveAcross(src, dest);
  await fs.promises.rm(path.join(T, 'info', n + '.trashinfo'), { force: true });
  broadcast('sys-changed', 'files'); return dest;
});
handle('bin:delete', async (n) => { if (!OS_MODE) throw new Error('The Bin is only on NexusOS.'); n = binName(n); const T = TRASH(); await fs.promises.rm(path.join(T, 'files', n), { recursive: true, force: true }); await fs.promises.rm(path.join(T, 'info', n + '.trashinfo'), { force: true }); broadcast('sys-changed', 'bin'); return true; });
handle('bin:empty', async () => { if (!OS_MODE) throw new Error('The Bin is only on NexusOS.'); const T = TRASH(); for (const d of ['files', 'info']) { const p = path.join(T, d); let l = []; try { l = await fs.promises.readdir(p); } catch (_) {} for (const f of l) await fs.promises.rm(path.join(p, f), { recursive: true, force: true }); } broadcast('sys-changed', 'bin'); return true; });

// copy / move / new text file / properties
async function moveAcross(from, to) {   // rename, or copy + delete when the two places are on different disks
  try { await fs.promises.rename(from, to); }
  catch (e) { if (e.code !== 'EXDEV') throw e; await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false, dereference: false }); await fs.promises.rm(from, { recursive: true, force: true }); }
}
const MAIN_FOLDERS = () => [path.resolve(DRIVE), ...FOLDERS.map((f) => path.join(path.resolve(DRIVE), f))];
handle('fs:copyTo', async (src, destDir) => {
  const from = path.resolve(String(src || '')); const dir = mustBeInDrive(String(destDir || ''));
  const st = await fs.promises.lstat(from);
  if (!st.isFile() && !st.isDirectory()) throw new Error('Only files and folders can be copied.');
  if (st.isDirectory() && (dir === from || dir.startsWith(from + path.sep))) throw new Error('A folder can’t be copied into itself.');
  const to = uniquePath(dir, path.basename(from));
  if (st.isDirectory()) await fs.promises.cp(from, to, { recursive: true, dereference: false, errorOnExist: true, force: false });
  else await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  broadcast('sys-changed', 'files'); return to;
});
handle('fs:moveTo', async (src, destDir) => {
  const from = mustBeInDrive(String(src || '')); const dir = mustBeInDrive(String(destDir || ''));
  if (MAIN_FOLDERS().includes(from)) throw new Error('NexusOS’s main folders can’t be moved.');
  if (path.dirname(from) === dir) return from;
  if (dir === from || dir.startsWith(from + path.sep)) throw new Error('A folder can’t be moved into itself.');
  const to = uniquePath(dir, path.basename(from));
  await moveAcross(from, to);
  broadcast('sys-changed', 'files'); return to;
});
handle('fs:newText', async (dir) => { const p = uniquePath(mustBeInDrive(dir), 'New text document.txt'); await fs.promises.writeFile(p, '', { flag: 'wx' }); broadcast('sys-changed', 'files'); return p; });
handle('fs:stat', async (p) => {
  const t = path.resolve(String(p || '')); const st = await fs.promises.stat(t);
  let size = st.size, files = 0, folders = 0;
  if (st.isDirectory()) {
    size = 0; const walk = async (d, depth) => { let l; try { l = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of l) { if (files + folders > 20000 || depth > 20) return; const q = path.join(d, e.name);
        if (e.isDirectory()) { folders++; await walk(q, depth + 1); } else if (e.isFile()) { files++; try { size += (await fs.promises.stat(q)).size; } catch (_) {} } } };
    await walk(t, 0);
  }
  return { path: t, name: path.basename(t), dir: st.isDirectory(), size, files, folders, modified: st.mtimeMs, created: st.birthtimeMs || st.ctimeMs, inDrive: insideDrive(t) };
});

// desktop background picture (a private copy, so it stays even if the original is deleted)
const WALL_DIR = () => app.getPath('userData');
handle('wall:set', async (p) => {
  const from = path.resolve(String(p || '')); const ext = path.extname(from).toLowerCase();
  if (!/^\.(png|jpe?g|webp|gif|bmp)$/.test(ext)) throw new Error('Only pictures can be the desktop background.');
  const st = await fs.promises.stat(from); if (!st.isFile() || st.size > 40 * 1024 * 1024) throw new Error('That picture is too big (40 MB at most).');
  for (const f of await fs.promises.readdir(WALL_DIR())) if (/^wallpaper\./.test(f)) await fs.promises.rm(path.join(WALL_DIR(), f), { force: true });
  const to = path.join(WALL_DIR(), 'wallpaper' + ext); await fs.promises.copyFile(from, to);
  config.wallpaper = path.basename(to); saveConfig(); broadcast('sys-changed', 'wallpaper'); return true;
});
// 1.4.5: backgrounds that come with NexusOS (app/wallpapers). A fresh install starts on the first one.
const BUILTIN_WALLS = { 'nexus-hoodie': 'NexusOS hoodie', 'nexus-hoodie-tan': 'NexusOS hoodie (tan)' };
const curWall = () => (config.wallpaper === undefined ? 'builtin:nexus-hoodie' : config.wallpaper);
handle('wall:builtins', () => Object.entries(BUILTIN_WALLS).map(([id, name]) => ({ id, name, url: `wallpapers/${id}.jpg`, thumb: `wallpapers/${id}-thumb.jpg`, on: curWall() === 'builtin:' + id })));
handle('wall:useBuiltin', async (id) => {
  if (!Object.prototype.hasOwnProperty.call(BUILTIN_WALLS, id)) throw new Error('Unknown background');
  if (config.wallpaper && !String(config.wallpaper).startsWith('builtin:')) await fs.promises.rm(path.join(WALL_DIR(), path.basename(config.wallpaper)), { force: true });
  config.wallpaper = 'builtin:' + id; saveConfig(); broadcast('sys-changed', 'wallpaper'); return true;
});
handle('wall:get', async () => {
  const w = curWall(); if (!w) return null;
  if (String(w).startsWith('builtin:')) { const id = String(w).slice(8); return Object.prototype.hasOwnProperty.call(BUILTIN_WALLS, id) && fs.existsSync(path.join(__dirname, 'wallpapers', id + '.jpg')) ? `wallpapers/${id}.jpg` : null; }
  const p = path.join(WALL_DIR(), path.basename(config.wallpaper));
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }[path.extname(p).toLowerCase()];
  try { return `data:${mime};base64,` + (await fs.promises.readFile(p)).toString('base64'); } catch (_) { return null; }
});
handle('wall:clear', async () => { if (config.wallpaper && !String(config.wallpaper).startsWith('builtin:')) await fs.promises.rm(path.join(WALL_DIR(), path.basename(config.wallpaper)), { force: true }); config.wallpaper = null; saveConfig(); broadcast('sys-changed', 'wallpaper'); return true; });

/* ---------------------------------------------------------------- 1.5: gaming helpers */
const STEAM_ID = 'com.valvesoftware.Steam';
const steamInstalled = () => run('flatpak', ['info', STEAM_ID], { timeout: 10000 }).then(() => true, () => false);
const steamRuntimeBranch = async () => { const r = await run('flatpak', ['info', '--show-runtime', STEAM_ID], { timeout: 10000 }).catch(() => ''); const m = /\/([^/\s]+)\s*$/.exec(r.trim()); return m ? m[1] : null; };
async function mangoLayerInstalled() {
  const br = await steamRuntimeBranch(); if (!br) return false;
  const out = await run('flatpak', ['list', '--runtime', '--columns=application,branch'], { timeout: 15000 }).catch(() => '');
  return out.split('\n').some((l) => { const [a, b] = l.trim().split('\t'); return a === 'org.freedesktop.Platform.VulkanLayer.MangoHud' && b === br; });
}
const MANGO_MARK = '# Written by NexusOS (Settings > Gaming). Delete this line to keep your own changes.';
async function writeMangoConfig() {
  const c = config.overlay || {}; const pos = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(c.position) ? c.position : 'top-left';
  const common = [MANGO_MARK, 'legacy_layout=false', 'position=' + pos, 'toggle_hud=Shift_R+F12', 'round_corners=8', 'background_alpha=0.45', 'font_size=20', 'text_outline'];
  const body = c.style === 'fps' ? ['fps_only', 'fps_color_change'] : ['fps', 'fps_color_change', 'frame_timing', 'gpu_stats', 'gpu_temp', 'gpu_power', 'vram', 'cpu_stats', 'cpu_temp', 'ram'];
  const text = [...common, ...body].join('\n') + '\n';
  for (const dir of [path.join(os.homedir(), '.config/MangoHud'), path.join(os.homedir(), '.var/app', STEAM_ID, 'config/MangoHud')]) {
    const f = path.join(dir, 'MangoHud.conf');
    try { const cur = await fs.promises.readFile(f, 'utf8'); if (!cur.startsWith(MANGO_MARK)) continue; } catch (_) {}
    try { await fs.promises.mkdir(dir, { recursive: true }); await fs.promises.writeFile(f, text); } catch (_) {}
  }
}
// Steam games (Proton uses Vulkan) always go to the NVIDIA GPU on hybrid laptops, however Steam was started
// 1.5.1: Flatpak apps (Steam) need their own copy of the NVIDIA driver files, 64-bit and 32-bit, matching the
// installed driver exactly. After a driver update they go missing and Steam warns "i386 ... extensions are not installed".
let nvExtBusy = false;
async function ensureNvidiaFlatpakGL() {
  if (!OS_MODE || nvExtBusy || !nvidiaPresent() || !(await steamInstalled())) return;
  let v = ''; try { v = fs.readFileSync('/sys/module/nvidia/version', 'utf8').trim(); } catch (_) { return; }
  if (!/^\d+(\.\d+){1,3}$/.test(v)) return;
  const tag = v.replace(/\./g, '-'), want = ['org.freedesktop.Platform.GL.nvidia-' + tag, 'org.freedesktop.Platform.GL32.nvidia-' + tag];
  const out = await run('flatpak', ['list', '--runtime', '--columns=application'], { timeout: 20000 }).catch(() => null); if (out == null) return;
  const have = new Set(out.split('\n').map((l) => l.trim()));
  const missing = want.filter((x) => !have.has(x)); if (!missing.length) return;
  nvExtBusy = true;
  try {
    await run('flatpak', ['remote-add', '--user', '--if-not-exists', 'flathub', 'https://dl.flathub.org/repo/flathub.flatpakrepo'], { timeout: 60000 }).catch(() => {});
    toastSend('toast', { t: 'Setting up NVIDIA graphics for Steam', s: `Downloading the driver files for your NVIDIA driver (${v}). Restart Steam when it's done.` });
    const br = await steamRuntimeBranch();
    let ok = false;
    for (const b of ['1.4', br].filter(Boolean)) {
      try { await run('flatpak', ['install', '--user', '-y', '--noninteractive', 'flathub', ...missing.map((x) => x + '//' + b)], { timeout: 900000 }); ok = true; break; } catch (_) {}
    }
    toastSend('toast', ok ? { t: 'NVIDIA graphics for Steam are ready', s: 'Quit Steam (bottom-right arrow) and open it again.' } : { t: 'Couldn’t set up NVIDIA graphics for Steam', s: 'Check your internet connection. NexusOS will try again next time you start.' });
  } finally { nvExtBusy = false; }
}
async function steamPreferNvidia() {
  if (!OS_MODE || !nvidiaPresent() || !(await steamInstalled())) return;
  const ov = await run('flatpak', ['override', '--user', '--show', STEAM_ID], { timeout: 10000 }).catch(() => '');
  if (!/__VK_LAYER_NV_optimus=NVIDIA_only/.test(ov)) await run('flatpak', ['override', '--user', '--env=__VK_LAYER_NV_optimus=NVIDIA_only', STEAM_ID], { timeout: 20000 }).catch(() => {});
}

/* ---------------------------------------------------------------- 1.4.4: the system tray (apps running in the background) */
let trayProc = null, trayItems = [], trayReq = 0, trayRestarts = 0; const trayWait = new Map();
function startTray() {
  if (!OS_MODE || trayProc) return;
  const bin = '/usr/lib/nexusos/nexus-tray'; if (!fs.existsSync(bin)) return;
  try { trayProc = cp.spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch (_) { trayProc = null; return; }
  let buf = '';
  trayProc.stdout.on('data', (d) => {
    buf += String(d); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.type === 'items') { trayItems = Array.isArray(m.items) ? m.items.slice(0, 64) : []; sendTray(); }
      else if ((m.type === 'menu' || m.type === 'error') && trayWait.has(m.req)) { const r = trayWait.get(m.req); trayWait.delete(m.req); r(m.type === 'menu' ? (m.items || []) : []); }
      else if (m.type === 'ready') trayRestarts = 0;
    }
  });
  trayProc.on('exit', () => { trayProc = null; trayItems = []; sendTray(); if (trayRestarts++ < 5) setTimeout(startTray, 3000); });
  trayProc.on('error', () => { trayProc = null; });
}
function traySend(obj) { if (trayProc && trayProc.stdin.writable) trayProc.stdin.write(JSON.stringify(obj) + '\n'); }
// NexusOS's own background helpers (Clips) sit in the same list as other apps' tray icons
const CLIPS_ICON = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#1b1030"/><rect x="4" y="7" width="12" height="10" rx="2.5" fill="none" stroke="#ff2e88" stroke-width="1.8"/><path d="M16 10.5 20 8v8l-4-2.5z" fill="#ff2e88"/><circle cx="10" cy="12" r="2.2" fill="#00e5ff"/></svg>').toString('base64');
const ownTray = () => (clipProc ? [{ key: 'nexus:clips', id: 'clips', title: 'Clips', tooltip: `Clips — press ${clipCfg().key} to save the last ${clipCfg().seconds} seconds`, status: 'Active', icon: CLIPS_ICON, hasMenu: true, own: true }] : []);
const allTray = () => [...ownTray(), ...trayItems];
function sendTray() { const l = allTray(); sendTo(panelWin, 'tray', l); sendTo(popupWin, 'tray', l); }
const trayItem = (key) => allTray().find((t) => t.key === key);
handle('tray:list', () => allTray());
handle('tray:act', (key, action) => {
  if (key === 'nexus:clips') { hidePopup(); if (action === 'activate') openAppWindow('clips'); return true; }
  if (!trayItem(key)) throw new Error('That app has closed.');
  if (!['activate', 'secondary', 'contextmenu'].includes(action)) throw new Error('Unknown action');
  const d = screen.getPrimaryDisplay().bounds; hidePopup();
  traySend({ cmd: action, key, x: d.x + d.width - 200, y: d.y + d.height - PANEL_H }); return true;
});
handle('tray:menu', (key) => new Promise((resolve) => {
  if (key === 'nexus:clips') return resolve([{ id: 1, label: `Save a clip now (${clipCfg().key})` }, { id: 2, label: 'Open Clips' }]);
  if (!trayItem(key) || !trayProc) return resolve([]);
  const req = ++trayReq; trayWait.set(req, resolve); traySend({ cmd: 'menu', req, key });
  setTimeout(() => { if (trayWait.has(req)) { trayWait.delete(req); resolve([]); } }, 4000);
}));
handle('tray:event', (key, id) => {
  if (key === 'nexus:clips') { hidePopup(); if (id === 1) clipsSave(); else if (id === 2) openAppWindow('clips'); else if (id === 3) clipsStop(); return true; }
  if (!trayItem(key) || !Number.isInteger(id)) throw new Error('That app has closed.'); traySend({ cmd: 'event', key, id }); return true; });
// Quit an app completely (not just close its window): Flatpak apps with "flatpak kill", others by process
async function quitApp(appId, pid) {
  if (appId) {
    if (!/^[A-Za-z0-9_.-]{3,120}$/.test(String(appId))) throw new Error('Unknown app');
    await run('flatpak', ['kill', String(appId)], { timeout: 15000 }); return true;
  }
  if (Number.isInteger(pid) && pid > 1) return LX.endTask([pid], false);
  throw new Error('NexusOS couldn’t tell which program that is.');
}
handle('tray:quit', (key) => { if (key === 'nexus:clips') return clipsStop().then(() => true); const t = trayItem(key); if (!t) throw new Error('That app has closed.'); return quitApp(t.appId, t.pid); });
handle('app:quitFlatpak', (appId) => quitApp(appId, 0));

/* ---------------------------------------------------------------- 1.4.4: a chime when a USB device is plugged in or pulled out */
let usbProc = null, usbTimer = null, usbPending = null, usbKnown = null;
const removableSet = async () => { try { return new Set((await LX.drives()).filter((d) => d.removable).map((d) => d.path)); } catch (_) { return new Set(); } };
function startUsbWatch() {
  if (!OS_MODE || usbProc) return;
  removableSet().then((s) => { usbKnown = s; });
  try { usbProc = cp.spawn('udevadm', ['monitor', '--udev', '--subsystem-match=usb/usb_device'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { usbProc = null; return; }
  let buf = '';
  usbProc.stdout.on('data', (d) => {
    buf += String(d); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = /^UDEV\s+\[[^\]]*\]\s+(add|remove)\s/.exec(line); if (!m) continue;
      // a hub or a composite device fires several events at once: chime once, for the last one
      usbPending = m[1] === 'add' ? 'in' : 'out'; clearTimeout(usbTimer); usbTimer = setTimeout(usbFire, 350);
    }
  });
  usbProc.on('exit', () => { usbProc = null; setTimeout(startUsbWatch, 10000); });
}
async function usbFire() {
  const kind = usbPending; usbPending = null;
  if (config.usbSound !== false) playSound(kind === 'in' ? 'usb-in' : 'usb-out');
  // a USB stick takes a moment to show up as a drive: offer to open it
  if (kind === 'in') await new Promise((r) => setTimeout(r, 2500));
  const now = await removableSet(); const before = usbKnown || new Set(); usbKnown = now;
  const added = [...now].filter((p) => !before.has(p));
  if (kind === 'in' && added.length) {
    const d = (await LX.drives().catch(() => [])).find((x) => x.path === added[0]);
    toastSend('toast', { t: 'USB drive connected', s: `${(d && d.label) || 'USB drive'} is ready. Open it from Files.` });
  }
}
handle('app:usbSound', (v) => { if (v !== undefined) { config.usbSound = !!v; saveConfig(); } return config.usbSound !== false; });

// short system sounds go through the sound server directly (no Chromium audio process kept around)
function playSound(name) {
  const f = path.join(__dirname, 'sounds', name + '.wav'); if (!fs.existsSync(f)) return;
  const tries = [['paplay', [f]], ['pw-play', [f]], ['aplay', ['-q', f]]];
  const next = () => { const t = tries.shift(); if (!t) return; const p = cp.spawn(t[0], t[1], { stdio: 'ignore' }); p.on('error', next); };
  next();
}


/* ---------------------------------------------------------------- 1.5: Clips (instant replay, like Medal or ShadowPlay)
 * GPU Screen Recorder (Flathub) keeps the last N seconds in a small buffer using the GPU's video encoder,
 * and saves them when you press the clip key. Nothing runs until you open Clips; closing its window keeps
 * it clipping in the background (it shows under the taskbar arrow, where you can quit it). */
const GSR_ID = 'com.dec05eba.gpu_screen_recorder';
const CLIP_DEFAULTS = { seconds: 30, quality: 'high', fps: 60, target: 'focused', gameAudio: true, mic: '', key: 'F8', storage: 'ram', notify: true, autostart: true };
const CLIP_KBPS = { standard: 10000, high: 20000, ultra: 40000 };
const clipCfg = () => ({ ...CLIP_DEFAULTS, ...(config.clips || {}) });
const clipsDir = () => path.join(os.homedir(), 'Videos', 'Clips');
let clipProc = null, clipPid = 0, clipErr = '', clipStarting = false, clipKeyOn = '', clipWatch = null, clipLastSave = 0;
const clipState = () => ({ running: !!clipProc, starting: clipStarting, error: clipErr, cfg: clipCfg(), dir: clipsDir(), memMB: clipCfg().storage === 'disk' ? 0 : Math.round(CLIP_KBPS[clipCfg().quality] / 8 / 1000 * clipCfg().seconds) });
function clipsChanged() { broadcast('clips', clipState()); sendTray(); }
const gsrInstalled = () => run('flatpak', ['info', GSR_ID], { timeout: 10000 }).then(() => true, () => false);
function gsrArgs(c) {
  const d = screen.getPrimaryDisplay(); const W = Math.round(d.size.width * d.scaleFactor), H = Math.round(d.size.height * d.scaleFactor);
  let target = 'focused';
  if (c.target === 'screen') target = 'screen';
  else if (/^window:\d+$/.test(c.target)) target = c.target.slice(7);
  const a = ['-w', target];
  if (target === 'focused') a.push('-s', `${W}x${H}`);
  a.push('-c', 'mp4', '-k', 'h264', '-ac', 'aac', '-f', String(c.fps === 30 ? 30 : 60), '-fm', 'cfr', '-bm', 'cbr', '-q', String(CLIP_KBPS[c.quality] || CLIP_KBPS.high),
    '-r', String(Math.max(5, Math.min(600, c.seconds | 0))), '-replay-storage', c.storage === 'disk' ? 'disk' : 'ram', '-cursor', 'yes', '-o', clipsDir());
  const audio = []; if (c.gameAudio) audio.push('default_output');
  if (c.mic === 'default') audio.push('default_input'); else if (c.mic && /^[\w.:@-]{1,200}$/.test(c.mic)) audio.push('device:' + c.mic);
  if (audio.length) a.push('-a', audio.join('|'));
  return a;
}
// the recorder runs inside Flatpak's sandbox: find its real process to send it signals
function findDescendant(root, comm) {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const r = st.lastIndexOf(')'); const ppid = +st.slice(r + 2).split(' ')[1]; const name = st.slice(st.indexOf('(') + 1, r);
      if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push([+d, name]); } catch (_) {}
  }
  const q = [root];
  while (q.length) { const p = q.shift(); for (const [pid, name] of kids.get(p) || []) { if (name.startsWith(comm)) return pid; q.push(pid); } }
  return 0;
}
async function clipsStart() {
  if (!OS_MODE) throw new Error('Clips works on NexusOS.');
  if (clipProc || clipStarting) return clipState();
  clipStarting = true; clipErr = ''; clipsChanged();
  try {
    if (!(await gsrInstalled())) throw new Error('NOT_INSTALLED');
    await fs.promises.mkdir(clipsDir(), { recursive: true });
    const c = clipCfg(); let errBuf = '';
    const p = cp.spawn('flatpak', ['run', '--command=gpu-screen-recorder', '--filesystem=' + clipsDir(), GSR_ID, ...gsrArgs(c)], { stdio: ['ignore', 'ignore', 'pipe'] });
    clipProc = p;
    p.stderr.on('data', (d) => { errBuf = (errBuf + String(d)).slice(-2000); });
    p.on('exit', (code) => {
      if (clipProc !== p) return;
      clipProc = null; clipPid = 0; clipKeys(false);
      if (code && !p.nexusStop) clipErr = gsrError(errBuf);
      clipsChanged();
    });
    // wait for the real recorder to come up (or fail)
    for (let i = 0; i < 40 && clipProc === p && !clipPid; i++) { await new Promise((r) => setTimeout(r, 250)); clipPid = findDescendant(p.pid, 'gpu-screen-reco'); }
    if (clipProc !== p) throw new Error(clipErr || 'The recorder stopped straight away.');
    clipKeys(true); startClipWatch();
  } catch (e) {
    clipErr = e.message === 'NOT_INSTALLED' ? '' : errMsgOf(e);
    clipStarting = false; clipsChanged();
    throw e;
  }
  clipStarting = false; clipsChanged(); return clipState();
}
const errMsgOf = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
function gsrError(t) {
  const lines = String(t).split('\n').map((l) => l.trim()).filter((l) => /error|failed|unable|not supported|invalid/i.test(l));
  const last = lines.pop() || String(t).trim().split('\n').pop() || '';
  if (/audio|device/i.test(last)) return 'The recorder couldn’t open that microphone or sound device. Pick another one in Options.';
  if (/window/i.test(last)) return 'The recorder couldn’t capture that window. Try “Whole screen” in Options.';
  return 'The recorder stopped: ' + last.replace(/^gsr (error|info):\s*/i, '').slice(0, 200);
}
async function clipsStop() {
  const p = clipProc; if (!p) return clipState();
  p.nexusStop = true; clipKeys(false);
  try { if (clipPid) process.kill(clipPid, 'SIGINT'); else p.kill('SIGINT'); } catch (_) {}
  await new Promise((r) => { const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} r(); }, 4000); p.once('exit', () => { clearTimeout(t); r(); }); });
  clipProc = null; clipPid = 0; clipsChanged(); return clipState();
}
function clipsSave() {
  if (!clipProc || !clipPid) throw new Error('Clips isn’t recording. Open Clips and press Start.');
  if (Date.now() - clipLastSave < 1500) return false;   // key held down / pressed twice
  clipLastSave = Date.now();
  const act = lastWinList.find((w) => w.active && !w.own); clipGame = act ? act.title : '';
  process.kill(clipPid, 'SIGUSR1'); return true;
}
function clipKeys(on) {
  if (clipKeyOn) { try { globalShortcut.unregister(clipKeyOn); } catch (_) {} clipKeyOn = ''; }
  if (!on) return;
  const k = clipCfg().key;
  try { if (globalShortcut.register(k, () => { try { clipsSave(); } catch (_) {} })) clipKeyOn = k; else clipErr = `The key ${k} is taken by something else. Pick another in Options.`; } catch (_) { clipErr = `NexusOS can’t use ${k} as the clip key. Pick another in Options.`; }
}
// name new clips after the game, play a sound and show a note
let clipGame = ''; const clipSeen = new Set();
const clipSafe = (t) => String(t || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
function startClipWatch() {
  if (clipWatch) return;
  try {
    clipWatch = fs.watch(clipsDir(), (ev, name) => {
      if (!name || !/^Replay_.*\.mp4$/.test(name) || clipSeen.has(name)) return;
      clipSeen.add(name); setTimeout(() => clipSeen.delete(name), 120000);
      const f = path.join(clipsDir(), name); let last = -1, n = 0;
      const tick = async () => {
        let st; try { st = await fs.promises.stat(f); } catch (_) { return; }
        if (st.size !== last || n < 2) { last = st.size; n++; if (n < 60) setTimeout(tick, 500); return; }
        const m = /Replay_(\d{4}-\d\d-\d\d)_(\d\d-\d\d-\d\d)/.exec(name);
        const base = `${clipSafe(clipGame) || 'Clip'} ${m ? m[1] + ' ' + m[2] : new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')}`;
        let to = path.join(clipsDir(), base + '.mp4'); for (let i = 2; fs.existsSync(to); i++) to = path.join(clipsDir(), `${base} (${i}).mp4`);
        try { await fs.promises.rename(f, to); } catch (_) { to = f; }
        const c = clipCfg();
        playSound('clip');
        if (c.notify) toastSend('toast', { t: 'Clip saved', s: `Last ${c.seconds} seconds · ${path.basename(to, '.mp4')}` });
        broadcast('clips-saved', path.basename(to));
      };
      setTimeout(tick, 400);
    });
  } catch (_) {}
}
handle('clips:state', async () => ({ ...clipState(), installed: await gsrInstalled() }));
handle('clips:install', async () => {
  await run('flatpak', ['remote-add', '--user', '--if-not-exists', 'flathub', 'https://dl.flathub.org/repo/flathub.flatpakrepo'], { timeout: 60000 });
  await streamJob('clips:install', 'flatpak', ['install', '--user', '-y', '--noninteractive', 'flathub', GSR_ID]); return true;
});
handle('clips:start', () => clipsStart());
handle('clips:stop', () => clipsStop());
handle('clips:save', () => clipsSave());
handle('clips:setCfg', async (o) => {
  const c = clipCfg(), n = { ...c }; o = o && typeof o === 'object' ? o : {};
  if ([15, 30, 60, 120, 300].includes(o.seconds)) n.seconds = o.seconds;
  if (Object.prototype.hasOwnProperty.call(CLIP_KBPS, o.quality)) n.quality = o.quality;
  if ([30, 60].includes(o.fps)) n.fps = o.fps;
  if (o.target === 'focused' || o.target === 'screen' || /^window:\d{1,12}$/.test(String(o.target))) n.target = o.target;
  if (typeof o.gameAudio === 'boolean') n.gameAudio = o.gameAudio;
  if (typeof o.mic === 'string' && (o.mic === '' || o.mic === 'default' || /^[\w.:@-]{1,200}$/.test(o.mic))) n.mic = o.mic;
  if (typeof o.key === 'string' && /^((Ctrl|Control|Alt|Shift|Super)\+){0,3}(F([1-9]|1[0-9]|2[0-4])|[A-Z0-9]|Insert|Home|End|PageUp|PageDown|Pause|ScrollLock|PrintScreen|numadd|numsub|nummult|numdiv|num[0-9])$/.test(o.key)) n.key = o.key;
  if (o.storage === 'ram' || o.storage === 'disk') n.storage = o.storage;
  if (typeof o.notify === 'boolean') n.notify = o.notify;
  if (typeof o.autostart === 'boolean') n.autostart = o.autostart;
  config.clips = n; saveConfig();
  const needRestart = ['seconds', 'quality', 'fps', 'target', 'gameAudio', 'mic', 'storage'].some((k) => n[k] !== c[k]);
  if (clipProc && needRestart) { await clipsStop(); await clipsStart().catch(() => {}); }
  else if (clipProc && n.key !== c.key) clipKeys(true);
  clipsChanged(); return clipState();
});
handle('clips:list', async () => {
  let l = []; try { l = await fs.promises.readdir(clipsDir()); } catch (_) { return []; }
  const out = [];
  for (const n of l) { if (!/\.mp4$/i.test(n) || /^Replay_/.test(n)) continue; try { const st = await fs.promises.stat(path.join(clipsDir(), n)); if (st.isFile()) out.push({ name: n, path: path.join(clipsDir(), n), size: st.size, time: st.mtimeMs }); } catch (_) {} }
  return out.sort((a, b) => b.time - a.time).slice(0, 200);
});
handle('clips:audio', async () => {
  const out = await run('flatpak', ['run', '--command=gpu-screen-recorder', GSR_ID, '--list-audio-devices'], { timeout: 20000 }).catch(() => '');
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('|'); return i > 0 ? { id: l.slice(0, i), name: l.slice(i + 1) } : { id: l, name: l }; })
    .filter((d) => !/\.monitor$/.test(d.id) && !/^default_(output|input)$/.test(d.id));
});
handle('clips:windows', () => lastWinList.filter((w) => !w.own).map((w) => ({ id: String(parseInt(w.id, 16)), title: w.title || w.cls })));
app.on('will-quit', () => { if (clipProc) { try { if (clipPid) process.kill(clipPid, 'SIGINT'); clipProc.kill('SIGINT'); } catch (_) {} } });


/* ---------------------------------------------------------------- 1.6: Nexa, the NexusOS assistant
 * Everything runs on this computer: llama.cpp (Vulkan, so the NVIDIA card does the work) with a small Qwen model
 * for her brain, and sherpa-onnx for her voice (Kokoro) and ears (Whisper). Nothing runs until her window opens,
 * and closing it stops all of it, which gives the memory and graphics card back to your games. */
const NEXA_DIR = () => path.join(os.homedir(), '.local/share/nexusos/nexa');
const NEXA_MODEL_REV = '1e1094e82febb22ad75c2802fc1cbc94c74f8481';
const NEXA_PARTS = [
  { key: 'engine', name: 'Her brain: the engine', size: 33256546, dir: 'engine', check: 'llama-server', sha256: '856fcfe9b273e6e813c8d5745396693080ce1cca8134b1180f0e8e2f22b21772',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b10456/llama-b10456-bin-ubuntu-vulkan-x64.tar.gz' },
  { key: 'model', name: 'Her brain: the AI model (Qwen3 4B)', size: 2500000000, file: 'model.gguf', sha256: 'etag',
    url: `https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/${NEXA_MODEL_REV}/Qwen3-4B-Instruct-2507-Q4_K_M.gguf` },
  { key: 'speech', name: 'Voice and hearing: the engine', size: 28156791, dir: 'sherpa', check: 'bin/sherpa-onnx-offline-tts', sha256: 'c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2' },
  { key: 'voice', name: 'Her voice (Kokoro)', size: 132303094, dir: 'voice2', check: 'lexicon-us-en.txt', sha256: '4c3052abaa60943a341f193888cf6abd68787dae6ab8ae5c925a706caa247e4e',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2' },
  { key: 'ears', name: 'Her hearing (Whisper)', size: 208576005, dir: 'ears', check: 'base.en-encoder.int8.onnx', sha256: '475bc7052ce299c007f6d5d5407ba8601f819a2867f6eecee510ed17df581542',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.en.tar.bz2' },
];
// Kokoro v1.0 speaker numbers
const NEXA_VOICES = { af_heart: [3, 'Heart (sweet, expressive)'], af_bella: [2, 'Bella (warm)'], af_kore: [5, 'Kore (smooth)'], af_aoede: [1, 'Aoede (soft)'], af_nicole: [6, 'Nicole (whispery)'],
  jf_alpha: [37, 'Alpha (anime accent)'], af_sky: [10, 'Sky (bright)'], af_sarah: [9, 'Sarah (calm)'], bf_emma: [21, 'Emma (British)'], bf_lily: [23, 'Lily (British)'] };
const NEXA_DEFAULTS = { name: 'Nexa', skin: 'light', voice: 'af_heart', pitch: -1.5, speak: true, control: true,
  personality: 'Cheerful, playful and a little teasing, like a gamer best friend. Genuinely helpful and honest; gets excited about games; keeps things short and sweet.' };
const nexaCfg = () => { const c = { ...NEXA_DEFAULTS, ...(config.nexa || {}) }; if (!NEXA_VOICES[c.voice]) c.voice = NEXA_DEFAULTS.voice; return c; };
const nexaPartDone = (p) => p.file ? fs.existsSync(path.join(NEXA_DIR(), p.file)) : fs.existsSync(path.join(NEXA_DIR(), p.dir, p.check));
let nexaInstalling = false;
function sha256File(f) {
  return new Promise((resolve, reject) => { const h = require('crypto').createHash('sha256'); fs.createReadStream(f).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex'))); });
}
async function nexaInstall() {
  if (nexaInstalling) throw new Error('Nexa is already downloading.');
  nexaInstalling = true;
  try {
    const dir = NEXA_DIR(); await fs.promises.mkdir(dir, { recursive: true });
    for (const p of NEXA_PARTS) {
      if (nexaPartDone(p)) continue;
      broadcast('nexa-setup', { key: p.key, name: p.name, state: 'start' });
      let want = p.sha256;
      if (want === 'etag') {   // Hugging Face publishes each file's SHA-256 as its "linked etag"
        const head = await run('curl', ['-sIL', '--max-time', '30', p.url], { timeout: 40000 }).catch(() => '');
        const m = /^x-linked-etag:\s*"?([0-9a-f]{64})"?/im.exec(head); want = m ? m[1] : null;
        if (!want) throw new Error('Couldn’t reach Hugging Face to check the AI model. Check your internet connection and try again.');
      }
      const tmp = path.join(dir, `.${p.key}.download`);
      await streamJob('nexa:' + p.key, 'curl', ['-L', '--fail', '--retry', '3', '-C', '-', '-#', '-o', tmp, p.url]).catch((e) => { throw new Error(`Couldn’t download ${p.name}: ${errMsgOf(e)}`); });
      broadcast('nexa-setup', { key: p.key, name: p.name, state: 'checking' });
      if ((await sha256File(tmp)) !== want) { await fs.promises.rm(tmp, { force: true }); throw new Error(`${p.name} didn’t download correctly (it doesn’t match its fingerprint). Try again.`); }
      if (p.file) await fs.promises.rename(tmp, path.join(dir, p.file));
      else {
        const to = path.join(dir, p.dir); await fs.promises.rm(to, { recursive: true, force: true }); await fs.promises.mkdir(to, { recursive: true });
        await run('tar', [p.url.endsWith('.bz2') ? '-xjf' : '-xzf', tmp, '-C', to, '--strip-components=1', '--no-same-owner'], { timeout: 600000 });
        await fs.promises.rm(tmp, { force: true });
        if (!nexaPartDone(p)) throw new Error(`${p.name} is missing files after unpacking.`);
      }
      broadcast('nexa-setup', { key: p.key, name: p.name, state: 'done' });
    }
    await fs.promises.rm(path.join(dir, 'voice'), { recursive: true, force: true });   // 1.6.0's older, smaller voice pack
    return true;
  } finally { nexaInstalling = false; }
}
async function nexaRemove() {
  await nexaStop();
  for (const d of ['engine', 'sherpa', 'voice', 'voice2', 'ears', 'model.gguf', 'tmp']) await fs.promises.rm(path.join(NEXA_DIR(), d), { recursive: true, force: true });
  return true;
}
// ---- her brain: llama-server, only while her window is open
const nexaKids = new Set(); let nexaAbort = null;
let nexaSrv = null, nexaPort = 0, nexaKey = '', nexaReady = null, nexaErr = '', nexaDevice = '';
const freePort = () => new Promise((resolve, reject) => { const srv = require('net').createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); }); srv.on('error', reject); });
function nexaStart() {
  if (nexaReady) return nexaReady;
  nexaReady = (async () => {
    const eng = path.join(NEXA_DIR(), 'engine'), model = path.join(NEXA_DIR(), 'model.gguf');
    if (!fs.existsSync(path.join(eng, 'llama-server')) || !fs.existsSync(model)) throw new Error('NOT_INSTALLED');
    nexaPort = await freePort(); nexaKey = require('crypto').randomBytes(24).toString('hex'); nexaErr = '';
    // use the NVIDIA card; never the software renderer, and don't split her across the laptop's built-in graphics too
    const envE = { ...process.env, LD_LIBRARY_PATH: eng };
    const devs = [...(await new Promise((res) => cp.execFile(path.join(eng, 'llama-server'), ['--list-devices'], { cwd: eng, env: envE, timeout: 30000 }, (_e, o, er) => res(String(o) + '\n' + String(er)))))
      .matchAll(/^\s*(Vulkan\d+):\s*(.+?)\s*\((\d+) MiB/gm)].map((m) => ({ id: m[1], name: m[2], mem: +m[3] }));
    const real = devs.filter((d) => !/llvmpipe|lavapipe|swiftshader|software/i.test(d.name));
    const dev = real.find((d) => /nvidia|geforce|rtx|gtx/i.test(d.name)) || real.filter((d) => d.mem >= 3000).sort((a, b) => b.mem - a.mem)[0];
    nexaDevice = dev ? dev.name : 'processor';
    let tail = '';
    const p = cp.spawn(path.join(eng, 'llama-server'), ['-m', model, '--host', '127.0.0.1', '--port', String(nexaPort), '--api-key', nexaKey,
      ...(dev ? ['--device', dev.id, '-ngl', '999'] : ['--device', 'none', '-ngl', '0', '-t', String(Math.max(2, os.cpus().length - 2))]),
      // 1.6.2: a smaller, compressed conversation memory (about half the graphics memory, still room for a long chat)
      '-c', '6144', '-ctk', 'q8_0', '-np', '1', '--jinja', '--no-webui'],
      { cwd: eng, env: envE, stdio: ['ignore', 'ignore', 'pipe'] });
    nexaSrv = p;
    p.stderr.on('data', (d) => { tail = (tail + String(d)).slice(-3000); });
    p.on('exit', (code) => { if (nexaSrv === p) { nexaSrv = null; nexaReady = null; if (code) nexaErr = tail.trim().split('\n').slice(-2).join(' '); broadcast('nexa-state', { up: false, error: nexaErr }); } });
    for (let i = 0; i < 480; i++) {   // loading the model takes a few seconds (longer the first time)
      if (nexaSrv !== p) {
        if (/model loading error|failed to load model|invalid magic|gguf/i.test(nexaErr)) throw new Error('Her AI model file is damaged. Open her settings, choose “Remove downloads”, then download her again.');
        if (/out of memory|ErrorOutOfDeviceMemory|failed to allocate/i.test(nexaErr)) throw new Error('Not enough graphics memory right now. Close a game or other heavy app and open her again.');
        throw new Error('Her brain stopped while starting: ' + (nexaErr || 'unknown error'));
      }
      try { const r = await fetch(`http://127.0.0.1:${nexaPort}/health`); if (r.ok) { broadcast('nexa-state', { up: true }); return true; } } catch (_) {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Her brain took too long to start.');
  })();
  nexaReady.catch(() => { nexaReady = null; });
  return nexaReady;
}
async function nexaStop() {
  for (const c of nexaKids) { try { c.kill('SIGKILL'); } catch (_) {} } nexaKids.clear();
  const p = nexaSrv; nexaSrv = null; nexaReady = null;
  if (p) { try { p.kill('SIGTERM'); } catch (_) {} setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 5000); }
  fs.promises.rm(path.join(NEXA_DIR(), 'tmp'), { recursive: true, force: true }).catch(() => {});
  return true;
}
app.on('will-quit', () => { nexaStop(); });
// ---- what she can do on the computer
function steamGames() {
  const root = path.join(os.homedir(), '.var/app', STEAM_ID, '.local/share/Steam');
  const libs = new Set([path.join(root, 'steamapps')]);
  try { for (const m of fs.readFileSync(path.join(root, 'steamapps/libraryfolders.vdf'), 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) libs.add(path.join(m[1], 'steamapps')); } catch (_) {}
  const out = [];
  for (const lib of libs) { let l = []; try { l = fs.readdirSync(lib); } catch (_) { continue; }
    for (const f of l) { if (!/^appmanifest_\d+\.acf$/.test(f)) continue; try { const t = fs.readFileSync(path.join(lib, f), 'utf8'); const id = /"appid"\s+"(\d+)"/.exec(t), nm = /"name"\s+"([^"]+)"/.exec(t);
      if (id && nm && !/^(Steamworks Common Redistributables|Proton|Steam Linux Runtime)/i.test(nm[1])) out.push({ id: id[1], name: nm[1] }); } catch (_) {} } }
  return out;
}
const NEXA_APPS = { files: 'Files', browser: 'web', settings: 'settings', 'app store': 'store', terminal: 'term', 'task manager': 'taskmgr', clips: 'clips', notes: 'notes', calculator: 'calc', paint: 'paint', bin: 'bin' };
const NEXA_TOOLS = [
  { name: 'open_app', description: 'Open an app. NexusOS apps: Files, Browser, Settings, App Store, Terminal, Task Manager, Clips, Notes, Calculator, Paint, Bin. Also installed apps like Steam, Discord, Firefox.', parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } },
  { name: 'list_steam_games', description: 'List the games installed in Steam.', parameters: { type: 'object', properties: {} } },
  { name: 'launch_steam_game', description: 'Start an installed Steam game by (part of) its name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'set_volume', description: 'Set the speaker volume, 0-100.', parameters: { type: 'object', properties: { percent: { type: 'integer' } }, required: ['percent'] } },
  { name: 'set_brightness', description: 'Set the screen brightness, 5-100.', parameters: { type: 'object', properties: { percent: { type: 'integer' } }, required: ['percent'] } },
  { name: 'set_performance_mode', description: 'Switch the performance profile.', parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['battery_saver', 'balanced', 'performance'] } }, required: ['mode'] } },
  { name: 'save_clip', description: 'Save a clip of the last moments of gameplay (Clips must be running).', parameters: { type: 'object', properties: {} } },
  { name: 'set_wallpaper', description: 'Change the desktop background.', parameters: { type: 'object', properties: { which: { type: 'string', enum: ['hoodie', 'hoodie_tan', 'animated'] } }, required: ['which'] } },
  { name: 'system_status', description: 'Battery, memory, CPU/GPU load and temperature, performance mode.', parameters: { type: 'object', properties: {} } },
  { name: 'power', description: 'Sleep, restart, shut down, or restart into Windows. The user is always asked to confirm.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['sleep', 'restart', 'shutdown', 'restart_windows'] } }, required: ['action'] } },
];
async function nexaTool(name, a, wc) {
  a = a && typeof a === 'object' ? a : {};
  const win = BrowserWindow.fromWebContents(wc);
  switch (name) {
    case 'open_app': {
      const q = String(a.app || '').toLowerCase().trim(); if (!q) return 'Which app?';
      const own = NEXA_APPS[q] || Object.keys(APP_TITLES).find((k) => k === q || APP_TITLES[k].toLowerCase() === q);
      if (own) { openAppWindow(own); return `Opened ${APP_TITLES[own]}.`; }
      const inst = await STORE.installed().catch(() => []);
      const hit = inst.find((x) => String(x.name || '').toLowerCase() === q) || inst.find((x) => String(x.name || '').toLowerCase().includes(q)) || inst.find((x) => x.id.toLowerCase().includes(q));
      if (!hit) return `No app called “${a.app}” is installed.`;
      await STORE.launch(hit.key || hit.id); return `Opened ${hit.name}.`;
    }
    case 'list_steam_games': { const g = steamGames(); return g.length ? 'Installed Steam games: ' + g.map((x) => x.name).join(', ') : 'No Steam games are installed (or Steam isn’t installed).'; }
    case 'launch_steam_game': {
      const q = String(a.name || '').toLowerCase(); const g = steamGames();
      const hit = g.find((x) => x.name.toLowerCase() === q) || g.find((x) => x.name.toLowerCase().includes(q)) || g.find((x) => q.split(/\s+/).every((w) => x.name.toLowerCase().includes(w)));
      if (!hit) return `No installed Steam game matches “${a.name}”. Installed: ${g.map((x) => x.name).join(', ') || 'none'}.`;
      const args = ['run']; if (nvidiaPresent()) args.push('--env=__NV_PRIME_RENDER_OFFLOAD=1', '--env=__GLX_VENDOR_LIBRARY_NAME=nvidia', '--env=__VK_LAYER_NV_optimus=NVIDIA_only');
      cp.spawn('flatpak', [...args, STEAM_ID, '-cef-disable-gpu', 'steam://rungameid/' + hit.id], { detached: true, stdio: 'ignore' }).unref();
      return `Starting ${hit.name} through Steam.`;
    }
    case 'set_volume': { const v = Math.max(0, Math.min(100, Math.round(+a.percent || 0))); await LX.setVolume(v); broadcast('sys-changed', 'volume'); return `Volume is now ${v}%.`; }
    case 'set_brightness': { const v = Math.max(5, Math.min(100, Math.round(+a.percent || 0))); await LX.setBrightness(v); return `Brightness is now ${v}%.`; }
    case 'set_performance_mode': { const m = { battery_saver: 'power-saver', balanced: 'balanced', performance: 'performance' }[a.mode]; if (!m) return 'Unknown mode.'; await LX.setPerfProfile(m); return `Performance mode is now ${a.mode.replace('_', ' ')}.`; }
    case 'save_clip': { try { clipsSave(); return 'Saved a clip.'; } catch (e) { return errMsgOf(e); } }
    case 'set_wallpaper': {
      if (a.which === 'animated') { config.wallpaper = null; saveConfig(); broadcast('sys-changed', 'wallpaper'); return 'Switched to the animated background.'; }
      const id = a.which === 'hoodie_tan' ? 'nexus-hoodie-tan' : 'nexus-hoodie'; config.wallpaper = 'builtin:' + id; saveConfig(); broadcast('sys-changed', 'wallpaper'); return 'Background changed.';
    }
    case 'system_status': {
      const [b, g, pf] = await Promise.all([LX.battery().catch(() => null), readGpu().catch(() => null), LX.perfProfile().catch(() => null)]);
      const parts = [];
      if (b && b.present) parts.push(`battery ${Math.round(b.percent)}% (${b.state}${b.health ? ', health ' + b.health : ''})`);
      parts.push(`memory ${Math.round((os.totalmem() - os.freemem()) / 1073741824 * 10) / 10} of ${Math.round(os.totalmem() / 1073741824)} GB used`);
      parts.push(`CPU load ${os.loadavg()[0].toFixed(1)} on ${os.cpus().length} threads`);
      if (g) parts.push(`GPU ${g.name}: ${g.util}% busy, ${g.temp}°C`);
      if (pf && pf.available) parts.push(`performance mode ${pf.current}`);
      return parts.join('; ') + '.';
    }
    case 'power': {
      const act = { sleep: 'sleep', restart: 'restart', shutdown: 'shutdown', restart_windows: 'windows' }[a.action]; if (!act) return 'Unknown action.';
      const label = { sleep: 'put the computer to sleep', restart: 'restart the computer', shutdown: 'shut down the computer', windows: 'restart into Windows' }[act];
      const r = await dialog.showMessageBox(win || undefined, { type: 'question', buttons: ['Cancel', 'Yes, do it'], defaultId: 0, cancelId: 0, title: nexaCfg().name, message: `${nexaCfg().name} wants to ${label}.`, detail: act === 'sleep' ? '' : 'Save your work first. Open apps will close.' });
      if (r.response !== 1) return 'The user said no, so nothing happened.';
      setTimeout(() => LX.power(act).catch(() => {}), 1500); return 'Okay, doing it now.';
    }
  }
  return 'Unknown tool.';
}
function nexaSystemPrompt() {
  const c = nexaCfg(); const now = new Date();
  return [`You are ${c.name}, the anime-girl assistant built into NexusOS, a gaming operating system (Debian-based) on ${os.userInfo().username}'s gaming laptop with an NVIDIA RTX 4050.`,
    `Your personality: ${c.personality}`,
    'You appear in NexusOS as a girl in a white NexusOS hoodie with cat ears.',
    'Keep replies short and natural, usually one to three sentences, because they may be read aloud. No emoji, no markdown, no lists unless asked.',
    c.control ? 'You can control the computer with your tools. Use them when asked to do something, then say briefly what happened. Never claim you did something unless a tool result says so.' : 'You cannot control the computer; if asked, say they can turn that on in your settings.',
    'Stay friendly and family-friendly: playful teasing is fine, nothing sexual. If you don’t know something (like live news), say so.',
    `It is ${now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}.`].join('\n');
}
// ---- chatting (streams words to her window as they arrive)
function handleS(channel, fn) {   // like handle(), but also tells the handler which window asked
  ipcMain.handle(channel, async (e, ...args) => {
    if (!TRUSTED.has(e.sender) || !e.senderFrame || !String(e.senderFrame.url).startsWith('file://')) throw new Error('Not allowed.');
    return fn(e.sender, ...args);
  });
}
const cleanMsgs = (h) => (Array.isArray(h) ? h : []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
  .slice(-24).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
handleS('nexa:chat', async (wc, history, reqId) => {
  if (!isNexaPage(wc)) throw new Error('Not allowed.');
  await nexaStart();
  const c = nexaCfg();
  const msgs = [{ role: 'system', content: nexaSystemPrompt() }, ...cleanMsgs(history)];
  const tools = c.control ? NEXA_TOOLS.map((t) => ({ type: 'function', function: t })) : undefined;
  if (nexaAbort) nexaAbort.abort();
  const ac = new AbortController(); nexaAbort = ac;
  const send = (m) => { if (!wc.isDestroyed()) wc.send('nexa-stream', { id: reqId, ...m }); };
  let finalText = '';
  try {
    for (let round = 0; round < 5; round++) {
      const res = await fetch(`http://127.0.0.1:${nexaPort}/v1/chat/completions`, { method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + nexaKey },
        body: JSON.stringify({ messages: msgs, tools, stream: true, temperature: 0.7, top_p: 0.8, max_tokens: 700 }) });
      if (!res.ok) throw new Error('Her brain answered with an error (' + res.status + ').');
      let text = '', buf = ''; const calls = [];
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true }); let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue; const data = line.slice(5).trim(); if (data === '[DONE]') continue;
          let j; try { j = JSON.parse(data); } catch (_) { continue; }
          const d = j.choices && j.choices[0] && j.choices[0].delta; if (!d) continue;
          if (d.content) { text += d.content; send({ delta: d.content }); }
          for (const tc of d.tool_calls || []) {
            const k = tc.index || 0; calls[k] = calls[k] || { id: tc.id || 'call' + k, name: '', args: '' };
            if (tc.id) calls[k].id = tc.id; if (tc.function && tc.function.name) calls[k].name += tc.function.name; if (tc.function && tc.function.arguments) calls[k].args += tc.function.arguments;
          }
        }
      }
      finalText += text;
      const todo = calls.filter((x) => x && x.name);
      if (!todo.length) break;
      msgs.push({ role: 'assistant', content: text || null, tool_calls: todo.map((x) => ({ id: x.id, type: 'function', function: { name: x.name, arguments: x.args || '{}' } })) });
      for (const x of todo) {
        let a = {}; try { a = JSON.parse(x.args || '{}'); } catch (_) {}
        send({ tool: x.name, args: a });
        let out; try { out = c.control ? await nexaTool(x.name, a, wc) : 'Not allowed.'; } catch (e) { out = 'That failed: ' + errMsgOf(e); }
        send({ toolDone: x.name, result: String(out).slice(0, 300) });
        msgs.push({ role: 'tool', tool_call_id: x.id, content: String(out) });
      }
      if (text) { send({ delta: '\n' }); finalText += '\n'; }
    }
  } catch (e) {
    if (e.name === 'AbortError') return { text: finalText, stopped: true };
    throw e;
  } finally { if (nexaAbort === ac) nexaAbort = null; }
  return { text: finalText.trim() };
});
handle('nexa:stopTalking', () => { if (nexaAbort) nexaAbort.abort(); for (const c of nexaKids) { try { c.kill('SIGKILL'); } catch (_) {} } nexaKids.clear(); return true; });
// ---- her voice: one sentence at a time, so she starts talking before the whole reply is ready
const nexaTmp = async () => { const d = path.join(NEXA_DIR(), 'tmp'); await fs.promises.mkdir(d, { recursive: true }); return d; };
let nexaSeq = 0;
function nexaRun(bin, args, timeout) {
  const sh = path.join(NEXA_DIR(), 'sherpa');
  return new Promise((resolve, reject) => {
    const p = cp.spawn(path.join(sh, 'bin', bin), args, { env: { ...process.env, LD_LIBRARY_PATH: path.join(sh, 'lib') }, stdio: ['ignore', 'pipe', 'pipe'] });
    nexaKids.add(p); let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, timeout);
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => { clearTimeout(t); nexaKids.delete(p); reject(e); });
    p.on('close', (code) => { clearTimeout(t); nexaKids.delete(p); code === 0 ? resolve(out + '\n' + err) : reject(new Error(err.trim().split('\n').pop() || 'failed')); });
  });
}
handleS('nexa:speak', async (wc, text, voice) => {
  if (!isNexaPage(wc)) throw new Error('Not allowed.');
  const t = String(text || '').replace(/[*_`#>~]/g, '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return null;
  const c = nexaCfg(); const v = NEXA_VOICES[voice] || NEXA_VOICES[c.voice];
  const vd = path.join(NEXA_DIR(), 'voice2'); if (!fs.existsSync(path.join(vd, 'model.int8.onnx'))) throw new Error('Her voice isn’t downloaded.');
  const out = path.join(await nexaTmp(), `say-${process.pid}-${++nexaSeq}.wav`);
  // "deeper": speak a little faster here, then her window plays it back slower, which lowers the pitch at normal speed
  const rate = Math.pow(2, Math.max(-4, Math.min(3, +c.pitch || 0)) / 12);
  await nexaRun('sherpa-onnx-offline-tts', [`--kokoro-model=${vd}/model.int8.onnx`, `--kokoro-voices=${vd}/voices.bin`, `--kokoro-tokens=${vd}/tokens.txt`, `--kokoro-data-dir=${vd}/espeak-ng-data`,
    `--kokoro-lexicon=${vd}/lexicon-us-en.txt`, `--kokoro-length-scale=${rate.toFixed(4)}`, `--sid=${v[0]}`, `--num-threads=${Math.max(2, Math.min(8, os.cpus().length - 2))}`, `--output-filename=${out}`, t], 120000);
  try { return { wav: await fs.promises.readFile(out), rate }; } finally { fs.promises.rm(out, { force: true }).catch(() => {}); }
});
// ---- her ears: a short recording from the microphone (16 kHz WAV made in her window) turned into text
handleS('nexa:hear', async (wc, bytes) => {
  if (!isNexaPage(wc)) throw new Error('Not allowed.');
  const buf = Buffer.from(bytes || []); if (buf.length < 1000 || buf.length > 4 * 1024 * 1024 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('That recording didn’t work.');
  const ed = path.join(NEXA_DIR(), 'ears'); if (!fs.existsSync(path.join(ed, 'base.en-encoder.int8.onnx'))) throw new Error('Her hearing isn’t downloaded.');
  const f = path.join(await nexaTmp(), `hear-${++nexaSeq}.wav`); await fs.promises.writeFile(f, buf);
  try {
    const out = await nexaRun('sherpa-onnx-offline', [`--whisper-encoder=${ed}/base.en-encoder.int8.onnx`, `--whisper-decoder=${ed}/base.en-decoder.int8.onnx`, `--tokens=${ed}/base.en-tokens.txt`,
      `--num-threads=${Math.max(2, Math.min(8, os.cpus().length - 2))}`, f], 60000);
    const line = out.split('\n').reverse().find((l) => l.trim().startsWith('{') && l.includes('"text"'));
    let text = ''; try { text = JSON.parse(line).text; } catch (_) {}
    return String(text || '').trim().replace(/^\[.*?\]\s*$/, '');   // "[BLANK_AUDIO]" and the like mean nothing was said
  } finally { fs.promises.rm(f, { force: true }).catch(() => {}); }
});
// ---- setup and settings
handle('nexa:state', () => ({ parts: NEXA_PARTS.map((p) => ({ key: p.key, name: p.name, size: p.size, done: nexaPartDone(p) })), installing: nexaInstalling, up: !!nexaSrv && !!nexaReady, error: nexaErr, device: nexaDevice, cfg: nexaCfg(),
  voices: Object.entries(NEXA_VOICES).map(([id, [, name]]) => ({ id, name })) }));
handle('nexa:install', () => nexaInstall());
handle('nexa:start', () => nexaStart().then(() => true, (e) => { throw new Error(e.message === 'NOT_INSTALLED' ? 'Nexa isn’t downloaded yet.' : e.message); }));
handle('nexa:remove', () => nexaRemove());
handle('nexa:setCfg', (o) => {
  const c = nexaCfg(); o = o && typeof o === 'object' ? o : {};
  if (typeof o.name === 'string' && o.name.trim()) c.name = o.name.trim().slice(0, 30);
  if (typeof o.personality === 'string') c.personality = o.personality.trim().slice(0, 800) || NEXA_DEFAULTS.personality;
  if (o.skin === 'light' || o.skin === 'tan') c.skin = o.skin;
  if (Object.prototype.hasOwnProperty.call(NEXA_VOICES, o.voice)) c.voice = o.voice;
  for (const k of ['speak', 'control']) if (typeof o[k] === 'boolean') c[k] = o[k];
  if (Number.isFinite(o.pitch)) c.pitch = Math.max(-4, Math.min(3, Math.round(o.pitch * 2) / 2));
  config.nexa = c; saveConfig(); return c;
});
// her memory of the conversation, so she remembers you next time
const nexaHistFile = () => path.join(NEXA_DIR(), 'chat.json');
handle('nexa:history', async (h) => {
  if (h === undefined) { try { return JSON.parse(await fs.promises.readFile(nexaHistFile(), 'utf8')); } catch (_) { return []; } }
  await fs.promises.mkdir(NEXA_DIR(), { recursive: true });
  await fs.promises.writeFile(nexaHistFile(), JSON.stringify(cleanMsgs(h).slice(-60))); return true;
});

// if the desktop ever crashed, Nexa's brain or the Clips recorder could still be running without anything to stop them
function sweepLeftovers() {
  if (!OS_MODE) return;
  const eng = path.join(NEXA_DIR(), 'engine', 'llama-server'), me = process.getuid && process.getuid();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || +d === process.pid) continue;
    try {
      if (me != null && fs.statSync('/proc/' + d).uid !== me) continue;
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      const nexa = cmd.includes(eng) || cmd[0] === eng;
      const clip = cmd.some((a) => /gpu-screen-recorder$/.test(a)) && cmd.includes(clipsDir());
      if (nexa || clip) process.kill(+d, 'SIGTERM');
    } catch (_) {}
  }
}
