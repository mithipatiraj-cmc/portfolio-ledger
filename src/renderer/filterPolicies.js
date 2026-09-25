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
    { value: 'destination_bank', label: 'Destination bank' }
  ];

  const SEARCHABLE_KEYS = FILTERABLE_FIELDS.map((f) => f.value).filter((v) => v !== 'all');

  /**
   * Case-insensitive substring match on one field, or across every
   * filterable field when field is 'all'. A blank query returns the input.
   */
  function filterPolicies(policies, field, query) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) return policies;

    const keys = field === 'all' ? SEARCHABLE_KEYS : [field];
    return policies.filter((p) =>
      keys.some((key) => String(p[key] ?? '').toLowerCase().includes(needle))
    );
  }

  /**
   * Apply several filters at once: a row must match every one (AND).
   * filters: [{ field, query }, …]; blank queries are ignored.
   */
  function applyFilters(policies, filters) {
    return filters.reduce((rows, { field, query }) => filterPolicies(rows, field, query), policies);
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
      const v = String(p[field] ?? '').trim();
      if (v) values.add(v);
    }
    return [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  const api = { FILTERABLE_FIELDS, filterPolicies, applyFilters, hasActiveFilter, distinctValues };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PolicyFilter = api;
})(typeof window !== 'undefined' ? window : globalThis);
