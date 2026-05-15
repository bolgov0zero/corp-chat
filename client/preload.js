const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  notify: (title, body, chatId) => ipcRenderer.send('notify', { title, body, chatId }),
  setUnread: (count) => ipcRenderer.send('unread', count),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onOpenChat: (cb) => ipcRenderer.on('open-chat', (_, chatId) => cb(chatId)),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (enabled) => ipcRenderer.invoke('set-autostart', enabled),
  // High Availability
  listDrives: () => ipcRenderer.invoke('ha-list-drives'),
  getHAConfig: () => ipcRenderer.invoke('ha-get-config'),
  setHAConfig: (drive) => ipcRenderer.invoke('ha-set-config', drive),
  clearHAConfig: () => ipcRenderer.invoke('ha-clear-config'),
});
