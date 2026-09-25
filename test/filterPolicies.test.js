'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterPolicies, FILTERABLE_FIELDS } = require('../src/renderer/filterPolicies.js');

const SAMPLE = [
  { id: 1, policy_number: 'FD-001', instrument: 'Fixed Deposit', institution: 'HDFC', holder: 'Raviraj', joint_holder: '', nominee: 'Asha', destination_bank: 'ICICI' },
  { id: 2, policy_number: 'FD-002', instrument: 'Bond', institution: 'SBI', holder: 'Raviraj', joint_holder: 'Asha', nominee: 'Kiran', destination_bank: 'HDFC' },
  { id: 3, policy_number: 'INS-001', instrument: 'Insurance Policy', institution: 'LIC', holder: 'Priya', joint_holder: '', nominee: 'Raviraj', destination_bank: 'SBI' }
];

test('filterPolicies: empty query returns everything unchanged', () => {
  assert.deepEqual(filterPolicies(SAMPLE, 'institution', ''), SAMPLE);
  assert.deepEqual(filterPolicies(SAMPLE, 'institution', '   '), SAMPLE);
});

test('filterPolicies: filters by a specific field, case-insensitively', () => {
  const result = filterPolicies(SAMPLE, 'institution', 'hdfc');
  assert.equal(result.length, 1);
  assert.equal(result[0].policy_number, 'FD-001');
});

test('filterPolicies: substring match, not exact match', () => {
  const result = filterPolicies(SAMPLE, 'instrument', 'Deposit');
  assert.equal(result.length, 1);
  assert.equal(result[0].policy_number, 'FD-001');
});

test('filterPolicies: a field value only present elsewhere does not leak into other fields', () => {
  // "Raviraj" is a nominee on row 3 but a holder on rows 1 & 2 — filtering by
  // nominee specifically should only match row 3.
  const result = filterPolicies(SAMPLE, 'nominee', 'Raviraj');
  assert.equal(result.length, 1);
  assert.equal(result[0].policy_number, 'INS-001');
});

test('filterPolicies: "all" field searches across every filterable field', () => {
  const result = filterPolicies(SAMPLE, 'all', 'Raviraj');
  // matches holder on FD-001/FD-002, nominee on INS-001
  assert.equal(result.length, 3);
});

test('filterPolicies: "all" field still excludes non-matching rows', () => {
  const result = filterPolicies(SAMPLE, 'all', 'LIC');
  assert.equal(result.length, 1);
  assert.equal(result[0].policy_number, 'INS-001');
});

test('filterPolicies: no match returns an empty array, not an error', () => {
  const result = filterPolicies(SAMPLE, 'institution', 'nonexistent-bank-xyz');
  assert.deepEqual(result, []);
});

test('FILTERABLE_FIELDS includes an "all" option plus every joined lookup field', () => {
  const values = FILTERABLE_FIELDS.map((f) => f.value);
  assert.ok(values.includes('all'));
  assert.ok(values.includes('nominee'));
  assert.ok(values.includes('joint_holder'));
});

test('applyFilters: every filter must match (AND)', () => {
  const { applyFilters } = require('../src/renderer/filterPolicies.js');
  const rows = [
    { policy_number: 'A', institution: 'HDFC', holder: 'Raviraj', instrument: 'F D' },
    { policy_number: 'B', institution: 'HDFC', holder: 'Madhavi', instrument: 'F D' },
    { policy_number: 'C', institution: 'SBI', holder: 'Raviraj', instrument: 'NSC' }
  ];
  const ids = (list) => list.map((r) => r.policy_number);

  assert.deepEqual(ids(applyFilters(rows, [{ field: 'institution', query: 'hdfc' }, { field: 'holder', query: 'ravi' }])), ['A']);
  assert.deepEqual(ids(applyFilters(rows, [{ field: 'holder', query: 'raviraj' }, { field: 'all', query: 'nsc' }])), ['C']);
  assert.deepEqual(ids(applyFilters(rows, [{ field: 'institution', query: 'hdfc' }, { field: 'holder', query: '' }])), ['A', 'B'], 'blank filters are ignored');
  assert.deepEqual(applyFilters(rows, [{ field: 'institution', query: 'hdfc' }, { field: 'holder', query: 'nobody' }]), []);
  assert.equal(applyFilters(rows, []), rows);
});

test('hasActiveFilter ignores blank and whitespace-only queries', () => {
  const { hasActiveFilter } = require('../src/renderer/filterPolicies.js');
  assert.equal(hasActiveFilter([{ field: 'all', query: '  ' }, { field: 'holder', query: '' }]), false);
  assert.equal(hasActiveFilter([{ field: 'all', query: '' }, { field: 'holder', query: 'r' }]), true);
});

test('distinctValues lists unique non-blank values, sorted case-insensitively', () => {
  const { distinctValues } = require('../src/renderer/filterPolicies.js');
  assert.deepEqual(distinctValues(SAMPLE, 'institution'), ['HDFC', 'LIC', 'SBI']);
  assert.deepEqual(distinctValues(SAMPLE, 'joint_holder'), ['Asha'], 'blanks dropped');
  assert.deepEqual(distinctValues([{ holder: 'b' }, { holder: 'A' }, { holder: 'b' }], 'holder'), ['A', 'b']);
});
