const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  setUnread: (count) => ipcRenderer.send('unread', count),
  showWindow: () => ipcRenderer.send('show-window')
});
