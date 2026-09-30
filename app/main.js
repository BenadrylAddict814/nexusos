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
function lockDownSession(ses, isWeb) {
  ses.setPermissionRequestHandler((wc, perm, cb, details) => {
    if (PERM_ALWAYS.has(perm)) return cb(true);
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
let desktopWin = null, panelWin = null, popupWin = null, toastWin = null, popupWhich = null, popupPrevActive = 0;
const PANEL_H = 52;
const INDEX = path.join(__dirname, 'index.html');
const APP_SIZES = { files: [880, 560], notes: [640, 520], web: [1180, 760], calc: [320, 480], term: [700, 440], paint: [760, 560], mines: [340, 440], settings: [900, 620], about: [560, 600], store: [940, 640], bin: [760, 500], taskmgr: [900, 620] };
const APP_MULTI = new Set(['notes']);
const APP_TITLES = { files: 'Files', notes: 'Notes', web: 'Browser', calc: 'Calculator', term: 'Terminal', paint: 'Paint', mines: 'Mines', settings: 'Settings', about: 'About NexusOS', store: 'App Store', bin: 'Bin', taskmgr: 'Task Manager' };

function sendTo(w, ch, data) { if (w && !w.isDestroyed()) w.webContents.send(ch, data); }
function broadcast(ch, data) { for (const wc of TRUSTED) if (!wc.isDestroyed()) wc.send(ch, data); }
const anyWin = () => win || desktopWin || [...appWins.values()].map((a) => a.win).find((w) => !w.isDestroyed()) || null;

function guard(w) {
  const wc = w.webContents;
  TRUSTED.add(wc);
  wc.once('destroyed', () => TRUSTED.delete(wc));
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) openUrl(url); return { action: 'deny' }; });
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
    if (!OS_MODE && input.key === 'F11' && win) { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (!OS_MODE && input.control && input.shift && input.key.toLowerCase() === 'q') { app.quit(); e.preventDefault(); }
  });
  wc.on('did-finish-load', () => { if (config.zoom && config.zoom !== 1) wc.setZoomFactor(config.zoom); });
}
const PREFS = () => ({ preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true, webSecurity: true, spellcheck: false, navigateOnDragDrop: false, safeDialogs: true, backgroundThrottling: false });
function makeWin(opts, query) {
  const w = new BrowserWindow({ backgroundColor: '#05060a', title: 'NexusOS', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, show: false, ...opts, webPreferences: PREFS() });
  guard(w);
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
  panelWin = makeWin({ type: 'dock', frame: false, x: b.x, y: b.y + b.height - PANEL_H, width: b.width, height: PANEL_H, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false }, { view: 'panel' });
  panelWin.once('ready-to-show', () => panelWin.showInactive());
  popupWin = makeWin({ frame: false, width: 640, height: 600, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, minimizable: false, maximizable: false, fullscreenable: false }, { view: 'popup' });
  popupWin.on('blur', () => hidePopup());
  toastWin = makeWin({ type: 'notification', frame: false, width: 380, height: 10, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, x: b.x + b.width - 396, y: b.y + 16 }, { view: 'toasts' });
  win = desktopWin;   // dialogs belong to the desktop
  const fit = () => {
    const d = screen.getPrimaryDisplay().bounds;
    if (desktopWin && !desktopWin.isDestroyed()) desktopWin.setBounds(d);
    if (panelWin && !panelWin.isDestroyed()) panelWin.setBounds({ x: d.x, y: d.y + d.height - PANEL_H, width: d.width, height: PANEL_H });
    placeToasts();
  };
  screen.on('display-metrics-changed', fit); screen.on('display-added', fit); screen.on('display-removed', fit);
  startWindowWatch();
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
  const w = makeWin({ width, height, minWidth: 300, minHeight: 200, x: Math.round(wa.x + (wa.width - width) / 2 - 60 + n * 28), y: Math.round(wa.y + Math.max(10, (wa.height - height) / 2 - 30 + n * 28)), title: APP_TITLES[key] },
    { view: 'app', app: key, arg: arg == null ? '' : JSON.stringify(arg) });
  appWins.set(w.id, { key, win: w });
  const id = w.id;
  w.on('closed', () => { appWins.delete(id); pushWindows(true); });
  w.once('ready-to-show', () => { w.show(); w.focus(); });
  return true;
}
function openUrl(url) { if (OS_MODE) openAppWindow('web', url); else sendTo(win, 'open-url', url); }

/* Start and quick settings */
function showPopup(which) {
  if (!popupWin || popupWin.isDestroyed()) return;
  if (popupWin.isVisible() && popupWhich === which) return hidePopup();
  const d = screen.getPrimaryDisplay().bounds;
  const [w, h] = which === 'quick' ? [380, 600] : [660, 620];
  const x = which === 'quick' ? d.x + d.width - w - 12 : Math.round(d.x + (d.width - w) / 2);
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
function placeToasts() {
  if (!toastWin || toastWin.isDestroyed()) return;
  const d = screen.getPrimaryDisplay().bounds;
  if (toastH <= 0) { toastWin.hide(); return; }
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
let lastWinSig = '', activeX = 0, watchTimer = null;
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
  if (force || sig !== lastWinSig) { lastWinSig = sig; sendTo(panelWin, 'windows', list); sendTo(desktopWin, 'windows', list); }
  // hide Start if the person clicked into another window
  // (only when a different window than before Start opened becomes active, so a slow focus change can't close it)
  if (popupWin && popupWin.isVisible() && activeX && activeX !== xid(popupWin) && activeX !== popupPrevActive) hidePopup();
}
function startWindowWatch() { clearInterval(watchTimer); watchTimer = setInterval(() => pushWindows(false).catch(() => {}), 900); }
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
    const send = (m) => sendTo(OS_MODE ? toastWin : win, 'download', { id, name, path: target, risky: isRisky(target), ...m });
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
handle('win:popup', (which) => { if (!['start', 'quick'].includes(which)) throw new Error('Unknown panel'); showPopup(which); return true; });
handle('win:popupHide', () => { hidePopup(); return true; });
handle('win:list', () => listWindows());
handle('win:act', (id, action) => { if (!['activate', 'minimize', 'close', 'toggle'].includes(action)) throw new Error('Unknown action'); return windowAction(id, action); });
handle('toast', (t, s) => { sendTo(toastWin || win, 'toast', { t: String(t || '').slice(0, 120), s: String(s || '').slice(0, 300) }); return true; });
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
    menu.popup({ window: w || undefined, callback: () => setTimeout(() => resolve(picked), 0) });
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
handle('wall:get', async () => {
  if (!config.wallpaper) return null; const p = path.join(WALL_DIR(), path.basename(config.wallpaper));
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }[path.extname(p).toLowerCase()];
  try { return `data:${mime};base64,` + (await fs.promises.readFile(p)).toString('base64'); } catch (_) { return null; }
});
handle('wall:clear', async () => { if (config.wallpaper) await fs.promises.rm(path.join(WALL_DIR(), path.basename(config.wallpaper)), { force: true }); config.wallpaper = null; saveConfig(); broadcast('sys-changed', 'wallpaper'); return true; });
