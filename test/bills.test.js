'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/main/db.js');
const { nextDueDate, dueStatus, summarizeBills, methodLabel, frequencyLabel, expectedAmount } = require('../src/renderer/billsMath.js');

const TODAY = new Date(2026, 8, 30); // 30 Sep 2026, local time
const electricity = { name: 'Electricity', paymentMethod: 'bank_transfer', dueDate: '2026-10-05', amount: 2400 };

test('nextDueDate moves a month on and keeps the day, even past short months', () => {
  assert.equal(nextDueDate('2026-10-05'), '2026-11-05');
  assert.equal(nextDueDate('2026-12-15'), '2027-01-15', 'across the year end');
  assert.equal(nextDueDate('2027-01-31', 31), '2027-02-28');
  assert.equal(nextDueDate('2027-02-28', 31), '2027-03-31', 'back to the 31st, not stuck on the 28th');
  assert.equal(nextDueDate('2028-01-30', 30), '2028-02-29', 'leap year');
  assert.equal(nextDueDate('not a date'), null);
});

test('nextDueDate steps by the bill\'s frequency', () => {
  assert.equal(nextDueDate('2026-10-05', 5, 'bimonthly'), '2026-12-05');
  assert.equal(nextDueDate('2026-11-30', 30, 'quarterly'), '2027-02-28');
  assert.equal(nextDueDate('2026-10-05', 5, 'semiannual'), '2027-04-05');
  assert.equal(nextDueDate('2028-02-29', 29, 'annual'), '2029-02-28');
  assert.equal(frequencyLabel('bimonthly'), 'Every 2 months');
});

test('dueStatus flags overdue and due within a week', () => {
  assert.deepEqual(dueStatus('2026-09-29', TODAY), { days: -1, level: 'overdue' });
  assert.deepEqual(dueStatus('2026-09-30', TODAY), { days: 0, level: 'soon' });
  assert.deepEqual(dueStatus('2026-10-07', TODAY), { days: 7, level: 'soon' });
  assert.deepEqual(dueStatus('2026-10-08', TODAY), { days: 8, level: null });
  assert.equal(methodLabel('check'), 'Check deposit');
});

test('summarizeBills totals active bills, what is overdue or due soon, and payments this month', () => {
  const bills = [
    { amount: 1000, due_date: '2026-09-20', frequency: 'monthly' },
    { amount: 500, due_date: '2026-10-02' },
    { amount: 3600, due_date: '2026-11-01', frequency: 'annual' },
    { amount: 9999, due_date: '2026-09-01', archived_at: '2026-09-02' }
  ];
  const payments = [{ amount: 700, paid_on: '2026-09-03' }, { amount: 50, paid_on: '2026-08-31' }];
  assert.deepEqual(summarizeBills(bills, payments, TODAY), {
    billCount: 3, monthlyEquivalent: 1800, // 1000 + 500 + 3600/12
    overdueCount: 1, overdueAmount: 1000,
    dueSoonCount: 1, dueSoonAmount: 500,
    paidThisMonth: 700, paymentsThisMonth: 1, unknownAmountCount: 0
  });
});

test('summarizeBills counts a bill whose amount varies at its last payment, and flags ones with neither', () => {
  const bills = [
    { amount: null, last_paid_amount: 1200, due_date: '2026-10-02' },
    { amount: null, last_paid_amount: null, due_date: '2026-10-03' },
    { amount: 0, last_paid_amount: 999, due_date: '2026-11-01' } // a real 0 wins over the last payment
  ];
  const s = summarizeBills(bills, [], TODAY);
  assert.equal(s.monthlyEquivalent, 1200);
  assert.equal(s.dueSoonAmount, 1200);
  assert.equal(s.unknownAmountCount, 1);
  assert.equal(expectedAmount({ amount: 2400, last_paid_amount: 2650 }), 2400);
});

