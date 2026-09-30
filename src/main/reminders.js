'use strict';

// Expiry-reminder rules and email content. Pure functions — no database,
// network, or Electron — so they're unit tested directly. main.js wires them
// to the db, the mailer, and the OS scheduler.

const { maturityStatus, maturityValue, roiPercent } = require('../renderer/portfolioMath.js');
const { dueStatus, methodLabel, frequencyLabel } = require('../renderer/billsMath.js');

const DEFAULT_PREFS = {
  enabled: false,
  recipient: '',
  gmailUser: '',
  daysBefore: [30, 7, 1],
  billsEnabled: false, // also remind about bill due dates
  billDaysBefore: [3, 1], // bills come round often, so closer thresholds than maturities
  checkHour: 9, // local time for the daily scheduled check
  hasPassword: false
};

/** Unique whole days 0–365, largest first. */
function tidyDays(days) {
  return [...new Set((days ?? []).map(Number))]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 365)
    .sort((a, b) => b - a);
}

/** Merge stored prefs over defaults and tidy both threshold lists. */
function normalizePrefs(stored) {
  const prefs = { ...DEFAULT_PREFS, ...(stored ?? {}) };
  prefs.daysBefore = tidyDays(prefs.daysBefore);
  prefs.billDaysBefore = tidyDays(prefs.billDaysBefore);
  prefs.billsEnabled = Boolean(prefs.billsEnabled);
  const hour = Number(prefs.checkHour);
  prefs.checkHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_PREFS.checkHour;
  return prefs;
}

/** "30, 7,1" → [30, 7, 1]; returns null when anything isn't a whole number 0–365. */
function parseDaysBefore(text) {
  const parts = String(text ?? '').split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const days = parts.map(Number);
  return days.every((d) => Number.isInteger(d) && d >= 0 && d <= 365) ? tidyDays(days) : null;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());
}

const sentKey = (policyId, maturityDate, daysBefore) => `${policyId}|${maturityDate}|${daysBefore}`;

/**
 * Of the items due within a threshold, those whose most urgent threshold
 * hasn't been sent for this date. Only that threshold is announced; larger
 * ones it has already passed are marked sent with it, so a late first run
 * (e.g. 5 days left with thresholds 30/7/1) sends one "7 days" email, not a
 * 30-day one then a 7-day one. Already-past dates are left out.
 */
function pickDue(items, sentKeys, daysBefore, dateOf, status) {
  const thresholds = [...daysBefore].sort((a, b) => a - b); // smallest (most urgent) first
  const due = [];
  for (const item of items) {
    const s = status(item);
    if (!s || s.days < 0) continue;
    const applicable = thresholds.filter((t) => s.days <= t);
    if (applicable.length === 0) continue;
    if (sentKeys.has(sentKey(item.id, dateOf(item), applicable[0]))) continue;
    due.push({ item, days: s.days, daysBefore: applicable[0], applicable });
  }
  return due.sort((a, b) => a.days - b.days);
}

/**
 * Which active policies need a reminder now (see pickDue).
 *
 * @returns {{ policy, days, daysBefore, markSent: {policyId, maturityDate, daysBefore}[] }[]}
 */
function findDueReminders(policies, sentKeys, daysBefore, today = new Date()) {
  const active = policies.filter((p) => !p.deleted_at);
  return pickDue(active, sentKeys, daysBefore, (p) => p.maturity_date, (p) => maturityStatus(p.maturity_date, today))
    .map(({ item: policy, days, daysBefore: d, applicable }) => ({
      policy,
      days,
      daysBefore: d,
      markSent: applicable.map((t) => ({ policyId: policy.id, maturityDate: policy.maturity_date, daysBefore: t }))
    }));
}

/**
 * Which active bills need a reminder now (see pickDue). Keyed on the due
 * date, so once a bill is paid and its due date moves on, the next one is
 * reminded afresh; a bill paid before its reminder never gets one.
 *
 * @returns {{ bill, days, daysBefore, markSent: {billId, dueDate, daysBefore}[] }[]}
 */
