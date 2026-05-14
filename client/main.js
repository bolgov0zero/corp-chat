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

// Envelope icon for blinking: orange envelope on transparent background (44x44 @2x = 22pt)
function makeEnvelopePNG() {
  const W = 44, H = 44;
  const px = Buffer.alloc(W * H * 4); // all transparent by default
  const E = [234, 88, 12, 255]; // orange
  function set(x, y, c) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = c[0]; px[i+1] = c[1]; px[i+2] = c[2]; px[i+3] = c[3];
  }
  function rect(x1, y1, x2, y2, c) { for (let y=y1;y<=y2;y++) for (let x=x1;x<=x2;x++) set(x,y,c); }
  // Envelope body outline (border only, 2px thick)
  const [x1,y1,x2,y2] = [5, 12, 39, 32];
  for (let t=0; t<2; t++) {
    for (let x=x1+t; x<=x2-t; x++) { set(x, y1+t, E); set(x, y2-t, E); }
    for (let y=y1+t; y<=y2-t; y++) { set(x1+t, y, E); set(x2-t, y, E); }
  }
  // Envelope flap V (2px thick lines from top corners to center)
  const mx = Math.floor((x1+x2)/2);
  const my = Math.floor((y1+y2)/2) - 2;
  for (let t=0; t<2; t++) {
    for (let i=0; i<=(mx-x1); i++) {
      const frac = i / (mx - x1);
      const fy = Math.round(y1 + frac * (my - y1));
      set(x1 + i + t, fy, E);
      set(x2 - i - t, fy, E);
    }
  }
  return makePNGFromPixels(W, H, px);
}

// Load normal tray icon: electron app icon, displayed as template on macOS
function getNormalImage() {
  const iconPath = path.join(__dirname, 'src', 'assets', 'tray-icon.png');
  try {
    const fs = require('fs');
    const buf = fs.readFileSync(iconPath);
    // scaleFactor:2 → 32px image displays as 16pt (proper menu bar size)
    const img = nativeImage.createFromBuffer(buf, { scaleFactor: 2 });
    if (!img.isEmpty() && process.platform === 'darwin') img.setTemplateImage(true);
    return img;
  } catch { return nativeImage.createEmpty(); }
}

const ICON_BLINK = makeEnvelopePNG();

function getBlinkImage() {
  // scaleFactor:2 → 44px image displays as 22pt
  return nativeImage.createFromBuffer(ICON_BLINK, { scaleFactor: 2 });
}

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
