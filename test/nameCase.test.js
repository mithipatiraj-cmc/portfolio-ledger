'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toTitleCase } = require('../src/shared/nameCase.js');

test('toTitleCase capitalises each word regardless of input case', () => {
  assert.equal(toTitleCase('RAVIRAJ'), 'Raviraj');
  assert.equal(toTitleCase('union bank'), 'Union Bank');
  assert.equal(toTitleCase('  post   OFFICE '), 'Post Office');
});

test('toTitleCase keeps known acronyms upper-case', () => {
  assert.equal(toTitleCase('hdfc'), 'HDFC');
  assert.equal(toTitleCase('icici bank'), 'ICICI Bank');
  assert.equal(toTitleCase('Sbi'), 'SBI');
});

test('toTitleCase capitalises after hyphens and dots', () => {
  assert.equal(toTitleCase('m.v. laxmi'), 'M.V. Laxmi');
  assert.equal(toTitleCase('sri-harsha'), 'Sri-Harsha');
});

test('toTitleCase passes null/undefined through', () => {
  assert.equal(toTitleCase(null), null);
  assert.equal(toTitleCase(undefined), undefined);
});
