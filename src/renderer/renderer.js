'use strict';

const { FILTERABLE_FIELDS, filterPolicies } = window.PolicyFilter;
const {
  CRITICAL_DAYS,
  roiPercent,
  maturityValue,
  maturityStatus,
  summarizePolicies,
  sortPolicies,
  allocationBy
} = window.PortfolioMath;

const tableBody = document.getElementById('policyTableBody');
const tableHead = document.querySelector('#policyTable thead');
const summaryEl = document.getElementById('summary');
const addRowBtn = document.getElementById('addRowBtn');
const importBtn = document.getElementById('importBtn');
const filterField = document.getElementById('filterField');
const filterQuery = document.getElementById('filterQuery');
const clearFilterBtn = document.getElementById('clearFilterBtn');
const filterCount = document.getElementById('filterCount');
const mappingModal = document.getElementById('mappingModal');
const mappingRows = document.getElementById('mappingRows');
const mappingCancelBtn = document.getElementById('mappingCancelBtn');
const mappingCommitBtn = document.getElementById('mappingCommitBtn');
const showDeleted = document.getElementById('showDeleted');
const sheetPicker = document.getElementById('sheetPicker');
const sheetSelect = document.getElementById('sheetSelect');
const allocationChart = document.getElementById('allocationChart');
const allocationTitle = document.getElementById('allocationTitle');
const chartTooltip = document.getElementById('chartTooltip');
const backupBtn = document.getElementById('backupBtn');
const restoreBtn = document.getElementById('restoreBtn');
const themeSelect = document.getElementById('themeSelect');

const EDITABLE_COLUMNS = [
  { key: 'policy_number', dbField: 'policy_number' },
  { key: 'instrument', dbField: 'instrument' },
  { key: 'institution', dbField: null }, // lookup field — read-only inline for v1, edited via import/re-entry
  { key: 'holder', dbField: null },
  { key: 'nominee', dbField: null },
  { key: 'amount_invested', dbField: 'amount_invested', numeric: true, format: formatAmountInput },
  { key: 'roi', dbField: 'roi', numeric: true, format: formatRoiInput },
  { key: 'maturity_date', dbField: 'maturity_date', badge: true },
  { key: 'maturity_value', dbField: null, render: renderMaturityValueCell }
];

const UPCOMING_DAYS = CRITICAL_DAYS;

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inrCompact = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 2
});

let allPolicies = []; // last full fetch, before any filter is applied
let sortState = { key: 'maturity_date', direction: 'asc' };
let allocationGroup = 'institution';

// --- Filter bar setup ---
for (const opt of FILTERABLE_FIELDS) {
  const el = document.createElement('option');
  el.value = opt.value;
  el.textContent = opt.label;
  filterField.appendChild(el);
}

function applyFilterAndRender() {
  const filtered = filterPolicies(allPolicies, filterField.value, filterQuery.value);
  renderSummary(summarizePolicies(filtered, { upcomingWithinDays: UPCOMING_DAYS }));
  renderAllocation(filtered);
  renderTable(sortPolicies(filtered, sortState.key, sortState.direction));
  renderSortIndicators();
  filterCount.textContent = filterQuery.value.trim()
    ? `${filtered.length} of ${allPolicies.length} shown`
    : '';
}

filterField.addEventListener('change', applyFilterAndRender);
filterQuery.addEventListener('input', applyFilterAndRender);
clearFilterBtn.addEventListener('click', () => {
  filterQuery.value = '';
  filterField.value = 'all';
  applyFilterAndRender();
});

showDeleted.addEventListener('change', () => refresh());

async function refresh() {
  allPolicies = await window.api.listPolicies({ includeDeleted: showDeleted.checked });
  applyFilterAndRender();
}

// --- Sorting: click a header to sort; click again to reverse ---
tableHead.addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  sortState = sortState.key === key
    ? { key, direction: sortState.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: defaultDirection(key) };
  applyFilterAndRender();
});

/** Numbers start largest-first; text and dates start A→Z / soonest-first. */
function defaultDirection(key) {
  return ['amount_invested', 'roi', 'maturity_value'].includes(key) ? 'desc' : 'asc';
}

function renderSortIndicators() {
  for (const th of tableHead.querySelectorAll('th[data-sort]')) {
    if (th.dataset.sort === sortState.key) {
      th.setAttribute('aria-sort', sortState.direction === 'asc' ? 'ascending' : 'descending');
    } else {
      th.removeAttribute('aria-sort');
    }
  }
}

