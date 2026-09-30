'use strict';

// Money formatting for the currency chosen in the header (a display
// preference: amounts are stored as plain numbers and never converted).
// Loaded as a plain <script> in the renderer (window.Money) and via require()
// in the main process for reminder emails, so it must stay free of DOM and
// Node APIs.
(function (root) {
  // Each currency is shown the way English speakers there write it: INR with
  // lakh grouping (₹1,00,000), USD as $100,000, and so on. All use '.' for
  // decimals, so amounts typed into the table parse the same way everywhere.
  const CURRENCIES = [
    { code: 'INR', locale: 'en-IN', name: 'Indian rupee' },
    { code: 'USD', locale: 'en-US', name: 'US dollar' },
    { code: 'EUR', locale: 'en-IE', name: 'Euro' },
    { code: 'GBP', locale: 'en-GB', name: 'British pound' },
    { code: 'AED', locale: 'en-AE', name: 'UAE dirham' },
    { code: 'SGD', locale: 'en-SG', name: 'Singapore dollar' },
    { code: 'AUD', locale: 'en-AU', name: 'Australian dollar' },
    { code: 'CAD', locale: 'en-CA', name: 'Canadian dollar' }
  ];
  const DEFAULT_CURRENCY = 'INR';

  const isSupported = (code) => CURRENCIES.some((c) => c.code === code);

  /**
   * Formatters for one currency (unknown codes fall back to INR):
   * format(n) whole units, format(n, { decimals: 2 }) with paise/cents,
   * compact(n) e.g. ₹6.25L or $625K, number(n, options) without a symbol.
   */
  function createMoney(code) {
    const currency = CURRENCIES.find((c) => c.code === code) ?? CURRENCIES.find((c) => c.code === DEFAULT_CURRENCY);
    const { locale } = currency;
    const cache = new Map();
    const formatter = (options) => {
      const key = JSON.stringify(options);
      if (!cache.has(key)) cache.set(key, new Intl.NumberFormat(locale, options));
      return cache.get(key);
    };
    const symbol = formatter({ style: 'currency', currency: currency.code })
      .formatToParts(0)
      .find((p) => p.type === 'currency').value;

    return {
      code: currency.code,
      locale,
      symbol,
      format: (n, { decimals = 0 } = {}) =>
        formatter({ style: 'currency', currency: currency.code, maximumFractionDigits: decimals }).format(n),
      compact: (n) =>
        formatter({ style: 'currency', currency: currency.code, notation: 'compact', maximumFractionDigits: 2 }).format(n),
      number: (n, options = {}) => formatter(options).format(n)
    };
  }

  // The renderer's current preference; setCurrency is called at startup and when it changes.
  let current = createMoney(DEFAULT_CURRENCY);

  const api = {
    CURRENCIES,
    DEFAULT_CURRENCY,
    isSupported,
    createMoney,
    setCurrency(code) {
      current = createMoney(code);
      return current;
    },
    code: () => current.code,
    symbol: () => current.symbol,
    format: (n, options) => current.format(n, options),
    compact: (n) => current.compact(n),
    number: (n, options) => current.number(n, options)
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Money = api;
})(typeof window !== 'undefined' ? window : globalThis);
