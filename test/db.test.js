'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initDb,
  addPolicy,
  updatePolicy,
  deletePolicy,
  deletePolicies,
  setIncomeTreatment,
  setTaxTreatment,
  restorePolicy,
  listPolicies,
  getPortfolioSummary,
  upsertInstitution,
  recreateDbSchema
} = require('../src/main/db.js');

function freshDb() {
  return initDb(':memory:');
}

test('schema creates the data, bills, settings and reminder-log tables', () => {
  const db = freshDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, [
    'bill_payments', 'bill_reminder_log', 'bills', 'destinations', 'institutions', 'people', 'policies', 'reminder_log', 'settings'
  ]);
});

test('addPolicy resolves lookups and round-trips through listPolicies', () => {
  const db = freshDb();
  const id = addPolicy(db, {
    policyNumber: 'FD-001',
    instrument: 'Fixed Deposit',
    startDate: '2024-01-01',
    maturityDate: '2027-01-01',
    termTotal: '3 years',
    amountInvested: 100000,
    roi: 6.5,
    compoundingPeriodsPerYear: 4,
    maturityAmount: 121000,
    institution: 'HDFC',
    branch: 'Koramangala',
    holder: 'Raviraj',
    jointHolder: null,
    nominee: 'Someone',
    destinationBank: 'ICICI',
    destinationAccount: '1234567890'
  });

  assert.ok(id > 0);

  const rows = listPolicies(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].policy_number, 'FD-001');
  assert.equal(rows[0].institution, 'HDFC');
  assert.equal(rows[0].holder, 'Raviraj');
  assert.equal(rows[0].destination_bank, 'ICICI');
});

test('repeated institution/person/destination names are deduplicated, not re-inserted', () => {
  const db = freshDb();

  addPolicy(db, {
    policyNumber: 'FD-001', institution: 'HDFC', branch: 'Koramangala',
    holder: 'Raviraj', nominee: 'Someone', destinationBank: 'ICICI', destinationAccount: '1234567890',
    amountInvested: 100000, roi: 6.5, maturityDate: '2027-01-01'
  });
  addPolicy(db, {
    policyNumber: 'FD-002', institution: 'HDFC', branch: 'Koramangala',
    holder: 'Raviraj', nominee: 'Someone Else', destinationBank: 'ICICI', destinationAccount: '1234567890',
    amountInvested: 50000, roi: 7.0, maturityDate: '2026-06-01'
  });

  const institutionCount = db.prepare('SELECT COUNT(*) AS c FROM institutions').get().c;
  const peopleCount = db.prepare('SELECT COUNT(*) AS c FROM people').get().c;
  const destinationCount = db.prepare('SELECT COUNT(*) AS c FROM destinations').get().c;

  assert.equal(institutionCount, 1, 'HDFC/Koramangala should be reused, not duplicated');
  assert.equal(destinationCount, 1, 'ICICI/1234567890 should be reused, not duplicated');
  assert.equal(peopleCount, 3, 'Raviraj (shared holder) + 2 distinct nominees = 3 people');
});

test('updatePolicy changes only the fields provided', () => {
  const db = freshDb();
  const id = addPolicy(db, {
    policyNumber: 'FD-001', institution: 'HDFC', holder: 'Raviraj', nominee: 'Someone',
    amountInvested: 100000, roi: 6.5, maturityDate: '2027-01-01'
  });

  updatePolicy(db, id, { roi: 7.25 });

  const row = listPolicies(db)[0];
  assert.equal(row.roi, 7.25);
  assert.equal(row.policy_number, 'FD-001', 'untouched fields should be unchanged');
});

test('deletePolicy soft-deletes: hidden from lists and totals, but the row is kept', () => {
  const db = freshDb();
  const id = addPolicy(db, {
    policyNumber: 'FD-001', institution: 'HDFC', holder: 'Raviraj', nominee: 'Someone',
    amountInvested: 100000, roi: 6.5, maturityDate: '2027-01-01'
  });

  assert.equal(deletePolicy(db, id), true);
  assert.equal(listPolicies(db).length, 0);
  assert.equal(getPortfolioSummary(db).accountCount, 0);
  assert.equal(getPortfolioSummary(db).totalInvested, 0);

  const withDeleted = listPolicies(db, { includeDeleted: true });
  assert.equal(withDeleted.length, 1);
  assert.ok(withDeleted[0].deleted_at, 'deleted_at is stamped');

  assert.equal(deletePolicy(db, id), false, 'deleting an already-deleted policy reports false');
  assert.equal(deletePolicy(db, 9999), false, 'deleting a non-existent id should report false, not throw');
});

