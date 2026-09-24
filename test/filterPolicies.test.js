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
