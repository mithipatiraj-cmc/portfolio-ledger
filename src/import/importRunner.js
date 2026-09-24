'use strict';

const { parseWorkbook, classifyForImport } = require('./excelImport.js');

/** DB row (snake_case, from listPolicies) → the camelCase shape parsed rows use, for comparison. */
function toComparableShape(dbRow) {
  return {
    policyNumber: dbRow.policy_number,
    instrument: dbRow.instrument,
    startDate: dbRow.start_date,
    maturityDate: dbRow.maturity_date,
    termTotal: dbRow.term_total,
    amountInvested: dbRow.amount_invested,
    roi: dbRow.roi,
    compoundingPeriodsPerYear: dbRow.compounding_periods_per_year,
    maturityAmount: dbRow.maturity_amount,
    institution: dbRow.institution,
    branch: dbRow.branch,
    holder: dbRow.holder,
    jointHolder: dbRow.joint_holder,
    nominee: dbRow.nominee,
    destinationBank: dbRow.destination_bank,
    destinationAccount: dbRow.destination_account
  };
}

/**
 * Parse an Excel buffer and commit its rows against an open db.
 * 'new' rows are inserted; 'duplicate-changed' rows overwrite the existing
 * policy; 'duplicate-identical' rows are skipped; 'invalid' rows are skipped
 * and reported back for the user to fix by hand (spec §2 step 3/4).
 *
  * @param {Buffer} buffer - raw .xlsx file contents
 * @param {object} [opts]
 * @param {string} [opts.sheetName]
 * @param {Object<number,string>} [opts.columnMapping] - optional manual column
 *   mapping, passed straight through to parseWorkbook — lets a sheet with
 *   different column names import correctly instead of failing auto-detection.
 */
function commitImport(database, dbModule, buffer, opts = {}) {
  const { rows, unmappedHeaders } = parseWorkbook(buffer, opts);

  const existingRows = dbModule.listPolicies(database);
  const existingByPolicyNumber = new Map(
    existingRows.map((r) => [r.policy_number, { id: r.id, ...toComparableShape(r) }])
  );

  const classified = classifyForImport(rows, existingByPolicyNumber);

  const result = { added: 0, updated: 0, skipped: 0, invalid: [], unmappedHeaders };

  for (const row of classified) {
    if (row.status === 'invalid') {
      result.invalid.push({ policyNumber: row.data.policyNumber, errors: row.errors });
      continue;
    }
    if (row.status === 'duplicate-identical') {
      result.skipped++;
      continue;
    }
    if (row.status === 'new') {
      dbModule.addPolicy(database, row.data);
      result.added++;
      continue;
    }
    if (row.status === 'duplicate-changed') {
      const existing = existingByPolicyNumber.get(row.data.policyNumber);
      dbModule.updatePolicy(database, existing.id, {
        instrument: row.data.instrument,
        start_date: row.data.startDate,
        maturity_date: row.data.maturityDate,
        term_total: row.data.termTotal,
        amount_invested: row.data.amountInvested,
        roi: row.data.roi,
        compounding_periods_per_year: row.data.compoundingPeriodsPerYear,
        maturity_amount: row.data.maturityAmount
      });
      result.updated++;
    }
  }

  return result;
}

module.exports = { commitImport };
