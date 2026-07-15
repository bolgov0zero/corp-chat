const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  notify: (title, body, chatId) => ipcRenderer.send('notify', { title, body, chatId }),
  setUnread: (count) => ipcRenderer.send('unread', count),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  installUpdate: (url) => ipcRenderer.invoke('install-update', url),
  onUpdateProgress: (cb) => {
    ipcRenderer.removeAllListeners('update-progress');
    ipcRenderer.on('update-progress', (_, p) => cb(p));
  },
  onUpdateRestarting: (cb) => {
    ipcRenderer.removeAllListeners('update-restarting');
    ipcRenderer.once('update-restarting', cb);
  },
  onWindowFocus: (cb) => ipcRenderer.on('window-focus', (_, focused) => cb(focused)),
  onOpenChat: (cb) => ipcRenderer.on('open-chat', (_, chatId) => cb(chatId)),
  getHostname: () => ipcRenderer.invoke('get-hostname'),
  getOS: () => ipcRenderer.invoke('get-os'),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (enabled) => ipcRenderer.invoke('set-autostart', enabled),
  downloadFile: (opts) => ipcRenderer.invoke('download-file', opts),
  fileExists: (filePath) => ipcRenderer.invoke('file-exists', filePath),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  // High Availability
  listDrives: () => ipcRenderer.invoke('ha-list-drives'),
  getHAConfig: () => ipcRenderer.invoke('ha-get-config'),
  setHAConfig: (drive) => ipcRenderer.invoke('ha-set-config', drive),
  clearHAConfig: () => ipcRenderer.invoke('ha-clear-config'),
});
