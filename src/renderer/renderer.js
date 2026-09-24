'use strict';

const tableBody = document.getElementById('policyTableBody');
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

const EDITABLE_COLUMNS = [
  { key: 'policy_number', dbField: 'policy_number' },
  { key: 'instrument', dbField: 'instrument' },
  { key: 'institution', dbField: null }, // lookup field — read-only inline for v1, edited via import/re-entry
  { key: 'holder', dbField: null },
  { key: 'nominee', dbField: null },
  { key: 'amount_invested', dbField: 'amount_invested', numeric: true },
  { key: 'roi', dbField: 'roi', numeric: true },
  { key: 'maturity_date', dbField: 'maturity_date' }
];

const UPCOMING_DAYS = 30;

let allPolicies = []; // last full fetch, before any filter is applied

// --- Filter bar setup ---
for (const opt of window.PolicyFilter.FILTERABLE_FIELDS) {
  const el = document.createElement('option');
  el.value = opt.value;
  el.textContent = opt.label;
  filterField.appendChild(el);
}

function applyFilterAndRender() {
  const filtered = window.PolicyFilter.filterPolicies(allPolicies, filterField.value, filterQuery.value);
  renderSummary(window.PolicyFilter.summarizePolicies(filtered, { upcomingWithinDays: UPCOMING_DAYS }));
  renderTable(filtered);
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

async function refresh() {
  allPolicies = await window.api.listPolicies();
  applyFilterAndRender();
}

// Summary covers only the rows currently shown, so it follows the filter.
function renderSummary(summary) {
  summaryEl.textContent =
    `${summary.accountCount} accounts · ₹${summary.totalInvested.toLocaleString('en-IN')} total` +
    (summary.upcomingCount ? ` · ${summary.upcomingCount} maturing within ${UPCOMING_DAYS} days` : '');
}

function renderTable(policies) {
  tableBody.innerHTML = '';
  for (const row of policies) {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;

    for (const col of EDITABLE_COLUMNS) {
      const td = document.createElement('td');
      const value = row[col.key] ?? '';
      if (col.dbField) {
        td.contentEditable = 'true';
        td.textContent = value;
        td.addEventListener('blur', () => onCellEdit(row.id, col, td));
      } else {
        // Lookup-derived fields (institution/holder/nominee): plain text for now.
        td.textContent = value;
        td.classList.add('lookup-cell');
      }
      tr.appendChild(td);
    }

    const deleteTd = document.createElement('td');
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => onDelete(row.id));
    deleteTd.appendChild(deleteBtn);
    tr.appendChild(deleteTd);

    tableBody.appendChild(tr);
  }
}

async function onCellEdit(id, col, td) {
  let value = td.textContent.trim();
  if (col.numeric) {
    const parsed = Number(value);
    value = Number.isFinite(parsed) ? parsed : null;
  }
  await window.api.updatePolicy(id, { [col.dbField]: value });
  await refresh();
}

async function onDelete(id) {
  if (!confirm('Delete this policy?')) return;
  await window.api.deletePolicy(id);
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

importBtn.addEventListener('click', async () => {
  const preview = await window.api.importPreview();
  if (!preview) return; // user cancelled the file picker
  openMappingModal(preview);
});

let currentImportFilePath = null;

function openMappingModal(preview) {
  currentImportFilePath = preview.filePath;
  mappingRows.innerHTML = '';

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

  mappingModal.classList.remove('hidden');
}

mappingCancelBtn.addEventListener('click', () => {
  mappingModal.classList.add('hidden');
  currentImportFilePath = null;
});

mappingCommitBtn.addEventListener('click', async () => {
  const columnMapping = {};
  mappingRows.querySelectorAll('select').forEach((select) => {
    columnMapping[select.dataset.colIndex] = select.value; // '' means "ignore this column"
  });

  const result = await window.api.importCommit(currentImportFilePath, columnMapping);
  mappingModal.classList.add('hidden');
  currentImportFilePath = null;

  let msg = `Import complete: ${result.added} added, ${result.updated} updated, ${result.skipped} unchanged.`;
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