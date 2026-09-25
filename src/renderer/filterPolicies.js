'use strict';

// Pure filtering logic for the policy table's quick-filter bar. Loaded as a
// plain <script> in the renderer (exposed as window.PolicyFilter) and via
// require() in tests, so it must stay free of DOM and Node APIs.
(function (root) {
  // Keys match the snake_case rows returned by db.listPolicies.
  const FILTERABLE_FIELDS = [
    { value: 'all', label: 'All fields' },
    { value: 'policy_number', label: 'Policy No' },
    { value: 'instrument', label: 'Instrument' },
    { value: 'institution', label: 'Institution' },
    { value: 'holder', label: 'Holder' },
    { value: 'joint_holder', label: 'Joint holder' },
    { value: 'nominee', label: 'Nominee' },
    { value: 'destination_bank', label: 'Destination bank' },
    // Matched on the whole value: a substring search for "cumulative" would also hit "non-cumulative".
    { value: 'income_treatment', label: 'Income treatment', exact: true }
  ];

  const SEARCHABLE_KEYS = FILTERABLE_FIELDS.map((f) => f.value).filter((v) => v !== 'all');
  const EXACT_KEYS = new Set(FILTERABLE_FIELDS.filter((f) => f.exact).map((f) => f.value));

  const INCOME_TREATMENT_LABELS = { cumulative: 'Cumulative', 'non-cumulative': 'Non-cumulative' };

  /** 'non-cumulative' → 'Non-cumulative'; not recorded (null) → 'Not recorded'. */
  function incomeTreatmentLabel(value) {
    return INCOME_TREATMENT_LABELS[value] ?? 'Not recorded';
  }

  /** A field's value as shown in the table, which is also what searches and suggestions use. */
  function displayValue(p, key) {
    if (key === 'income_treatment') return incomeTreatmentLabel(p.income_treatment);
    return String(p[key] ?? '');
  }

  /**
   * Case-insensitive substring match on one field, or across every
   * filterable field when field is 'all'. Fields marked exact must match
   * the whole value. A blank query returns the input.
   */
  function filterPolicies(policies, field, query) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) return policies;

    const keys = field === 'all' ? SEARCHABLE_KEYS : [field];
    const exact = field !== 'all' && EXACT_KEYS.has(field);
    return policies.filter((p) =>
      keys.some((key) => {
        const value = displayValue(p, key).toLowerCase();
        return exact ? value === needle : value.includes(needle);
      })
    );
  }

  /**
   * Apply several filters at once. Filters on different fields must all
   * match (AND); filters on the same field match any of their values (OR),
   * so "Institution: HDFC" + "Institution: SBI" shows both banks.
   * filters: [{ field, query }, …]; blank queries are ignored.
   */
  function applyFilters(policies, filters) {
    const byField = new Map();
    for (const { field, query } of filters) {
      if (String(query ?? '').trim() === '') continue;
      byField.set(field, [...(byField.get(field) ?? []), query]);
    }
    let rows = policies;
    for (const [field, queries] of byField) {
      rows = rows.filter((p) => queries.some((q) => filterPolicies([p], field, q).length > 0));
    }
    return rows;
  }

  function fieldLabel(field) {
    return field === 'all' ? 'Any field' : FILTERABLE_FIELDS.find((f) => f.value === field)?.label ?? field;
  }

  /** True when at least one filter has a non-blank query. */
  function hasActiveFilter(filters) {
    return filters.some(({ query }) => String(query ?? '').trim() !== '');
  }

  /**
   * Sorted distinct non-blank values of field, for a filter's suggestion list.
   * Pass the rows left after the *other* filters so suggestions narrow as you
   * filter (e.g. only holders at the chosen institution).
   */
  function distinctValues(policies, field) {
    const values = new Set();
    for (const p of policies) {
      const v = displayValue(p, field).trim();
      if (v) values.add(v);
    }
    return [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  const api = {
    FILTERABLE_FIELDS,
    filterPolicies,
    applyFilters,
    hasActiveFilter,
    distinctValues,
    fieldLabel,
    incomeTreatmentLabel
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PolicyFilter = api;
})(typeof window !== 'undefined' ? window : globalThis);
