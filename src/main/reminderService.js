'use strict';

// Glue between the reminder rules (reminders.js), the database, Gmail
// (mailer.js), and the OS scheduler (scheduler.js). Used both by the running
// app (settings screen, hourly check) and by the headless --check-reminders run.

const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');
const db = require('./db.js');
const { sendMail } = require('./mailer.js');
const {
  normalizePrefs,
  parseDaysBefore,
  isValidEmail,
  findDueReminders,
  findDueBillReminders,
  buildReminderEmail
} = require('./reminders.js');
const scheduler = require('./scheduler.js');

const PREFS_KEY = 'reminders';
const PASSWORD_KEY = 'reminders.appPassword'; // encrypted with the OS keychain / DPAPI
const LAST_CHECK_KEY = 'reminders.lastCheck';
const SCHEDULE_KEY = 'reminders.schedule';

/**
 * @param {object} deps
 * @param {() => import('node:sqlite').DatabaseSync} deps.getDatabase - current connection (it changes on restore)
 * @param {string} deps.userDataPath - where reminders.log goes
 * @param {() => {command: string, args: string[]}} deps.launchCommand - how the OS job starts this app headless
 */
function createReminderService({ getDatabase, userDataPath, launchCommand }) {
  const logPath = path.join(userDataPath, 'reminders.log');
  let checkInProgress = null;

  function log(message) {
    const line = `${new Date().toISOString()} ${message}\n`;
    try { fs.appendFileSync(logPath, line); } catch { /* logging must never break a check */ }
  }

  function loadPrefs() {
    const prefs = normalizePrefs(db.getSetting(getDatabase(), PREFS_KEY));
    prefs.hasPassword = Boolean(db.getSetting(getDatabase(), PASSWORD_KEY));
    return prefs;
  }

  function readPassword() {
    const stored = db.getSetting(getDatabase(), PASSWORD_KEY);
    if (!stored) return null;
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  }

  function savePassword(plain) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure password storage is not available on this system, so the app password cannot be saved.');
    }
    db.setSetting(getDatabase(), PASSWORD_KEY, safeStorage.encryptString(plain).toString('base64'));
  }

  /** Everything the settings screen shows. Never includes the password itself. */
  function getSettingsView() {
    return {
      prefs: loadPrefs(),
      lastCheck: db.getSetting(getDatabase(), LAST_CHECK_KEY),
      schedule: db.getSetting(getDatabase(), SCHEDULE_KEY),
      logPath
    };
  }

  /** Validate the form input; returns { prefs, password } or throws with a message for the user. */
  function validateInput(input, { requireComplete }) {
    const current = loadPrefs();
    const daysBefore = parseDaysBefore(input.daysBefore);
    if (!daysBefore) throw new Error('"Days before maturity" must be whole numbers between 0 and 365, e.g. 30, 7, 1.');
    const billsEnabled = Boolean(input.billsEnabled);
    // Keep the saved bill thresholds while bill reminders are off, so ticking them again restores them.
    const billDaysBefore = billsEnabled ? parseDaysBefore(input.billDaysBefore) : current.billDaysBefore;
    if (!billDaysBefore) throw new Error('"Days before a bill is due" must be whole numbers between 0 and 365, e.g. 3, 1.');
    const prefs = normalizePrefs({
      enabled: Boolean(input.enabled),
      recipient: String(input.recipient ?? '').trim(),
      gmailUser: String(input.gmailUser ?? '').trim(),
      daysBefore,
      billsEnabled,
      billDaysBefore,
      checkHour: Number(input.checkHour)
    });
    const password = String(input.appPassword ?? '').trim();
    if (requireComplete) {
      if (!isValidEmail(prefs.recipient)) throw new Error('Enter the email address reminders should go to.');
      if (!isValidEmail(prefs.gmailUser)) throw new Error('Enter the Gmail address to send from.');
      if (!password && !current.hasPassword) throw new Error('Enter the Gmail app password.');
    }
    return { prefs, password };
  }

  /** Save preferences and create/remove the daily OS job to match. */
  function saveSettings(input) {
    const { prefs, password } = validateInput(input, { requireComplete: Boolean(input.enabled) });
    if (password) savePassword(password);
    db.setSetting(getDatabase(), PREFS_KEY, { ...prefs, hasPassword: undefined });

    if (prefs.enabled) {
      const { command, args } = launchCommand();
      const schedule = scheduler.installSchedule({ command, args, hour: prefs.checkHour, logPath });
      db.setSetting(getDatabase(), SCHEDULE_KEY, schedule);
      log(`reminders enabled; ${schedule.description}`);
    } else {
      scheduler.removeSchedule();
      db.setSetting(getDatabase(), SCHEDULE_KEY, null);
      log('reminders disabled; daily job removed');
    }
    return getSettingsView();
  }

  /** Send a test email using the form's values (falls back to the saved password). */
  async function sendTest(input) {
    const { prefs, password } = validateInput({ ...input, enabled: true }, { requireComplete: true });
    await sendMail({
      gmailUser: prefs.gmailUser,
      appPassword: password || readPassword(),
      to: prefs.recipient,
      subject: 'Portfolio Ledger: test email',
      text: `Email reminders are working. You'll be emailed ${prefs.daysBefore.join(', ')} day(s) before a policy matures` +
        (prefs.billsEnabled ? ` and ${prefs.billDaysBefore.join(', ')} day(s) before a bill is due.` : '.')
    });
    return { ok: true };
  }

  /**
   * Email any due reminders. Safe to call often: sent reminders are logged in
   * the database, so each goes out once. trigger is just for the log.
   */
  function runCheck(trigger) {
    if (checkInProgress) return checkInProgress;
    checkInProgress = (async () => {
      const prefs = loadPrefs();
      if (!prefs.enabled) return { ran: false, reason: 'disabled' };

      const result = { at: new Date().toISOString(), trigger, ok: true, sent: 0, error: null };
      try {
        const database = getDatabase();
        const due = findDueReminders(db.listPolicies(database), db.listSentReminders(database), prefs.daysBefore);
        const billsDue = prefs.billsEnabled
          ? findDueBillReminders(db.listBills(database), db.listSentBillReminders(database), prefs.billDaysBefore)
          : [];
        if (due.length + billsDue.length > 0) {
          const password = readPassword();
          if (!password) throw new Error('No Gmail app password saved.');
          const mail = buildReminderEmail(due, billsDue);
          await sendMail({ gmailUser: prefs.gmailUser, appPassword: password, to: prefs.recipient, ...mail });
          // Both logs only after the email went out, so a failed send is retried next check.
          db.recordRemindersSent(database, due.flatMap((d) => d.markSent));
          db.recordBillRemindersSent(database, billsDue.flatMap((d) => d.markSent));
          result.sent = due.length + billsDue.length;
        }
      } catch (err) {
        result.ok = false;
        result.error = err.message;
      }
      db.setSetting(getDatabase(), LAST_CHECK_KEY, result);
      log(`check (${trigger}): ${result.ok ? `sent ${result.sent} reminder(s)` : `FAILED — ${result.error}`}`);
      return { ran: true, ...result };
    })().finally(() => { checkInProgress = null; });
    return checkInProgress;
  }

  return { getSettingsView, saveSettings, sendTest, runCheck, log };
}

module.exports = { createReminderService };
