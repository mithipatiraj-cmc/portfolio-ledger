'use strict';

// Pure calculations behind the Tax projection tab: interest earned per Indian
// financial year (April–March) and the tax on it for each holder. Loaded as a
// plain <script> in the renderer (window.TaxMath) and via require() in tests,
// so it must stay free of DOM and Node APIs.
(function (root) {
  const PortfolioMath = typeof module !== 'undefined' && module.exports
    ? require('./portfolioMath.js')
    : root.PortfolioMath;
  const { DAY_MS, dayValue, roiPercent, parseTermYears } = PortfolioMath;

  // New regime: section 87A leaves total income up to ₹12 lakh tax-free. It's
  // a rebate, not a deduction: above the limit the whole income is taxed.
  const DEFAULT_REBATE_LIMIT = 1200000;
  const NO_HOLDER = '(No holder)';

  /** The financial year a date falls in, as its starting calendar year (Sep 2026 → 2026, i.e. FY 2026-27). */
  function financialYearOf(date = new Date()) {
    return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  }

  function fyLabel(startYear) {
    return `FY ${startYear}-${String(startYear + 1).slice(-2)}`;
  }

  /** 1 April of startYear up to (not including) 1 April the year after, as UTC ms. */
  function fyBounds(startYear) {
    return { from: Date.UTC(startYear, 3, 1), to: Date.UTC(startYear + 1, 3, 1) };
  }

  /** When a policy runs, as UTC ms. A missing start date is worked back from maturity − term. */
  function policyPeriod(p) {
    const end = dayValue(p.maturity_date);
    if (end === null) return null;
    let start = dayValue(p.start_date);
    if (start === null) {
      const years = parseTermYears(p.term_total);
      if (years === null) return null;
      start = end - Math.round(years * 365) * DAY_MS;
    }
    return end > start ? { start, end } : null;
  }

  /**
   * Interest a policy earns between from and to (UTC ms), or null without
   * enough data. Cumulative interest is counted as it accrues each year (the
   * growth of the compounded value), which is how it's taxed even though it's
   * only received at maturity. Non-cumulative interest is paid out, so it's
   * simple interest on the amount invested. Not recorded counts as cumulative.
   */
  function interestEarned(p, from, to) {
    const period = policyPeriod(p);
    const principal = Number(p.amount_invested);
    const rate = roiPercent(p.roi);
    if (!period || !(principal > 0) || rate === null) return null;

    const a = Math.max(from, period.start);
    const b = Math.min(to, period.end);
    if (b <= a) return 0;

    const yearsAt = (t) => (t - period.start) / DAY_MS / 365;
    const r = rate / 100;
    if (p.income_treatment === 'non-cumulative') return principal * r * (yearsAt(b) - yearsAt(a));

    const n = Number(p.compounding_periods_per_year) > 0 ? Number(p.compounding_periods_per_year) : 1;
    const valueAt = (years) => principal * Math.pow(1 + r / n, n * years);
    return valueAt(yearsAt(b)) - valueAt(yearsAt(a));
  }

  /**
   * Tax projection for one financial year. Every policy is taxed to its
   * holder (joint holders are ignored). holders: { [name]: { rate, otherIncome } }
   * where rate is a percentage and otherIncome is the holder's income from
   * everything else in the year. A holder whose other income plus taxable
   * interest is within rebateLimit owes nothing; otherwise the interest is
   * taxed at their rate. Soft-deleted policies are left out.
   */
  function projectTax(allPolicies, { fyStartYear, holders = {}, rebateLimit = DEFAULT_REBATE_LIMIT }) {
    const { from, to } = fyBounds(fyStartYear);
    const rows = [];
    const missingData = [];
    const byHolder = new Map();

    for (const p of allPolicies) {
      if (p.deleted_at) continue;
      const holder = String(p.holder ?? '').trim() || NO_HOLDER;
      const interest = interestEarned(p, from, to);
      if (interest === null) {
        missingData.push(p);
        continue;
      }
      if (interest <= 0) continue;
      const exempt = p.tax_treatment === 'exempt';
      rows.push({ policy: p, holder, interest, exempt });

      const h = byHolder.get(holder) ?? { name: holder, taxableInterest: 0, exemptInterest: 0 };
      if (exempt) h.exemptInterest += interest;
      else h.taxableInterest += interest;
      byHolder.set(holder, h);
    }

    const holderRows = [...byHolder.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((h) => {
        const input = holders[h.name] ?? {};
        const rate = numberOrNull(input.rate);
        const otherIncome = numberOrNull(input.otherIncome) ?? 0;
        const totalIncome = otherIncome + h.taxableInterest;
        const withinLimit = totalIncome <= rebateLimit;
        let tax = null;
        if (withinLimit) tax = 0;
        else if (rate !== null) tax = h.taxableInterest * (rate / 100);
        return { ...h, rate, otherIncome, totalIncome, withinLimit, tax };
      });

    return { fyStartYear, rows, holders: holderRows, missingData };
  }

  function numberOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  const api = {
    DEFAULT_REBATE_LIMIT,
    NO_HOLDER,
    financialYearOf,
    fyLabel,
    fyBounds,
    policyPeriod,
    interestEarned,
    projectTax
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TaxMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
