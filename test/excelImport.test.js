'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const {
  autoMapHeaders,
  parseExcelDate,
  parseNumeric,
  parseWorkbook,
  classifyForImport
} = require('../src/import/excelImport.js');

const REAL_HEADERS = [
  'Policy No', 'Instrument', 'Date of taking the policy', 'Maturity Date', 'Total Term',
  'Institution', 'Branch', 'Holder', 'Joint Holder', 'Nominee', '',
  'Amount', 'ROI', 'Compounding periods per year', 'Mat Amount',
  'Expected', 'Proceeds directed to bank'
];

function buildWorkbookBuffer(headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('autoMapHeaders maps every one of the real Excel headers to a schema field', () => {
  const { mapping, unmapped } = autoMapHeaders(REAL_HEADERS);
  // 16 real headers + 1 blank column; the blank should be unmapped-but-ignored (empty string, not pushed)
  assert.equal(Object.keys(mapping).length, 16);
  assert.deepEqual(unmapped, []);
});

test('autoMapHeaders is case- and whitespace-insensitive', () => {
  const { mapping } = autoMapHeaders(['  POLICY NO  ', 'roi', 'Nominee']);
  assert.equal(mapping[0], 'policyNumber');
  assert.equal(mapping[1], 'roi');
  assert.equal(mapping[2], 'nominee');
});

test('autoMapHeaders reports genuinely unknown columns as unmapped', () => {
  const { unmapped } = autoMapHeaders(['Policy No', 'Some Random Column']);
  assert.deepEqual(unmapped, ['Some Random Column']);
});

test('parseExcelDate handles Excel serial numbers, Date objects, and strings', () => {
  assert.equal(parseExcelDate(45658), '2025-01-01'); // Excel serial for 2025-01-01
  assert.equal(parseExcelDate(new Date(2025, 0, 1)), '2025-01-01');
  assert.equal(parseExcelDate('2025-01-01'), '2025-01-01');
  assert.equal(parseExcelDate(null), null);
  assert.equal(parseExcelDate('not a date'), null);
});

test('parseNumeric strips commas and coerces strings', () => {
  assert.equal(parseNumeric('1,00,000'), 100000);
  assert.equal(parseNumeric(6.5), 6.5);
  assert.equal(parseNumeric(''), null);
  assert.equal(parseNumeric('abc'), null);
});

test('parseWorkbook parses a real .xlsx buffer end-to-end with the actual column set', () => {
  const rows = [
    [
      'FD-001', 'Fixed Deposit', '2024-01-01', '2027-01-01', '3 years',
      'HDFC', 'Koramangala', 'Raviraj', '', 'Someone', '',
      100000, 6.5, 4, 121000, '1234567890', 'ICICI'
    ]
  ];
  const buffer = buildWorkbookBuffer(REAL_HEADERS, rows);
  const { rows: parsed, unmappedHeaders } = parseWorkbook(buffer);

  assert.equal(unmappedHeaders.length, 0);
  assert.equal(parsed.length, 1);
  const { data, errors } = parsed[0];
  assert.deepEqual(errors, []);
  assert.equal(data.policyNumber, 'FD-001');
  assert.equal(data.institution, 'HDFC');
  assert.equal(data.amountInvested, 100000);
  assert.equal(data.roi, 6.5);
  assert.equal(data.destinationAccount, '1234567890');
  assert.equal(data.destinationBank, 'ICICI');
  assert.equal(data.maturityDate, '2027-01-01');
});

test('parseWorkbook flags rows missing required fields instead of dropping them', () => {
  const rows = [
    ['', 'Fixed Deposit', 44927, 45992, '3 years', 'HDFC', '', 'Raviraj', '', 'Someone', '', 100000, 6.5, 4, 121000, '', '']
  ];
  const buffer = buildWorkbookBuffer(REAL_HEADERS, rows);
  const { rows: parsed } = parseWorkbook(buffer);

  assert.equal(parsed.length, 1, 'invalid rows are still returned, not silently dropped');
  assert.ok(parsed[0].errors.some((e) => e.includes('policyNumber')));
});

test('parseWorkbook flags unparseable numeric values', () => {
  const rows = [
    ['FD-001', 'FD', 44927, 45992, '3y', 'HDFC', '', 'R', '', 'S', '', 'not-a-number', 6.5, 4, 121000, '', '']
  ];
  const buffer = buildWorkbookBuffer(REAL_HEADERS, rows);
  const { rows: parsed } = parseWorkbook(buffer);
  // parseNumeric returns null (not NaN) for unparseable strings, so this becomes a
  // "missing required field" error rather than "invalid number" — both are caught.
  assert.ok(parsed[0].errors.length > 0);
});

test('parseWorkbook skips fully blank rows', () => {
  const rows = [
    ['FD-001', 'FD', 44927, 45992, '3y', 'HDFC', '', 'R', '', 'S', '', 100000, 6.5, 4, 121000, '', ''],
    [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
    ['FD-002', 'FD', 44927, 45992, '3y', 'SBI', '', 'R', '', 'S', '', 50000, 7, 1, 60000, '', '']
  ];
  const buffer = buildWorkbookBuffer(REAL_HEADERS, rows);
  const { rows: parsed } = parseWorkbook(buffer);
  assert.equal(parsed.length, 2);
});

test('classifyForImport: new policy numbers are classified as new', () => {
  const parsed = [{ data: { policyNumber: 'FD-999', roi: 6.5 }, errors: [] }];
  const result = classifyForImport(parsed, new Map());
  assert.equal(result[0].status, 'new');
});

test('classifyForImport: identical re-import is classified duplicate-identical', () => {
  const existing = new Map([['FD-001', { policyNumber: 'FD-001', roi: 6.5 }]]);
  const parsed = [{ data: { policyNumber: 'FD-001', roi: 6.5 }, errors: [] }];
  const result = classifyForImport(parsed, existing);
  assert.equal(result[0].status, 'duplicate-identical');
});

test('classifyForImport: changed field is classified duplicate-changed and names the field', () => {
  const existing = new Map([['FD-001', { policyNumber: 'FD-001', roi: 6.5 }]]);
  const parsed = [{ data: { policyNumber: 'FD-001', roi: 7.0 }, errors: [] }];
  const result = classifyForImport(parsed, existing);
  assert.equal(result[0].status, 'duplicate-changed');
  assert.deepEqual(result[0].changedFields, ['roi']);
});

test('parseWorkbook: an explicit columnMapping override maps a differently-named header correctly', () => {
  // Sheet using different header text than the standard set — mapping is supplied manually.
  const customHeaders = ['Policy #', 'Type', 'Started', 'Matures', 'Term', 'Bank', 'Branch Name',
    'Primary Holder', 'Secondary Holder', 'Nominee Name', '', 'Invested', 'Rate', 'Compounding',
    'Maturity Value', 'Acct No', 'Bank Name'];
  const rows = [
    ['FD-777', 'FD', '2024-01-01', '2027-01-01', '3y', 'Axis', 'MG Road', 'Raviraj', '', 'Asha', '',
      50000, 6.0, 4, 60000, '999', 'Kotak']
  ];
  const buffer = buildWorkbookBuffer(customHeaders, rows);

  // Without a mapping, none of these headers auto-match (except maybe 'branch'-ish ones by luck) —
  // confirm the base case first.
  const unmapped = parseWorkbook(buffer);
  assert.ok(unmapped.unmappedHeaders.length > 5, 'most custom headers should be unrecognized without mapping');

  // Now supply an explicit column mapping (by column index) and confirm it parses correctly.
  const columnMapping = {
    0: 'policyNumber', 1: 'instrument', 2: 'startDate', 3: 'maturityDate', 4: 'termTotal',
    5: 'institution', 6: 'branch', 7: 'holder', 8: 'jointHolder', 9: 'nominee',
    11: 'amountInvested', 12: 'roi', 13: 'compoundingPeriodsPerYear', 14: 'maturityAmount',
    15: 'destinationAccount', 16: 'destinationBank'
  };
  const { rows: parsed, unmappedHeaders } = parseWorkbook(buffer, { columnMapping });

  assert.equal(unmappedHeaders.length, 0);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].errors, []);
  assert.equal(parsed[0].data.policyNumber, 'FD-777');
  assert.equal(parsed[0].data.institution, 'Axis');
  assert.equal(parsed[0].data.amountInvested, 50000);
  assert.equal(parsed[0].data.destinationBank, 'Kotak');
});

