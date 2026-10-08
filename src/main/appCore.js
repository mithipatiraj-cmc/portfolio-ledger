'use strict';

// Everything the app does that doesn't depend on how it's shown: the database,
// every request the page can make, backup/restore, and the reminder service.
// Two front ends sit on top of it, sharing this code and the same database file:
//   - Electron (main.js): IPC handlers plus native file dialogs
//   - the browser server (src/server/server.js): the same handlers over HTTP
// Requests are named by channel ('policies:list', ...) and take one payload,
// exactly as preload.js / webApi.js send them.

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db.js');
const Money = require('../renderer/money.js');
const { commitImport } = require('../import/importRunner.js');
const { getImportPreview } = require('../import/excelImport.js');
const { createReminderService } = require('./reminderService.js');

const DB_FILE = 'portfolio-ledger.sqlite';
const TAX_SETTINGS_KEY = 'tax';
const CURRENCY_KEY = 'currency';

/** portfolio-ledger.sqlite → portfolio-ledger.<label>-<timestamp>.sqlite, next to it. */
function timestampedCopyPath(dbPath, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return dbPath.replace(/\.sqlite$/, `.${label}-${stamp}.sqlite`);
}

/** Keep only non-negative numbers: { rebateLimit, holders: { [name]: { rate, otherIncome } } }. */
function normalizeTaxSettings(input) {
  const amount = (v) => (v === null || v === '' || !(Number(v) >= 0) ? null : Number(v));
  const holders = {};
  for (const [name, h] of Object.entries(input?.holders ?? {})) {
    holders[name] = { rate: amount(h?.rate), otherIncome: amount(h?.otherIncome) };
  }
  return { rebateLimit: amount(input?.rebateLimit), holders };
}

/**
 * Open the database in userDataPath and build the request handlers.
 * @param {object} opts
 * @param {string} opts.userDataPath - folder holding the database, logs and safety copies
 * @param {() => {command: string, args: string[]}} opts.launchCommand - how the daily OS job starts a headless reminder check
 * @param {object} opts.secretStore - protects the Gmail app password (see reminderService.js)
 */
function createAppCore({ userDataPath, launchCommand, secretStore }) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const dbPath = path.join(userDataPath, DB_FILE);
  let database = db.initDb(dbPath);
  const getDatabase = () => database;
  const reminders = createReminderService({ getDatabase, userDataPath, launchCommand, secretStore });

  /**
   * When DB_RESET=true (in .env), drop and recreate every table. The existing
   * database file is copied to a timestamped backup first, so a forgotten flag
   * can't silently destroy data.
   */
  function resetIfRequested() {
    if (process.env.DB_RESET !== 'true') return;
    if (fs.existsSync(dbPath)) {
      const backupPath = timestampedCopyPath(dbPath, 'backup');
      fs.copyFileSync(dbPath, backupPath);
      console.log(`DB_RESET: backed up existing database to ${backupPath}`);
    }
    db.recreateDbSchema(database);
    console.log('DB_RESET: database schema recreated (all data cleared).');
  }

  // --- Excel import: preview a file, then commit it with the user's column mapping ---
  const previewImportFile = (filePath, sheetName) => ({ filePath, ...getImportPreview(fs.readFileSync(filePath), { sheetName }) });
  const commitImportFile = (filePath, { sheetName, columnMapping, incomeTreatment }) =>
    commitImport(database, db, fs.readFileSync(filePath), { sheetName, columnMapping, incomeTreatment });

  // --- Backup & restore ---
  /** Write a consistent copy of the live database to destPath. */
  const backupTo = (destPath) => db.backupTo(database, destPath);

  /** Check a candidate backup before restoring: { ok, policyCount, currentCount } or { ok: false, error }. */
  function inspectRestore(sourcePath) {
    const backup = db.inspectBackup(sourcePath);
    if (!backup.ok) return backup;
    return { ...backup, currentCount: db.listPolicies(database, { includeDeleted: true }).length };
  }

  /** Replace the database with sourcePath: safety copy first, then swap the file in and reopen (running migrations). */
  function restoreFrom(sourcePath) {
    const backup = db.inspectBackup(sourcePath);
    if (!backup.ok) return backup;
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
  }

  // --- Requests from the page, by channel. Each takes the one payload the page sends. ---
  const handlers = {
    'policies:list': (opts) => db.listPolicies(database, opts),
    'policies:add': (policy) => db.addPolicy(database, policy),
    'policies:update': ({ id, fields }) => db.updatePolicy(database, id, fields),
    'policies:delete': (id) => db.deletePolicy(database, id),
    'policies:deleteMany': (ids) => db.deletePolicies(database, ids),
    'policies:restore': (id) => db.restorePolicy(database, id),
    'policies:setIncomeTreatment': ({ ids, treatment }) => db.setIncomeTreatment(database, ids, treatment),
    'policies:setTaxTreatment': ({ ids, treatment }) => db.setTaxTreatment(database, ids, treatment),
    'portfolio:summary': (opts) => db.getPortfolioSummary(database, opts),

    'bills:list': (opts) => db.listBills(database, opts),
    'bills:add': (bill) => db.addBill(database, bill),
    'bills:update': ({ id, bill }) => db.updateBill(database, id, bill),
    'bills:archive': (id) => db.archiveBill(database, id),
    'bills:restore': (id) => db.restoreBill(database, id),
    'bills:recordPayment': ({ billId, payment, options }) => db.recordPayment(database, billId, payment, options),
    'bills:payments': (opts) => db.listPayments(database, opts),
    'bills:deletePayment': (id) => db.deletePayment(database, id),

    // Display currency (no conversion; reminder emails use it too)
    'settings:getCurrency': () => {
      const code = db.getSetting(database, CURRENCY_KEY);
      return Money.isSupported(code) ? code : Money.DEFAULT_CURRENCY;
    },
    'settings:setCurrency': (code) => {
      if (!Money.isSupported(code)) throw new Error(`Unsupported currency: ${code}`);
      db.setSetting(database, CURRENCY_KEY, code);
      return code;
    },

    // Tax projection inputs: the rebate limit plus each holder's rate and other income
    'tax:getSettings': () => db.getSetting(database, TAX_SETTINGS_KEY, {}),
    'tax:saveSettings': (settings) => {
      db.setSetting(database, TAX_SETTINGS_KEY, normalizeTaxSettings(settings));
      return db.getSetting(database, TAX_SETTINGS_KEY);
    },

    // Email reminders (optional, off until enabled in the Reminders dialog)
    'reminders:get': () => reminders.getSettingsView(),
    'reminders:save': (input) => reminders.saveSettings(input),
    'reminders:test': (input) => reminders.sendTest(input),
    'reminders:checkNow': () => reminders.runCheck('manual')
  };

  return {
    dbPath,
    handlers,
    reminders,
    getDatabase,
    resetIfRequested,
    previewImportFile,
    commitImportFile,
    backupTo,
    inspectRestore,
    restoreFrom,
    close: () => database.close()
  };
}

module.exports = { createAppCore, timestampedCopyPath, normalizeTaxSettings, DB_FILE };
