'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_REBATE_LIMIT,
  financialYearOf,
  fyLabel,
  fyBounds,
  policyPeriod,
  interestEarned,
  projectTax
} = require('../src/renderer/taxMath.js');

const near = (actual, expected, tolerance = 1) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ≈${expected}, got ${actual}`);

// A policy that exactly covers FY 2026-27 (365 days), ₹1,00,000 at 10%.
const fullYear = {
  amount_invested: 100000, roi: 10, start_date: '2026-04-01', maturity_date: '2027-04-01', holder: 'Ravi'
};

test('financialYearOf: April starts a new financial year', () => {
  assert.equal(financialYearOf(new Date(2026, 2, 31)), 2025, '31 Mar 2026 is still FY 2025-26');
  assert.equal(financialYearOf(new Date(2026, 3, 1)), 2026);
  assert.equal(financialYearOf(new Date(2026, 8, 25)), 2026);
  assert.equal(fyLabel(2026), 'FY 2026-27');
});

test('interestEarned: a full year at 10% compounded yearly earns ₹10,000', () => {
  const { from, to } = fyBounds(2026);
  near(interestEarned(fullYear, from, to), 10000);
});

test('interestEarned: cumulative interest accrues across years, compounding in later years', () => {
  const twoYears = { ...fullYear, maturity_date: '2028-03-31' }; // 730 days
  near(interestEarned(twoYears, ...Object.values(fyBounds(2026))), 10000);
  near(interestEarned(twoYears, ...Object.values(fyBounds(2027))), 11000, 30); // interest on ₹1.1L
});

test('interestEarned: non-cumulative is simple interest on the amount invested, every year', () => {
  const payout = { ...fullYear, maturity_date: '2028-03-31', income_treatment: 'non-cumulative' };
  near(interestEarned(payout, ...Object.values(fyBounds(2026))), 10000);
  near(interestEarned(payout, ...Object.values(fyBounds(2027))), 10000, 30);
});

test('interestEarned: only the part of the year the policy is running counts', () => {
  const starts = { ...fullYear, start_date: '2026-10-01', maturity_date: '2031-10-01', income_treatment: 'non-cumulative' };
  near(interestEarned(starts, ...Object.values(fyBounds(2026))), 100000 * 0.1 * (182 / 365));
  assert.equal(interestEarned(starts, ...Object.values(fyBounds(2032))), 0, 'after maturity');
});

test('interestEarned: missing amount, rate or dates gives null; a missing start date comes from the term', () => {
  assert.equal(interestEarned({ ...fullYear, roi: null }, 0, 1), null);
  assert.equal(interestEarned({ ...fullYear, maturity_date: null }, 0, 1), null);
  const fromTerm = { ...fullYear, start_date: null, term_total: '1 year' };
  assert.equal(policyPeriod(fromTerm).start, Date.UTC(2026, 3, 1));
});

test('projectTax: interest is taxed to the holder at their rate once total income is over the limit', () => {
  const result = projectTax([fullYear], {
    fyStartYear: 2026,
    holders: { Ravi: { rate: 30, otherIncome: 1500000 } }
  });
  const [ravi] = result.holders;
  near(ravi.taxableInterest, 10000);
  assert.equal(ravi.withinLimit, false);
  near(ravi.tax, 3000);
});

test('projectTax: nothing is owed when other income plus interest is within ₹12 lakh', () => {
  assert.equal(DEFAULT_REBATE_LIMIT, 1200000);
  const [ravi] = projectTax([fullYear], { fyStartYear: 2026, holders: { Ravi: { rate: 30, otherIncome: 1000000 } } }).holders;
  assert.equal(ravi.withinLimit, true);
  assert.equal(ravi.tax, 0);
});

test('projectTax: exempt policies are reported but not taxed and do not count towards the limit', () => {
  const policies = [fullYear, { ...fullYear, tax_treatment: 'exempt' }];
  const [ravi] = projectTax(policies, { fyStartYear: 2026, holders: { Ravi: { rate: 30, otherIncome: 1195000 } } }).holders;
  near(ravi.exemptInterest, 10000);
  near(ravi.totalIncome, 1205000);
  near(ravi.tax, 3000);
});

test('projectTax: joint holders are ignored, deleted policies skipped, and a missing rate leaves tax unknown', () => {
  const policies = [
    { ...fullYear, joint_holder: 'Asha' },
    { ...fullYear, holder: 'Asha', deleted_at: '2026-05-01' },
    { ...fullYear, holder: 'Kiran', roi: null }
  ];
  const result = projectTax(policies, { fyStartYear: 2026, holders: { Ravi: { otherIncome: 2000000 } } });
  assert.deepEqual(result.holders.map((h) => h.name), ['Ravi']);
  assert.equal(result.holders[0].tax, null, 'over the limit but no rate entered yet');
  assert.deepEqual(result.missingData.map((p) => p.holder), ['Kiran']);
});
