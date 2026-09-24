'use strict';

// Expiry-reminder rules and email content. Pure functions — no database,
// network, or Electron — so they're unit tested directly. main.js wires them
// to the db, the mailer, and the OS scheduler.

const { maturityStatus, maturityValue, roiPercent } = require('../renderer/portfolioMath.js');

const DEFAULT_PREFS = {
  enabled: false,
  recipient: '',
  gmailUser: '',
  daysBefore: [30, 7, 1],
  checkHour: 9, // local time for the daily scheduled check
  hasPassword: false
};

/** Merge stored prefs over defaults and tidy daysBefore (unique, whole, ≥0, largest first). */
function normalizePrefs(stored) {
  const prefs = { ...DEFAULT_PREFS, ...(stored ?? {}) };
  prefs.daysBefore = [...new Set((prefs.daysBefore ?? []).map(Number))]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 365)
    .sort((a, b) => b - a);
  const hour = Number(prefs.checkHour);
  prefs.checkHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_PREFS.checkHour;
  return prefs;
}

/** "30, 7,1" → [30, 7, 1]; returns null when anything isn't a whole number 0–365. */
function parseDaysBefore(text) {
  const parts = String(text ?? '').split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const days = parts.map(Number);
  return days.every((d) => Number.isInteger(d) && d >= 0 && d <= 365) ? normalizePrefs({ daysBefore: days }).daysBefore : null;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());
}

const sentKey = (policyId, maturityDate, daysBefore) => `${policyId}|${maturityDate}|${daysBefore}`;

/**
 * Which active policies need a reminder now. A policy is due when its days
 * left fall within a threshold that hasn't been sent for this maturity date.
 * Only the most urgent threshold is announced; larger ones it has already
 * passed are marked sent with it, so a late first run (e.g. 5 days left with
 * thresholds 30/7/1) sends one "7 days" email, not a 30-day one then a 7-day one.
 *
 * @returns {{ policy, days, daysBefore, markSent: {policyId, maturityDate, daysBefore}[] }[]}
 */
function findDueReminders(policies, sentKeys, daysBefore, today = new Date()) {
  const thresholds = [...daysBefore].sort((a, b) => a - b); // smallest (most urgent) first
  const due = [];
  for (const policy of policies) {
    if (policy.deleted_at) continue;
    const status = maturityStatus(policy.maturity_date, today);
    if (!status || status.days < 0) continue;

    const applicable = thresholds.filter((t) => status.days <= t);
    if (applicable.length === 0) continue;
    const mostUrgent = applicable[0];
    if (sentKeys.has(sentKey(policy.id, policy.maturity_date, mostUrgent))) continue;

    due.push({
      policy,
      days: status.days,
      daysBefore: mostUrgent,
      markSent: applicable.map((t) => ({ policyId: policy.id, maturityDate: policy.maturity_date, daysBefore: t }))
    });
  }
  return due.sort((a, b) => a.days - b.days);
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

/** One digest email covering every due policy: { subject, text, html }. */
function buildReminderEmail(due) {
  const count = due.length;
  const soonest = due[0];
  const subject = count === 1
    ? `Portfolio Ledger: ${soonest.policy.policy_number} matures ${whenText(soonest.days)}`
    : `Portfolio Ledger: ${count} policies maturing soon (first ${whenText(soonest.days)})`;

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

  const text = [
    `${count === 1 ? 'This policy is' : 'These policies are'} approaching maturity:`,
    '',
    ...rows.flatMap((r) => [
      `• ${r.policyNumber} — matures ${r.when}`,
      `  ${r.instrument} at ${r.institution}; holder ${r.holder}`,
      `  Invested ${r.amount} at ${r.rate}; maturity value ${r.maturityValue}; proceeds to ${r.proceedsTo}`,
      ''
    ]),
    'Sent by Portfolio Ledger on your computer. Turn reminders off under Reminders in the app.'
  ].join('\n');

  const cols = [
    ['Policy No', 'policyNumber'], ['Matures', 'when'], ['Instrument', 'instrument'],
    ['Institution', 'institution'], ['Holder', 'holder'], ['Invested', 'amount'],
    ['ROI', 'rate'], ['Maturity value', 'maturityValue'], ['Proceeds to', 'proceedsTo']
  ];
  const cell = 'padding:6px 10px;border-bottom:1px solid #e6e2db;text-align:left;font-size:14px;';
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1c1b1a">
<p>${count === 1 ? 'This policy is' : 'These policies are'} approaching maturity:</p>
<table style="border-collapse:collapse">
<tr>${cols.map(([h]) => `<th style="${cell}background:#f0eee9">${h}</th>`).join('')}</tr>
${rows.map((r) => `<tr>${cols.map(([, k]) => `<td style="${cell}">${escapeHtml(r[k])}</td>`).join('')}</tr>`).join('\n')}
</table>
<p style="color:#6b6560;font-size:12px">Sent by Portfolio Ledger on your computer. Turn reminders off under Reminders in the app.</p>
</div>`;

  return { subject, text, html };
}

module.exports = {
  DEFAULT_PREFS,
  normalizePrefs,
  parseDaysBefore,
  isValidEmail,
  sentKey,
  findDueReminders,
  buildReminderEmail
};