// --- Summary tiles: cover only the rows currently shown, so they follow the filter ---
function renderSummary(summary) {
  const tiles = [
    { label: 'Accounts', value: summary.accountCount.toLocaleString('en-IN') },
    { label: 'Total invested', value: inrCompact.format(summary.totalInvested), title: inr.format(summary.totalInvested) },
    {
      label: 'Weighted avg return',
      value: summary.weightedAvgRoi === null ? '—' : `${summary.weightedAvgRoi.toFixed(2)}%`,
      note: 'weighted by amount invested'
    },
    {
      label: 'Expected at maturity',
      value: inrCompact.format(summary.expectedAtMaturity),
      title: inr.format(summary.expectedAtMaturity),
      note: summary.missingMaturityValue ? `${summary.missingMaturityValue} without enough data` : ''
    },
    { label: `Maturing in ${UPCOMING_DAYS} days`, value: String(summary.upcomingCount) }
  ];

  summaryEl.replaceChildren(...tiles.map((t) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    if (t.title) tile.title = t.title;
    tile.append(
      el('div', 'tile-label', t.label),
      el('div', 'tile-value', t.value)
    );
    if (t.note) tile.append(el('div', 'tile-note', t.note));
    return tile;
  }));
}

// --- Allocation chart: horizontal bars, one series, largest first ---
document.querySelectorAll('.segmented .seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    allocationGroup = btn.dataset.group;
    document.querySelectorAll('.segmented .seg').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    applyFilterAndRender();
  });
});

function renderAllocation(policies) {
  const groupLabel = allocationGroup === 'holder' ? 'holder' : 'institution';
  allocationTitle.textContent = `Amount invested by ${groupLabel}`;
  const groups = allocationBy(policies, allocationGroup);
  hideTooltip();

  if (groups.length === 0) {
    allocationChart.replaceChildren(el('div', 'chart-empty', 'No invested amounts to chart for the policies shown.'));
    return;
  }

  const max = groups[0].amount;
  allocationChart.replaceChildren(...groups.map((g) => {
    const row = el('div', 'bar-row');
    if (g.isOther) row.classList.add('other');

    const bar = el('div', 'bar');
    // Leave room for the value label beside the longest bar.
    bar.style.width = `calc((100% - 150px) * ${g.amount / max})`;

    const track = el('div', 'bar-track');
    track.append(bar, el('span', 'bar-value', `${inrCompact.format(g.amount)} · ${(g.share * 100).toFixed(1)}%`));
    row.append(el('div', 'bar-label', g.label), track);

    const tip = [
      g.label,
      inr.format(g.amount),
      `${(g.share * 100).toFixed(1)}% of total · ${g.count} ${g.count === 1 ? 'policy' : 'policies'}`
    ];
    row.addEventListener('mouseenter', (e) => showTooltip(tip, e));
    row.addEventListener('mousemove', (e) => positionTooltip(e));
    row.addEventListener('mouseleave', hideTooltip);
    return row;
  }));
}

function showTooltip([title, ...lines], e) {
  chartTooltip.replaceChildren(el('strong', null, title), ...lines.map((l) => el('div', null, l)));
  chartTooltip.hidden = false;
  positionTooltip(e);
}

function positionTooltip(e) {
  const pad = 14;
  const { offsetWidth: w, offsetHeight: h } = chartTooltip;
  const x = Math.min(e.clientX + pad, window.innerWidth - w - 8);
  const y = e.clientY + pad + h > window.innerHeight ? e.clientY - h - pad : e.clientY + pad;
  chartTooltip.style.left = `${x}px`;
  chartTooltip.style.top = `${y}px`;
}

function hideTooltip() {
  chartTooltip.hidden = true;
}

