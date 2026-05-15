const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain } = require('electron');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
const path = require('path');
const zlib = require('zlib');
const fs = require('fs');
const https = require('https');
const os = require('os');

// ── AUTO UPDATE ──
const GITHUB_REPO = 'bolgov0zero/corp-chat';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const request = (u) => {
      https.get(u, { headers: { 'User-Agent': 'Electron' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) { request(res.headers.location); return; }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    };
    request(url);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (u) => {
      https.get(u, { headers: { 'User-Agent': 'Electron' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) { request(res.headers.location); return; }
        const total = parseInt(res.headers['content-length'] || '0');
        let received = 0;
        res.on('data', chunk => { received += chunk.length; file.write(chunk); if (total) onProgress?.(Math.round(received / total * 100)); });
        res.on('end', () => { file.end(); resolve(); });
        res.on('error', reject);
      }).on('error', reject);
    };
    request(url);
  });
}

function semverGt(a, b) {
  const n = v => v.split('.').map(Number);
  const [am, an, ap] = n(a), [bm, bn, bp] = n(b);
  return am !== bm ? am > bm : an !== bn ? an > bn : ap > bp;
}

function getAssetPattern() {
  if (process.platform === 'win32') return /\.exe$/i;
  if (process.platform === 'darwin') return /\.dmg$/i;
  return process.arch === 'arm64' ? /arm64\.AppImage$/i : /x86_64\.AppImage$/i;
}

