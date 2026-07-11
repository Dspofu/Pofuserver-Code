const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  listFiles: (dirPath) => ipcRenderer.invoke('list-files', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  executeCommand: (command, cwd, opts) => ipcRenderer.invoke('execute-command', command, cwd, opts),
  readProcessOutput: (pid) => ipcRenderer.invoke('read-process-output', pid),
  listProcesses: () => ipcRenderer.invoke('list-processes'),
  stopProcess: (pid) => ipcRenderer.invoke('stop-process', pid),
  loadStore: () => ipcRenderer.invoke('load-store'),
  saveStore: (data) => ipcRenderer.invoke('save-store', data),
  momentAI: (title) => ipcRenderer.send("set-title", title)
});