'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  roiPercent,
  parseTermYears,
  termYears,
  calcMaturityValue,
  maturityValue,
  maturityStatus,
  weightedAverageRoi,
  summarizePolicies,
  sortPolicies,
  allocationBy
} = require('../src/renderer/portfolioMath.js');

const TODAY = new Date(2026, 8, 24); // 24 Sep 2026, local time

test('roiPercent reads sheet fractions and typed percentages the same way', () => {
  assert.equal(roiPercent(0.0685), 6.85);
  assert.equal(roiPercent(6.85), 6.85);
  assert.equal(roiPercent(null), null);
  assert.equal(roiPercent(''), null);
  assert.equal(roiPercent(0), 0);
});

test('parseTermYears handles the term formats used in the sheet', () => {
  assert.equal(parseTermYears('5 years'), 5);
  assert.equal(parseTermYears('24 months'), 2);
  assert.equal(parseTermYears('3y'), 3);
  assert.ok(Math.abs(parseTermYears('800 days') - 800 / 365) < 1e-9);
  assert.equal(parseTermYears('1 year 6 months'), 1.5);
  assert.equal(parseTermYears('long'), null);
  assert.equal(parseTermYears(null), null);
});

test('termYears prefers start/maturity dates and falls back to term text', () => {
  assert.equal(termYears({ start_date: '2024-01-01', maturity_date: '2026-01-01', term_total: '99 years' }), 731 / 365);
  assert.equal(termYears({ start_date: null, maturity_date: '2026-01-01', term_total: '25 months' }), 25 / 12);
  assert.equal(termYears({}), null);
});

test('calcMaturityValue compounds P(1 + r/n)^(nt)', () => {
  // ₹1,00,000 at 12% compounded monthly for 1 year = 112,682.50
  const r = calcMaturityValue({ amount_invested: 100000, roi: 0.12, compounding_periods_per_year: 12, term_total: '1 year' });
  assert.equal(r.value, 112683);
  assert.equal(r.periodsPerYear, 12);

  // No compounding frequency recorded → yearly
  assert.equal(calcMaturityValue({ amount_invested: 1000, roi: 10, term_total: '2 years' }).value, 1210);

  assert.equal(calcMaturityValue({ amount_invested: 1000, roi: null, term_total: '2 years' }), null);
  assert.equal(calcMaturityValue({ amount_invested: 1000, roi: 7 }), null, 'no term');
});

test('calcMaturityValue is close to a real FD from the sheet', () => {
  // 140012805631/1: ₹8,86,815 at 6.85%, 25 months; bank's figure is ₹10,21,754
  const r = calcMaturityValue({
    amount_invested: 886815, roi: 0.0685, compounding_periods_per_year: 12,
    start_date: '2023-07-03', maturity_date: '2025-08-03'
  });
  assert.ok(Math.abs(r.value - 1021754) / 1021754 < 0.002, `got ${r.value}`);
});

test('maturityValue uses the recorded amount, else the calculated one', () => {
  const base = { amount_invested: 1000, roi: 10, term_total: '2 years' };
  assert.deepEqual(
    { ...maturityValue({ ...base, maturity_amount: 1500 }), calc: undefined },
    { value: 1500, calculated: false, calc: undefined }
  );
  const calc = maturityValue({ ...base, maturity_amount: null });
  assert.equal(calc.value, 1210);
  assert.equal(calc.calculated, true);
  assert.equal(maturityValue({ amount_invested: 1000 }).value, null);
});

test('maturityStatus: critical ≤30 days, warning ≤60, matured when past', () => {
  assert.deepEqual(maturityStatus('2026-09-24', TODAY), { days: 0, level: 'critical' });
  assert.deepEqual(maturityStatus('2026-10-24', TODAY), { days: 30, level: 'critical' });
  assert.deepEqual(maturityStatus('2026-10-25', TODAY), { days: 31, level: 'warning' });
  assert.deepEqual(maturityStatus('2026-11-23', TODAY), { days: 60, level: 'warning' });
  assert.deepEqual(maturityStatus('2026-11-24', TODAY), { days: 61, level: null });
  assert.deepEqual(maturityStatus('2026-09-23', TODAY), { days: -1, level: 'matured' });
  assert.equal(maturityStatus(null, TODAY), null);
});

test('weightedAverageRoi weights by amount and skips policies without an ROI', () => {
  const policies = [
    { amount_invested: 300000, roi: 0.07 },
    { amount_invested: 100000, roi: 6 },
    { amount_invested: 999999, roi: null }
  ];
  assert.ok(Math.abs(weightedAverageRoi(policies) - 6.75) < 1e-9);
  assert.equal(weightedAverageRoi([]), null);
});

