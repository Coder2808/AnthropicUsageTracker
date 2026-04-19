const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tracker', {
  fetchStats:    ()    => ipcRenderer.invoke('fetch-stats'),
  fetchSnapshot: ()    => ipcRenderer.invoke('fetch-snapshot'),
  checkDaemon:   ()    => ipcRenderer.invoke('check-daemon'),
  openDashboard: ()    => ipcRenderer.send('open-dashboard'),
  hideWindow:    ()    => ipcRenderer.send('hide-window'),
  onRefresh:     (cb)  => ipcRenderer.on('refresh', cb),
});