test('restorePolicy brings a soft-deleted policy back', () => {
  const db = freshDb();
  const id = addPolicy(db, { policyNumber: 'FD-001', institution: 'HDFC', amountInvested: 5000, maturityDate: '2027-01-01' });
  deletePolicy(db, id);

  assert.equal(restorePolicy(db, id), true);
  const [row] = listPolicies(db);
  assert.equal(row.policy_number, 'FD-001');
  assert.equal(row.deleted_at, null);
  assert.equal(restorePolicy(db, id), false, 'restoring an active policy reports false');
});

test('policy_number UNIQUE constraint rejects duplicates', () => {
  const db = freshDb();
  addPolicy(db, {
    policyNumber: 'FD-001', institution: 'HDFC', holder: 'Raviraj', nominee: 'Someone',
    amountInvested: 100000, roi: 6.5, maturityDate: '2027-01-01'
  });

  assert.throws(() => {
    addPolicy(db, {
      policyNumber: 'FD-001', institution: 'SBI', holder: 'Raviraj', nominee: 'Someone',
      amountInvested: 50000, roi: 6.0, maturityDate: '2026-01-01'
    });
  }, /UNIQUE/);
});

test('getPortfolioSummary aggregates totals, by-institution breakdown, and upcoming maturities', () => {
  const db = freshDb();
  const soon = new Date();
  soon.setDate(soon.getDate() + 10);
  const soonStr = soon.toISOString().slice(0, 10);
  const far = '2099-01-01';

  addPolicy(db, {
    policyNumber: 'FD-001', institution: 'HDFC', holder: 'Raviraj', nominee: 'Someone',
    amountInvested: 100000, roi: 6.5, maturityDate: soonStr
  });
  addPolicy(db, {
    policyNumber: 'FD-002', institution: 'SBI', holder: 'Raviraj', nominee: 'Someone',
    amountInvested: 200000, roi: 7.5, maturityDate: far
  });

  const summary = getPortfolioSummary(db, { upcomingWithinDays: 30 });

  assert.equal(summary.accountCount, 2);
  assert.equal(summary.totalInvested, 300000);
  assert.equal(summary.byInstitution.length, 2);
  assert.equal(summary.upcomingMaturities.length, 1, 'only the soon-maturing policy should be flagged');
  assert.equal(summary.upcomingMaturities[0].policyNumber, 'FD-001');
});

test('upsertInstitution treats null branch consistently', () => {
  const db = freshDb();
  const id1 = upsertInstitution(db, 'SBI', null);
  const id2 = upsertInstitution(db, 'SBI', null);
  assert.equal(id1, id2, 'same name with null branch should resolve to the same row');
});

