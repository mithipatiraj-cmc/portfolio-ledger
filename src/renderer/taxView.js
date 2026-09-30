'use strict';

// The Tax projection tab. The numbers come from TaxMath; el() and
// ipcErrorMessage() are shared from renderer.js.
(function () {
  const { DEFAULT_REBATE_LIMIT, financialYearOf, fyLabel, projectTax } = window.TaxMath;
  const { incomeTreatmentLabel } = window.PolicyFilter;

  const yearSelect = document.getElementById('taxYear');
  const rebateInput = document.getElementById('taxRebateLimit');
  const tilesEl = document.getElementById('taxTiles');
  const holderTable = document.getElementById('taxHolderTable');
  const holderBody = holderTable.querySelector('tbody');
  const policyBody = document.querySelector('#taxPolicyTable tbody');
  const policiesTitle = document.getElementById('taxPoliciesTitle');
  const missingEl = document.getElementById('taxMissing');

  const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  const SAVE_DELAY_MS = 400;

  let policies = [];
  let settings = { rebateLimit: null, holders: {} };
  let fyStartYear = financialYearOf();
  let saveTimer = null;
  const holderRows = new Map(); // holder name → { tr, cells } so typing only updates the computed cells

  window.Tabs.onShow('tax', load);

  // --- Data ---
  async function load() {
    const [rows, saved] = await Promise.all([window.api.listPolicies(), window.api.getTaxSettings()]);
    policies = rows;
    settings = { rebateLimit: saved?.rebateLimit ?? null, holders: saved?.holders ?? {} };
    rebateInput.value = rebateLimit();
    renderYears();
    render();
  }

  const rebateLimit = () => settings.rebateLimit ?? DEFAULT_REBATE_LIMIT;
  const project = () => projectTax(policies, { fyStartYear, holders: settings.holders, rebateLimit: rebateLimit() });

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await window.api.saveTaxSettings(settings);
      } catch (err) {
        alert(ipcErrorMessage(err));
      }
    }, SAVE_DELAY_MS);
  }

  const numberOrNull = (text) => (text.trim() === '' ? null : Number(text));

  // --- Controls ---
  /** Last year through the latest maturity (at most 10 years ahead), so every year with interest can be picked. */
  function renderYears() {
    const current = financialYearOf();
    let last = current;
    for (const p of policies) {
      if (!p.deleted_at && p.maturity_date) last = Math.max(last, financialYearOf(new Date(`${p.maturity_date}T00:00`)));
    }
    last = Math.min(last, current + 10);
    const options = [];
    for (let y = current - 1; y <= last; y++) {
      const opt = el('option', null, fyLabel(y) + (y === current ? ' (current)' : ''));
      opt.value = String(y);
      options.push(opt);
    }
    yearSelect.replaceChildren(...options);
    yearSelect.value = String(fyStartYear);
  }

  yearSelect.addEventListener('change', () => {
    fyStartYear = Number(yearSelect.value);
    render();
  });

  rebateInput.addEventListener('input', () => {
    settings.rebateLimit = numberOrNull(rebateInput.value);
    updateTotals();
    scheduleSave();
  });

  // --- Rendering ---
  function render() {
    const result = project();
    renderHolders(result);
    renderPolicies(result);
    updateTotals(result);
  }

  /** Recalculate and refresh the numbers without rebuilding the inputs being typed in. */
  function updateTotals(result = project()) {
    renderTiles(result);
    for (const h of result.holders) {
      const row = holderRows.get(h.name);
      if (row) fillHolderCells(row.cells, h);
    }
    renderHolderFooter(result);
  }

  function renderTiles(result) {
    const sum = (key) => result.holders.reduce((s, h) => s + h[key], 0);
    const taxable = sum('taxableInterest');
    const exempt = sum('exemptInterest');
    const needRate = result.holders.filter((h) => h.tax === null).length;
    const tax = result.holders.reduce((s, h) => s + (h.tax ?? 0), 0);
    const tiles = [
      { label: `Interest in ${fyLabel(fyStartYear)}`, value: rupees.format(taxable + exempt) },
      { label: 'Taxable interest', value: rupees.format(taxable) },
      { label: 'Tax-exempt interest', value: rupees.format(exempt) },
      {
        label: 'Estimated tax on interest',
        value: rupees.format(tax),
        note: needRate ? `${needRate} holder(s) over the limit need a tax rate` : 'across all holders'
      }
    ];
    tilesEl.replaceChildren(...tiles.map((t) => {
      const tile = el('div', 'tile');
      tile.append(el('div', 'tile-label', t.label), el('div', 'tile-value', t.value));
      if (t.note) tile.append(el('div', 'tile-note', t.note));
      return tile;
    }));
  }

  function renderHolders(result) {
    holderRows.clear();
    if (result.holders.length === 0) {
      holderBody.replaceChildren(emptyRow(7, `No interest earned in ${fyLabel(fyStartYear)}.`));
      return;
    }
    holderBody.replaceChildren(...result.holders.map((h) => {
      const tr = el('tr');
      const saved = settings.holders[h.name] ?? {};
      const otherIncome = numberInput(saved.otherIncome, { step: 10000, label: `Other income for ${h.name}` });
      const rate = numberInput(saved.rate, { step: 0.1, max: 100, label: `Tax rate for ${h.name}`, className: 'rate' });
      const onInput = () => {
        settings.holders[h.name] = { otherIncome: numberOrNull(otherIncome.value), rate: numberOrNull(rate.value) };
        updateTotals();
        scheduleSave();
      };
      otherIncome.addEventListener('input', onInput);
      rate.addEventListener('input', onInput);

      const cells = {
        taxable: el('td', 'num'),
        exempt: el('td', 'num'),
        total: el('td', 'num'),
        tax: el('td', 'num')
      };
      tr.append(el('td', null, h.name), cellWith(otherIncome), cellWith(rate), cells.taxable, cells.exempt, cells.total, cells.tax);
      holderRows.set(h.name, { tr, cells });
      fillHolderCells(cells, h);
      return tr;
    }));
  }

  function fillHolderCells(cells, h) {
    cells.taxable.textContent = rupees.format(h.taxableInterest);
    cells.exempt.textContent = rupees.format(h.exemptInterest);
    cells.total.textContent = rupees.format(h.totalIncome);
    cells.tax.className = 'num';
    if (h.withinLimit) {
      cells.tax.textContent = `₹0 · within ${rupees.format(rebateLimit())}`;
      cells.tax.classList.add('tax-within');
    } else if (h.tax === null) {
      cells.tax.textContent = 'Enter a tax rate';
      cells.tax.classList.add('tax-unknown');
    } else {
      cells.tax.textContent = rupees.format(h.tax);
    }
  }

  function renderHolderFooter(result) {
    holderTable.querySelector('tfoot')?.remove();
    if (result.holders.length < 2) return;
    const sum = (key) => result.holders.reduce((s, h) => s + (h[key] ?? 0), 0);
    const tfoot = el('tfoot');
    const tr = el('tr');
    tr.append(
      el('td', null, 'Total'), el('td'), el('td'),
      el('td', 'num', rupees.format(sum('taxableInterest'))),
      el('td', 'num', rupees.format(sum('exemptInterest'))),
      el('td'),
      el('td', 'num', rupees.format(sum('tax')))
    );
    tfoot.append(tr);
    holderTable.append(tfoot);
  }

  function renderPolicies(result) {
    policiesTitle.textContent = `Interest by policy · ${fyLabel(fyStartYear)}`;
    const rows = [...result.rows].sort((a, b) =>
      a.holder.localeCompare(b.holder) || String(a.policy.policy_number).localeCompare(String(b.policy.policy_number), undefined, { numeric: true }));

    if (rows.length === 0) {
      policyBody.replaceChildren(emptyRow(6, `No policy earns interest in ${fyLabel(fyStartYear)}.`));
    } else {
      policyBody.replaceChildren(...rows.map(({ policy, holder, interest, exempt }) => {
        const tr = el('tr');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = exempt;
        box.setAttribute('aria-label', `${policy.policy_number} is tax-exempt`);
        box.addEventListener('change', () => setExempt(policy, box));
        const income = el('td', 'lookup-cell', incomeTreatmentLabel(policy.income_treatment));
        if (!policy.income_treatment) income.title = 'Not recorded, so counted as cumulative';
        tr.append(
          el('td', null, policy.policy_number ?? ''),
          el('td', 'lookup-cell', holder),
          el('td', null, policy.instrument ?? ''),
          income,
          el('td', 'num', rupees.format(interest)),
          cellWith(box, null)
        );
        if (exempt) tr.classList.add('selected');
        return tr;
      }));
    }

    missingEl.hidden = result.missingData.length === 0;
    missingEl.textContent = result.missingData.length
      ? `Left out for missing data (needs amount, ROI, maturity date and a start date or term): ` +
        result.missingData.map((p) => p.policy_number).join(', ')
      : '';
  }

  async function setExempt(policy, box) {
    const treatment = box.checked ? 'exempt' : 'taxable';
    try {
      await window.api.setTaxTreatment([policy.id], treatment);
      policy.tax_treatment = treatment;
    } catch (err) {
      box.checked = !box.checked;
      alert(ipcErrorMessage(err));
    }
    render();
  }

  // --- Small DOM helpers ---
  function numberInput(value, { step, max, label, className }) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    if (max !== undefined) input.max = String(max);
    input.step = String(step);
    input.inputMode = 'decimal';
    input.value = value ?? '';
    input.setAttribute('aria-label', label);
    if (className) input.className = className;
    return input;
  }

  function cellWith(child, className = 'num') {
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