// --- Table ---
function renderTable(policies) {
  tableBody.innerHTML = '';
  for (const row of policies) {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;
    const isDeleted = Boolean(row.deleted_at);
    if (isDeleted) {
      tr.classList.add('deleted');
      tr.title = `Deleted ${row.deleted_at} (UTC)`;
    }

    for (const col of EDITABLE_COLUMNS) {
      const td = document.createElement('td');
      if (col.numeric || col.key === 'maturity_value') td.classList.add('num');

      if (col.render) {
        col.render(td, row);
      } else {
        const value = col.format ? col.format(row[col.key]) : row[col.key] ?? '';
        if (col.dbField && !isDeleted) {
          // Editable text lives in its own span so badges beside it aren't part of the edit.
          const span = el('span', 'cell-edit', value);
          span.contentEditable = 'true';
          span.addEventListener('blur', () => onCellEdit(row, col, span));
          td.appendChild(span);
          td.addEventListener('click', (e) => { if (e.target === td) span.focus(); });
        } else {
          // Lookup-derived fields (institution/holder/nominee) and deleted rows: plain text.
          td.textContent = value;
          if (!col.dbField) td.classList.add('lookup-cell');
        }
        if (col.badge && !isDeleted) appendMaturityBadge(td, row.maturity_date);
      }
      tr.appendChild(td);
    }

    const actionTd = document.createElement('td');
    const actionBtn = document.createElement('button');
    if (isDeleted) {
      actionBtn.textContent = 'Restore';
      actionBtn.className = 'restore-btn';
      actionBtn.addEventListener('click', () => onRestore(row.id));
    } else {
      actionBtn.textContent = 'Delete';
      actionBtn.className = 'secondary';
      actionBtn.addEventListener('click', () => onDelete(row.id));
    }
    actionTd.appendChild(actionBtn);
    tr.appendChild(actionTd);

    tableBody.appendChild(tr);
  }
}

/** ≤30 days: critical, ≤60 days: warning, past: matured. Always icon + text, not colour alone. */
function appendMaturityBadge(td, maturityDate) {
  const status = maturityStatus(maturityDate);
  if (!status?.level) return;
  const { days, level } = status;
  const text = {
    matured: 'Matured',
    critical: days === 0 ? '⚠ Today' : `⚠ ${days}d`,
    warning: `◷ ${days}d`
  }[level];
  const badge = el('span', `badge ${level}`, text);
  badge.title = level === 'matured'
    ? `Matured ${-days} day${days === -1 ? '' : 's'} ago`
    : `Matures in ${days} day${days === 1 ? '' : 's'}`;
  td.appendChild(badge);
}

function renderMaturityValueCell(td, row) {
  const { value, calculated, calc } = maturityValue(row);
  if (value === null) {
    td.textContent = '—';
    td.title = 'Not enough data to calculate (needs amount, ROI, and dates or term).';
    return;
  }
  td.textContent = (calculated ? '≈ ' : '') + inr.format(value);
  if (calculated) td.classList.add('calculated');
  if (calc) {
    const how = `${calc.rate.toFixed(2)}% compounded ${calc.periodsPerYear}×/yr over ${calc.years.toFixed(2)} yrs`;
    td.title = calculated
      ? `Calculated: ${how}`
      : `Recorded amount. Calculated from the rate: ${inr.format(calc.value)} (${how})`;
  } else {
    td.title = 'Recorded amount';
  }
}

/** 997154 → "9,97,154". Commas are stripped again when an edit is saved. */
function formatAmountInput(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(v);
}

/** Shown as a percentage (6.85) whether stored as 0.0685 or 6.85. */
function formatRoiInput(v) {
  const pct = roiPercent(v);
  return pct === null ? '' : String(Number(pct.toFixed(4)));
}

async function onCellEdit(row, col, span) {
  let value = span.textContent.trim();
  if (value === (col.format ? col.format(row[col.key]) : String(row[col.key] ?? ''))) return; // unchanged
  if (col.numeric) {
    const parsed = Number(value.replace(/[,₹%\s]/g, ''));
    value = value === '' || !Number.isFinite(parsed) ? null : parsed;
  } else if (value === '') {
    value = null;
  }
  try {
    await window.api.updatePolicy(row.id, { [col.dbField]: value });
  } catch (err) {
    alert(ipcErrorMessage(err)); // refresh below puts the previous value back
  }
  await refresh();
}