test('addBill validates the form: name, method, bank details for checks, due date, and an amount if given', () => {
  const d = db.initDb(':memory:');
  assert.throws(() => db.addBill(d, { ...electricity, name: ' ' }), /name/);
  assert.throws(() => db.addBill(d, { ...electricity, frequency: 'weekly' }), /how often/);
  assert.throws(() => db.addBill(d, { ...electricity, paymentMethod: 'cash' }), /how the bill is paid/);
  assert.throws(() => db.addBill(d, { ...electricity, paymentMethod: 'check' }), /bank details/);
  assert.throws(() => db.addBill(d, { ...electricity, dueDate: '' }), /due date/);
  assert.throws(() => db.addBill(d, { ...electricity, amount: -5 }), /usual amount/);
  assert.throws(() => db.addBill(d, { ...electricity, amount: 'lots' }), /usual amount/);
  const id = db.addBill(d, { ...electricity, paymentMethod: 'check', bankDetail: 'HDFC ••1234' });
  const [bill] = db.listBills(d);
  assert.equal(bill.id, id);
  assert.equal(bill.due_day, 5);
  assert.equal(bill.frequency, 'monthly', 'monthly unless chosen');
  assert.equal(bill.last_paid_amount, null, 'no payments yet');
});

test('recordPayment keeps every payment as history, shows the latest as last paid, and moves the due date on', () => {
  const d = db.initDb(':memory:');
  const id = db.addBill(d, electricity);
  db.recordPayment(d, id, { paidOn: '2026-10-04', amount: 2400 });
  db.recordPayment(d, id, { paidOn: '2026-11-03', amount: 2650.5, note: 'winter' });

  const [bill] = db.listBills(d);
  assert.equal(bill.due_date, '2026-12-05');
  assert.equal(bill.last_paid_on, '2026-11-03');
  assert.equal(bill.last_paid_amount, 2650.5);
  assert.equal(bill.payment_count, 2);

  const history = db.listPayments(d, { billId: id });
  assert.deepEqual(history.map((p) => [p.paid_on, p.amount, p.for_due_date, p.payment_method]), [
    ['2026-11-03', 2650.5, '2026-11-05', 'bank_transfer'],
    ['2026-10-04', 2400, '2026-10-05', 'bank_transfer']
  ]);
});

test('recordPayment moves a quarterly bill\'s due date on three months', () => {
  const d = db.initDb(':memory:');
  const id = db.addBill(d, { ...electricity, name: 'Water', frequency: 'quarterly' });
  db.recordPayment(d, id, { paidOn: '2026-10-04', amount: 900 });
  assert.equal(db.listBills(d)[0].due_date, '2027-01-05');
});

test('recordPayment: a one-off payment can leave the due date alone; bad input changes nothing', () => {
  const d = db.initDb(':memory:');
  const id = db.addBill(d, electricity);
  db.recordPayment(d, id, { paidOn: '2026-10-01', amount: 100 }, { advanceDueDate: false });
  assert.equal(db.listBills(d)[0].due_date, '2026-10-05');

  assert.throws(() => db.recordPayment(d, id, { paidOn: '2026-10-02', amount: 0 }), /amount paid/);
  assert.throws(() => db.recordPayment(d, id, { paidOn: '2026-10-02', amount: 5, paymentMethod: 'check' }), /bank details/);
  assert.equal(db.listPayments(d, { billId: id }).length, 1);
  assert.equal(db.listBills(d)[0].due_date, '2026-10-05');
});

test('a payment records the method used then, even if the bill later changes how it is paid', () => {
  const d = db.initDb(':memory:');
  const id = db.addBill(d, electricity);
  db.recordPayment(d, id, { paidOn: '2026-10-04', amount: 2400 });
  db.updateBill(d, id, { ...electricity, paymentMethod: 'check', bankDetail: 'SBI ••9876', dueDate: '2026-11-05' });
  db.recordPayment(d, id, { paidOn: '2026-11-04', amount: 2400 });
  assert.deepEqual(db.listPayments(d, { billId: id }).map((p) => [p.payment_method, p.bank_detail]), [
    ['check', 'SBI ••9876'],
    ['bank_transfer', null]
  ]);
});

