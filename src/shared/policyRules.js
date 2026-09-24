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

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

module.exports = { isFixedDeposit, isMaturityDateRequired, isBlank };
