'use strict';

// window.api for the browser version: the same methods preload.js gives the
// Electron window, sent to server.js over HTTP instead of IPC. The page's own
// scripts (renderer.js, taxView.js, billsView.js) are unchanged.
// The three that use native dialogs in Electron work the browser way here:
// choosing an Excel file or backup uploads it, and a backup downloads.
(function () {
  const HEADERS = { 'X-Portfolio-Ledger': '1' };

  async function readError(res) {
    try {
      return (await res.json()).error ?? `Request failed (${res.status})`;
    } catch {
      return `Request failed (${res.status})`;
    }
  }

  async function call(channel, payload) {
    let res;
    try {
      res = await fetch(`/api/call/${channel}`, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: payload === undefined ? null : payload })
      });
    } catch {
      throw new Error('Portfolio Ledger isn’t running. Start it again with "npm run serve", then reload this page.');
    }
    if (!res.ok) throw new Error(await readError(res));
    return (await res.json()).result;
  }

  /** Let the user choose a file. Resolves null if they cancel. */
  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = Object.assign(document.createElement('input'), { type: 'file', accept });
      input.addEventListener('change', () => resolve(input.files[0] ?? null));
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  }

  async function upload(kind, file) {
    const res = await fetch(`/api/upload/${kind}`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/octet-stream' },
      body: file
    });
    if (!res.ok) throw new Error(await readError(res));
    return (await res.json()).token;
  }

  window.api = {
    listPolicies: (opts) => call('policies:list', opts),
    addPolicy: (policy) => call('policies:add', policy),
    updatePolicy: (id, fields) => call('policies:update', { id, fields }),
    deletePolicy: (id) => call('policies:delete', id),
    deletePolicies: (ids) => call('policies:deleteMany', ids),
    restorePolicy: (id) => call('policies:restore', id),
    setIncomeTreatment: (ids, treatment) => call('policies:setIncomeTreatment', { ids, treatment }),
    setTaxTreatment: (ids, treatment) => call('policies:setTaxTreatment', { ids, treatment }),
    getPortfolioSummary: (opts) => call('portfolio:summary', opts),
    getTaxSettings: () => call('tax:getSettings'),
    saveTaxSettings: (settings) => call('tax:saveSettings', settings),
    getCurrency: () => call('settings:getCurrency'),
    setCurrency: (code) => call('settings:setCurrency', code),
    listBills: (opts) => call('bills:list', opts),
    addBill: (bill) => call('bills:add', bill),
    updateBill: (id, bill) => call('bills:update', { id, bill }),
    archiveBill: (id) => call('bills:archive', id),
    restoreBill: (id) => call('bills:restore', id),
    recordPayment: (billId, payment, options) => call('bills:recordPayment', { billId, payment, options }),
    listPayments: (opts) => call('bills:payments', opts),
    deletePayment: (id) => call('bills:deletePayment', id),
    getReminderSettings: () => call('reminders:get'),
    saveReminderSettings: (input) => call('reminders:save', input),
    sendTestReminder: (input) => call('reminders:test', input),
    checkRemindersNow: () => call('reminders:checkNow'),
    quitApp: () => call('app:quit'), // browser version only: stops the local server

    // Excel import: upload the chosen file; previewSheet/commit refer to it by its token.
    async importPreview() {
      const file = await pickFile('.xlsx,.xls');
      if (!file) return null;
      return call('import:previewUpload', { token: await upload('import', file) });
    },
    importPreviewSheet: (filePath, sheetName) => call('import:previewSheet', { filePath, sheetName }),
    importCommit: (filePath, sheetName, columnMapping, incomeTreatment) =>
      call('import:commitWithMapping', { filePath, sheetName, columnMapping, incomeTreatment }),

    // Backup: download a copy of the database through the browser.
    async backupDb() {
      const res = await fetch('/api/backup', { headers: HEADERS });
      if (!res.ok) throw new Error(await readError(res));
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'portfolio-ledger-backup.sqlite';
      const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: name });
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      return { ok: true, filePath: `${name} (in your browser's downloads folder)` };
    },

    // Restore: upload a backup, confirm with the same counts the desktop app shows, then swap it in.
    async restoreDb() {
      const file = await pickFile('.sqlite');
      if (!file) return null;
      const token = await upload('restore', file);
      const info = await call('db:inspectUpload', { token });
      if (!info.ok) {
        await call('uploads:discard', { token });
        return info;
      }
      const ok = confirm(
        'Replace all current data with this backup?\n\n' +
        `Current data: ${info.currentCount} policies.\nBackup: ${info.policyCount} policies.\n\n` +
        'A safety copy of the current data is saved first, next to the database file.'
      );
      if (!ok) {
        await call('uploads:discard', { token });
        return null;
      }
      return call('db:restoreUpload', { token });
    }
  };
})();
