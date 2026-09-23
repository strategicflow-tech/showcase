'use strict';

// These words make a title-cased phrase look like ordinary sentence prose
// rather than a named concept/framework.
const COMMON_CONNECTORS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from',
  'in', 'nor', 'of', 'on', 'or', 'the', 'to', 'via', 'with',
  'without', 'yet',
]);

function stripOuterPunctuation(token) {
  return token
    .replace(/^[("'“‘]+/, '')
    .replace(/[)"'“”.,;:!?]+$/, '');
}

function isCapitalizedWord(token) {
  const cleaned = stripOuterPunctuation(token);
  if (!cleaned || COMMON_CONNECTORS.has(cleaned.toLowerCase())) return false;

  // Hyphenated names such as Feature-First and
  // Consequence-After-Caveat are still one displayed term, but contain
  // multiple capitalized words for detection purposes.
  return cleaned.split('-').every(part => /^[A-Z][A-Za-z0-9]*$/.test(part));
}

/**
 * Return the input as an exact named term only when the complete input looks
 * like a multi-word proper noun/concept. Generic categories intentionally
 * return null and keep the existing buyer-question generation path.
 */
function detectBrandedTerm(input) {
  const text = String(input || '').trim().replace(/^(["“‘])([\s\S]*)\1$/, '$2').trim();
  if (!text) return null;

  const tokens = text.split(/\s+/);
  if (!tokens.every(isCapitalizedWord)) return null;

  const wordCount = tokens.reduce((count, token) => {
    return count + stripOuterPunctuation(token).split('-').length;
  }, 0);
  return wordCount >= 2 ? text : null;
}

function buildBrandedTermQuestions(term) {
  return [
    `What is "${term}"?`,
    `Who created the concept of "${term}"?`,
    `Can you explain what "${term}" means?`,
    `Is "${term}" associated with a specific company or framework?`,
    `What problem does "${term}" solve, and who uses it?`,
  ];
}

module.exports = { detectBrandedTerm, buildBrandedTermQuestions };