test('parseWorkbook: columnMapping can override an auto-detected column too', () => {
  // "Institution" would normally auto-map to institution — force it to be ignored instead.
  const rows = [
    ['FD-001', 'FD', 44927, 45992, '3y', 'HDFC', '', 'R', '', 'S', '', 100000, 6.5, 4, 121000, '', '']
  ];
  const buffer = buildWorkbookBuffer(REAL_HEADERS, rows);
  const { rows: parsed } = parseWorkbook(buffer, { columnMapping: { 5: '' } }); // column 5 = Institution
  assert.equal(parsed[0].data.institution, undefined);
  // institution is required, so this row should now be invalid
  assert.ok(parsed[0].errors.some((e) => e.includes('institution')));
});

test('getImportPreview: returns headers, auto-mapping, and schema field list for a mapping UI', () => {
  const { getImportPreview } = require('../src/import/excelImport.js');
  const buffer = buildWorkbookBuffer(REAL_HEADERS, [row_stub()]);
  const preview = getImportPreview(buffer);
  assert.deepEqual(preview.headerRow, REAL_HEADERS);
  assert.equal(Object.keys(preview.mapping).length, 16);
  assert.deepEqual(preview.unmapped, []);
  assert.ok(preview.schemaFields.some((f) => f.value === 'policyNumber'));
  assert.ok(preview.schemaFields.some((f) => f.value === '')); // "(ignore this column)" option present
});

