const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error || 'The operation could not be completed.');
  return result.value;
}

contextBridge.exposeInMainWorld('cursorStudio', {
  scan: () => invoke('cursor:scan'),
  addInstallation: () => invoke('cursor:add-installation'),
  stageFile: (file) => {
    const filePath = webUtils.getPathForFile(file);
    if (!filePath) return Promise.reject(new Error('Drop a PNG file from File Explorer.'));
    return invoke('cursor:stage', filePath);
  },
  choosePng: () => invoke('cursor:choose-png'),
  apply: (request) => invoke('cursor:apply', request),
  restore: (request) => invoke('cursor:restore', request),
  openInstallation: (id) => invoke('cursor:open-installation', id),
  openBackups: () => invoke('cursor:open-backups'),
  openSamples: () => invoke('cursor:open-samples'),
  getAppInfo: () => invoke('cursor:app-info')
});
