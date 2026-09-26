'use strict';

// Pure calculations behind the summary tiles, maturity badges, maturity value
// column, column sorting, and allocation chart. Loaded as a plain <script>
// in the renderer (window.PortfolioMath) and via require() in tests, so it
// must stay free of DOM and Node APIs. Rows are the snake_case objects
// returned by db.listPolicies.
(function (root) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WARNING_DAYS = 60;
  const CRITICAL_DAYS = 30;

  /** Local calendar date as 'YYYY-MM-DD' (not UTC, so "today" matches the user's clock). */
  function toISODate(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${mm}-${dd}`;
  }

  /** 'YYYY-MM-DD' → UTC midnight ms, or null. UTC avoids DST skewing day counts. */
  function dayValue(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }

  /**
   * ROI as a percentage. The Excel sheet stores rates as fractions (0.0685),
   * while values typed in the app are percentages (6.85); anything below 1 is
   * treated as a fraction.
   */
  function roiPercent(roi) {
    if (roi === null || roi === undefined || roi === '') return null;
    const n = Number(roi);
    if (!Number.isFinite(n)) return null;
    return n < 1 ? Math.round(n * 100 * 1e6) / 1e6 : n; // round off float noise (0.0685 × 100)
  }

  /** "25 months", "800 days", "5 years", "3y", "1 year 6 months" → years, or null. */
  function parseTermYears(text) {
    const re = /(\d+(?:\.\d+)?)\s*(years?|yrs?|y|months?|mons?|mo|m|days?|d)\b/gi;
    let years = 0;
    let matched = false;
    for (const [, num, unit] of String(text ?? '').matchAll(re)) {
      matched = true;
      const u = unit.toLowerCase();
      if (u.startsWith('y')) years += Number(num);
      else if (u.startsWith('m')) years += Number(num) / 12;
      else years += Number(num) / 365;
    }
    return matched && years > 0 ? years : null;
  }

  /** Term in years: from start → maturity date when both exist, else parsed from term_total. */
  function termYears(p) {
    const start = dayValue(p.start_date);
    const end = dayValue(p.maturity_date);
    if (start !== null && end !== null && end > start) return (end - start) / DAY_MS / 365;
    return parseTermYears(p.term_total);
  }

  /**
   * Compound-interest maturity value: P × (1 + r/n)^(n·t). Compounding
   * frequency defaults to yearly when not recorded. Returns null when the
   * amount, rate, or term is missing.
   */
  function calcMaturityValue(p) {
    const principal = Number(p.amount_invested);
    const rate = roiPercent(p.roi);
    const years = termYears(p);
    if (!(principal > 0) || rate === null || years === null) return null;
    const n = Number(p.compounding_periods_per_year) > 0 ? Number(p.compounding_periods_per_year) : 1;
    const value = principal * Math.pow(1 + rate / 100 / n, n * years);
    return { value: Math.round(value), rate, periodsPerYear: n, years };
  }

  /** The recorded maturity amount when there is one, otherwise the calculated value. */
  function maturityValue(p) {
    const calc = calcMaturityValue(p);
    const stored = Number(p.maturity_amount);
    if (p.maturity_amount !== null && p.maturity_amount !== undefined && p.maturity_amount !== '' && Number.isFinite(stored)) {
      return { value: stored, calculated: false, calc };
    }
    return calc ? { value: calc.value, calculated: true, calc } : { value: null, calculated: false, calc: null };
  }

  /**
   * Days until maturity plus a badge level: 'matured' (past), 'critical'
   * (≤30 days), 'warning' (≤60 days), or null. No maturity date → null.
   */
  function maturityStatus(maturityDate, today = new Date()) {
    const end = dayValue(maturityDate);
    if (end === null) return null;
    const days = Math.round((end - dayValue(toISODate(today))) / DAY_MS);
    let level = null;
    if (days < 0) level = 'matured';
    else if (days <= CRITICAL_DAYS) level = 'critical';
    else if (days <= WARNING_DAYS) level = 'warning';
    return { days, level };
  }

  /** True when the policy matures between today and `days` days from now (inclusive). */
  function isMaturingWithin(p, days, today = new Date()) {
    const status = maturityStatus(p.maturity_date, today);
    return Boolean(status) && status.days >= 0 && status.days <= days;
  }

  /** Average ROI (%) weighted by amount invested; policies without an ROI are left out. */
  function weightedAverageRoi(policies) {
    let weighted = 0;
    let total = 0;
    for (const p of policies) {
      const rate = roiPercent(p.roi);
      const amount = Number(p.amount_invested);
      if (rate === null || !(amount > 0)) continue;
      weighted += amount * rate;
      total += amount;
    }
    return total > 0 ? weighted / total : null;
  }

  /**
   * Summary for whichever policies are currently shown, so it follows the
   * filter. Soft-deleted rows (shown via "Show deleted") never count.
   */
  function summarizePolicies(allShown, { upcomingWithinDays = CRITICAL_DAYS, today = new Date() } = {}) {
    const policies = allShown.filter((p) => !p.deleted_at);
    let expectedAtMaturity = 0;
    let missingMaturityValue = 0;
    for (const p of policies) {
      const { value } = maturityValue(p);
      if (value === null) missingMaturityValue++;
      else expectedAtMaturity += value;
    }
    return {
      accountCount: policies.length,
      totalInvested: policies.reduce((sum, p) => sum + (Number(p.amount_invested) || 0), 0),
      upcomingCount: policies.filter((p) => isMaturingWithin(p, upcomingWithinDays, today)).length,
      weightedAvgRoi: weightedAverageRoi(policies),
      expectedAtMaturity,
      missingMaturityValue
    };
  }

  // How each sortable column compares. Anything not listed sorts as text.
  const SORT_VALUE = {
    amount_invested: (p) => numberOrNull(p.amount_invested),
    roi: (p) => roiPercent(p.roi),
    maturity_value: (p) => maturityValue(p).value,
    maturity_date: (p) => dayValue(p.maturity_date),
    start_date: (p) => dayValue(p.start_date)
  };

  function numberOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Sorted copy. Blank values always go last, whichever direction. */
  function sortPolicies(policies, key, direction = 'asc') {
    const valueOf = SORT_VALUE[key] ?? ((p) => {
      const s = String(p[key] ?? '').trim();
      return s === '' ? null : s;
    });
    const sign = direction === 'desc' ? -1 : 1;
    return policies
      .map((p, index) => ({ p, index, v: valueOf(p) }))
      .sort((a, b) => {
        if (a.v === null || b.v === null) {
          if (a.v === b.v) return a.index - b.index;
          return a.v === null ? 1 : -1;
        }
        const cmp = typeof a.v === 'string'
          ? a.v.localeCompare(b.v, undefined, { numeric: true, sensitivity: 'base' })
          : a.v - b.v;
        return cmp * sign || a.index - b.index;
      })
      .map(({ p }) => p);
  }

  /**
   * Amount invested grouped by a field (e.g. institution, holder), largest
   * first. Groups beyond maxGroups fold into a single "Other" bar.
   */
  function allocationBy(allShown, field, { maxGroups = 8 } = {}) {
    const policies = allShown.filter((p) => !p.deleted_at);
    const groups = new Map();
    let total = 0;
    for (const p of policies) {
      const amount = Number(p.amount_invested) || 0;
      if (amount <= 0) continue;
      const label = String(p[field] ?? '').trim() || '(none)';
      const g = groups.get(label) ?? { label, amount: 0, count: 0 };
      g.amount += amount;
      g.count += 1;
      groups.set(label, g);
      total += amount;
    }
    let rows = [...groups.values()].sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
    if (rows.length > maxGroups) {
      const rest = rows.slice(maxGroups - 1);
      rows = rows.slice(0, maxGroups - 1);
      rows.push({
        label: `Other (${rest.length})`,
        amount: rest.reduce((s, g) => s + g.amount, 0),
        count: rest.reduce((s, g) => s + g.count, 0),
        isOther: true
      });
    }
    return rows.map((g) => ({ ...g, share: total > 0 ? g.amount / total : 0 }));
  }

  const api = {
    WARNING_DAYS,
    CRITICAL_DAYS,
    DAY_MS,
    toISODate,
    dayValue,
    roiPercent,
    parseTermYears,
    termYears,
    calcMaturityValue,
    maturityValue,
    maturityStatus,
    isMaturingWithin,
    weightedAverageRoi,
    summarizePolicies,
    sortPolicies,
    allocationBy
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PortfolioMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
