const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain } = require('electron');
const path = require('path');
const zlib = require('zlib');

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

// Envelope icon for blinking (orange, 32x32)
function makeEnvelopePNG() {
  const W = 32, H = 32;
  const px = Buffer.alloc(W * H * 4);
  const O = [234, 88, 12, 255];   // orange bg
  const L = [255, 255, 255, 255]; // white
  function set(x, y, c) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = c[0]; px[i+1] = c[1]; px[i+2] = c[2]; px[i+3] = c[3];
  }
  function rect(x1, y1, x2, y2, c) { for (let y=y1;y<=y2;y++) for (let x=x1;x<=x2;x++) set(x,y,c); }
  // Fill orange background
  rect(0, 0, W-1, H-1, O);
  // Envelope body (white rectangle)
  rect(4, 9, 27, 22, L);
  // Envelope flap (V-shape pointing down from top)
  for (let i = 0; i <= 11; i++) {
    set(4 + i, 9 + i, O);
    set(27 - i, 9 + i, O);
  }
  // Bottom fold line (subtle V pointing up)
  for (let i = 0; i <= 5; i++) {
    set(4 + i, 22 - i, O);
    set(27 - i, 22 - i, O);
  }
  return makePNGFromPixels(W, H, px);
}

const ICON_BLINK = makeEnvelopePNG();

function makeImage(buf) {
  return nativeImage.createFromBuffer(buf, { scaleFactor: 1 });
}

const TRAY_ICON_PATH = path.join(__dirname, 'src', 'assets', 'tray-icon.png');
const ICON_NORMAL_IMAGE = (() => {
  try { return nativeImage.createFromPath(TRAY_ICON_PATH); } catch { return null; }
})();

function getNormalImage() {
  return (ICON_NORMAL_IMAGE && !ICON_NORMAL_IMAGE.isEmpty()) ? ICON_NORMAL_IMAGE : nativeImage.createEmpty();
}

function startBlink() {
  if (blinkInterval) return;
  blinkInterval = setInterval(() => {
    blinkState = !blinkState;
    try { tray?.setImage(blinkState ? makeImage(ICON_BLINK) : getNormalImage()); } catch {}
  }, 600);
}

function stopBlink() {
  if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null; }
  try { tray?.setImage(getNormalImage()); } catch {}
}

function updateTray() {
  if (!tray) return;
  const label = unreadCount > 0 ? `Corp Chat (${unreadCount})` : 'Corp Chat';
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
    title: 'Corp Chat',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    show: false,
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', e => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
      // На macOS скрываем и из Dock
      if (process.platform === 'darwin') app.dock?.hide();
    }
  });

  mainWindow.on('show', () => {
    if (process.platform === 'darwin') app.dock?.show();
  });
  mainWindow.on('focus', () => {
    // Stop blinking when window is focused
    if (unreadCount === 0) stopBlink();
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
  unreadCount = count;
  updateTray();
});

ipcMain.handle('get-platform', () => process.platform);

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', e => e.preventDefault());
app.on('activate', () => { mainWindow?.show(); mainWindow?.focus(); });
app.on('before-quit', () => { app.isQuiting = true; });
