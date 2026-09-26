'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { toTitleCase } = require('../shared/nameCase.js');
const { INCOME_TREATMENTS, TAX_TREATMENTS, isMaturityDateRequired, isBlank } = require('../shared/policyRules.js');

const FD_MATURITY_ERROR = 'Maturity date is required for fixed deposits.';
const oneOf = (column, values) => `CHECK (${column} IN (${values.map((v) => `'${v}'`).join(', ')}))`;
const INCOME_TREATMENT_CHECK = oneOf('income_treatment', INCOME_TREATMENTS);
const TAX_TREATMENT_CHECK = oneOf('tax_treatment', TAX_TREATMENTS);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS institutions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  branch TEXT,
  UNIQUE(name, branch)
);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS destinations (
  id INTEGER PRIMARY KEY,
  bank TEXT,
  account TEXT,
  UNIQUE(bank, account)
);

CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY,
  policy_number TEXT UNIQUE,
  instrument TEXT,
  start_date TEXT,
  maturity_date TEXT,
  term_total TEXT,
  amount_invested REAL,
  roi REAL,
  compounding_periods_per_year INTEGER,
  maturity_amount REAL,
  institution_id INTEGER REFERENCES institutions(id),
  holder_id INTEGER REFERENCES people(id),
  joint_holder_id INTEGER REFERENCES people(id),
  nominee_id INTEGER REFERENCES people(id),
  destination_id INTEGER REFERENCES destinations(id),
  income_treatment TEXT ${INCOME_TREATMENT_CHECK}, -- NULL = not recorded
  tax_treatment TEXT ${TAX_TREATMENT_CHECK}, -- NULL = taxable
  deleted_at TEXT -- soft delete: set when the user deletes, NULL while active
);

