'use strict';

const XLSX = require('xlsx');
const { toTitleCase } = require('../shared/nameCase.js');
const { isMaturityDateRequired, isBlank } = require('../shared/policyRules.js');

/**
 * Maps Excel column headers (as they appear in the user's sheet) to schema field names.
 * Matching is case-insensitive and tolerant of extra whitespace.
 */
const HEADER_TO_FIELD = {
  'policy no': 'policyNumber',
  'instrument': 'instrument',
  'date of taking the policy': 'startDate',
  'maturity date': 'maturityDate',
  'total term': 'termTotal',
  'institution': 'institution',
  'branch': 'branch',
  'holder': 'holder',
  'joint holder': 'jointHolder',
  'nominee': 'nominee',
  'amount': 'amountInvested',
  'roi': 'roi',
  'compounding periods per year': 'compoundingPeriodsPerYear',
  'mat amount': 'maturityAmount',
  'expected': 'destinationAccount',
  'proceeds directed to bank': 'destinationBank'
};

// maturityDate is conditionally required (fixed deposits only) — see validateRow.
const REQUIRED_FIELDS = ['policyNumber', 'institution', 'amountInvested'];

/** Options for the import mapping UI's per-column dropdown. '' = ignore the column. */
const SCHEMA_FIELDS = [
  { value: '', label: '(ignore this column)' },
  { value: 'policyNumber', label: 'Policy No' },
  { value: 'instrument', label: 'Instrument' },
  { value: 'startDate', label: 'Start date' },
  { value: 'maturityDate', label: 'Maturity date' },
  { value: 'termTotal', label: 'Total term' },
  { value: 'institution', label: 'Institution' },
  { value: 'branch', label: 'Branch' },
  { value: 'holder', label: 'Holder' },
  { value: 'jointHolder', label: 'Joint holder' },
  { value: 'nominee', label: 'Nominee' },
  { value: 'amountInvested', label: 'Amount Invested' },
  { value: 'roi', label: 'ROI %' },
  { value: 'compoundingPeriodsPerYear', label: 'Compounding periods per year' },
  { value: 'maturityAmount', label: 'Maturity amount' },
  { value: 'destinationAccount', label: 'Destination account' },
  { value: 'destinationBank', label: 'Destination bank' }
];
const NUMERIC_FIELDS = ['amountInvested', 'roi', 'compoundingPeriodsPerYear', 'maturityAmount'];
// Stored in Title Case (see db.js), so parse them the same way for re-import comparisons.
const NAME_FIELDS = ['institution', 'branch', 'holder', 'jointHolder', 'nominee', 'destinationBank'];