test('recreateDbSchema clears all data and leaves a usable empty schema', () => {
  const db = freshDb();
  addPolicy(db, {
    policyNumber: 'FD-001', institution: 'HDFC', holder: 'Raviraj',
    amountInvested: 100000, roi: 6.5, maturityDate: '2027-01-01'
  });

  recreateDbSchema(db);

  assert.equal(listPolicies(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM institutions').get().n, 0);
  addPolicy(db, { policyNumber: 'FD-002', institution: 'SBI', amountInvested: 5000, maturityDate: '2027-01-01' });
  assert.equal(listPolicies(db).length, 1);
});

test('addPolicy stores lookup names in Title Case and treats case variants as the same row', () => {
  const db = freshDb();
  const base = { institution: 'union bank', branch: 'TELLAPUR', amountInvested: 1000, maturityDate: '2027-01-01' };
  addPolicy(db, { ...base, policyNumber: 'A', holder: 'RAVIRAJ', nominee: 'madhavi' });
  addPolicy(db, { ...base, policyNumber: 'B', institution: 'Union Bank', holder: 'raviraj', nominee: 'Madhavi' });

  const [a, b] = listPolicies(db);
  assert.equal(a.institution, 'Union Bank');
  assert.equal(a.branch, 'Tellapur');
  assert.equal(a.holder, 'Raviraj');
  assert.equal(b.nominee, 'Madhavi');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM institutions').get().n, 1);
});

test('initDb merges existing case-only duplicate names and re-points policies to the survivor', () => {
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), 'dupes.sqlite');

  // Simulate data written before names were normalised.
  const first = initDb(dbPath);
  first.exec(`
    INSERT INTO people (id, name) VALUES (1, 'RAVIRAJ'), (2, 'raviraj'), (3, 'madhavi');
    INSERT INTO institutions (id, name, branch) VALUES (1, 'Union Bank', 'tellapur'), (2, 'union bank', 'tellapur');
    INSERT INTO policies (policy_number, holder_id, nominee_id, institution_id) VALUES ('A', 1, 3, 1), ('B', 2, 3, 2);
  `);
  first.close();

  const db = initDb(dbPath);
  assert.deepEqual(db.prepare('SELECT name FROM people ORDER BY id').all().map((r) => r.name), ['Raviraj', 'Madhavi']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM institutions').get().n, 1);
  const rows = listPolicies(db);
  assert.deepEqual(rows.map((r) => [r.policy_number, r.holder, r.institution, r.branch]), [
    ['A', 'Raviraj', 'Union Bank', 'Tellapur'],
    ['B', 'Raviraj', 'Union Bank', 'Tellapur']
  ]);
  db.close();
});

test('addPolicy/updatePolicy enforce maturity date for fixed deposits only', () => {
  const db = freshDb();
  assert.throws(() => addPolicy(db, { policyNumber: 'A', instrument: 'F D', institution: 'HDFC', amountInvested: 1 }), /fixed deposits/);

  const nscId = addPolicy(db, { policyNumber: 'B', instrument: 'NSC', institution: 'Post Office', amountInvested: 1 });
  const fdId = addPolicy(db, { policyNumber: 'C', instrument: 'Fixed Deposit', institution: 'HDFC', amountInvested: 1, maturityDate: '2027-01-01' });

  assert.throws(() => updatePolicy(db, fdId, { maturity_date: null }), /fixed deposits/, 'cannot clear an FD maturity date');
  assert.throws(() => updatePolicy(db, nscId, { instrument: 'FD' }), /fixed deposits/, 'cannot turn a dateless policy into an FD');
  assert.equal(updatePolicy(db, nscId, { instrument: 'FD', maturity_date: '2028-01-01' }), true, 'fine when both are set together');
  assert.equal(updatePolicy(db, fdId, { instrument: 'NSC' }), true);
  assert.equal(updatePolicy(db, fdId, { maturity_date: null }), true, 'non-FD may have no maturity date');
});

test('listPolicies sorts policies without a maturity date last', () => {
  const db = freshDb();
  addPolicy(db, { policyNumber: 'NO-DATE', instrument: 'NSC', institution: 'Post Office', amountInvested: 1 });
  addPolicy(db, { policyNumber: 'DATED', instrument: 'FD', institution: 'HDFC', amountInvested: 1, maturityDate: '2027-01-01' });
  assert.deepEqual(listPolicies(db).map((p) => p.policy_number), ['DATED', 'NO-DATE']);
});

test('backupTo writes a restorable copy that inspectBackup accepts', () => {
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const { backupTo, inspectBackup } = require('../src/main/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
  const dest = path.join(dir, 'backup.sqlite');

  const db = freshDb();
  addPolicy(db, { policyNumber: 'FD-001', institution: 'HDFC', amountInvested: 1000, maturityDate: '2027-01-01' });
  fs.writeFileSync(dest, 'stale file that must be replaced');
  backupTo(db, dest);

  assert.deepEqual(inspectBackup(dest), { ok: true, policyCount: 1 });
  const reopened = initDb(dest);
  assert.equal(listPolicies(reopened)[0].policy_number, 'FD-001');
  reopened.close();
});

test('inspectBackup rejects files that are not Portfolio Ledger databases', () => {
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const { DatabaseSync } = require('node:sqlite');
  const { inspectBackup } = require('../src/main/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));

  const textFile = path.join(dir, 'notes.sqlite');
  fs.writeFileSync(textFile, 'definitely not sqlite');
  const r1 = inspectBackup(textFile);
  assert.equal(r1.ok, false);

  const otherDb = path.join(dir, 'other.sqlite');
  const other = new DatabaseSync(otherDb);
  other.exec('CREATE TABLE something (id INTEGER)');
  other.close();
  const r2 = inspectBackup(otherDb);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /missing tables/);
});

test('settings round-trip as JSON and survive recreateDbSchema', () => {
  const { getSetting, setSetting } = require('../src/main/db.js');
  const db = freshDb();
  assert.equal(getSetting(db, 'reminders'), null);
  assert.deepEqual(getSetting(db, 'reminders', { enabled: false }), { enabled: false });

  setSetting(db, 'reminders', { enabled: true, daysBefore: [30, 7] });
  setSetting(db, 'reminders', { enabled: true, daysBefore: [7] }); // upsert
  assert.deepEqual(getSetting(db, 'reminders'), { enabled: true, daysBefore: [7] });

  recreateDbSchema(db);
  assert.deepEqual(getSetting(db, 'reminders'), { enabled: true, daysBefore: [7] }, 'preferences are not data');
});

test('reminder log records sent reminders once and is cleared by recreateDbSchema', () => {
  const { listSentReminders, recordRemindersSent } = require('../src/main/db.js');
  const db = freshDb();
  const id = addPolicy(db, { policyNumber: 'FD-1', institution: 'HDFC', amountInvested: 1, maturityDate: '2026-10-01' });

  const entries = [{ policyId: id, maturityDate: '2026-10-01', daysBefore: 7 }, { policyId: id, maturityDate: '2026-10-01', daysBefore: 30 }];
  recordRemindersSent(db, entries);
  recordRemindersSent(db, entries); // duplicates ignored
  assert.deepEqual([...listSentReminders(db)].sort(), [`${id}|2026-10-01|30`, `${id}|2026-10-01|7`]);

  recreateDbSchema(db);
  assert.equal(listSentReminders(db).size, 0);
});

test('initDb adds income_treatment to older databases, and only known values are accepted', () => {
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), 'noincome.sqlite');

  const old = new DatabaseSync(dbPath);
  old.exec('CREATE TABLE policies (id INTEGER PRIMARY KEY, policy_number TEXT UNIQUE, amount_invested REAL, deleted_at TEXT);');
  old.exec("INSERT INTO policies (policy_number, amount_invested) VALUES ('FD-OLD', 1);");
  old.close();

  const db = initDb(dbPath);
  const [existing] = db.prepare('SELECT income_treatment FROM policies').all();
  assert.equal(existing.income_treatment, null, 'existing policies are left unrecorded');

  const id = db.prepare('SELECT id FROM policies').get().id;
  assert.equal(updatePolicy(db, id, { income_treatment: 'non-cumulative' }), true);
  assert.throws(() => updatePolicy(db, id, { income_treatment: 'monthly' }), /CHECK constraint/);
  db.close();
});

