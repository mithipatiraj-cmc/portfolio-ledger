'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const dbModule = require('../src/main/db.js');
const { commitImport } = require('../src/import/importRunner.js');

const HEADERS = [
  'Policy No', 'Instrument', 'Date of taking the policy', 'Maturity Date', 'Total Term',
  'Institution', 'Branch', 'Holder', 'Joint Holder', 'Nominee', '',
  'Amount', 'ROI', 'Compounding periods per year', 'Mat Amount',
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

test('commitImport: policies soft-deleted in the app are not re-added or updated by a re-import', () => {
  const database = dbModule.initDb(':memory:');
  const buffer = buildWorkbookBuffer([row({ policyNumber: 'FD-001' }), row({ policyNumber: 'FD-002' })]);
  commitImport(database, dbModule, buffer);

  const fd1 = dbModule.listPolicies(database).find((p) => p.policy_number === 'FD-001');
  dbModule.deletePolicy(database, fd1.id);

  const changed = buildWorkbookBuffer([row({ policyNumber: 'FD-001', roi: 9.9 }), row({ policyNumber: 'FD-002' })]);
  const result = commitImport(database, dbModule, changed);

  assert.deepEqual(result.deletedSkipped, ['FD-001']);
  assert.equal(result.added, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 1);
  const stillDeleted = dbModule.listPolicies(database, { includeDeleted: true }).find((p) => p.policy_number === 'FD-001');
  assert.ok(stillDeleted.deleted_at);
  assert.equal(stillDeleted.roi, 6.5, 'deleted policy is left untouched');
});

test('commitImport: sheetName imports from the chosen sheet of a multi-sheet workbook', () => {
  const database = dbModule.initDb(':memory:');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Notes'], ['nothing here']]), 'Notes');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, row({ policyNumber: 'FD-777' })]), 'Policies');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const result = commitImport(database, dbModule, buffer, { sheetName: 'Policies' });

  assert.equal(result.added, 1);
  assert.equal(dbModule.listPolicies(database)[0].policy_number, 'FD-777');
});

test('commitImport: an FD without maturity date is invalid, a non-FD without one is imported', () => {
  const database = dbModule.initDb(':memory:');
  const buffer = buildWorkbookBuffer([
    row({ policyNumber: 'FD-NODATE', instrument: 'F D', maturityDate: '' }),
    row({ policyNumber: 'NSC-NODATE', instrument: 'NSC', maturityDate: '' })
  ]);

  const result = commitImport(database, dbModule, buffer);

  assert.equal(result.added, 1);
  assert.deepEqual(result.invalid.map((r) => r.policyNumber), ['FD-NODATE']);
  const [nsc] = dbModule.listPolicies(database);
  assert.equal(nsc.policy_number, 'NSC-NODATE');
  assert.equal(nsc.maturity_date, null);
});

test('commitImport: a destination bank with no account column imports and reuses one destination row', () => {
  const database = dbModule.initDb(':memory:');
  const buffer = buildWorkbookBuffer([
    row({ policyNumber: 'FD-001', destinationBank: 'ICICI' }),
    row({ policyNumber: 'FD-002', destinationBank: 'ICICI' })
  ]);
  const expectedCol = HEADERS.indexOf('Expected');

  const result = commitImport(database, dbModule, buffer, { columnMapping: { [expectedCol]: '' } });

  assert.equal(result.added, 2);
  const destinations = database.prepare('SELECT bank, account FROM destinations').all();
  assert.deepEqual(destinations.map((d) => ({ ...d })), [{ bank: 'ICICI', account: null }]);
});

test('commitImport: the chosen income treatment is saved on every row, and a re-import can change it', () => {
  const database = dbModule.initDb(':memory:');
  const buffer = buildWorkbookBuffer([row({ policyNumber: 'FD-001' }), row({ policyNumber: 'FD-002' })]);

  const first = commitImport(database, dbModule, buffer, { incomeTreatment: 'cumulative' });
  assert.equal(first.added, 2);
  assert.deepEqual(dbModule.listPolicies(database).map((p) => p.income_treatment), ['cumulative', 'cumulative']);

  const same = commitImport(database, dbModule, buffer, { incomeTreatment: 'cumulative' });
  assert.equal(same.skipped, 2, 'same file and same choice: nothing to change');

  const switched = commitImport(database, dbModule, buffer, { incomeTreatment: 'non-cumulative' });
  assert.equal(switched.updated, 2);
  assert.deepEqual(dbModule.listPolicies(database).map((p) => p.income_treatment), ['non-cumulative', 'non-cumulative']);
});

test('commitImport: an unknown income treatment is rejected before anything is written', () => {
  const database = dbModule.initDb(':memory:');
  const buffer = buildWorkbookBuffer([row({ policyNumber: 'FD-001' })]);

  assert.throws(() => commitImport(database, dbModule, buffer, { incomeTreatment: 'monthly' }), /Unknown income treatment/);
  assert.equal(dbModule.listPolicies(database).length, 0);
});

test('commitImport: a re-import that changes institution, holder or destination saves the new names', () => {
  const database = dbModule.initDb(':memory:');
  commitImport(database, dbModule, buildWorkbookBuffer([row({ institution: 'HDFC', holder: 'Ravi', destinationBank: 'ICICI' })]));

  const changed = buildWorkbookBuffer([row({ institution: 'SBI', holder: 'Priya', destinationBank: 'Axis' })]);
  const first = commitImport(database, dbModule, changed);
  const second = commitImport(database, dbModule, changed);

  assert.equal(first.updated, 1);
  assert.equal(second.skipped, 1, 'once saved, the same file is unchanged, not "updated" again');
  const [p] = dbModule.listPolicies(database);
  assert.deepEqual([p.institution, p.holder, p.destination_bank], ['SBI', 'Priya', 'Axis']);
});

test('commitImport: re-importing a changed policy from a sheet with a column ignored keeps that stored value', () => {
  const database = dbModule.initDb(':memory:');
  commitImport(database, dbModule, buildWorkbookBuffer([row({ roi: 6.5, startDate: '2024-01-01' })]), { incomeTreatment: 'non-cumulative' });

  const startCol = HEADERS.indexOf('Date of taking the policy');
  const result = commitImport(database, dbModule, buildWorkbookBuffer([row({ roi: 7.25 })]), {
    columnMapping: { [startCol]: '' }
  });

  assert.equal(result.updated, 1);
  const [p] = dbModule.listPolicies(database);
  assert.equal(p.roi, 7.25);
  assert.equal(p.start_date, '2024-01-01', 'ignored column left as it was');
  assert.equal(p.income_treatment, 'non-cumulative', 'no choice made this time, so the stored one stays');
});