/** Electron wraps main-process errors as "Error invoking remote method '…': Error: <msg>" — keep just <msg>. */
function ipcErrorMessage(err) {
  return String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function onDelete(id) {
  if (!confirm('Delete this policy? You can restore it later via "Show deleted".')) return;
  await window.api.deletePolicy(id);
  await refresh();
}

async function onRestore(id) {
  await window.api.restorePolicy(id);
  await refresh();
}

addRowBtn.addEventListener('click', async () => {
  await window.api.addPolicy({
    policyNumber: `NEW-${Date.now()}`,
    institution: 'Unnamed',
    holder: 'Unnamed',
    nominee: 'Unnamed',
    amountInvested: 0,
    roi: 0,
    maturityDate: new Date().toISOString().slice(0, 10)
  });
  await refresh();
});

// --- Backup & restore ---
backupBtn.addEventListener('click', async () => {
  try {
    const result = await window.api.backupDb();
    if (result) alert(`Backup saved to:\n${result.filePath}`);
  } catch (err) {
    alert(`Backup failed: ${ipcErrorMessage(err)}`);
  }
});

restoreBtn.addEventListener('click', async () => {
  try {
    const result = await window.api.restoreDb();
    if (!result) return; // cancelled
    if (!result.ok) {
      alert(result.error);
      return;
    }
    alert(`Restored ${result.policyCount} policies.\n\nYour previous data was saved to:\n${result.safetyPath}`);
    await refresh();
  } catch (err) {
    alert(`Restore failed: ${ipcErrorMessage(err)}`);
  }
});

// --- Theme: System (follows the OS) / Light / Dark, remembered on this machine ---
function readTheme() {
  try {
    return localStorage.getItem('theme') || 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

themeSelect.value = readTheme();
themeSelect.addEventListener('change', () => {
  applyTheme(themeSelect.value);
  try {
    localStorage.setItem('theme', themeSelect.value);
  } catch {}
});

// --- Email reminders dialog ---
const remindersBtn = document.getElementById('remindersBtn');
const remindersModal = document.getElementById('remindersModal');
const remindersForm = document.getElementById('remindersForm');
const remEnabled = document.getElementById('remEnabled');
const remRecipient = document.getElementById('remRecipient');
const remGmailUser = document.getElementById('remGmailUser');
const remPassword = document.getElementById('remPassword');
const remDays = document.getElementById('remDays');
const remHour = document.getElementById('remHour');
const remStatus = document.getElementById('remStatus');
const remMessage = document.getElementById('remMessage');
const remFields = remindersForm.querySelector('.form-grid');

for (let h = 0; h < 24; h++) {
  const label = `${String(h).padStart(2, '0')}:00`;
  remHour.appendChild(Object.assign(document.createElement('option'), { value: String(h), textContent: label }));
}

function reminderFormInput() {
  return {
    enabled: remEnabled.checked,
    recipient: remRecipient.value,
    gmailUser: remGmailUser.value,
    appPassword: remPassword.value,
    daysBefore: remDays.value,
    checkHour: Number(remHour.value)
  };
}

function showReminderMessage(text, isError = false) {
  remMessage.textContent = text;
  remMessage.classList.toggle('error', isError);
  remMessage.hidden = !text;
}

function renderReminderSettings({ prefs, lastCheck, schedule }) {
  remEnabled.checked = prefs.enabled;
  remRecipient.value = prefs.recipient;
  remGmailUser.value = prefs.gmailUser;
  remPassword.value = '';
  remPassword.placeholder = prefs.hasPassword ? 'Saved — leave blank to keep' : '';
  remDays.value = prefs.daysBefore.join(', ');
  remHour.value = String(prefs.checkHour);
  remFields.classList.toggle('disabled', !prefs.enabled);
  renderReminderStatus({ prefs, lastCheck, schedule });
}

function renderReminderStatus({ prefs, lastCheck, schedule }) {
  const lines = [];
  if (prefs.enabled && schedule) lines.push(`Background check: ${schedule.description}.`);
  if (lastCheck) {
    const when = new Date(lastCheck.at).toLocaleString();
    lines.push(lastCheck.ok
      ? `Last check ${when}: ${lastCheck.sent ? `emailed ${lastCheck.sent} reminder(s)` : 'nothing due'}.`
      : `Last check ${when} failed: ${lastCheck.error}`);
  }
  remStatus.textContent = lines.join(' ');
}

remEnabled.addEventListener('change', () => remFields.classList.toggle('disabled', !remEnabled.checked));

remindersBtn.addEventListener('click', async () => {
  showReminderMessage('');
  renderReminderSettings(await window.api.getReminderSettings());
  remindersModal.classList.remove('hidden');
});

document.getElementById('remCancelBtn').addEventListener('click', () => remindersModal.classList.add('hidden'));

/** Run an action with the dialog's buttons disabled, showing its outcome inline. */
async function reminderAction(button, busyText, action) {
  const buttons = remindersForm.querySelectorAll('button');
  const label = button.textContent;
  buttons.forEach((b) => { b.disabled = true; });
  button.textContent = busyText;
  showReminderMessage('');
  try {
    await action();
  } catch (err) {
    showReminderMessage(ipcErrorMessage(err), true);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    button.textContent = label;
  }
}

remindersForm.addEventListener('submit', (e) => {
  e.preventDefault();
  reminderAction(document.getElementById('remSaveBtn'), 'Saving…', async () => {
    renderReminderSettings(await window.api.saveReminderSettings(reminderFormInput()));
    remindersModal.classList.add('hidden');
  });
});

document.getElementById('remTestBtn').addEventListener('click', (e) => {
  reminderAction(e.currentTarget, 'Sending…', async () => {
    await window.api.sendTestReminder(reminderFormInput());
    showReminderMessage(`Test email sent to ${remRecipient.value.trim()}. Check your inbox (and spam).`);
  });
});

document.getElementById('remCheckBtn').addEventListener('click', (e) => {
  reminderAction(e.currentTarget, 'Checking…', async () => {
    const result = await window.api.checkRemindersNow();
    if (!result.ran) {
      showReminderMessage('Reminders are off. Turn them on and save first.', true);
    } else if (!result.ok) {
      showReminderMessage(`Check failed: ${result.error}`, true);
    } else {
      showReminderMessage(result.sent ? `Emailed ${result.sent} reminder(s).` : 'Nothing due right now.');
    }
    renderReminderStatus(await window.api.getReminderSettings()); // keep any unsaved form edits
  });
});

// --- Excel import ---
importBtn.addEventListener('click', async () => {
  const preview = await window.api.importPreview();
  if (!preview) return; // user cancelled the file picker
  openMappingModal(preview);
});

let currentImportFilePath = null;
let currentImportSheet = null;

function openMappingModal(preview) {
  currentImportFilePath = preview.filePath;

  // Sheet picker: only shown when the workbook has more than one sheet.
  sheetSelect.innerHTML = '';
  for (const name of preview.sheetNames) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sheetSelect.appendChild(opt);
  }
  sheetPicker.classList.toggle('hidden', preview.sheetNames.length < 2);

  renderMappingRows(preview);
  mappingModal.classList.remove('hidden');
}

sheetSelect.addEventListener('change', async () => {
  const preview = await window.api.importPreviewSheet(currentImportFilePath, sheetSelect.value);
  renderMappingRows(preview);
});

/** Rebuild the column → field dropdowns for the previewed sheet. */
function renderMappingRows(preview) {
  currentImportSheet = preview.sheetName;
  sheetSelect.value = preview.sheetName;
  mappingRows.innerHTML = '';

  if (preview.headerRow.length === 0) {
    mappingRows.textContent = 'This sheet is empty.';
    return;
  }

  preview.headerRow.forEach((header, colIndex) => {
    if (header === null || header === '') return; // skip genuinely blank columns

    const row = document.createElement('div');
    row.className = 'mapping-row';

    const label = document.createElement('span');
    label.className = 'mapping-header';
    label.textContent = header;

    const select = document.createElement('select');
    select.dataset.colIndex = colIndex;
    for (const field of preview.schemaFields) {
      const opt = document.createElement('option');
      opt.value = field.value;
      opt.textContent = field.label;
      select.appendChild(opt);
    }
    // Pre-fill with the auto-detected mapping, if any.
    select.value = preview.mapping[colIndex] ?? '';

    row.appendChild(label);
    row.appendChild(select);
    mappingRows.appendChild(row);
  });
}

function closeMappingModal() {
  mappingModal.classList.add('hidden');
  currentImportFilePath = null;
  currentImportSheet = null;
}

mappingCancelBtn.addEventListener('click', closeMappingModal);

mappingCommitBtn.addEventListener('click', async () => {
  const columnMapping = {};
  mappingRows.querySelectorAll('select').forEach((select) => {
    columnMapping[select.dataset.colIndex] = select.value; // '' means "ignore this column"
  });

  const result = await window.api.importCommit(currentImportFilePath, currentImportSheet, columnMapping);
  closeMappingModal();

  let msg = `Import complete: ${result.added} added, ${result.updated} updated, ${result.skipped} unchanged.`;
  if (result.deletedSkipped.length) {
    msg += `\n\n${result.deletedSkipped.length} row(s) skipped because you deleted them in the app ` +
      `(restore via "Show deleted"): ${result.deletedSkipped.join(', ')}`;
  }
  if (result.invalid.length) {
    msg += `\n\n${result.invalid.length} row(s) skipped due to errors:\n` +
      result.invalid.map((r) => `- ${r.policyNumber || '(no policy number)'}: ${r.errors.join('; ')}`).join('\n');
  }
  if (result.unmappedHeaders.length) {
    msg += `\n\nColumns left unmapped (ignored): ${result.unmappedHeaders.join(', ')}`;
  }
  alert(msg);
  await refresh();
});

refresh();
