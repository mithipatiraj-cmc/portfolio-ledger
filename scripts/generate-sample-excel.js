'use strict';

// Generates samples/sample-portfolio.xls: fictional test data for trying out
// the import, badges, chart, and email reminders. Maturity dates are relative
// to the day it's run, so re-run it (npm run sample) to get fresh "due soon"
// rows. All names and account numbers are made up.

const path = require('node:path');
const fs = require('node:fs');
const XLSX = require('xlsx');

const OUT = path.join(__dirname, '..', 'samples', 'sample-portfolio.xls');

const HEADERS = [
  'Policy No', 'Instrument', 'Date of taking the policy', 'Maturity Date', 'Total Term',
  'Institution', 'Branch', 'Holder', 'Joint Holder', 'Nominee', 'Amount', 'ROI',
  'Compounding periods per year', 'Mat Amount', 'Expected', 'Proceeds directed to bank'
];

// Mixed capitalisation on purpose: the app stores names in Title Case.
const HOLDERS = [
  'Aarav Sharma', 'PRIYA NAIR', 'rohan mehta', 'Ananya Iyer', 'Vikram Rao', 'meera KRISHNAN',
  'Arjun Reddy', 'Kavya Menon', 'SIDDHARTH JOSHI', 'Ishita Gupta', 'Karthik Subramanian', 'neha kapoor',
  'Rahul Verma', 'Divya Pillai', 'Aditya Kulkarni', 'POOJA DESAI', 'Varun Bhat', 'Sneha Patil',
  'nikhil agarwal', 'Lakshmi Venkatesh', 'Harish Chandra', 'Swati Mishra', 'MANOJ KUMAR', 'Deepa Hegde',
  'Suresh Babu', 'anjali rao', 'Gaurav Saxena', 'Revathi Srinivasan', 'Pranav Shetty', 'Tanvi Bose'
];
const NOMINEES = ['Asha Sharma', 'ravi nair', 'Sunita Mehta', 'Gopal Iyer', 'Latha Rao', 'Mohan Krishnan'];

// [name, branches, instrument choices, ROI range (fraction), compounding/yr]
const INSTITUTIONS = [
  ['HDFC', ['Koramangala', 'indiranagar'], ['F D', 'Fixed Deposit'], [0.065, 0.0725], 4],
  ['sbi', ['MG Road', 'Jayanagar'], ['F D', 'Fixed Deposit'], [0.064, 0.071], 4],
  ['ICICI Bank', ['Whitefield'], ['Fixed Deposit'], [0.066, 0.0735], 4],
  ['Canara Bank', ['Gandhi Nagar', 'NALLAGANDLA'], ['F D'], [0.0675, 0.0725], 12],
  ['union bank', ['Tellapur'], ['F D'], [0.066, 0.073], 12],
  ['Post Office', ['Khairatabad'], ['NSC', 'Savings Certificate'], [0.077, 0.077], 1]
];
const BANKS = ['HDFC', 'SBI', 'ICICI Bank', 'Canara Bank', 'Axis Bank'];

// Days from today until maturity, one per holder — a spread across the badge
// and reminder thresholds (matured, ≤1, ≤7, ≤30, ≤60 days, and later).
const DAYS_TO_MATURITY = [
  -120, -15, 0, 1, 3, 6, 12, 21, 29, 35, 44, 58, 75, 90, 120,
  150, 200, 260, 300, 365, 420, 500, 600, 700, 800, 900, 1000, 1200, 1500, 1800
];

// Deterministic pseudo-random numbers so the file is the same for the same day.
let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = (list) => list[Math.floor(rand() * list.length)];

function isoDate(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

const today = new Date();
const rows = HOLDERS.map((holder, i) => {
  const [institution, branches, instruments, [roiMin, roiMax], compounding] = INSTITUTIONS[i % INSTITUTIONS.length];
  const instrument = pick(instruments);
  const termMonths = instrument === 'NSC' || instrument === 'Savings Certificate' ? 60 : pick([12, 24, 25, 36, 60]);
  const maturity = addDays(today, DAYS_TO_MATURITY[i]);
  const start = new Date(maturity);
  start.setMonth(start.getMonth() - termMonths);

  const amount = Math.round((50000 + rand() * 1450000) / 1000) * 1000;
  const roi = Math.round((roiMin + rand() * (roiMax - roiMin)) * 10000) / 10000;
  const years = (maturity - start) / (365 * 24 * 60 * 60 * 1000);
  const matAmount = Math.round(amount * Math.pow(1 + roi / compounding, compounding * years));

  return [
    `SAMPLE-${String(i + 1).padStart(3, '0')}`,
    instrument,
    isoDate(start),
    isoDate(maturity),
    termMonths % 12 === 0 ? `${termMonths / 12} years` : `${termMonths} months`,
    institution,
    pick(branches),
    holder,
    i % 4 === 0 ? pick(NOMINEES) : '',
    pick(NOMINEES),
    amount,
    roi,
    compounding,
    i % 5 === 2 ? '' : matAmount, // every 5th left blank → the app calculates it (shown with ≈)
    `5010${String(1000000 + Math.floor(rand() * 8999999))}`,
    pick(BANKS)
  ];
});

// Two rows the import should reject, to see validation messages.
rows.push(
  ['SAMPLE-INVALID-1', 'F D', isoDate(today), '', '1 year', 'HDFC', 'Koramangala', 'Test Holder', '', 'Asha Sharma',
    100000, 0.07, 4, '', '', ''], // fixed deposit without a maturity date
  ['', 'NSC', isoDate(today), isoDate(addDays(today, 1825)), '5 years', 'Post Office', 'Khairatabad', 'Test Holder',
    '', 'Asha Sharma', 50000, 0.077, 1, '', '', ''] // missing Policy No
);

const notes = [
  ['Portfolio Ledger sample data'],
  [`Generated ${isoDate(today)}. All names and account numbers are fictional.`],
  ['Import the "Policies" sheet. It has 30 valid rows (one per holder) and 2 rows that should be rejected:'],
  ['- SAMPLE-INVALID-1: fixed deposit without a maturity date'],
  ['- a row with no Policy No'],
  ['Maturity dates are relative to the generation date, spanning matured, due within 1/7/30/60 days, and later.']
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notes), 'Notes');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, ...rows]), 'Policies');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
XLSX.writeFile(wb, OUT, { bookType: 'biff8' }); // .xls (Excel 97–2003)
console.log(`Wrote ${rows.length} rows to ${path.relative(process.cwd(), OUT)}`);
