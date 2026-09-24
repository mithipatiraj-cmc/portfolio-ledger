'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const db = require('./db.js');
const { commitImport } = require('../import/importRunner.js');
const { getImportPreview } = require('../import/excelImport.js');

let database;

function getDbPath() {
  return path.join(app.getPath('userData'), 'portfolio-ledger.sqlite');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  database = db.initDb(getDbPath());

  // --- IPC handlers: the renderer never touches SQLite directly ---
  ipcMain.handle('policies:list', () => db.listPolicies(database));
  ipcMain.handle('policies:add', (_event, policy) => db.addPolicy(database, policy));
  ipcMain.handle('policies:update', (_event, { id, fields }) => db.updatePolicy(database, id, fields));
  ipcMain.handle('policies:delete', (_event, id) => db.deletePolicy(database, id));
  ipcMain.handle('portfolio:summary', (_event, opts) => db.getPortfolioSummary(database, opts));

  // --- Excel import, two-step so the renderer can show a mapping UI before committing ---
  // Step 1: user picks a file; we return its header row + auto-detected mapping.
  // The renderer builds a mapping screen from this and lets the user adjust it.
  ipcMain.handle('import:pickAndPreview', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
    });
    if (canceled || filePaths.length === 0) return null;
    const filePath = filePaths[0];
    const buffer = fs.readFileSync(filePath);
    const preview = getImportPreview(buffer);
    return { filePath, ...preview };
  });

  // Step 2: user confirms (or adjusts) the mapping; we re-read the same file and commit.
  ipcMain.handle('import:commitWithMapping', (_event, { filePath, columnMapping }) => {
    const buffer = fs.readFileSync(filePath);
    return commitImport(database, db, buffer, { columnMapping });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (database) database.close();
  if (process.platform !== 'darwin') app.quit();
});