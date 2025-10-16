import { supabase } from '../config/supabase.js'

let _cache = null
let _ts = 0
const CACHE_MS = 5 * 60 * 1000

// Flexible parse of numeric ranges like "600-850" or "600 – 850" or single value
function parseRange(val) {
  const s = String(val || '').replace(/[,\s]/g, '').replace(/[–—]/g, '-').toLowerCase()
  if (!s) return { min: null, max: null }
  const m = s.match(/(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?/)
  if (!m) return { min: null, max: null }
  const min = Number(m[1])
  const max = m[2] ? Number(m[2]) : min
  return { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null }
}

function toNum(x) { const n = Number(x); return Number.isFinite(n) ? n : null }

async function fetchFromDB() {
  try {
    const { data, error } = await supabase
      .from('rules')
      .select('*')
      .eq('active', true)
    if (error) throw error
    if (!Array.isArray(data)) return []
    return data.map(r => ({
      id: r.id,
      propertyType: String(r.property_type || r.propertyType || '').toLowerCase(),
      configuration: String(r.configuration || '').toLowerCase(), // e.g., '2 bhk'
      otherNames: String(r.other_variant_names || '').split(',').map(s=>s.trim()).filter(Boolean),
      carpet: parseRange(r.carpet_area_range_sqft || r.carpet),
      builtUp: parseRange(r.built_up_area_range_sqft || r.builtup),
      budget: {
        economy: parseRange(r.budget_range_economy_inr || r.budget_economy),
        premium: parseRange(r.budget_range_premium_inr || r.budget_premium),
        luxury: parseRange(r.budget_range_luxury_inr || r.budget_luxury)
      }
    }))
  } catch (_) {
    return []
  }
}

export async function loadRules() {
  const now = Date.now()
  if (_cache && (now - _ts) < CACHE_MS) return _cache
  _cache = await fetchFromDB()
  _ts = now
  return _cache
}

// Derive a compact hint for the LLM given bhk and sqft
export async function deriveRuleFor({ propertyType = 'apartment', bhk = null, sqft = null } = {}) {
  const rules = await loadRules()
  const bhkText = bhk ? `${bhk} bhk` : ''
  const typeMatch = String(propertyType || '').toLowerCase()
  // Find the best row matching type and configuration
  const candidates = rules.filter(r => {
    const typeOk = !typeMatch || r.propertyType.includes(typeMatch)
    const confOk = !bhkText || r.configuration.includes(bhkText)
    return typeOk && confOk
  })
  // Prefer one whose carpet/builtUp range contains sqft, if provided
  let best = null
  if (sqft && candidates.length) {
    for (const c of candidates) {
      const inCarpet = c.carpet.min && c.carpet.max ? (sqft >= c.carpet.min && sqft <= c.carpet.max) : false
      const inBuilt = c.builtUp.min && c.builtUp.max ? (sqft >= c.builtUp.min && sqft <= c.builtUp.max) : false
      if (inCarpet || inBuilt) { best = c; break }
    }
  }
  if (!best) best = candidates[0] || null
  if (!best) return null
  return {
    propertyType: best.propertyType,
    configuration: best.configuration,
    carpetRange: best.carpet,
    builtUpRange: best.builtUp,
    budgetEconomy: best.budget.economy,
    budgetPremium: best.budget.premium,
    budgetLuxury: best.budget.luxury
  }
}