ipcMain.handle('check-update', async () => {
  try {
    const data = JSON.parse(await httpsGet(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`));
    if (data.status === '404' || data.message === 'Not Found') return { upToDate: true };
    if (data.message) return { error: data.message };
    const latest = data.tag_name.replace(/^v/, '');
    const current = app.getVersion();
    if (!semverGt(latest, current)) return { upToDate: true, version: current };
    const asset = data.assets?.find(a => getAssetPattern().test(a.name));
    return { upToDate: false, version: latest, notes: data.body || '', downloadUrl: asset?.browser_download_url || null };
  } catch(e) { return { error: e.message }; }
});

ipcMain.handle('install-update', async (_, downloadUrl) => {
  const ext = process.platform === 'win32' ? '.exe' : process.platform === 'darwin' ? '.dmg' : '.AppImage';
  const tmpFile = path.join(os.tmpdir(), `electron-update${ext}`);
  try {
    await downloadFile(downloadUrl, tmpFile, p => mainWindow?.webContents.send('update-progress', p));

    if (process.platform === 'win32') {
      const { spawn } = require('child_process');
      spawn(tmpFile, ['/S'], { detached: true, stdio: 'ignore' }).unref();
      app.isQuiting = true; app.quit();
    } else if (process.platform === 'linux') {
      fs.chmodSync(tmpFile, 0o755);
      fs.copyFileSync(tmpFile, process.execPath);
      app.relaunch(); app.isQuiting = true; app.quit();
    } else if (process.platform === 'darwin') {
      const { execSync } = require('child_process');
      const out = execSync(`hdiutil attach "${tmpFile}" -nobrowse -quiet`).toString();
      const mountPoint = out.split('\n').map(l => l.match(/\/Volumes\/.+/)?.[0]).filter(Boolean)[0]?.trim();
      const appFile = fs.readdirSync(mountPoint).find(f => f.endsWith('.app'));
      execSync(`cp -rf "${mountPoint}/${appFile}" /Applications/`);
      execSync(`xattr -d com.apple.quarantine "/Applications/${appFile}" 2>/dev/null; true`, { shell: true });
      execSync(`hdiutil detach "${mountPoint}" -quiet`);
      const execPath = `/Applications/${appFile}/Contents/MacOS/${appFile.replace('.app', '')}`;
      app.relaunch({ execPath }); app.isQuiting = true; app.quit();
    }
    return { ok: true };
  } catch(e) { return { error: e.message }; }
});

// ── HIGH AVAILABILITY ──
// Config stored in ProgramData — one config per machine, shared across all Windows users.
// Each user mounts their own personal network drive (e.g. U:) so userData resolves
// to their personal roaming storage automatically.
const HA_CONFIG_PATH = process.platform === 'win32' && process.env.PROGRAMDATA
  ? path.join(process.env.PROGRAMDATA, 'Electron', 'ha-config.json')
  : null;

function readHAConfig() {
  if (!HA_CONFIG_PATH) return null;
  try { return JSON.parse(fs.readFileSync(HA_CONFIG_PATH, 'utf8')); } catch { return null; }
}

// Apply BEFORE app.ready so Electron uses the correct userData path
const haConfig = readHAConfig();
if (haConfig?.drive) {
  app.setPath('userData', path.join(haConfig.drive + ':\\Electron'));
}

let mainWindow = null;
let tray = null;
let unreadCount = 0;
let blinkInterval = null;
let blinkState = false;

// Generate PNG from pixel buffer using Node's built-in zlib
function makePNGFromPixels(w, h, pixels) {
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const byte of buf) { c ^= byte; for (let i = 0; i < 8; i++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([t, data]);
    const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(crcBuf));
    return Buffer.concat([len, t, data, crcVal]);
  }
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    pixels.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = chunk('IHDR', Buffer.from([0,0,0,w,0,0,0,h,8,6,0,0,0]));
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

// White rounded square with black symbol inside. Works on all platforms.
function makeIconPNG(drawSymbol) {
  const W = 32, H = 32, R = 5;
  const px = Buffer.alloc(W * H * 4); // transparent

  function set(x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = r; px[i+1] = g; px[i+2] = b; px[i+3] = a;
  }

  // Fill white rounded rectangle
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = Math.max(0, R - x, x - (W - 1 - R));
      const dy = Math.max(0, R - y, y - (H - 1 - R));
      if (dx * dx + dy * dy <= R * R) set(x, y, 255, 255, 255, 255);
    }
  }

  // Draw symbol in black
  const black = (x, y) => set(x, y, 0, 0, 0, 255);
  drawSymbol(black, W, H);

  return makePNGFromPixels(W, H, px);
}

function drawElectron(px, W, H) {
  const cx = (W - 1) / 2, cy = (H - 1) / 2;
  const a = W * 0.36, b = W * 0.115;
  for (let orbit = 0; orbit < 3; orbit++) {
    const th = (orbit * Math.PI) / 3;
    for (let t = 0; t < 2 * Math.PI; t += 0.012) {
      const ex = cx + a * Math.cos(t) * Math.cos(th) - b * Math.sin(t) * Math.sin(th);
      const ey = cy + a * Math.cos(t) * Math.sin(th) + b * Math.sin(t) * Math.cos(th);
      px(ex, ey);
      px(ex + Math.cos(th + Math.PI / 2), ey + Math.sin(th + Math.PI / 2));
    }
  }
  const r = 2;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= r * r) px(cx + dx, cy + dy);
}

function drawEnvelope(px, W, H) {
  const x1 = 5, y1 = 9, x2 = 26, y2 = 22;
  for (let t = 0; t < 2; t++) {
    for (let x = x1 + t; x <= x2 - t; x++) { px(x, y1 + t); px(x, y2 - t); }
    for (let y = y1 + t; y <= y2 - t; y++) { px(x1 + t, y); px(x2 - t, y); }
  }
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 1;
  for (let t = 0; t < 2; t++) {
    for (let i = 0; i <= mx - x1; i++) {
      const fy = y1 + (i / (mx - x1)) * (my - y1);
      px(x1 + i + t, fy); px(x2 - i - t, fy);
    }
  }
}

const NORMAL_ICON_BUF = makeIconPNG(drawElectron);
const BLINK_ICON_BUF  = makeIconPNG(drawEnvelope);

function makeIconImage(buf) {
  return nativeImage.createFromBuffer(buf, { scaleFactor: process.platform === 'darwin' ? 2 : 1 });
}

function getNormalImage() { return makeIconImage(NORMAL_ICON_BUF); }
function getBlinkImage()  { return makeIconImage(BLINK_ICON_BUF); }

function startBlink() {
  if (blinkInterval) return;
  blinkInterval = setInterval(() => {
    blinkState = !blinkState;
    try { tray?.setImage(blinkState ? getBlinkImage() : getNormalImage()); } catch {}
  }, 600);
}

function stopBlink() {
  if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null; }
  try { tray?.setImage(getNormalImage()); } catch {}
}

function updateTray() {
  if (!tray) return;
  const label = unreadCount > 0 ? `Electron (${unreadCount})` : 'Electron';
  tray.setToolTip(label);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Открыть', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Выйти', click: () => { app.isQuiting = true; app.quit(); } },
  ]));
  if (unreadCount > 0) startBlink();
  else stopBlink();
  if (app.dock) app.dock.setBadge(unreadCount > 0 ? String(unreadCount) : '');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720, minWidth: 820, minHeight: 540,
    title: 'Electron',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    show: false,
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', e => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('focus', () => {
    if (unreadCount === 0) stopBlink();
    if (process.platform === 'win32') mainWindow.flashFrame(false);
  });
}

function createTray() {
  try { tray = new Tray(getNormalImage()); }
  catch { tray = new Tray(nativeImage.createEmpty()); }
  updateTray();
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// IPC
ipcMain.on('notify', (_, { title, body, chatId }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
    if (chatId) mainWindow?.webContents.send('open-chat', chatId);
  });
  n.show();
});

ipcMain.on('unread', (_, count) => {
  const prev = unreadCount;
  unreadCount = count;
  updateTray();
  if (process.platform === 'win32' && count > prev && mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
  if (count === 0 && mainWindow) mainWindow.flashFrame(false);
});

ipcMain.handle('get-platform', () => process.platform);
ipcMain.handle('get-version', () => app.getVersion());

// ── HA IPC ──
ipcMain.handle('ha-list-drives', async () => {
  if (process.platform !== 'win32') return [];
  try {
    const { execSync } = require('child_process');
    const out = execSync('wmic logicaldisk get caption,drivetype,volumename', { encoding: 'utf8', timeout: 5000 });
    const lines = out.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
    return lines.map(line => {
      const parts = line.trim().split(/\s+/);
      const caption = parts[0]; // e.g. C:
      const driveType = parts[1]; // 2=removable,3=local,4=network,5=optical
      const volumeName = parts.slice(2).join(' ') || '';
      if (!/^[A-Z]:$/.test(caption)) return null;
      const typeLabel = driveType === '3' ? 'Локальный' : driveType === '4' ? 'Сетевой' : driveType === '2' ? 'Съёмный' : 'Диск';
      return { letter: caption[0], caption, label: volumeName ? `${caption} — ${volumeName} (${typeLabel})` : `${caption} (${typeLabel})` };
    }).filter(Boolean);
  } catch { return []; }
});

ipcMain.handle('ha-get-config', () => readHAConfig());

ipcMain.handle('ha-set-config', (_, drive) => {
  if (!HA_CONFIG_PATH || !drive) return false;
  try {
    fs.mkdirSync(path.dirname(HA_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(HA_CONFIG_PATH, JSON.stringify({ drive }), 'utf8');
    app.relaunch();
    app.quit();
    return true;
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('ha-clear-config', () => {
  if (!HA_CONFIG_PATH) return false;
  try {
    if (fs.existsSync(HA_CONFIG_PATH)) fs.unlinkSync(HA_CONFIG_PATH);
    app.relaunch();
    app.quit();
    return true;
  } catch { return false; }
});

ipcMain.handle('get-autostart', () => {
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
});

ipcMain.handle('set-autostart', (_, enabled) => {
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? ['--hidden'] : [] });
  }
});

// Detect if launched at login (should start hidden in tray)
function shouldStartHidden() {
  if (process.platform === 'darwin') {
    return app.getLoginItemSettings().wasOpenedAsHidden;
  }
  return process.argv.includes('--hidden');
}

if (process.platform === 'win32') app.setAppUserModelId('Electron');

app.whenReady().then(() => {
  createWindow();
  createTray();
  if (shouldStartHidden()) {
    mainWindow.hide();
  }
});

app.on('window-all-closed', e => e.preventDefault());
app.on('activate', () => { mainWindow?.show(); mainWindow?.focus(); });
app.on('before-quit', () => { app.isQuiting = true; });