-- User preferences (e.g. email reminders), one JSON value per key.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Which expiry reminders have gone out, so each is sent once. Keyed on the
-- maturity date too, so a renewed policy (new date) gets reminded again.
CREATE TABLE IF NOT EXISTS reminder_log (
  policy_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  maturity_date TEXT NOT NULL,
  days_before INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (policy_id, maturity_date, days_before)
);
`;

/**
 * Open (or create) the database at dbPath and ensure the schema exists.
 * @param {string} dbPath - absolute path, or ':memory:' for tests
 * @returns {DatabaseSync}
 */
function initDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Bring databases created by older versions up to the current SCHEMA, keeping their data. */
function migrate(db) {
  const policyColumns = db.prepare('PRAGMA table_info(policies)').all().map((c) => c.name);
  if (!policyColumns.includes('income_treatment')) {
    db.exec(`ALTER TABLE policies ADD COLUMN income_treatment TEXT ${INCOME_TREATMENT_CHECK};`);
  }
  if (!policyColumns.includes('tax_treatment')) {
    db.exec(`ALTER TABLE policies ADD COLUMN tax_treatment TEXT ${TAX_TREATMENT_CHECK};`);
  }
  normalizeLookupNames(db);
}

const keepAsIs = (v) => v;

// Lookup tables whose name columns are stored in Title Case, and the policy
// columns that reference them (re-pointed when case-only duplicates merge).
const LOOKUP_TABLES = [
  {
    table: 'people',
    columns: { name: toTitleCase },
    refs: ['holder_id', 'joint_holder_id', 'nominee_id']
  },
  {
    table: 'institutions',
    columns: { name: toTitleCase, branch: toTitleCase },
    refs: ['institution_id']
  },
  {
    table: 'destinations',
    columns: { bank: toTitleCase, account: keepAsIs },
    refs: ['destination_id']
  }
];

/**
 * Title-case every lookup name, merging rows that differ only by case
 * (e.g. "RAVIRAJ" and "raviraj") into the oldest one. Idempotent, so it's
 * safe to run on every startup.
 */
function normalizeLookupNames(db) {
  db.exec('BEGIN');
  try {
    for (const { table, columns, refs } of LOOKUP_TABLES) {
      const cols = Object.keys(columns);
      const rows = db.prepare(`SELECT id, ${cols.join(', ')} FROM ${table} ORDER BY id`).all();
      const survivors = new Map(); // normalized key → { id, values }

      // Pass 1: merge duplicates into the first row of each group.
      for (const row of rows) {
        const values = cols.map((c) => columns[c](row[c]));
        const key = JSON.stringify(values);
        const survivor = survivors.get(key);
        if (!survivor) {
          survivors.set(key, { id: row.id, values, changed: cols.some((c, i) => row[c] !== values[i]) });
          continue;
        }
        for (const ref of refs) {
          db.prepare(`UPDATE policies SET ${ref} = ? WHERE ${ref} = ?`).run(survivor.id, row.id);
        }
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
      }

      // Pass 2: rename survivors. Every group now has one row, so no UNIQUE clash.
      const update = db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`);
      for (const { id, values, changed } of survivors.values()) {
        if (changed) update.run(...values, id);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Write a consistent copy of the open database to destPath (overwriting it).
 * VACUUM INTO is safe while the app is running, unlike copying the file.
 */
function backupTo(db, destPath) {
  fs.rmSync(destPath, { force: true }); // VACUUM INTO refuses to overwrite
  db.prepare('VACUUM INTO ?').run(destPath);
}

/**
 * Check that a file is a Portfolio Ledger database before restoring from it.
 * Returns { ok: true, policyCount } or { ok: false, error }.
 */
function inspectBackup(filePath) {
  let candidate;
  try {
    candidate = new DatabaseSync(filePath, { readOnly: true });
    const tables = new Set(
      candidate.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    const missing = ['policies', 'institutions', 'people', 'destinations'].filter((t) => !tables.has(t));
    if (missing.length) return { ok: false, error: `Not a Portfolio Ledger backup (missing tables: ${missing.join(', ')}).` };
    const integrity = candidate.prepare('PRAGMA integrity_check').get();
    if (Object.values(integrity)[0] !== 'ok') return { ok: false, error: 'The backup file is damaged (integrity check failed).' };
    const { n } = candidate.prepare('SELECT COUNT(*) AS n FROM policies').get();
    return { ok: true, policyCount: n };
  } catch (err) {
    return { ok: false, error: `Could not read the file as a database: ${err.message}` };
  } finally {
    candidate?.close();
  }
}

function recreateDbSchema(db) {
  db.exec('PRAGMA foreign_keys = OFF;');

  // Settings (preferences) survive a reset; the reminder log refers to policy ids, so it goes.
  db.exec(`
    DROP TABLE IF EXISTS reminder_log;
    DROP TABLE IF EXISTS policies;
    DROP TABLE IF EXISTS institutions;
    DROP TABLE IF EXISTS people;
    DROP TABLE IF EXISTS destinations;
  `);

  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
}

/**
 * Insert a lookup row if it doesn't already exist (by its UNIQUE constraint), return its id either way.
 * Names are stored in Title Case, so "union bank" and "Union Bank" resolve to the same row.
 */
function upsertInstitution(db, name, branch) {
  name = toTitleCase(name);
  branch = toTitleCase(branch);
  if (!name) return null;
  const existing = db
    .prepare('SELECT id FROM institutions WHERE name = ? AND (branch = ? OR (branch IS NULL AND ? IS NULL))')
    .get(name, branch ?? null, branch ?? null);
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO institutions (name, branch) VALUES (?, ?)').run(name, branch ?? null);
  return Number(info.lastInsertRowid);
}

function upsertPerson(db, name) {
  name = toTitleCase(name);
  if (!name) return null;
  const existing = db.prepare('SELECT id FROM people WHERE name = ?').get(name);
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO people (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

function upsertDestination(db, bank, account) {
  bank = toTitleCase(bank) ?? null;
  account = account ?? null;
  if (!bank && !account) return null;
  // IS rather than = so a missing bank or account (NULL) still matches its existing row.
  const existing = db.prepare('SELECT id FROM destinations WHERE bank IS ? AND account IS ?').get(bank, account);
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO destinations (bank, account) VALUES (?, ?)').run(bank, account);
  return Number(info.lastInsertRowid);
}

/** Find or create the institution, people, and destination a policy's names refer to. */
function resolveLookups(db, p) {
  return {
    institutionId: upsertInstitution(db, p.institution, p.branch),
    holderId: upsertPerson(db, p.holder),
    jointHolderId: p.jointHolder ? upsertPerson(db, p.jointHolder) : null,
    nomineeId: upsertPerson(db, p.nominee),
    destinationId: upsertDestination(db, p.destinationBank, p.destinationAccount)
  };
}

/**
 * Insert a policy, resolving/creating its institution, people, and destination lookups.
 * @param {DatabaseSync} db
 * @param {object} p - flat policy fields, matching the spec's column names
 * @returns {number} the new policy's id
 */
function addPolicy(db, p) {
  if (isMaturityDateRequired(p.instrument) && isBlank(p.maturityDate)) throw new Error(FD_MATURITY_ERROR);

  const { institutionId, holderId, jointHolderId, nomineeId, destinationId } = resolveLookups(db, p);

  const info = db
    .prepare(
      `INSERT INTO policies (
        policy_number, instrument, start_date, maturity_date, term_total,
        amount_invested, roi, compounding_periods_per_year, maturity_amount,
        institution_id, holder_id, joint_holder_id, nominee_id, destination_id, income_treatment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.policyNumber ?? null,
      p.instrument ?? null,
      p.startDate ?? null,
      p.maturityDate ?? null,
      p.termTotal ?? null,
      p.amountInvested ?? null,
      p.roi ?? null,
      p.compoundingPeriodsPerYear ?? null,
      p.maturityAmount ?? null,
      institutionId,
      holderId,
      jointHolderId,
      nomineeId,
      destinationId,
      p.incomeTreatment ?? null
    );
  return Number(info.lastInsertRowid);
}

function updatePolicy(db, id, fields) {
  const allowed = [
    'policy_number', 'instrument', 'start_date', 'maturity_date', 'term_total',
    'amount_invested', 'roi', 'compounding_periods_per_year', 'maturity_amount', 'income_treatment'
  ];
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    // undefined means "not given" (null clears a field), and SQLite can't bind it anyway.
    if (allowed.includes(key) && value !== undefined) {
      sets.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (sets.length === 0) return false;

  // Check the maturity-date rule against the row as it will look after this update.
  if ('instrument' in fields || 'maturity_date' in fields) {
    const current = db.prepare('SELECT instrument, maturity_date FROM policies WHERE id = ?').get(id);
    if (current) {
      const instrument = 'instrument' in fields ? fields.instrument : current.instrument;
      const maturityDate = 'maturity_date' in fields ? fields.maturity_date : current.maturity_date;
      if (isMaturityDateRequired(instrument) && isBlank(maturityDate)) throw new Error(FD_MATURITY_ERROR);
    }
  }

  values.push(id);
  db.prepare(`UPDATE policies SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return true;
}

/**
 * Overwrite an existing policy with a complete row in addPolicy's shape
 * (used by re-import), including its institution, people, and destination.
 */
function replacePolicy(db, id, p) {
  inTransaction(db, () => {
    updatePolicy(db, id, {
      instrument: p.instrument ?? null,
      start_date: p.startDate ?? null,
      maturity_date: p.maturityDate ?? null,
      term_total: p.termTotal ?? null,
      amount_invested: p.amountInvested ?? null,
      roi: p.roi ?? null,
      compounding_periods_per_year: p.compoundingPeriodsPerYear ?? null,
      maturity_amount: p.maturityAmount ?? null,
      income_treatment: p.incomeTreatment ?? null
    });
    const { institutionId, holderId, jointHolderId, nomineeId, destinationId } = resolveLookups(db, p);
    db.prepare(
      `UPDATE policies SET institution_id = ?, holder_id = ?, joint_holder_id = ?, nominee_id = ?, destination_id = ?
       WHERE id = ?`
    ).run(institutionId, holderId, jointHolderId, nomineeId, destinationId, id);
  });
}

/** Soft delete: the row stays (restorable, and re-import won't re-add it) but is hidden from lists and totals. */
function deletePolicy(db, id) {
  const info = db
    .prepare("UPDATE policies SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL")
    .run(id);
  return Number(info.changes) > 0;
}

/** Run fn inside one transaction, so a bulk change applies to every row or none. */
function inTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Soft-delete several policies at once. Returns how many were deleted (already-deleted ones don't count). */
function deletePolicies(db, ids) {
  return inTransaction(db, () => ids.filter((id) => deletePolicy(db, id)).length);
}

/** Set the income treatment of several active policies at once. Returns how many were updated. */
function setIncomeTreatment(db, ids, treatment) {
  if (!INCOME_TREATMENTS.includes(treatment)) throw new Error(`Unknown income treatment: ${treatment}`);
  return setOnActivePolicies(db, ids, 'income_treatment', treatment);
}

/** Tag several active policies as taxable or tax-exempt at once. Returns how many were updated. */
function setTaxTreatment(db, ids, treatment) {
  if (!TAX_TREATMENTS.includes(treatment)) throw new Error(`Unknown tax treatment: ${treatment}`);
  return setOnActivePolicies(db, ids, 'tax_treatment', treatment);
}

/** column is one of our own column names, never user input. */
function setOnActivePolicies(db, ids, column, value) {
  const update = db.prepare(`UPDATE policies SET ${column} = ? WHERE id = ? AND deleted_at IS NULL`);
  return inTransaction(db, () => ids.reduce((n, id) => n + Number(update.run(value, id).changes), 0));
}

function restorePolicy(db, id) {
  const info = db.prepare('UPDATE policies SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id);
  return Number(info.changes) > 0;
}

/**
 * List policies with their lookup fields resolved (joined), sorted by soonest maturity first.
 * Soft-deleted policies are left out unless includeDeleted is set.
 */
function listPolicies(db, { includeDeleted = false } = {}) {
  return db
    .prepare(
      `SELECT
        p.id, p.policy_number, p.instrument, p.start_date, p.maturity_date, p.term_total,
        p.amount_invested, p.roi, p.compounding_periods_per_year, p.maturity_amount, p.income_treatment, p.tax_treatment, p.deleted_at,
        i.name AS institution, i.branch AS branch,
        h.name AS holder, jh.name AS joint_holder, n.name AS nominee,
        d.bank AS destination_bank, d.account AS destination_account
      FROM policies p
      LEFT JOIN institutions i ON i.id = p.institution_id
      LEFT JOIN people h ON h.id = p.holder_id
      LEFT JOIN people jh ON jh.id = p.joint_holder_id
      LEFT JOIN people n ON n.id = p.nominee_id
      LEFT JOIN destinations d ON d.id = p.destination_id
      ${includeDeleted ? '' : 'WHERE p.deleted_at IS NULL'}
      ORDER BY p.maturity_date IS NULL OR p.maturity_date = '', p.maturity_date ASC`
    )
    .all();
}

/** Aggregate summary used by the dashboard and, later, the AI recommendation prompt. */
function getPortfolioSummary(db, { upcomingWithinDays = 30 } = {}) {
  const totals = db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_invested), 0) AS total FROM policies WHERE deleted_at IS NULL')
    .get();

  const byInstitution = db
    .prepare(
      `SELECT i.name AS institution, COUNT(*) AS count,
              COALESCE(SUM(p.amount_invested), 0) AS totalAmount,
              COALESCE(AVG(p.roi), 0) AS avgROI
       FROM policies p
       LEFT JOIN institutions i ON i.id = p.institution_id
       WHERE p.deleted_at IS NULL
       GROUP BY i.name
       ORDER BY totalAmount DESC`
    )
    .all();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + upcomingWithinDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const upcomingMaturities = db
    .prepare(
      `SELECT p.policy_number AS policyNumber, p.maturity_date AS maturityDate,
              p.amount_invested AS amount, i.name AS institution
       FROM policies p
       LEFT JOIN institutions i ON i.id = p.institution_id
       WHERE p.deleted_at IS NULL AND p.maturity_date BETWEEN ? AND ?
       ORDER BY p.maturity_date ASC`
    )
    .all(today, cutoffStr);

  const roiRange = db
    .prepare('SELECT MIN(roi) AS min, MAX(roi) AS max, AVG(roi) AS avg FROM policies WHERE roi IS NOT NULL AND deleted_at IS NULL')
    .get();

  return {
    totalInvested: totals.total,
    accountCount: totals.count,
    byInstitution,
    upcomingMaturities,
    roiRange
  };
}

/** Stored preference for key (parsed JSON), or fallback when unset. */
function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

/** Set of "policyId|maturityDate|daysBefore" keys for reminders already sent. */
function listSentReminders(db) {
  return new Set(
    db.prepare('SELECT policy_id, maturity_date, days_before FROM reminder_log').all()
      .map((r) => `${r.policy_id}|${r.maturity_date}|${r.days_before}`)
  );
}

function recordRemindersSent(db, entries) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO reminder_log (policy_id, maturity_date, days_before) VALUES (?, ?, ?)'
  );
  db.exec('BEGIN');
  try {
    for (const e of entries) insert.run(e.policyId, e.maturityDate, e.daysBefore);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = {
  initDb,
  backupTo,
  inspectBackup,
  recreateDbSchema,
  upsertInstitution,
  upsertPerson,
  upsertDestination,
  addPolicy,
  updatePolicy,
  replacePolicy,
  deletePolicy,
  deletePolicies,
  setIncomeTreatment,
  setTaxTreatment,
  restorePolicy,
  listPolicies,
  getPortfolioSummary,
  getSetting,
  setSetting,
  listSentReminders,
  recordRemindersSent
};