function findDueBillReminders(bills, sentKeys, daysBefore, today = new Date()) {
  const active = bills.filter((b) => !b.archived_at);
  return pickDue(active, sentKeys, daysBefore, (b) => b.due_date, (b) => dueStatus(b.due_date, today))
    .map(({ item: bill, days, daysBefore: d, applicable }) => ({
      bill,
      days,
      daysBefore: d,
      markSent: applicable.map((t) => ({ billId: bill.id, dueDate: bill.due_date, daysBefore: t }))
    }));
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

function whenText(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function reminderSubject(due, billsDue) {
  if (billsDue.length === 0) {
    const [soonest] = due;
    return due.length === 1
      ? `Portfolio Ledger: ${soonest.policy.policy_number} matures ${whenText(soonest.days)}`
      : `Portfolio Ledger: ${due.length} policies maturing soon (first ${whenText(soonest.days)})`;
  }
  if (due.length === 0) {
    const [soonest] = billsDue;
    return billsDue.length === 1
      ? `Portfolio Ledger: ${soonest.bill.name} is due ${whenText(soonest.days)}`
      : `Portfolio Ledger: ${billsDue.length} bills due soon (first ${whenText(soonest.days)})`;
  }
  return `Portfolio Ledger: ${plural(due.length, 'policy', 'policies')} maturing and ${plural(billsDue.length, 'bill', 'bills')} due soon`;
}

const FOOTER = 'Sent by Portfolio Ledger on your computer. Turn reminders off under Reminders in the app.';
const cell = 'padding:6px 10px;border-bottom:1px solid #e6e2db;text-align:left;font-size:14px;';

function htmlTable(cols, rows) {
  return `<table style="border-collapse:collapse">
<tr>${cols.map(([h]) => `<th style="${cell}background:#f0eee9">${h}</th>`).join('')}</tr>
${rows.map((r) => `<tr>${cols.map(([, k]) => `<td style="${cell}">${escapeHtml(r[k])}</td>`).join('')}</tr>`).join('\n')}
</table>`;
}

/** The usual amount, or for a bill that varies, "Varies" with the last payment for reference. */
function billAmountText(b) {
  if (b.amount !== null && b.amount !== undefined) return inr.format(b.amount);
  return b.last_paid_amount == null ? 'Varies' : `Varies (last ${inr.format(b.last_paid_amount)})`;
}

/** Bill rows for the email: what's due, when, and how it's paid. */
function billSection(billsDue) {
  const rows = billsDue.map(({ bill: b, days }) => ({
    name: b.name,
    when: `${b.due_date} (${whenText(days)})`,
    amount: billAmountText(b),
    paidBy: methodLabel(b.payment_method),
    bank: b.bank_detail ?? '—',
    frequency: frequencyLabel(b.frequency)
  }));
  const intro = billsDue.length === 1 ? 'This bill is due soon:' : 'These bills are due soon:';
  const text = [
    intro,
    '',
    ...rows.flatMap((r) => [
      `• ${r.name} — ${r.amount} due ${r.when}`,
      `  ${r.paidBy}${r.bank === '—' ? '' : ` (${r.bank})`}; ${r.frequency.toLowerCase()}`,
      ''
    ])
  ];
  const cols = [['Bill', 'name'], ['Due', 'when'], ['Amount', 'amount'], ['Paid by', 'paidBy'], ['Bank / card', 'bank'], ['How often', 'frequency']];
  return { text, html: `<p>${intro}</p>\n${htmlTable(cols, rows)}` };
}

/**
 * One digest email covering every due policy and bill: { subject, text, html }.
 * Either list may be empty, but not both.
 */
function buildReminderEmail(due, billsDue = []) {
  const subject = reminderSubject(due, billsDue);
  const policies = due.length ? policySection(due) : { text: [], html: '' };
  const bills = billsDue.length ? billSection(billsDue) : { text: [], html: '' };
  const text = [...policies.text, ...bills.text, FOOTER].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1c1b1a">
${[policies.html, bills.html].filter(Boolean).join('\n')}
<p style="color:#6b6560;font-size:12px">${FOOTER}</p>
</div>`;
  return { subject, text, html };
}

/** Policy rows for the email. */
function policySection(due) {
  const count = due.length;

  const rows = due.map(({ policy: p, days }) => {
    const rate = roiPercent(p.roi);
    const mv = maturityValue(p);
    return {
      policyNumber: p.policy_number,
      when: `${p.maturity_date} (${whenText(days)})`,
      instrument: p.instrument ?? '',
      institution: [p.institution, p.branch].filter(Boolean).join(', '),
      holder: p.holder ?? '',
      amount: p.amount_invested === null || p.amount_invested === undefined ? '—' : inr.format(p.amount_invested),
      rate: rate === null ? '—' : `${rate.toFixed(2)}%`,
      maturityValue: mv.value === null ? '—' : `${mv.calculated ? '≈ ' : ''}${inr.format(mv.value)}`,
      proceedsTo: [p.destination_bank, p.destination_account].filter(Boolean).join(' · ') || '—'
    };
  });

  const intro = `${count === 1 ? 'This policy is' : 'These policies are'} approaching maturity:`;
  const text = [
    intro,
    '',
    ...rows.flatMap((r) => [
      `• ${r.policyNumber} — matures ${r.when}`,
      `  ${r.instrument} at ${r.institution}; holder ${r.holder}`,
      `  Invested ${r.amount} at ${r.rate}; maturity value ${r.maturityValue}; proceeds to ${r.proceedsTo}`,
      ''
    ])
  ];

  const cols = [
    ['Policy No', 'policyNumber'], ['Matures', 'when'], ['Instrument', 'instrument'],
    ['Institution', 'institution'], ['Holder', 'holder'], ['Invested', 'amount'],
    ['ROI', 'rate'], ['Maturity value', 'maturityValue'], ['Proceeds to', 'proceedsTo']
  ];
  return { text, html: `<p>${intro}</p>\n${htmlTable(cols, rows)}` };
}

module.exports = {
  DEFAULT_PREFS,
  normalizePrefs,
  parseDaysBefore,
  isValidEmail,
  sentKey,
  findDueReminders,
  findDueBillReminders,
  buildReminderEmail
};
