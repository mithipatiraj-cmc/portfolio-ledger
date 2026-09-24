'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePrefs,
  parseDaysBefore,
  isValidEmail,
  sentKey,
  findDueReminders,
  buildReminderEmail
} = require('../src/main/reminders.js');

const TODAY = new Date(2026, 8, 24); // 24 Sep 2026, local
const policy = (id, maturity_date, extra = {}) => ({
  id, policy_number: `FD-${id}`, maturity_date, institution: 'HDFC', holder: 'Raviraj',
  amount_invested: 100000, roi: 0.07, maturity_amount: 107000, ...extra
});

test('parseDaysBefore accepts comma/space lists and rejects bad values', () => {
  assert.deepEqual(parseDaysBefore('30, 7,1'), [30, 7, 1]);
  assert.deepEqual(parseDaysBefore('1 7 30 7'), [30, 7, 1], 'deduplicated, largest first');
  assert.deepEqual(parseDaysBefore('0'), [0]);
  assert.equal(parseDaysBefore(''), null);
  assert.equal(parseDaysBefore('7, soon'), null);
  assert.equal(parseDaysBefore('1.5'), null);
  assert.equal(parseDaysBefore('400'), null);
});

test('normalizePrefs fills defaults and keeps reminders off by default', () => {
  const prefs = normalizePrefs(null);
  assert.equal(prefs.enabled, false);
  assert.deepEqual(prefs.daysBefore, [30, 7, 1]);
  assert.equal(prefs.checkHour, 9);
  assert.equal(normalizePrefs({ checkHour: 25 }).checkHour, 9);
});

test('isValidEmail', () => {
  assert.equal(isValidEmail('me@gmail.com'), true);
  assert.equal(isValidEmail(' me@gmail.com '), true);
  assert.equal(isValidEmail('me@gmail'), false);
  assert.equal(isValidEmail(''), false);
});

test('findDueReminders picks policies within a threshold that has not been sent', () => {
  const policies = [
    policy(1, '2026-10-24'), // 30 days
    policy(2, '2026-10-25'), // 31 days — not yet
    policy(3, '2026-09-30'), // 6 days
    policy(4, '2026-09-20'), // already matured
    policy(5, null),
    policy(6, '2026-09-25', { deleted_at: '2026-09-01' })
  ];
  const due = findDueReminders(policies, new Set(), [30, 7, 1], TODAY);
  assert.deepEqual(due.map((d) => [d.policy.id, d.days, d.daysBefore]), [[3, 6, 7], [1, 30, 30]]);
});

test('findDueReminders: a late first check sends only the most urgent reminder and marks the rest', () => {
  const [d] = findDueReminders([policy(1, '2026-09-29')], new Set(), [30, 7, 1], TODAY); // 5 days left
  assert.equal(d.daysBefore, 7);
  assert.deepEqual(d.markSent.map((m) => m.daysBefore), [7, 30]);

  // Once those are recorded, nothing more until the 1-day threshold.
  const sent = new Set(d.markSent.map((m) => sentKey(m.policyId, m.maturityDate, m.daysBefore)));
  assert.equal(findDueReminders([policy(1, '2026-09-29')], sent, [30, 7, 1], TODAY).length, 0);
  const oneDayBefore = new Date(2026, 8, 28);
  assert.equal(findDueReminders([policy(1, '2026-09-29')], sent, [30, 7, 1], oneDayBefore)[0].daysBefore, 1);
});

test('findDueReminders reminds again when the maturity date changes (renewal)', () => {
  const sent = new Set([sentKey(1, '2026-09-30', 7), sentKey(1, '2026-09-30', 30)]);
  assert.equal(findDueReminders([policy(1, '2026-09-30')], sent, [30, 7], TODAY).length, 0);
  assert.equal(findDueReminders([policy(1, '2026-10-01')], sent, [30, 7], TODAY).length, 1);
});

test('findDueReminders includes a policy maturing today with a 0-day threshold', () => {
  const due = findDueReminders([policy(1, '2026-09-24')], new Set(), [0], TODAY);
  assert.equal(due[0].days, 0);
});

test('buildReminderEmail: one digest, soonest first, with HTML escaped', () => {
  const due = findDueReminders(
    [policy(1, '2026-10-20'), policy(2, '2026-09-25', { institution: 'A&B <Bank>' })],
    new Set(), [30], TODAY
  );
  const mail = buildReminderEmail(due);
  assert.match(mail.subject, /2 policies maturing soon \(first tomorrow\)/);
  assert.ok(mail.text.indexOf('FD-2') < mail.text.indexOf('FD-1'), 'soonest first');
  assert.match(mail.text, /₹1,07,000/);
  assert.match(mail.html, /A&amp;B &lt;Bank&gt;/);
  assert.doesNotMatch(mail.html, /<Bank>/);

  const single = buildReminderEmail(due.slice(0, 1));
  assert.equal(single.subject, 'Portfolio Ledger: FD-2 matures tomorrow');
});
