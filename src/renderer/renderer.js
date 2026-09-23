'use strict';

const tableBody = document.getElementById('policyTableBody');
const summaryEl = document.getElementById('summary');
const addRowBtn = document.getElementById('addRowBtn');
const importBtn = document.getElementById('importBtn');

const EDITABLE_COLUMNS = [
  { key: 'policy_number', dbField: 'policy_number' },
  { key: 'instrument', dbField: 'instrument' },
  { key: 'institution', dbField: null }, // lookup field — read-only inline for v1, edited via import/re-entry
  { key: 'holder', dbField: null },
  { key: 'nominee', dbField: null },
  { key: 'received_amount', dbField: 'received_amount', numeric: true },
  { key: 'roi', dbField: 'roi', numeric: true },
  { key: 'maturity_date', dbField: 'maturity_date' }
];

async function refresh() {
  const [policies, summary] = await Promise.all([
    window.api.listPolicies(),
    window.api.getPortfolioSummary({ upcomingWithinDays: 30 })
  ]);
  renderSummary(summary);
  renderTable(policies);
}

function renderSummary(summary) {
  summaryEl.textContent =
    `${summary.accountCount} accounts · ₹${summary.totalInvested.toLocaleString('en-IN')} total` +
    (summary.upcomingMaturities.length
      ? ` · ${summary.upcomingMaturities.length} maturing within 30 days`
      : '');
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
    receivedAmount: 0,
    roi: 0,
    maturityDate: new Date().toISOString().slice(0, 10)
  });
  await refresh();
});

importBtn.addEventListener('click', async () => {
  const result = await window.api.importExcel();
  if (!result) return; // user cancelled the file picker
  let msg = `Import complete: ${result.added} added, ${result.updated} updated, ${result.skipped} unchanged.`;
  if (result.invalid.length) {
    msg += `\n\n${result.invalid.length} row(s) skipped due to errors:\n` +
      result.invalid.map((r) => `- ${r.policyNumber || '(no policy number)'}: ${r.errors.join('; ')}`).join('\n');
  }
  if (result.unmappedHeaders.length) {
    msg += `\n\nColumns not recognized (ignored): ${result.unmappedHeaders.join(', ')}`;
  }
  alert(msg);
  await refresh();
});

refresh();
