'use strict';

// The Bills tab: bills with how often and how they're paid, a dialog to add or
// edit one, a dialog to record a payment, and the full payment history.
// Dates and totals come from BillsMath; el() and ipcErrorMessage() are shared
// from renderer.js.
(function () {
  const { PAYMENT_METHODS, FREQUENCIES, methodLabel, frequencyLabel, nextDueDate, dueStatus, summarizeBills } =
    window.BillsMath;
  const hasAmount = (v) => v !== null && v !== undefined && v !== '';
  const { toISODate } = window.PortfolioMath;

  const $ = (id) => document.getElementById(id);
  const tilesEl = $('billTiles');
  const billBody = document.querySelector('#billTable tbody');
  const paymentBody = document.querySelector('#paymentTable tbody');
  const historyBill = $('historyBill');
  const showArchived = $('showArchivedBills');

  const billModal = $('billModal');
  const billForm = $('billForm');
  const billFields = {
    name: $('billName'), frequency: $('billFrequency'), amount: $('billAmount'),
    dueDate: $('billDueDate'), method: $('billMethod'), bank: $('billBank')
  };
  const billBankHelp = $('billBankHelp');
  const billMessage = $('billMessage');

  const paymentModal = $('paymentModal');
  const paymentForm = $('paymentForm');
  const payFields = {
    date: $('payDate'), amount: $('payAmount'), method: $('payMethod'), bank: $('payBank'),
    note: $('payNote'), advance: $('payAdvance')
  };
  const payAdvanceLabel = $('payAdvanceLabel');
  const paymentMessage = $('paymentMessage');

  const money = (n) => Money.format(n, { decimals: 2 });
  const moneyWhole = (n) => Money.format(n);
  const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const formatDate = (iso) => (iso ? dateFormat.format(new Date(`${iso}T00:00:00Z`)) : '');

  let bills = [];
  let payments = [];
  let editingBillId = null; // null while adding
  let payingBill = null;

  for (const f of FREQUENCIES) billFields.frequency.append(option(f.value, f.label));
  for (const m of PAYMENT_METHODS) {
    billFields.method.append(option(m, methodLabel(m)));
    payFields.method.append(option(m, methodLabel(m)));
  }

  window.Tabs.onShow('bills', load);
  window.addEventListener('currencychange', () => {
    if (document.getElementById('billsView').hidden) return;
    renderTiles();
    renderBills();
    renderPayments();
  });
  showArchived.addEventListener('change', load);
  historyBill.addEventListener('change', renderPayments);

  async function load() {
    [bills, payments] = await Promise.all([
      window.api.listBills({ includeArchived: showArchived.checked }),
      window.api.listPayments()
    ]);
    renderTiles();
    renderBills();
    renderHistoryFilter();
    renderPayments();
  }

  // --- Tiles ---
  function renderTiles() {
    const s = summarizeBills(bills, payments);
    const tiles = [
      { label: 'Bills', value: String(s.billCount) },
      {
        label: 'Monthly from bank, avg',
        value: moneyWhole(s.monthlyEquivalent),
        note: averageNote(s)
      },
      {
        label: 'Overdue',
        value: String(s.overdueCount),
        note: s.overdueCount ? moneyWhole(s.overdueAmount) : 'nothing overdue',
        level: s.overdueCount ? 'overdue' : null
      },
      {
        label: 'Due in the next 7 days',
        value: String(s.dueSoonCount),
        note: s.dueSoonCount ? moneyWhole(s.dueSoonAmount) : ''
      },
      {
        label: 'Paid from bank this month',
        value: moneyWhole(s.paidThisMonth),
        note: paidNote(s)
      }
    ];
    tilesEl.replaceChildren(...tiles.map((t) => {
      const tile = el('div', 'tile');
      const value = el('div', 'tile-value', t.value);
      if (t.level === 'overdue') value.classList.add('tile-alert');
      tile.append(el('div', 'tile-label', t.label), value);
      if (t.note) tile.append(el('div', 'tile-note', t.note));
      return tile;
    }));
  }

  /** What the monthly average leaves out: card bills (the card's own bill covers them) and bills with no amount yet. */
  function averageNote(s) {
    const parts = [];
    if (s.cardBillCount) {
      parts.push(`${moneyWhole(s.cardMonthlyEquivalent)}/month on credit cards not included`);
    }
    if (s.unknownAmountCount) {
      parts.push(`${s.unknownAmountCount} bill${s.unknownAmountCount === 1 ? '' : 's'} with no amount yet`);
    }
    return parts.length ? parts.join(' · ') : 'direct payments and checks';
  }

  function paidNote(s) {
    const count = `${s.paymentsThisMonth} payment${s.paymentsThisMonth === 1 ? '' : 's'}`;
    return s.cardPaymentsThisMonth
      ? `${count} · ${moneyWhole(s.paidByCardThisMonth)} on credit cards not included`
      : count;
  }

  // --- Bills table ---
  function renderBills() {
    if (bills.length === 0) {
      billBody.replaceChildren(emptyRow(7, showArchived.checked ? 'No bills.' : 'No bills yet. Use "+ Add bill" to start tracking one.'));
      return;
    }
    billBody.replaceChildren(...bills.map((bill) => {
      const tr = el('tr');
      const archived = Boolean(bill.archived_at);
      if (archived) tr.classList.add('archived');

      const name = el('td', null, bill.name);
      if (archived) name.append(el('span', 'bill-sub', 'Archived'));

      const paidBy = el('td', null, methodLabel(bill.payment_method));
      if (bill.bank_detail) paidBy.append(el('span', 'bill-sub', bill.bank_detail));

      const due = el('td', null, formatDate(bill.due_date));
      if (!archived) appendDueBadge(due, bill.due_date);

      const last = el('td', 'num');
      if (bill.last_paid_on) {
        last.append(money(bill.last_paid_amount), el('span', 'bill-sub', formatDate(bill.last_paid_on)));
      } else {
        last.append(el('span', 'tax-unknown', 'Not paid yet'));
      }

      const actions = el('td', 'actions');
      if (archived) {
        actions.append(button('Restore', 'restore-btn small', async () => {
          await window.api.restoreBill(bill.id);
          await load();
        }));
      } else {
        actions.append(
          button('Record payment', 'small', () => openPaymentModal(bill)),
          button('History', 'secondary small', () => showHistoryFor(bill.id)),
          button('Edit', 'secondary small', () => openBillModal(bill)),
          button('Archive', 'secondary small', () => archive(bill))
        );
      }

      const usual = hasAmount(bill.amount)
        ? el('td', 'num', money(bill.amount))
        : el('td', 'num tax-unknown', 'Varies');
      tr.append(name, el('td', null, frequencyLabel(bill.frequency)), paidBy, due, usual, last, actions);
      return tr;
    }));
  }

  /** Overdue or due within a week. Always icon + text, not colour alone. */
  function appendDueBadge(td, dueDate) {
    const status = dueStatus(dueDate);
    if (!status?.level) return;
    const { days, level } = status;
    const text = level === 'overdue'
      ? `⚠ ${-days}d overdue`
      : days === 0 ? '◷ Today' : `◷ ${days}d`;
    const badge = el('span', `badge ${level}`, text);
    badge.title = level === 'overdue'
      ? `Was due ${-days} day${days === -1 ? '' : 's'} ago`
      : `Due in ${days} day${days === 1 ? '' : 's'}`;
    td.append(badge);
  }

  async function archive(bill) {
    if (!confirm(`Archive "${bill.name}"? It's hidden from the list but its payment history is kept. You can restore it via "Show archived".`)) return;
    await window.api.archiveBill(bill.id);
    await load();
  }

  // --- Payment history ---
  function renderHistoryFilter() {
    const current = historyBill.value;
    const names = new Map(payments.map((p) => [String(p.bill_id), p.bill_name]));
    for (const b of bills) names.set(String(b.id), b.name);
    const sorted = [...names].sort((a, b) => a[1].localeCompare(b[1]));
    historyBill.replaceChildren(option('', 'All bills'), ...sorted.map(([id, name]) => option(id, name)));
    historyBill.value = names.has(current) ? current : '';
  }

  function showHistoryFor(billId) {
    historyBill.value = String(billId);
    renderPayments();
    historyBill.closest('section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderPayments() {
    const shown = historyBill.value ? payments.filter((p) => String(p.bill_id) === historyBill.value) : payments;
    if (shown.length === 0) {
      paymentBody.replaceChildren(emptyRow(8, 'No payments recorded yet.'));
      return;
    }
    paymentBody.replaceChildren(...shown.map((p) => {
      const tr = el('tr');
      const remove = button('Delete', 'secondary small', async () => {
        if (!confirm(`Delete the ${money(p.amount)} payment for ${p.bill_name} on ${formatDate(p.paid_on)}? This can't be undone. The bill's due date isn't changed.`)) return;
        await window.api.deletePayment(p.id);
        await load();
      });
      tr.append(
        el('td', null, formatDate(p.paid_on)),
        el('td', null, p.bill_name),
        el('td', 'num', money(p.amount)),
        el('td', null, methodLabel(p.payment_method)),
        el('td', 'lookup-cell', p.bank_detail ?? ''),
        el('td', 'lookup-cell', formatDate(p.for_due_date)),
        el('td', 'lookup-cell', p.note ?? ''),
        cellWith(remove, 'actions')
      );
      return tr;
    }));
  }

  // --- Add / edit bill dialog ---
  $('addBillBtn').addEventListener('click', () => openBillModal(null));

  function openBillModal(bill) {
    editingBillId = bill?.id ?? null;
    $('billModalTitle').textContent = bill ? `Edit ${bill.name}` : 'Add bill';
    billFields.name.value = bill?.name ?? '';
    billFields.frequency.value = bill?.frequency ?? 'monthly';
    billFields.amount.value = bill?.amount ?? '';
    billFields.dueDate.value = bill?.due_date ?? '';
    billFields.method.value = bill?.payment_method ?? 'bank_transfer';
    billFields.bank.value = bill?.bank_detail ?? '';
    updateBankHelp();
    billMessage.hidden = true;
    billModal.classList.remove('hidden');
    billFields.name.focus();
  }

  function updateBankHelp() {
    billBankHelp.textContent = {
      check: 'Required: the bank and account the check is deposited into.',
      credit_card: 'Optional: which card, e.g. HDFC Regalia ••5678.',
      bank_transfer: 'Optional: the account it’s paid from.'
    }[billFields.method.value];
  }
  billFields.method.addEventListener('change', updateBankHelp);

  billForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const bill = {
      name: billFields.name.value,
      frequency: billFields.frequency.value,
      amount: billFields.amount.value,
      dueDate: billFields.dueDate.value,
      paymentMethod: billFields.method.value,
      bankDetail: billFields.bank.value
    };
    try {
      if (editingBillId === null) await window.api.addBill(bill);
      else await window.api.updateBill(editingBillId, bill);
    } catch (err) {
      showMessage(billMessage, err);
      return;
    }
    closeModal(billModal);
    await load();
  });
  $('billCancelBtn').addEventListener('click', () => closeModal(billModal));

  // --- Record payment dialog ---
  function openPaymentModal(bill) {
    payingBill = bill;
    $('paymentModalTitle').textContent = `Record payment · ${bill.name}`;
    const usual = hasAmount(bill.amount) ? `usually ${money(bill.amount)}` : 'amount varies';
    $('paymentModalSub').textContent =
      `Due ${formatDate(bill.due_date)}, ${usual} (${frequencyLabel(bill.frequency).toLowerCase()}). ` +
      'Saved as a new entry in the payment history.';
    payFields.date.value = toISODate(new Date());
    // Start from the usual amount, else the last payment; either way it's what was paid this time that's saved.
    if (hasAmount(bill.amount)) {
      payFields.amount.value = bill.amount;
      $('payAmountHelp').textContent = 'The usual amount. Change it if this period’s bill was different.';
    } else if (hasAmount(bill.last_paid_amount)) {
      payFields.amount.value = bill.last_paid_amount;
      $('payAmountHelp').textContent = `Last time you paid ${money(bill.last_paid_amount)}. Enter this period’s amount.`;
    } else {
      payFields.amount.value = '';
      $('payAmountHelp').textContent = 'Enter the amount paid for this period.';
    }
    payFields.method.value = bill.payment_method;
    payFields.bank.value = bill.bank_detail ?? '';
    payFields.note.value = '';
    payFields.advance.checked = true;
    payAdvanceLabel.textContent = `Move the next due date to ${formatDate(nextDueDate(bill.due_date, bill.due_day, bill.frequency))}`;
    paymentMessage.hidden = true;
    paymentModal.classList.remove('hidden');
    payFields.amount.focus();
  }

  paymentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payment = {
      paidOn: payFields.date.value,
      amount: payFields.amount.value,
      paymentMethod: payFields.method.value,
      bankDetail: payFields.bank.value,
      note: payFields.note.value
    };
    try {
      await window.api.recordPayment(payingBill.id, payment, { advanceDueDate: payFields.advance.checked });
    } catch (err) {
      showMessage(paymentMessage, err);
      return;
    }
    closeModal(paymentModal);
    await load();
  });
  $('paymentCancelBtn').addEventListener('click', () => closeModal(paymentModal));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const modal of [billModal, paymentModal]) if (!modal.classList.contains('hidden')) closeModal(modal);
  });

  // --- Small helpers ---
  function closeModal(modal) {
    modal.classList.add('hidden');
  }

  function showMessage(target, err) {
    target.textContent = ipcErrorMessage(err);
    target.hidden = false;
  }

  function option(value, label) {
    const opt = el('option', null, label);
    opt.value = value;
    return opt;
  }

  function button(label, className, onClick) {
    const b = el('button', className, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function cellWith(child, className) {
    const td = el('td', className);
    td.append(child);
    return td;
  }

  function emptyRow(columns, text) {
    const tr = el('tr');
    const td = el('td', 'tax-unknown', text);
    td.colSpan = columns;
    tr.append(td);
    return tr;
  }
})();
