'use strict';

// The Electron front end: a window, native file dialogs, and IPC wiring on top
// of appCore.js, which holds the database and every request handler. The
// browser server (src/server/server.js) is the other front end on the same core.

const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('node:path');
const { createAppCore } = require('./appCore.js');
const { CHECK_FLAG } = require('./scheduler.js');

// Load .env from the project root regardless of the directory the app was launched from.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

let core;

// Started by the daily OS job (see scheduler.js): check and email reminders, no window.
const isReminderCheck = process.argv.includes(CHECK_FLAG);
const HOUR_MS = 60 * 60 * 1000;

/** The Gmail app password, encrypted with the OS keychain (macOS) or DPAPI (Windows) via Electron. */
const electronSecretStore = {
  settingsKey: 'reminders.appPassword',
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64'))
};

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

/** How the OS job relaunches this app headless: packaged app vs `electron .` in development. */
function reminderLaunchCommand() {
  return process.defaultApp
    ? { command: process.execPath, args: [app.getAppPath(), CHECK_FLAG] }
    : { command: process.execPath, args: [CHECK_FLAG] };
}

// One instance at a time. If the daily job fires while the app is open, the
// open app runs the check instead; a second normal launch focuses the window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes(CHECK_FLAG)) {
      core?.reminders.runCheck('scheduled (app open)');
      return;
    }
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  if (isReminderCheck) app.dock?.hide();
  app.whenReady().then(start);
}

async function start() {
  core = createAppCore({
    userDataPath: app.getPath('userData'),
    launchCommand: reminderLaunchCommand,
    secretStore: electronSecretStore
  });

  if (isReminderCheck) {
    try {
      await core.reminders.runCheck('scheduled');
    } finally {
      app.quit();
    }
    return; // headless: no reset, no window, no IPC
  }

  core.resetIfRequested();

  // --- IPC: the renderer never touches SQLite directly ---
  for (const [channel, handler] of Object.entries(core.handlers)) {
    ipcMain.handle(channel, (_event, payload) => handler(payload));
  }

  // --- Excel import, two-step so the renderer can show a mapping UI before committing ---
  // Step 1: user picks a file; we return its header row + auto-detected mapping.
  ipcMain.handle('import:pickAndPreview', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
    });
    if (canceled || filePaths.length === 0) return null;
    return core.previewImportFile(filePaths[0]);
  });
  // Step 1b: user picks a different sheet in a multi-sheet workbook; re-preview that sheet.
  ipcMain.handle('import:previewSheet', (_event, { filePath, sheetName }) => core.previewImportFile(filePath, sheetName));
  // Step 2: user confirms (or adjusts) the mapping; we re-read the same file and commit.
  ipcMain.handle('import:commitWithMapping', (_event, { filePath, ...options }) => core.commitImportFile(filePath, options));

  // --- Backup & restore, through native save/open dialogs ---
  ipcMain.handle('db:backup', async (event) => {
    const today = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Save backup',
      defaultPath: path.join(app.getPath('documents'), `portfolio-ledger-backup-${today}.sqlite`),
      filters: [{ name: 'Portfolio Ledger backup', extensions: ['sqlite'] }]
    });
    if (canceled || !filePath) return null;
    core.backupTo(filePath);
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

    const backup = core.inspectRestore(sourcePath);
    if (!backup.ok) return { ok: false, error: backup.error };

    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Restore', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Replace all current data with this backup?',
      detail:
        `Current data: ${backup.currentCount} policies.\nBackup: ${backup.policyCount} policies.\n\n` +
        'A safety copy of the current data is saved first, next to the database file.'
    });
    if (response !== 0) return null;
    return core.restoreFrom(sourcePath);
  });

  createWindow();

  // Catch anything that came due while the app was closed, then keep checking hourly.
  core.reminders.runCheck('startup');
  setInterval(() => core.reminders.runCheck('hourly'), HOUR_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

// On macOS the app stays running with no windows and can reopen one from the
// Dock, so the database is closed on quit rather than when the last window closes.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (core) core.close();
});