function normalizeHeader(h) {
  return String(h ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build the header→field mapping for a parsed sheet's actual header row.
 * Returns { mapping: {colIndex: field}, unmapped: [headerText] } so the UI
 * can show a manual-mapping step for anything that didn't auto-match.
 */
function autoMapHeaders(headerRow) {
  const mapping = {};
  const unmapped = [];
  headerRow.forEach((raw, i) => {
    const key = normalizeHeader(raw);
    if (HEADER_TO_FIELD[key]) {
      mapping[i] = HEADER_TO_FIELD[key];
    } else if (key) {
      unmapped.push(raw);
    }
  });
  return { mapping, unmapped };
}

/** Excel serial date (or JS Date, or string) → 'YYYY-MM-DD', or null if unparseable. */
function parseExcelDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    const mm = String(parsed.m).padStart(2, '0');
    const dd = String(parsed.d).padStart(2, '0');
    return `${parsed.y}-${mm}-${dd}`;
  }
  const str = String(value).trim();
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseNumeric(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a workbook buffer into { rows, unmappedHeaders }.
 * Each row is { data, errors } — data holds every mapped field (raw + parsed
 * dates/numbers), errors is a list of human-readable problems (empty = valid).
 * Invalid rows are still returned (not silently dropped) so the UI can show
 * and let the user fix them inline, per spec §2 step 3.
 *
 * columnMapping ({colIndex: field}) overrides the auto-detected mapping per
 * column; a field of '' means "ignore this column". Columns it doesn't
 * mention keep their auto-detected mapping.
 */
function parseWorkbook(buffer, { sheetName, columnMapping } = {}) {
  const grid = readGrid(buffer, sheetName);
  if (grid.length === 0) return { rows: [], unmappedHeaders: [] };

  const [headerRow, ...dataRows] = grid;
  const { mapping, unmapped } = columnMapping
    ? applyColumnMapping(headerRow, columnMapping)
    : autoMapHeaders(headerRow);

  const rows = dataRows
    .filter((r) => r.some((cell) => cell !== null && cell !== ''))
    .map((r) => {
      const data = {};
      for (const [colIndex, field] of Object.entries(mapping)) {
        const raw = r[Number(colIndex)];
        if (field === 'maturityDate' || field === 'startDate') {
          data[field] = parseExcelDate(raw);
        } else if (NUMERIC_FIELDS.includes(field)) {
          data[field] = parseNumeric(raw);
        } else if (NAME_FIELDS.includes(field)) {
          data[field] = raw == null ? null : toTitleCase(raw);
        } else {
          data[field] = raw == null ? null : String(raw).trim();
        }
      }
      return { data, errors: validateRow(data) };
    });

  return { rows, unmappedHeaders: unmapped };
}

/** Read one sheet (default: the first) as a grid of rows, plus every sheet name in the workbook. */
function readSheet(buffer, sheetName) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const name = sheetName || workbook.SheetNames[0];
  const sheet = workbook.Sheets[name];
  if (!sheet) throw new Error(`Sheet "${name}" not found in workbook`);
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  return { grid, sheetName: name, sheetNames: workbook.SheetNames };
}

function readGrid(buffer, sheetName) {
  return readSheet(buffer, sheetName).grid;
}

/**
 * Merge a manual columnMapping over the auto-detected one. Anything the user
 * explicitly set to '' is treated as deliberately ignored, not "unmapped".
 */
function applyColumnMapping(headerRow, columnMapping) {
  const validFields = new Set(SCHEMA_FIELDS.map((f) => f.value));
  const { mapping } = autoMapHeaders(headerRow);
  for (const [colIndex, field] of Object.entries(columnMapping)) {
    if (!validFields.has(field)) throw new Error(`Unknown field in column mapping: ${field}`);
    if (field) mapping[colIndex] = field;
    else delete mapping[colIndex];
  }
  const unmapped = headerRow.filter(
    (raw, i) => normalizeHeader(raw) && mapping[i] === undefined && !(i in columnMapping)
  );
  return { mapping, unmapped };
}

/**
 * First step of the import wizard: the header row plus the auto-detected
 * mapping, so the UI can let the user confirm or correct it before committing.
 * sheetNames lets the UI offer a sheet picker; sheetName is the one previewed.
 */
function getImportPreview(buffer, { sheetName } = {}) {
  const sheet = readSheet(buffer, sheetName);
  const [headerRow = []] = sheet.grid;
  const { mapping, unmapped } = autoMapHeaders(headerRow);
  return {
    sheetName: sheet.sheetName,
    sheetNames: sheet.sheetNames,
    headerRow,
    mapping,
    unmapped,
    schemaFields: SCHEMA_FIELDS
  };
}

function validateRow(data) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (data[field] === null || data[field] === undefined || data[field] === '') {
      errors.push(`Missing required field: ${field}`);
    }
  }
  // An unparseable date also parses to null, so it's reported here as missing too.
  if (isMaturityDateRequired(data.instrument) && isBlank(data.maturityDate)) {
    errors.push('Missing required field: maturityDate (required for fixed deposits)');
  }
  if (data.startDate !== undefined && data.startDate === null) {
    // startDate isn't required, so a null here (given raw input existed) would've
    // come from an unparseable value — caller can inspect data vs. raw if needed.
  }
  for (const field of NUMERIC_FIELDS) {
    if (data[field] !== null && data[field] !== undefined && Number.isNaN(data[field])) {
      errors.push(`Invalid number: ${field}`);
    }
  }
  return errors;
}

/**
 * Compare freshly-parsed rows against existing policies (by policyNumber) to
 * classify each as new / duplicate-identical / duplicate-changed, per spec §2 step 4.
 * existingByPolicyNumber: Map<policyNumber, existingRowObject>
 */
function classifyForImport(parsedRows, existingByPolicyNumber) {
  return parsedRows.map(({ data, errors }) => {
    if (errors.length > 0) return { data, errors, status: 'invalid' };

    const existing = existingByPolicyNumber.get(data.policyNumber);
    if (!existing) return { data, errors, status: 'new' };

    const changedFields = Object.keys(data).filter((key) => {
      const newVal = data[key];
      const oldVal = existing[key];
      return newVal !== undefined && String(newVal ?? '') !== String(oldVal ?? '');
    });

    return changedFields.length === 0
      ? { data, errors, status: 'duplicate-identical' }
      : { data, errors, status: 'duplicate-changed', changedFields };
  });
}

module.exports = {
  HEADER_TO_FIELD,
  REQUIRED_FIELDS,
  SCHEMA_FIELDS,
  autoMapHeaders,
  getImportPreview,
  parseExcelDate,
  parseNumeric,
  parseWorkbook,
  validateRow,
  classifyForImport
};
