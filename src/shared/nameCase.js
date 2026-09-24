'use strict';

// Words kept fully upper-case by toTitleCase. Add to this list if another
// bank/instrument acronym shows up as e.g. "Hdfc".
const ACRONYMS = new Set([
  'HDFC', 'SBI', 'ICICI', 'LIC', 'IDBI', 'IDFC', 'PNB', 'UCO', 'HSBC', 'RBL', 'IOB', 'BOB', 'BOI',
  'HPO', 'NSC', 'KVP', 'PPF', 'NPS', 'ELSS', 'FD', 'RD', 'SCSS', 'EPF'
]);

/**
 * "raviraj  KUMAR" → "Raviraj Kumar", "union bank" → "Union Bank", "hdfc" → "HDFC".
 * Also collapses repeated whitespace. null/undefined pass through unchanged.
 */
function toTitleCase(value) {
  if (value == null) return value;
  return String(value)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s\-.'(/])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase())
    .replace(/\p{L}+/gu, (word) => (ACRONYMS.has(word.toUpperCase()) ? word.toUpperCase() : word));
}

module.exports = { ACRONYMS, toTitleCase };
