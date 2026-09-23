'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listPolicies: () => ipcRenderer.invoke('policies:list'),
  addPolicy: (policy) => ipcRenderer.invoke('policies:add', policy),
  updatePolicy: (id, fields) => ipcRenderer.invoke('policies:update', { id, fields }),
  deletePolicy: (id) => ipcRenderer.invoke('policies:delete', id),
  getPortfolioSummary: (opts) => ipcRenderer.invoke('portfolio:summary', opts),
  importExcel: () => ipcRenderer.invoke('import:pickAndCommit')
});