test('summarizePolicies totals only the policies passed in (i.e. the filtered set)', () => {
  const policies = [
    { amount_invested: 100000, roi: 0.07, maturity_date: '2026-10-01', maturity_amount: 110000 },
    { amount_invested: 50000, roi: 0.06, maturity_date: '2027-06-01', maturity_amount: null, term_total: '1 year' },
    { amount_invested: null, maturity_date: '2026-09-01' } // already matured, no amount
  ];

  const all = summarizePolicies(policies, { today: TODAY });
  assert.equal(all.accountCount, 3);
  assert.equal(all.totalInvested, 150000);
  assert.equal(all.upcomingCount, 1);
  assert.equal(all.expectedAtMaturity, 110000 + 53000);
  assert.equal(all.missingMaturityValue, 1);
  assert.ok(Math.abs(all.weightedAvgRoi - (100000 * 7 + 50000 * 6) / 150000) < 1e-9);

  const some = summarizePolicies(policies.slice(1), { today: TODAY });
  assert.equal(some.accountCount, 2);
  assert.equal(some.totalInvested, 50000);
  assert.equal(some.upcomingCount, 0);

  const none = summarizePolicies([], { today: TODAY });
  assert.equal(none.accountCount, 0);
  assert.equal(none.weightedAvgRoi, null);
});

test('summarizePolicies ignores soft-deleted rows shown via "Show deleted"', () => {
  const policies = [
    { amount_invested: 1000, maturity_date: '2026-10-01', deleted_at: null },
    { amount_invested: 5000, maturity_date: '2026-10-01', deleted_at: '2026-09-20 10:00:00' }
  ];
  const s = summarizePolicies(policies, { today: TODAY });
  assert.equal(s.accountCount, 1);
  assert.equal(s.totalInvested, 1000);
  assert.equal(s.upcomingCount, 1);
});

test('sortPolicies sorts numbers, dates and text, with blanks always last', () => {
  const rows = [
    { policy_number: 'B', amount_invested: 500, roi: 0.07, maturity_date: '2027-01-01', holder: 'madhavi' },
    { policy_number: 'A', amount_invested: 1500, roi: 6.5, maturity_date: null, holder: 'Raviraj' },
    { policy_number: 'C', amount_invested: null, roi: null, maturity_date: '2026-10-01', holder: 'Harsha' }
  ];
  const ids = (list) => list.map((r) => r.policy_number);

  assert.deepEqual(ids(sortPolicies(rows, 'amount_invested', 'asc')), ['B', 'A', 'C']);
  assert.deepEqual(ids(sortPolicies(rows, 'amount_invested', 'desc')), ['A', 'B', 'C']);
  assert.deepEqual(ids(sortPolicies(rows, 'roi', 'desc')), ['B', 'A', 'C'], '0.07 = 7% beats 6.5%');
  assert.deepEqual(ids(sortPolicies(rows, 'maturity_date', 'asc')), ['C', 'B', 'A']);
  assert.deepEqual(ids(sortPolicies(rows, 'maturity_date', 'desc')), ['B', 'C', 'A']);
  assert.deepEqual(ids(sortPolicies(rows, 'holder', 'asc')), ['C', 'B', 'A'], 'case-insensitive');
  assert.deepEqual(ids(rows), ['B', 'A', 'C'], 'input is not mutated');
});

test('sortPolicies compares policy numbers naturally', () => {
  const rows = [{ policy_number: 'FD-10' }, { policy_number: 'FD-9' }];
  assert.deepEqual(sortPolicies(rows, 'policy_number').map((r) => r.policy_number), ['FD-9', 'FD-10']);
});

test('allocationBy groups amounts, sorts largest first, and folds the tail into Other', () => {
  const rows = [
    { institution: 'HDFC', amount_invested: 300 },
    { institution: 'SBI', amount_invested: 100 },
    { institution: 'HDFC', amount_invested: 200 },
    { institution: 'LIC', amount_invested: 50 },
    { institution: 'Axis', amount_invested: 50 },
    { institution: 'Gone', amount_invested: 999, deleted_at: '2026-01-01' }
  ];
  const all = allocationBy(rows, 'institution');
  assert.deepEqual(all.map((g) => [g.label, g.amount, g.count]), [
    ['HDFC', 500, 2], ['SBI', 100, 1], ['Axis', 50, 1], ['LIC', 50, 1]
  ]);
  assert.equal(all[0].share, 500 / 700);

  const folded = allocationBy(rows, 'institution', { maxGroups: 3 });
  assert.deepEqual(folded.map((g) => [g.label, g.amount]), [['HDFC', 500], ['SBI', 100], ['Other (2)', 100]]);
  assert.ok(folded[2].isOther);
});
