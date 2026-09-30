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
const { app, BrowserWindow, ipcMain, shell, dialog, session, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const OS_MODE = IS_LINUX && (process.argv.includes('--session') || process.env.HALCYON_SESSION === '1');
const VERSION = String(require('./package.json').version || '0');

app.enableSandbox();
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
  setZoom: async (z) => { config.zoom = Math.max(0.75, Math.min(2, Number(z) || 1)); saveConfig(); if (win) win.webContents.setZoomFactor(config.zoom); return config.zoom; },

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
    if (!a) throw new Error('Unknown power action');
    await run('systemctl', [a]); return true;
  },

  /* Date and time */
  async time() {
    const [tz, ntp] = await Promise.all([run('timedatectl', ['show', '-p', 'Timezone', '--value']).catch(() => ''), run('timedatectl', ['show', '-p', 'NTP', '--value']).catch(() => '')]);
    return { timezone: tz.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone, ntp: ntp.trim() === 'yes', clock24: config.clock24 !== false };
  },
  timezones: async () => (await run('timedatectl', ['list-timezones'])).trim().split('\n'),
  setTimezone: async (tz) => { if (!/^[A-Za-z0-9_+\-/]+$/.test(String(tz))) throw new Error('Unknown time zone'); await run('timedatectl', ['set-timezone', tz], { timeout: 120000 }); return true; },
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
  /* NexusOS's own updates (signed GitHub releases) */
  nexusUpdateState: async () => ({ version: VERSION, previous: prevVersion(), rolledBack: process.env.NEXUS_ROLLED_BACK === '1', canUpdate: fs.existsSync('/usr/lib/nexusos/nexus-system') && fs.existsSync(UPDATE_KEY) }),
  nexusUpdateCheck: async () => { const m = await fetchManifest(); return { available: newerThan(m.version, VERSION), version: m.version, notes: String(m.notes || '').slice(0, 4000), size: Number(m.size) || 0, date: m.date || '' }; },
  async nexusUpdateInstall() {
    const m = await fetchManifest();
    if (!newerThan(m.version, VERSION)) throw new Error('You already have the newest NexusOS.');
    const dir = path.join(app.getPath('userData'), 'updates', m.version); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const send = (line, pct) => { if (win && !win.isDestroyed()) win.webContents.send('job', { id: 'nexus-update', line, pct }); };
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

  openTerminal: async () => { cp.spawn('lxterminal', ['--working-directory=' + os.homedir()], { detached: true, stdio: 'ignore' }).unref(); return true; },
};

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
    const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send('job', { id: jobId, ...m }); };
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
function askPermission(info) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(false);
    const id = ++permSeq; permWaiting.set(id, resolve);
    win.webContents.send('perm-ask', { id, ...info });
    setTimeout(() => { if (permWaiting.has(id)) { permWaiting.delete(id); resolve(false); } }, 60000);
  });
}
function lockDownSession(ses, isWeb) {
  ses.setPermissionRequestHandler((wc, perm, cb, details) => {
    if (PERM_ALWAYS.has(perm)) return cb(true);
    if (!isWeb || !PERM_ASK.has(perm)) return cb(false);
    let origin = ''; try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch (_) { return cb(false); }
    if (!/^https:/.test(origin)) return cb(false); // only secure sites may even ask
    const media = (details.mediaTypes || []).slice().sort().join('+');
    const key = `${origin}|${perm}|${media}`;
    if (permMemo.has(key)) return cb(permMemo.get(key));
    askPermission({ origin, perm, media }).then((ok) => { permMemo.set(key, ok); cb(ok); });
  });
  ses.setPermissionCheckHandler((wc, perm, origin) => {
    if (PERM_ALWAYS.has(perm)) return true;
    if (!isWeb) return false;
    for (const [k, v] of permMemo) if (v && k.startsWith(`${origin}|${perm === 'media' ? 'media' : perm}|`)) return true;
    return false;
  });
  ses.setDevicePermissionHandler(() => false); // no USB, HID or serial devices for websites
  ses.on('select-serial-port', (e, _ports, _wc, cb) => { e.preventDefault(); cb(''); });
  ses.on('select-hid-device', (e, _d, cb) => { e.preventDefault(); cb(); });
  ses.on('select-usb-device', (e, _d, cb) => { e.preventDefault(); cb(); });
}

/* ---------------------------------------------------------------- windows */
function createWindow() {
  const common = {
    backgroundColor: '#070d0f', title: 'NexusOS', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true, webSecurity: true, spellcheck: false, navigateOnDragDrop: false, safeDialogs: true },
  };
  if (OS_MODE) {
    const b = screen.getPrimaryDisplay().bounds;
    win = new BrowserWindow({ ...common, type: 'desktop', frame: false, x: b.x, y: b.y, width: b.width, height: b.height, resizable: false, movable: false, skipTaskbar: true });
    const fit = () => { if (win && !win.isDestroyed()) win.setBounds(screen.getPrimaryDisplay().bounds); };
    screen.on('display-metrics-changed', fit); screen.on('display-added', fit); screen.on('display-removed', fit);
  } else {
    win = new BrowserWindow({ ...common, width: 1400, height: 900, fullscreen: true });
  }
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => { if (config.zoom) win.webContents.setZoomFactor(config.zoom); win.show(); });
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) wc.send('open-url', url); return { action: 'deny' }; });
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  // Lock down the Browser's <webview>: no bridge, sandboxed, web addresses only
  wc.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload; delete prefs.preloadURL;
    Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, plugins: false, experimentalFeatures: false });
    if (params.partition !== 'persist:halcyon' || !/^(https?:\/\/|about:blank$)/i.test(params.src || '')) e.preventDefault();
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (!OS_MODE && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (!OS_MODE && input.control && input.shift && input.key.toLowerCase() === 'q') { app.quit(); e.preventDefault(); }
  });
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
    const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send('download', { id, name, path: target, risky: isRisky(target), ...m }); };
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
app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore(); win.focus();
  const url = urlFromArgs(argv); if (url) win.webContents.send('open-url', url);
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
  const first = urlFromArgs(process.argv); if (first) win.webContents.once('did-finish-load', () => win.webContents.send('open-url', first));
});
app.on('window-all-closed', () => app.quit());

/* ---------------------------------------------------------------- the only doors into the system */
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!win || e.sender !== win.webContents || !e.senderFrame || !String(e.senderFrame.url).startsWith('file://')) throw new Error('Not allowed.');
    return fn(...args);
  });
}
ipcMain.on('perm-answer', (e, id, ok) => {
  if (!win || e.sender !== win.webContents) return;
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
  await shell.trashItem(t); return true;
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
