const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  listFiles: (dirPath) => ipcRenderer.invoke('list-files', dirPath),
  listTree: (rootPath) => ipcRenderer.invoke('list-tree', rootPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  createDirectory: (dirPath) => ipcRenderer.invoke('create-directory', dirPath),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  executeCommand: (command, cwd, opts) => ipcRenderer.invoke('execute-command', command, cwd, opts),
  readProcessOutput: (pid) => ipcRenderer.invoke('read-process-output', pid),
  listProcesses: () => ipcRenderer.invoke('list-processes'),
  stopProcess: (pid) => ipcRenderer.invoke('stop-process', pid),
  clearFinishedProcesses: () => ipcRenderer.invoke('clear-finished-processes'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  webSearch: (query, maxResults) => ipcRenderer.invoke('web-search', query, maxResults),
  fetchUrl: (url, maxChars) => ipcRenderer.invoke('fetch-url', url, maxChars),
  loadStore: () => ipcRenderer.invoke('load-store'),
  saveStore: (data) => ipcRenderer.invoke('save-store', data),
  setTitle: (title) => ipcRenderer.send('set-title', title)
});