test('archiving hides a bill but keeps its history; listPayments can filter by date across bills', () => {
  const d = db.initDb(':memory:');
  const a = db.addBill(d, electricity);
  const b = db.addBill(d, { ...electricity, name: 'Internet', amount: 999 });
  db.recordPayment(d, a, { paidOn: '2026-08-04', amount: 2400 });
  db.recordPayment(d, b, { paidOn: '2026-09-04', amount: 999 });

  assert.equal(db.archiveBill(d, a), true);
  assert.deepEqual(db.listBills(d).map((x) => x.name), ['Internet']);
  assert.equal(db.listBills(d, { includeArchived: true }).length, 2);
  assert.equal(db.listPayments(d, { billId: a }).length, 1, 'history kept');
  assert.deepEqual(db.listPayments(d, { from: '2026-09-01' }).map((p) => p.bill_name), ['Internet']);

  assert.equal(db.restoreBill(d, a), true);
  const [payment] = db.listPayments(d, { billId: b });
  assert.equal(db.deletePayment(d, payment.id), true);
  assert.equal(db.listBills(d).find((x) => x.id === b).last_paid_amount, null);
});

test('recreateDbSchema clears bills and payments too', () => {
  const d = db.initDb(':memory:');
  db.recordPayment(d, db.addBill(d, electricity), { paidOn: '2026-10-04', amount: 2400 });
  db.recreateDbSchema(d);
  assert.equal(db.listBills(d, { includeArchived: true }).length, 0);
  assert.equal(db.listPayments(d).length, 0);
});

test('bill reminder log: records each (bill, due date, threshold) once and is cleared with the bill data', () => {
  const d = db.initDb(':memory:');
  const id = db.addBill(d, electricity);
  const entry = { billId: id, dueDate: '2026-10-05', daysBefore: 3 };
  db.recordBillRemindersSent(d, [entry, entry]);
  assert.deepEqual([...db.listSentBillReminders(d)], [`${id}|2026-10-05|3`]);
  db.recreateDbSchema(d);
  assert.equal(db.listSentBillReminders(d).size, 0);
});

test('a bill can leave its amount blank; each payment then records what was actually paid', () => {
  const d = db.initDb(':memory:');
  const id = db.addBill(d, { ...electricity, name: 'Phone', amount: '' });
  assert.equal(db.listBills(d)[0].amount, null);
  assert.throws(() => db.recordPayment(d, id, { paidOn: '2026-10-04', amount: '' }), /amount paid/, 'the payment still needs one');
  db.recordPayment(d, id, { paidOn: '2026-10-04', amount: 612 });
  db.recordPayment(d, id, { paidOn: '2026-11-04', amount: 745.2 });
  assert.deepEqual(db.listPayments(d, { billId: id }).map((p) => p.amount), [745.2, 612]);
  assert.equal(db.listBills(d)[0].last_paid_amount, 745.2);
  db.updateBill(d, id, { ...electricity, name: 'Phone', amount: 700 });
  assert.equal(db.listBills(d)[0].amount, 700, 'and can be set later');
});

test('initDb rebuilds a bills table that required an amount, keeping bills, payments and reminder log', () => {
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), 'bills-v1.sqlite');

  // A database from before this change: set it up with today's schema, then
  // swap in the old bills table that had amount REAL NOT NULL.
  const setup = db.initDb(dbPath);
  setup.exec(`PRAGMA foreign_keys = OFF;
    DROP TABLE bills;
    CREATE TABLE bills (id INTEGER PRIMARY KEY, name TEXT NOT NULL, frequency TEXT NOT NULL DEFAULT 'monthly',
      payment_method TEXT NOT NULL, bank_detail TEXT, due_date TEXT NOT NULL, due_day INTEGER NOT NULL,
      amount REAL NOT NULL, archived_at TEXT);
    INSERT INTO bills VALUES (7, 'Rent', 'monthly', 'check', 'SBI', '2026-10-01', 1, 25000, NULL);
    INSERT INTO bill_payments (bill_id, paid_on, amount, payment_method) VALUES (7, '2026-09-01', 25000, 'check');
    INSERT INTO bill_reminder_log (bill_id, due_date, days_before) VALUES (7, '2026-10-01', 3);`);
  setup.close();

  const d = db.initDb(dbPath);
  const amountCol = d.prepare('PRAGMA table_info(bills)').all().find((c) => c.name === 'amount');
  assert.equal(amountCol.notnull, 0);
  const [rent] = db.listBills(d);
  assert.deepEqual([rent.id, rent.name, rent.amount, rent.last_paid_amount], [7, 'Rent', 25000, 25000]);
  assert.equal(db.listSentBillReminders(d).size, 1);
  assert.equal(d.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.updateBill(d, 7, { name: 'Rent', paymentMethod: 'check', bankDetail: 'SBI', dueDate: '2026-10-01', amount: '' });
  assert.equal(db.listBills(d)[0].amount, null, 'blank now allowed');
  d.close();

  const again = db.initDb(dbPath); // second start: nothing left to migrate
  assert.equal(db.listBills(again).length, 1);
  again.close();
});

