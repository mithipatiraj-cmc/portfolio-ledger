'use strict';

const { DatabaseSync } = require('node:sqlite');

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
  destination_id INTEGER REFERENCES destinations(id)
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
  if (policyColumns.includes('received_amount') && !policyColumns.includes('amount_invested')) {
    db.exec('ALTER TABLE policies RENAME COLUMN received_amount TO amount_invested;');
  }
}

function recreateDbSchema(db) {
  db.exec('PRAGMA foreign_keys = OFF;');

  db.exec(`
    DROP TABLE IF EXISTS policies;
    DROP TABLE IF EXISTS institutions;
    DROP TABLE IF EXISTS people;
    DROP TABLE IF EXISTS destinations;
  `);

  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
}

/** Insert a lookup row if it doesn't already exist (by its UNIQUE constraint), return its id either way. */
function upsertInstitution(db, name, branch) {
  if (!name) return null;
  const existing = db
    .prepare('SELECT id FROM institutions WHERE name = ? AND (branch = ? OR (branch IS NULL AND ? IS NULL))')
    .get(name, branch ?? null, branch ?? null);
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO institutions (name, branch) VALUES (?, ?)').run(name, branch ?? null);
  return Number(info.lastInsertRowid);
}

function upsertPerson(db, name) {
  if (!name) return null;
  const existing = db.prepare('SELECT id FROM people WHERE name = ?').get(name);
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO people (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

function upsertDestination(db, bank, account) {
  if (!bank && !account) return null;
  const existing = db.prepare('SELECT id FROM destinations WHERE bank = ? AND account = ?').get(bank, account);
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO destinations (bank, account) VALUES (?, ?)').run(bank, account);
  return Number(info.lastInsertRowid);
}

/**
 * Insert a policy, resolving/creating its institution, people, and destination lookups.
 * @param {DatabaseSync} db
 * @param {object} p - flat policy fields, matching the spec's column names
 * @returns {number} the new policy's id
 */
function addPolicy(db, p) {
  const institutionId = upsertInstitution(db, p.institution, p.branch);
  const holderId = upsertPerson(db, p.holder);
  const jointHolderId = p.jointHolder ? upsertPerson(db, p.jointHolder) : null;
  const nomineeId = upsertPerson(db, p.nominee);
  const destinationId = upsertDestination(db, p.destinationBank, p.destinationAccount);

  const info = db
    .prepare(
      `INSERT INTO policies (
        policy_number, instrument, start_date, maturity_date, term_total,
        amount_invested, roi, compounding_periods_per_year, maturity_amount,
        institution_id, holder_id, joint_holder_id, nominee_id, destination_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      destinationId
    );
  return Number(info.lastInsertRowid);
}

function updatePolicy(db, id, fields) {
  const allowed = [
    'policy_number', 'instrument', 'start_date', 'maturity_date', 'term_total',
    'amount_invested', 'roi', 'compounding_periods_per_year', 'maturity_amount'
  ];
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (sets.length === 0) return false;
  values.push(id);
  db.prepare(`UPDATE policies SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return true;
}

function deletePolicy(db, id) {
  const info = db.prepare('DELETE FROM policies WHERE id = ?').run(id);
  return Number(info.changes) > 0;
}

/** List all policies with their lookup fields resolved (joined), sorted by soonest maturity first. */
function listPolicies(db) {
  return db
    .prepare(
      `SELECT
        p.id, p.policy_number, p.instrument, p.start_date, p.maturity_date, p.term_total,
        p.amount_invested, p.roi, p.compounding_periods_per_year, p.maturity_amount,
        i.name AS institution, i.branch AS branch,
        h.name AS holder, jh.name AS joint_holder, n.name AS nominee,
        d.bank AS destination_bank, d.account AS destination_account
      FROM policies p
      LEFT JOIN institutions i ON i.id = p.institution_id
      LEFT JOIN people h ON h.id = p.holder_id
      LEFT JOIN people jh ON jh.id = p.joint_holder_id
      LEFT JOIN people n ON n.id = p.nominee_id
      LEFT JOIN destinations d ON d.id = p.destination_id
      ORDER BY p.maturity_date ASC`
    )
    .all();
}

/** Aggregate summary used by the dashboard and, later, the AI recommendation prompt. */
function getPortfolioSummary(db, { upcomingWithinDays = 30 } = {}) {
  const totals = db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_invested), 0) AS total FROM policies')
    .get();

  const byInstitution = db
    .prepare(
      `SELECT i.name AS institution, COUNT(*) AS count,
              COALESCE(SUM(p.amount_invested), 0) AS totalAmount,
              COALESCE(AVG(p.roi), 0) AS avgROI
       FROM policies p
       LEFT JOIN institutions i ON i.id = p.institution_id
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
       WHERE p.maturity_date BETWEEN ? AND ?
       ORDER BY p.maturity_date ASC`
    )
    .all(today, cutoffStr);

  const roiRange = db
    .prepare('SELECT MIN(roi) AS min, MAX(roi) AS max, AVG(roi) AS avg FROM policies WHERE roi IS NOT NULL')
    .get();

  return {
    totalInvested: totals.total,
    accountCount: totals.count,
    byInstitution,
    upcomingMaturities,
    roiRange
  };
}

module.exports = {
  initDb,
  recreateDbSchema,
  upsertInstitution,
  upsertPerson,
  upsertDestination,
  addPolicy,
  updatePolicy,
  deletePolicy,
  listPolicies,
  getPortfolioSummary
};
