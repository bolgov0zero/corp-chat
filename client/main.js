const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, shell } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;
let unreadCount = 0;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    title: 'Corp Chat',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', e => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'src', 'assets', 'tray.png');
  let img;
  try { img = nativeImage.createFromPath(iconPath); } catch { img = nativeImage.createEmpty(); }
  if (img.isEmpty()) img = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);

  tray = new Tray(img);
  updateTray();

  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

function updateTray() {
  const label = unreadCount > 0 ? `Corp Chat (${unreadCount})` : 'Corp Chat';
  tray.setToolTip(label);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Открыть', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Выйти', click: () => { app.isQuiting = true; app.quit(); } }
  ]));
}

// IPC handlers
ipcMain.on('notify', (_, { title, body }) => {
  new Notification({ title, body }).show();
});

ipcMain.on('unread', (_, count) => {
  unreadCount = count;
  updateTray();
  if (app.dock) app.dock.setBadge(count > 0 ? String(count) : '');
});

ipcMain.on('show-window', () => { mainWindow.show(); mainWindow.focus(); });

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', e => e.preventDefault());
app.on('activate', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });

// Minimal embedded tray icon (1x1 transparent PNG as fallback)
const TRAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABJSURBVFiF7c4xCgAgDETRxPsfOhe8i4i4VxCbGMIkMJ+BgXfeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAvbgMAAP//AwDKHBpTBdDiAAAAAElFTkSuQmCC';
