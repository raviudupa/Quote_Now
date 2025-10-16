// Central synonyms/aliases for robust matching
// Keep this small and focused; we can enrich keywords in DB as well.

const SYNONYMS = {
  // Types
  'sofa': ['couch', 'settee', 'lounger', 'sofa set'],
  'coffee table': ['center table', 'centre table', 'cocktail table'],
  'side table': ['end table', 'lamp table', 'bedside table'],
  'bedside table': ['nightstand', 'night stand', 'bedside', 'bedside cabinet'],
  'tv bench': ['tv unit', 'tv table', 'tv stand', 'media unit', 'tv storage', 'tv storage combination', 'tv bench with drawers', 'tv-table'],
  'bookcase': ['bookshelf', 'shelving unit', 'shelf unit', 'shelving', 'kallax'],
  'wardrobe': ['closet', 'cupboard', 'almirah'],
  'cabinet': ['storage', 'cupboard'],
  'washstand': ['wash-stand', 'vanity', 'vanity cabinet', 'wash stand', 'wash-stand with drawers', 'wash-stand with doors'],
  'towel rack': ['towel rail', 'towel bar', 'towel-holder', 'towel holder'],

  // Materials
  'wood': ['wooden', 'solid wood'],
  'glass': ['tempered glass'],
  'leather': ['leatherette', 'faux leather'],
  'fabric': ['cloth', 'textile'],
  'metal': ['steel', 'iron'],

  // Packages / price tiers
  'premium': ['high-end'],
  'economy': ['budget', 'affordable', 'cheap'],
  'luxury': ['luxurious'],

  // Seating
  '3 seater': ['3-seater', '3 seat', 'three seater'],
  '2 seater': ['2-seater', '2 seat', 'two seater'],

  // Subtypes
  'dining table': ['dinner table'],
}

// Return a de-duplicated list of synonyms including the token itself
export function getSynonyms(token) {
  if (!token) return [token]
  const t = String(token).toLowerCase()
  const list = SYNONYMS[t] || []
  return Array.from(new Set([t, ...list.map(x => x.toLowerCase())]))
}

// Expand an entire user text by injecting synonyms around recognized phrases
export function expandUserText(text) {
  if (!text) return ''
  let s = String(text)
  // Normalize hyphens/dashes (ASCII and Unicode) to spaces for easier matching
  s = s.replace(/[\-\u2010-\u2015\u2212]/g, ' ')
  // Normalize fancy quotes to plain
  s = s.replace(/[\u2018\u2019\u201C\u201D]/g, ' ')
  const lower = s.toLowerCase()

  // Phrases we want to expand aggressively
  const phrases = [
    'sofa', 'coffee table', 'side table', 'dining table', 'tv bench', 'bookcase', 'wardrobe', 'cabinet',
    'premium', 'luxury', 'economy', '3 seater', '2 seater'
  ]
  let out = lower
  for (const p of phrases) {
    if (lower.includes(p)) {
      const syns = getSynonyms(p)
      // Append synonyms once to help regex/token searches later
      out += ' ' + syns.join(' ')
    }
  }
  // Special: tv-table
  if (lower.includes('tv table') || lower.includes('tv-table')) {
    out += ' tv bench tv unit tv stand media unit'
  }
  return out
}

// Expand a list of keywords into the set including synonyms
export function expandKeywords(keywords) {
  const out = new Set()
  for (const kw of (keywords || [])) {
    for (const s of getSynonyms(kw)) out.add(s)
  }
  return Array.from(out)
}
