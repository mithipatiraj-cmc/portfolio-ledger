'use strict';

/** "Fixed Deposit", "FD", "F D", "f.d." → true. Ignores case, spaces and punctuation. */
function isFixedDeposit(instrument) {
  const key = String(instrument ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return key === 'fd' || key === 'fixeddeposit';
}

/** Maturity date is mandatory for fixed deposits only. */
function isMaturityDateRequired(instrument) {
  return isFixedDeposit(instrument);
}

/** How a policy's interest is handled: reinvested until maturity, or paid out as it's earned. */
const INCOME_TREATMENTS = ['cumulative', 'non-cumulative'];

/** Whether a policy's interest is taxed. Untagged (NULL) policies count as taxable. */
const TAX_TREATMENTS = ['taxable', 'exempt'];

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

module.exports = { INCOME_TREATMENTS, TAX_TREATMENTS, isFixedDeposit, isMaturityDateRequired, isBlank };
