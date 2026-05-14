const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain } = require('electron');
const path = require('path');
const zlib = require('zlib');

let mainWindow = null;
let tray = null;
let unreadCount = 0;
let blinkInterval = null;
let blinkState = false;

// Generate a solid-color PNG using Node's built-in zlib
function makePNG(width, height, r, g, b, a = 255) {
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
  const hasAlpha = a < 255;
  const channels = hasAlpha ? 4 : 3;
  const colorType = hasAlpha ? 6 : 2;
  const row = Buffer.alloc(1 + width * channels);
  const raw = Buffer.alloc(height * (1 + width * channels));
  for (let y = 0; y < height; y++) {
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      const i = 1 + x * channels;
      row[i] = r; row[i+1] = g; row[i+2] = b;
      if (hasAlpha) row[i+3] = a;
    }
    row.copy(raw, y * row.length);
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = chunk('IHDR', Buffer.from([0,0,0,width,0,0,0,height,8,colorType,0,0,0]));
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

// Normal icon: blue square with "C"
// Envelope icon for blinking: orange
const ICON_NORMAL = makePNG(32, 32, 37, 99, 235);   // #2563eb
const ICON_BLINK  = makePNG(32, 32, 234, 88, 12);   // #ea580c (orange)

function makeImage(buf) {
  return nativeImage.createFromBuffer(buf, { scaleFactor: 1 });
}

function startBlink() {
  if (blinkInterval) return;
  blinkInterval = setInterval(() => {
    blinkState = !blinkState;
    try { tray?.setImage(makeImage(blinkState ? ICON_BLINK : ICON_NORMAL)); } catch {}
  }, 600);
}

function stopBlink() {
  if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null; }
  try { tray?.setImage(makeImage(ICON_NORMAL)); } catch {}
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
  mainWindow.on('close', e => { if (!app.isQuiting) { e.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('focus', () => {
    // Stop blinking when window is focused
    if (unreadCount === 0) stopBlink();
  });
}

function createTray() {
  try { tray = new Tray(makeImage(ICON_NORMAL)); }
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
