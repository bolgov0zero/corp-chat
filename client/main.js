const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;
let unreadCount = 0;

function makeTrayIcon(hasUnread) {
  const color = hasUnread ? '#ef4444' : '#2563eb';
  const dot = hasUnread ? `<circle cx="13" cy="3" r="3" fill="#ef4444"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <rect width="16" height="16" rx="4" fill="${color}"/>
    <text x="8" y="11.5" text-anchor="middle" font-size="9" fill="white" font-family="Arial,sans-serif" font-weight="bold">C</text>
  </svg>`;
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  if (process.platform === 'darwin') img.setTemplateImage(false);
  return img;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720, minWidth: 820, minHeight: 540,
    title: 'Corp Chat',
    backgroundColor: process.platform === 'darwin' ? '#ffffff' : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', e => {
    if (!app.isQuiting) { e.preventDefault(); mainWindow.hide(); }
  });
}

function updateTray() {
  if (!tray) return;
  const label = unreadCount > 0 ? `Corp Chat (${unreadCount})` : 'Corp Chat';
  tray.setToolTip(label);
  try { tray.setImage(makeTrayIcon(unreadCount > 0)); } catch {}
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Открыть', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Выйти', click: () => { app.isQuiting = true; app.quit(); } },
  ]));
}

function createTray() {
  try { tray = new Tray(makeTrayIcon(false)); } catch { tray = new Tray(nativeImage.createEmpty()); }
  updateTray();
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

ipcMain.on('notify', (_, { title, body }) => {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
    n.show();
  }
});

ipcMain.on('unread', (_, count) => {
  unreadCount = count;
  updateTray();
  if (app.dock) app.dock.setBadge(count > 0 ? String(count) : '');
});

ipcMain.handle('get-platform', () => process.platform);

app.whenReady().then(() => {
  createWindow();
  createTray();
  if (process.platform === 'darwin') app.dock?.show();
});

app.on('window-all-closed', e => e.preventDefault());
app.on('activate', () => { mainWindow?.show(); mainWindow?.focus(); });
app.on('before-quit', () => { app.isQuiting = true; });
