'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const dbModule = require('../src/main/db.js');
const { commitImport } = require('../src/import/importRunner.js');

const HEADERS = [
  'Policy No', 'Instrument', 'Date of taking the policy', 'Maturity Date', 'Total Term',
  'Institution', 'Branch', 'Holder', 'Joint Holder', 'Nominee', '',
  'Received amount', 'ROI', 'Compounding periods per year', 'Mat Amount',
  'Expected', 'Proceeds directed to bank'
];

function buildWorkbookBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function row(overrides = {}) {
  const base = {
    policyNumber: 'FD-001', instrument: 'FD', startDate: '2024-01-01', maturityDate: '2027-01-01',
    termTotal: '3y', institution: 'HDFC', branch: 'Koramangala', holder: 'Raviraj', jointHolder: '',
    nominee: 'Someone', amountInvested: 100000, roi: 6.5, compoundingPeriodsPerYear: 4,
    maturityAmount: 121000, destinationAccount: '1234567890', destinationBank: 'ICICI'
  };
  const merged = { ...base, ...overrides };
  return [
    merged.policyNumber, merged.instrument, merged.startDate, merged.maturityDate, merged.termTotal,
    merged.institution, merged.branch, merged.holder, merged.jointHolder, merged.nominee, '',
    merged.amountInvested, merged.roi, merged.compoundingPeriodsPerYear, merged.maturityAmount,
    merged.destinationAccount, merged.destinationBank
  ];
}

test('commitImport: fresh database, all-new rows are added', () => {
  const database = dbModule.initDb(':memory:');
  const buffer = buildWorkbookBuffer([
    row({ policyNumber: 'FD-001' }),
    row({ policyNumber: 'FD-002', institution: 'SBI' })
  ]);

  const result = commitImport(database, dbModule, buffer);

  assert.equal(result.added, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.invalid, []);
  assert.equal(dbModule.listPolicies(database).length, 2);
});

test('commitImport: re-importing the identical file a second time skips everything', () => {
  const database = dbModule.initDb(':memory:');
  const buffer = buildWorkbookBuffer([row({ policyNumber: 'FD-001' })]);

  commitImport(database, dbModule, buffer);
  const second = commitImport(database, dbModule, buffer);

  assert.equal(second.added, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.skipped, 1);
  assert.equal(dbModule.listPolicies(database).length, 1, 'no duplicate row created');
});

test('commitImport: a changed ROI on re-import updates the existing policy in place', () => {
  const database = dbModule.initDb(':memory:');
  commitImport(database, dbModule, buildWorkbookBuffer([row({ policyNumber: 'FD-001', roi: 6.5 })]));

  const result = commitImport(database, dbModule, buildWorkbookBuffer([row({ policyNumber: 'FD-001', roi: 7.25 })]));

  assert.equal(result.updated, 1);
  assert.equal(result.added, 0);
  const rows = dbModule.listPolicies(database);
  assert.equal(rows.length, 1, 'updated, not duplicated');
  assert.equal(rows[0].roi, 7.25);
});

test('commitImport: rows missing required fields are reported as invalid and not committed', () => {
  const database = dbModule.initDb(':memory:');
  const buffer = buildWorkbookBuffer([
    row({ policyNumber: 'FD-001' }),
    row({ policyNumber: '' }) // missing required policyNumber
  ]);

  const result = commitImport(database, dbModule, buffer);

  assert.equal(result.added, 1);
  assert.equal(result.invalid.length, 1);
  assert.equal(dbModule.listPolicies(database).length, 1);
});

test('commitImport: repeated institution/destination across rows reuses lookup rows, not duplicates', () => {
  const database = dbModule.initDb(':memory:');
  const buffer = buildWorkbookBuffer([
    row({ policyNumber: 'FD-001', institution: 'HDFC', destinationBank: 'ICICI', destinationAccount: '111' }),
    row({ policyNumber: 'FD-002', institution: 'HDFC', destinationBank: 'ICICI', destinationAccount: '111' })
  ]);

  commitImport(database, dbModule, buffer);

  const institutionCount = database.prepare('SELECT COUNT(*) AS c FROM institutions').get().c;
  const destinationCount = database.prepare('SELECT COUNT(*) AS c FROM destinations').get().c;
  assert.equal(institutionCount, 1);
  assert.equal(destinationCount, 1);
});

test('commitImport: mixed batch (new + duplicate-identical + duplicate-changed + invalid) is classified correctly in one pass', () => {
  const database = dbModule.initDb(':memory:');
  commitImport(database, dbModule, buildWorkbookBuffer([
    row({ policyNumber: 'FD-001', roi: 6.5 }),
    row({ policyNumber: 'FD-002', roi: 7.0 })
  ]));

  const result = commitImport(database, dbModule, buildWorkbookBuffer([
    row({ policyNumber: 'FD-001', roi: 6.5 }),      // identical -> skipped
    row({ policyNumber: 'FD-002', roi: 7.5 }),      // changed -> updated
    row({ policyNumber: 'FD-003', roi: 8.0 }),      // new -> added
    row({ policyNumber: '' })                        // invalid
  ]));

  assert.equal(result.skipped, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.added, 1);
  assert.equal(result.invalid.length, 1);
  assert.equal(dbModule.listPolicies(database).length, 3);
});
