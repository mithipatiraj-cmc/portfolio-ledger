'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isFixedDeposit, isMaturityDateRequired } = require('../src/shared/policyRules.js');

test('isFixedDeposit recognises the spellings used in the sheet', () => {
  for (const v of ['Fixed Deposit', 'fixed deposit', 'FD', 'F D', 'f.d.', ' fd ']) {
    assert.equal(isFixedDeposit(v), true, v);
  }
  for (const v of ['NSC', 'Savings Certificate', 'Recurring Deposit', 'FDR bond', '', null, undefined]) {
    assert.equal(isFixedDeposit(v), false, String(v));
  }
});

test('maturity date is required only for fixed deposits', () => {
  assert.equal(isMaturityDateRequired('F D'), true);
  assert.equal(isMaturityDateRequired('NSC'), false);
});