test('deletePolicies soft-deletes every listed policy and counts only ones not already deleted', () => {
  const db = initDb(':memory:');
  const ids = ['A', 'B', 'C'].map((n) => addPolicy(db, { policyNumber: n, institution: 'HDFC', amountInvested: 1 }));
  deletePolicy(db, ids[0]);

  assert.equal(deletePolicies(db, ids.slice(0, 2)), 1, 'A was already deleted');
  assert.deepEqual(listPolicies(db).map((p) => p.policy_number), ['C']);
});

test('setIncomeTreatment updates active policies only, and rejects unknown values without changing anything', () => {
  const db = initDb(':memory:');
  const [a, b, c] = ['A', 'B', 'C'].map((n) => addPolicy(db, { policyNumber: n, institution: 'HDFC', amountInvested: 1 }));
  deletePolicy(db, c);

  assert.equal(setIncomeTreatment(db, [a, b, c], 'non-cumulative'), 2, 'deleted C is left alone');
  const byNumber = Object.fromEntries(listPolicies(db, { includeDeleted: true }).map((p) => [p.policy_number, p.income_treatment]));
  assert.deepEqual(byNumber, { A: 'non-cumulative', B: 'non-cumulative', C: null });

  assert.throws(() => setIncomeTreatment(db, [a], 'monthly'), /Unknown income treatment/);
  assert.equal(listPolicies(db).find((p) => p.id === a).income_treatment, 'non-cumulative');
});

test('updatePolicy skips undefined fields instead of failing to bind them', () => {
  const db = initDb(':memory:');
  const id = addPolicy(db, { policyNumber: 'A', institution: 'HDFC', amountInvested: 1, roi: 6 });
  assert.equal(updatePolicy(db, id, { roi: 7, start_date: undefined }), true);
  assert.equal(listPolicies(db)[0].roi, 7);
});

test('setTaxTreatment tags active policies as exempt or taxable; untagged policies stay NULL', () => {
  const db = initDb(':memory:');
  const [a, b] = ['A', 'B'].map((n) => addPolicy(db, { policyNumber: n, institution: 'HDFC', amountInvested: 1 }));
  assert.equal(setTaxTreatment(db, [a], 'exempt'), 1);
  assert.deepEqual(listPolicies(db).map((p) => p.tax_treatment), ['exempt', null]);
  assert.equal(setTaxTreatment(db, [a], 'taxable'), 1);
  assert.throws(() => setTaxTreatment(db, [b], 'partly'), /Unknown tax treatment/);
});