test('credit card is a payment method; card details are optional', () => {
  const d = db.initDb(':memory:');
  assert.equal(methodLabel('credit_card'), 'Credit card');
  const id = db.addBill(d, { ...electricity, name: 'Netflix', paymentMethod: 'credit_card', amount: 649 });
  db.recordPayment(d, id, { paidOn: '2026-10-05', amount: 649, bankDetail: 'HDFC Regalia ••5678' });
  const [bill] = db.listBills(d);
  assert.deepEqual([bill.payment_method, bill.bank_detail], ['credit_card', null]);
  assert.deepEqual(db.listPayments(d).map((p) => [p.payment_method, p.bank_detail]), [['credit_card', 'HDFC Regalia ••5678']]);
});

test('initDb upgrades bill tables that only allowed bank transfer and check, keeping everything', () => {
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), 'bills-2methods.sqlite');

  // Both tables as the previous version created them: CHECK allows only two methods.
  const setup = db.initDb(dbPath);
  const oldCheck = "CHECK (payment_method IN ('bank_transfer', 'check'))";
  setup.exec(`PRAGMA foreign_keys = OFF;
    DROP TABLE bill_payments; DROP TABLE bills;
    CREATE TABLE bills (id INTEGER PRIMARY KEY, name TEXT NOT NULL, frequency TEXT NOT NULL DEFAULT 'monthly',
      payment_method TEXT NOT NULL ${oldCheck}, bank_detail TEXT, due_date TEXT NOT NULL,
      due_day INTEGER NOT NULL, amount REAL, archived_at TEXT);
    CREATE TABLE bill_payments (id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES bills(id),
      paid_on TEXT NOT NULL, amount REAL NOT NULL, payment_method TEXT NOT NULL ${oldCheck}, bank_detail TEXT,
      for_due_date TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO bills VALUES (3, 'Rent', 'monthly', 'check', 'SBI', '2026-10-01', 1, 25000, NULL);
    INSERT INTO bill_payments (id, bill_id, paid_on, amount, payment_method, note, created_at)
      VALUES (11, 3, '2026-09-01', 25000, 'check', 'cheque 000411', '2026-09-01 10:00:00');
    INSERT INTO bill_reminder_log (bill_id, due_date, days_before) VALUES (3, '2026-10-01', 1);`);
  assert.throws(() => setup.exec("INSERT INTO bills VALUES (4, 'X', 'monthly', 'credit_card', NULL, '2026-10-01', 1, 1, NULL)"), /CHECK/);
  setup.close();

  const d = db.initDb(dbPath);
  const [p] = db.listPayments(d);
  assert.deepEqual([p.id, p.bill_id, p.note, p.created_at], [11, 3, 'cheque 000411', '2026-09-01 10:00:00']);
  assert.equal(db.listBills(d)[0].last_paid_amount, 25000);
  assert.equal(db.listSentBillReminders(d).size, 1);
  const indexes = d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bill_payments'").all().map((r) => r.name);
  assert.ok(indexes.includes('bill_payments_by_bill'), 'index recreated');

  db.updateBill(d, 3, { name: 'Rent', paymentMethod: 'credit_card', dueDate: '2026-10-01', amount: 25000 });
  db.recordPayment(d, 3, { paidOn: '2026-10-01', amount: 25000 });
  assert.equal(db.listPayments(d)[0].payment_method, 'credit_card');
  d.close();

  const again = db.initDb(dbPath); // already current: no second rebuild, nothing lost
  assert.equal(db.listPayments(again).length, 2);
  again.close();
});
