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
  'Received amount', 'ROI', 'Compounding periods per year', 'Mat Amount',
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
  assert.equal(data.receivedAmount, 100000);
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

test('classifyForImport: invalid rows stay invalid regardless of existing data', () => {
  const parsed = [{ data: { policyNumber: null }, errors: ['Missing required field: policyNumber'] }];
  const result = classifyForImport(parsed, new Map());
  assert.equal(result[0].status, 'invalid');
});
