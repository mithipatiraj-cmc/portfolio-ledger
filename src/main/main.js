'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const db = require('./db.js');
const { commitImport } = require('../import/importRunner.js');
const { getImportPreview } = require('../import/excelImport.js');

// Load .env from the project root regardless of the directory the app was launched from.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

let database;

function getDbPath() {
  return path.join(app.getPath('userData'), 'portfolio-ledger.sqlite');
}

/**
 * When DB_RESET=true (in .env), drop and recreate every table on startup.
 * The existing database file is copied to a timestamped backup first, so a
 * forgotten flag can't silently destroy data.
 */
function resetDbIfRequested(dbPath) {
  if (process.env.DB_RESET !== 'true') return;
  if (fs.existsSync(dbPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = dbPath.replace(/\.sqlite$/, `.backup-${stamp}.sqlite`);
    fs.copyFileSync(dbPath, backupPath);
    console.log(`DB_RESET: backed up existing database to ${backupPath}`);
  }
  db.recreateDbSchema(database);
  console.log('DB_RESET: database schema recreated (all data cleared).');
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
  resetDbIfRequested(getDbPath());

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