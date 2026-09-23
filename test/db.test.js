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
  upsertInstitution
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
    receivedAmount: 100000,
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
    receivedAmount: 100000, roi: 6.5, maturityDate: '2027-01-01'
  });
  addPolicy(db, {
    policyNumber: 'FD-002', institution: 'HDFC', branch: 'Koramangala',
    holder: 'Raviraj', nominee: 'Someone Else', destinationBank: 'ICICI', destinationAccount: '1234567890',
    receivedAmount: 50000, roi: 7.0, maturityDate: '2026-06-01'
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
    receivedAmount: 100000, roi: 6.5, maturityDate: '2027-01-01'
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
    receivedAmount: 100000, roi: 6.5, maturityDate: '2027-01-01'
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
    receivedAmount: 100000, roi: 6.5, maturityDate: '2027-01-01'
  });

  assert.throws(() => {
    addPolicy(db, {
      policyNumber: 'FD-001', institution: 'SBI', holder: 'Raviraj', nominee: 'Someone',
      receivedAmount: 50000, roi: 6.0, maturityDate: '2026-01-01'
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
    receivedAmount: 100000, roi: 6.5, maturityDate: soonStr
  });
  addPolicy(db, {
    policyNumber: 'FD-002', institution: 'SBI', holder: 'Raviraj', nominee: 'Someone',
    receivedAmount: 200000, roi: 7.5, maturityDate: far
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
