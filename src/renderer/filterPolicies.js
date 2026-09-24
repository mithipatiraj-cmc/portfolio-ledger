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
   * Header summary for whichever policies are currently shown, so it follows
   * the filter. Soft-deleted rows (shown via "Show deleted") never count.
   * Dates are ISO 'YYYY-MM-DD' strings, compared lexically.
   */
  function summarizePolicies(allShown, { upcomingWithinDays = 30, today = new Date() } = {}) {
    const policies = allShown.filter((p) => !p.deleted_at);
    const todayStr = today.toISOString().slice(0, 10);
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() + upcomingWithinDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    return {
      accountCount: policies.length,
      totalInvested: policies.reduce((sum, p) => sum + (Number(p.amount_invested) || 0), 0),
      upcomingCount: policies.filter(
        (p) => p.maturity_date && p.maturity_date >= todayStr && p.maturity_date <= cutoffStr
      ).length
    };
  }

  const api = { FILTERABLE_FIELDS, filterPolicies, summarizePolicies };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PolicyFilter = api;
})(typeof window !== 'undefined' ? window : globalThis);
