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

/** portfolio-ledger.sqlite → portfolio-ledger.<label>-<timestamp>.sqlite, next to it. */
function timestampedCopyPath(dbPath, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return dbPath.replace(/\.sqlite$/, `.${label}-${stamp}.sqlite`);
}

/**
 * When DB_RESET=true (in .env), drop and recreate every table on startup.
 * The existing database file is copied to a timestamped backup first, so a
 * forgotten flag can't silently destroy data.
 */
function resetDbIfRequested(dbPath) {
  if (process.env.DB_RESET !== 'true') return;
  if (fs.existsSync(dbPath)) {
    const backupPath = timestampedCopyPath(dbPath, 'backup');
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
  ipcMain.handle('policies:list', (_event, opts) => db.listPolicies(database, opts));
  ipcMain.handle('policies:add', (_event, policy) => db.addPolicy(database, policy));
  ipcMain.handle('policies:update', (_event, { id, fields }) => db.updatePolicy(database, id, fields));
  ipcMain.handle('policies:delete', (_event, id) => db.deletePolicy(database, id));
  ipcMain.handle('policies:restore', (_event, id) => db.restorePolicy(database, id));
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

  // Step 1b: user picks a different sheet in a multi-sheet workbook; re-preview that sheet.
  ipcMain.handle('import:previewSheet', (_event, { filePath, sheetName }) => {
    const buffer = fs.readFileSync(filePath);
    return { filePath, ...getImportPreview(buffer, { sheetName }) };
  });

  // Step 2: user confirms (or adjusts) the mapping; we re-read the same file and commit.
  ipcMain.handle('import:commitWithMapping', (_event, { filePath, sheetName, columnMapping }) => {
    const buffer = fs.readFileSync(filePath);
    return commitImport(database, db, buffer, { sheetName, columnMapping });
  });

  // --- Backup & restore ---
  ipcMain.handle('db:backup', async (event) => {
    const today = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Save backup',
      defaultPath: path.join(app.getPath('documents'), `portfolio-ledger-backup-${today}.sqlite`),
      filters: [{ name: 'Portfolio Ledger backup', extensions: ['sqlite'] }]
    });
    if (canceled || !filePath) return null;
    db.backupTo(database, filePath);
    return { ok: true, filePath };
  });

  ipcMain.handle('db:restore', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Restore from backup',
      properties: ['openFile'],
      filters: [{ name: 'Portfolio Ledger backup', extensions: ['sqlite'] }]
    });
    if (canceled || filePaths.length === 0) return null;
    const sourcePath = filePaths[0];

    const backup = db.inspectBackup(sourcePath);
    if (!backup.ok) return { ok: false, error: backup.error };

    const currentCount = db.listPolicies(database, { includeDeleted: true }).length;
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Restore', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Replace all current data with this backup?',
      detail:
        `Current data: ${currentCount} policies.\nBackup: ${backup.policyCount} policies.\n\n` +
        'A safety copy of the current data is saved first, next to the database file.'
    });
    if (response !== 0) return null;

    // Safety copy first, then swap the file in and reopen (initDb runs any migrations).
    const dbPath = getDbPath();
    const safetyPath = timestampedCopyPath(dbPath, 'before-restore');
    db.backupTo(database, safetyPath);
    database.close();
    try {
      fs.copyFileSync(sourcePath, dbPath);
      database = db.initDb(dbPath);
    } catch (err) {
      fs.copyFileSync(safetyPath, dbPath);
      database = db.initDb(dbPath);
      return { ok: false, error: `Restore failed, your previous data is unchanged: ${err.message}` };
    }
    return { ok: true, policyCount: backup.policyCount, safetyPath };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// On macOS the app stays running with no windows and can reopen one from the
// Dock, so the database is closed on quit rather than when the last window closes.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (database) database.close();
});