function row_stub() {
  return ['FD-001', 'FD', 44927, 45992, '3y', 'HDFC', '', 'R', '', 'S', '', 100000, 6.5, 4, 121000, '', ''];
}

test('classifyForImport: invalid rows stay invalid regardless of existing data', () => {
  const parsed = [{ data: { policyNumber: null }, errors: ['Missing required field: policyNumber'] }];
  const result = classifyForImport(parsed, new Map());
  assert.equal(result[0].status, 'invalid');
});
test('getImportPreview: lists every sheet and previews the requested one', () => {
  const { getImportPreview } = require('../src/import/excelImport.js');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Notes']]), 'Notes');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([REAL_HEADERS, row_stub()]), 'FDs');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Empty');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const first = getImportPreview(buffer);
  assert.deepEqual(first.sheetNames, ['Notes', 'FDs', 'Empty']);
  assert.equal(first.sheetName, 'Notes', 'defaults to the first sheet');
  assert.deepEqual(first.headerRow, ['Notes']);

  const fds = getImportPreview(buffer, { sheetName: 'FDs' });
  assert.equal(fds.sheetName, 'FDs');
  assert.equal(Object.keys(fds.mapping).length, 16);

  assert.deepEqual(getImportPreview(buffer, { sheetName: 'Empty' }).headerRow, []);
  assert.throws(() => getImportPreview(buffer, { sheetName: 'Nope' }), /not found/);
});

test('validateRow: maturity date is required for fixed deposits only', () => {
  const { validateRow } = require('../src/import/excelImport.js');
  const base = { policyNumber: 'X-1', institution: 'HDFC', amountInvested: 1000, maturityDate: null };

  assert.ok(validateRow({ ...base, instrument: 'F D' }).some((e) => e.includes('maturityDate')));
  assert.ok(validateRow({ ...base, instrument: 'Fixed Deposit' }).some((e) => e.includes('maturityDate')));
  assert.deepEqual(validateRow({ ...base, instrument: 'NSC' }), []);
  assert.deepEqual(validateRow({ ...base, instrument: null }), []);
  assert.deepEqual(validateRow({ ...base, instrument: 'FD', maturityDate: '2027-01-01' }), []);
});

test('parseWorkbook: every spelling of fixed deposit is stored as "Fixed Deposit"', () => {
  const spellings = ['FD', 'F D', 'fd', 'f.d.', 'fixed deposit', 'Fixed Deposit', 'NSC'];
  const rows = spellings.map((instrument, i) => {
    const r = row_stub();
    r[0] = `P-${i}`;
    r[1] = instrument;
    return r;
  });

  const { rows: parsed } = parseWorkbook(buildWorkbookBuffer(REAL_HEADERS, rows));

  assert.deepEqual(parsed.map((r) => r.data.instrument), [
    'Fixed Deposit', 'Fixed Deposit', 'Fixed Deposit', 'Fixed Deposit', 'Fixed Deposit', 'Fixed Deposit', 'NSC'
  ]);
});
