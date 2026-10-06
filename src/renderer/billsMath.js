'use strict';

// Pure date and summary logic for the Monthly bills tab. Loaded as a plain
// <script> in the renderer (window.BillsMath) and via require() in db.js and
// tests, so it must stay free of DOM and Node APIs. Dates are 'YYYY-MM-DD'.
(function (root) {
  const PortfolioMath = typeof module !== 'undefined' && module.exports
    ? require('./portfolioMath.js')
    : root.PortfolioMath;
  const { DAY_MS, dayValue, toISODate } = PortfolioMath;

  const PAYMENT_METHODS = ['bank_transfer', 'check', 'credit_card'];
  const METHOD_LABELS = { bank_transfer: 'Direct bank payment', check: 'Check deposit', credit_card: 'Credit card' };

  // Methods that take money straight out of a bank account. Card bills are left
  // out of the monthly average: the card's own bill, paid from the bank, covers them.
  const BANK_METHODS = ['bank_transfer', 'check'];
  // Works for a bill (its usual method) or a payment (the method actually used).
  const isPaidFromBank = (billOrPayment) => BANK_METHODS.includes(billOrPayment.payment_method);

  // How often a bill falls due, and how many months each step moves the due date.
  // Bi-monthly means every two months (as with bimonthly electricity bills).
  const FREQUENCIES = [
    { value: 'monthly', label: 'Monthly', months: 1 },
    { value: 'bimonthly', label: 'Every 2 months', months: 2 },
    { value: 'quarterly', label: 'Quarterly', months: 3 },
    { value: 'semiannual', label: 'Every 6 months', months: 6 },
    { value: 'annual', label: 'Yearly', months: 12 }
  ];
  const FREQUENCY_VALUES = FREQUENCIES.map((f) => f.value);
  const monthsFor = (frequency) => FREQUENCIES.find((f) => f.value === frequency)?.months ?? 1;
  const frequencyLabel = (frequency) => FREQUENCIES.find((f) => f.value === frequency)?.label ?? frequency ?? '';
  const DUE_SOON_DAYS = 7;

  function methodLabel(method) {
    return METHOD_LABELS[method] ?? method ?? '';
  }

  function daysInMonth(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  }

  /**
   * The due date one step of frequency after dueDate (monthly when not given),
   * on dueDay (1–31) where the month has it, else its last day: due on the
   * 31st → 28 Feb → 31 Mar, not stuck on the 28th. dueDay defaults to
   * dueDate's own day. Returns null for a bad date.
   */
  function nextDueDate(dueDate, dueDay, frequency = 'monthly') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dueDate ?? ''));
    if (!m) return null;
    const monthsFromZero = Number(m[1]) * 12 + (Number(m[2]) - 1) + monthsFor(frequency);
    const year = Math.floor(monthsFromZero / 12);
    const month = monthsFromZero % 12; // 0-based
    const day = Math.min(Number(dueDay) || Number(m[3]), daysInMonth(year, month));
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  /** Days until due (negative when overdue) and a level: 'overdue', 'soon' (≤7 days), or null. */
  function dueStatus(dueDate, today = new Date()) {
    const due = dayValue(dueDate);
    if (due === null) return null;
    const days = Math.round((due - dayValue(toISODate(today))) / DAY_MS);
    let level = null;
    if (days < 0) level = 'overdue';
    else if (days <= DUE_SOON_DAYS) level = 'soon';
    return { days, level };
  }

  /**
   * What a bill is expected to cost: its usual amount, or for a bill whose
   * amount varies, its last payment. null when neither is known yet.
   */
  function expectedAmount(bill) {
    for (const v of [bill.amount, bill.last_paid_amount]) {
      if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  }

  /**
   * Each active bill's most recent payment dated today or earlier (scheduled,
   * future-dated payments don't count yet), as [{ bill, payment }].
   */
  function lastCyclePayments(bills, payments, today = new Date()) {
    const todayIso = toISODate(today);
    const latest = new Map(); // bill id → payment
    for (const p of payments) {
      if (String(p.paid_on) > todayIso) continue;
      const seen = latest.get(p.bill_id);
      if (!seen || p.paid_on > seen.paid_on || (p.paid_on === seen.paid_on && p.id > seen.id)) latest.set(p.bill_id, p);
    }
    return bills
      .filter((b) => !b.archived_at && latest.has(b.id))
      .map((bill) => ({ bill, payment: latest.get(bill.id) }));
  }

  /**
   * Tiles for the bills shown: what they cost per month on average (a yearly
   * ₹12,000 bill counts as ₹1,000), what's overdue or due within a week, and
   * what was paid last cycle. Bills without a usual amount count at their last
   * payment; unknownAmountCount is those with neither.
   *
   * Paid last cycle is each bill's most recent payment, made per month by its
   * frequency (a ₹6,000 quarterly payment counts as ₹2,000), summed across bills.
   *
   * Both money figures count only what leaves the bank (direct payment or
   * check), so a card's charges aren't counted twice once the card's own bill
   * is paid: the monthly average by each bill's usual method (a forecast), and
   * last cycle by the method recorded on each payment (what happened). Card
   * amounts are reported separately (cardMonthlyEquivalent, lastCycleCardMonthly).
   */
  function summarizeBills(bills, payments, today = new Date()) {
    const active = bills.filter((b) => !b.archived_at);
    const status = (b) => dueStatus(b.due_date, today);
    const amountOf = (list) => list.reduce((sum, b) => sum + (expectedAmount(b) ?? 0), 0);
    const overdue = active.filter((b) => status(b)?.level === 'overdue');
    const dueSoon = active.filter((b) => status(b)?.level === 'soon');
    const lastCycle = lastCyclePayments(active, payments, today);
    const lastFromBank = lastCycle.filter(({ payment }) => isPaidFromBank(payment));
    const lastByCard = lastCycle.filter(({ payment }) => !isPaidFromBank(payment));
    const monthlyPaid = (list) =>
      list.reduce((sum, { bill, payment }) => sum + (Number(payment.amount) || 0) / monthsFor(bill.frequency), 0);
    const perMonth = (list) => list.reduce((sum, b) => sum + (expectedAmount(b) ?? 0) / monthsFor(b.frequency), 0);
    const fromBank = active.filter(isPaidFromBank);
    const onCard = active.filter((b) => !isPaidFromBank(b));
    return {
      billCount: active.length,
      monthlyEquivalent: perMonth(fromBank),
      unknownAmountCount: fromBank.filter((b) => expectedAmount(b) === null).length,
      cardBillCount: onCard.length,
      cardMonthlyEquivalent: perMonth(onCard),
      overdueCount: overdue.length,
      overdueAmount: amountOf(overdue),
      dueSoonCount: dueSoon.length,
      dueSoonAmount: amountOf(dueSoon),
      lastCycleMonthly: monthlyPaid(lastFromBank),
      lastCycleBillCount: lastFromBank.length,
      lastCycleCardMonthly: monthlyPaid(lastByCard),
      lastCycleCardBillCount: lastByCard.length,
      notPaidYetCount: active.length - lastCycle.length
    };
  }

  const api = {
    PAYMENT_METHODS,
    BANK_METHODS,
    FREQUENCIES,
    FREQUENCY_VALUES,
    DUE_SOON_DAYS,
    methodLabel,
    frequencyLabel,
    expectedAmount,
    isPaidFromBank,
    nextDueDate,
    dueStatus,
    lastCyclePayments,
    summarizeBills
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BillsMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
