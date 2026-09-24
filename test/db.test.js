'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initDb,
  addPolicy,
  updatePolicy,
  deletePolicy,
  listPolicies,
  getPortfolioSummary,
  upsertInstitution,
  recreateDbSchema
} = require('../src/main/db.js');

function freshDb() {
  return initDb(':memory:');
}

test('schema creates all four tables', () => {
  const db = freshDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ['destinations', 'institutions', 'people', 'policies']);
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

test('deletePolicy removes the row and reports success', () => {
  const db = freshDb();
  const id = addPolicy(db, {
    policyNumber: 'FD-001', institution: 'HDFC', holder: 'Raviraj', nominee: 'Someone',
    amountInvested: 100000, roi: 6.5, maturityDate: '2027-01-01'
  });

  const deleted = deletePolicy(db, id);
  assert.equal(deleted, true);
  assert.equal(listPolicies(db).length, 0);

  const deletedAgain = deletePolicy(db, id);
  assert.equal(deletedAgain, false, 'deleting a non-existent id should report false, not throw');
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

test('initDb migrates an old database whose policies table still has received_amount', () => {
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), 'old.sqlite');

  const old = new DatabaseSync(dbPath);
  old.exec('CREATE TABLE policies (id INTEGER PRIMARY KEY, policy_number TEXT UNIQUE, received_amount REAL);');
  old.exec("INSERT INTO policies (policy_number, received_amount) VALUES ('FD-OLD', 50000);");
  old.close();

  const db = initDb(dbPath);
  const row = db.prepare('SELECT amount_invested FROM policies WHERE policy_number = ?').get('FD-OLD');
  assert.equal(row.amount_invested, 50000);
  db.close();
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
