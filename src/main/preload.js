'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listPolicies: (opts) => ipcRenderer.invoke('policies:list', opts),
  addPolicy: (policy) => ipcRenderer.invoke('policies:add', policy),
  updatePolicy: (id, fields) => ipcRenderer.invoke('policies:update', { id, fields }),
  deletePolicy: (id) => ipcRenderer.invoke('policies:delete', id),
  restorePolicy: (id) => ipcRenderer.invoke('policies:restore', id),
  getPortfolioSummary: (opts) => ipcRenderer.invoke('portfolio:summary', opts),
  importPreview: () => ipcRenderer.invoke('import:pickAndPreview'),
  importPreviewSheet: (filePath, sheetName) => ipcRenderer.invoke('import:previewSheet', { filePath, sheetName }),
  importCommit: (filePath, sheetName, columnMapping) =>
    ipcRenderer.invoke('import:commitWithMapping', { filePath, sheetName, columnMapping }),
  backupDb: () => ipcRenderer.invoke('db:backup'),
  restoreDb: () => ipcRenderer.invoke('db:restore')
});
