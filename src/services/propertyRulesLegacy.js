import { supabase } from '../config/supabase.js'

// Adapter for existing table structure
// Your tables: space | item | 1bhk | 2bhk/2.5bhk | 3bhk/3.5bhk | 4bhk/4.5bhk/5bhk

let _rulesCache = null
let _sizePricingCache = null
let _cacheTs = 0
const CACHE_MS = 10 * 60 * 1000

// Map BHK to your column names (based on your screenshots)
function bhkToColumn(bhk) {
  if (!bhk) return null
  const n = Number(bhk)
  if (n === 1) return '1bhk'
  if (n === 2) return '2bhk'
  if (n === 3) return '3bhk'
  if (n >= 4) return '4bhk/4.5bhk/5bhk'
  return null
}

// Parse room name to extract type and subtype
export function parseRoomName(roomName) {
  const s = String(roomName || '').toLowerCase().trim()
  if (!s) return { type: null, subtype: null }
  
  if (/bedroom/.test(s)) {
    if (/master/.test(s)) return { type: 'bedroom', subtype: 'master' }
    if (/guest/.test(s)) return { type: 'bedroom', subtype: 'guest' }
    return { type: 'bedroom', subtype: null }
  }
  
  if (/bathroom|bath/.test(s)) {
    if (/attached|ensuite/.test(s)) return { type: 'bathroom', subtype: 'attached' }
    if (/common|shared/.test(s)) return { type: 'bathroom', subtype: 'common' }
    return { type: 'bathroom', subtype: null }
  }
  
  if (/living|lounge/.test(s)) return { type: 'living', subtype: null }
  if (/kitchen/.test(s)) return { type: 'kitchen', subtype: null }
  if (/dining/.test(s)) return { type: 'dining', subtype: null }
  if (/foyer/.test(s)) return { type: 'foyer', subtype: null }
  
  return { type: s, subtype: null }
}

// Fetch rules from your existing table
async function fetchRulesForApartment() {
  try {
    const { data, error } = await supabase
      .from('rules_for_apartment')
      .select('*')
    if (error) throw error
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('[propertyRulesLegacy] fetchRulesForApartment failed', e?.message || e)
    return []
  }
}

// Fetch size and pricing
async function fetchSizePricing() {
  try {
    const { data, error } = await supabase
      .from('size_and_pricing')
      .select('*')
    if (error) throw error
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('[propertyRulesLegacy] fetchSizePricing failed', e?.message || e)
    return []
  }
}

// Load with caching
export async function loadPropertyRules() {
  const now = Date.now()
  if (_rulesCache && _sizePricingCache && (now - _cacheTs) < CACHE_MS) {
    return { rules: _rulesCache, sizePricing: _sizePricingCache }
  }
  
  const [rules, sizePricing] = await Promise.all([
    fetchRulesForApartment(),
    fetchSizePricing()
  ])
  
  _rulesCache = rules
  _sizePricingCache = sizePricing
  _cacheTs = now
  
  return { rules, sizePricing }
}

// Get size and pricing info
export async function getSizePricingFor({ propertyType = 'apartment', bhk = null } = {}) {
  const { sizePricing } = await loadPropertyRules()
  
  const matches = sizePricing.filter(sp => {
    const typeMatch = String(sp.property_type || '').toLowerCase().includes(String(propertyType).toLowerCase())
    const configMatch = !bhk || String(sp.configuration || '').toLowerCase().includes(`${bhk} bhk`)
    return typeMatch && configMatch
  })
  
  return matches[0] || null
}

// Derive item constraints from your existing table structure
export async function deriveItemConstraints({ propertyType = 'apartment', bhk = null, roomName, itemType, itemSubtype = null } = {}) {
  const { type: roomType, subtype: roomSubtype } = parseRoomName(roomName)
  if (!roomType) return null
  
  const { rules } = await loadPropertyRules()
  const col = bhkToColumn(bhk)
  if (!col) return null
  
  // Map item type to your item names (based on your screenshots)
  const ITEM_MAP = {
    'sofa': 'Sofa-Large/ Sectional sofa',
    'tv_bench': 'TV unit',
    'table': itemSubtype === 'coffee' ? 'Coffee table/Console Unit' : 
             itemSubtype === 'dining' ? 'Dining table' :
             itemSubtype === 'side' ? 'Side table' : 'Table',
    'bed': 'Bed',
    'wardrobe': 'Wardrobe',
    'mirror': 'Mirror',
    'washstand': 'Wash-stand',
    'chair': 'Arm chair/ Lounge Chair',
    'shelf': 'Shelf',
    'cabinet': 'Cabinet',
    'bookcase': 'Bookcase',
    'lamp': 'Lamp'
  }
  
  const itemName = ITEM_MAP[String(itemType || '').toLowerCase()] || itemType
  
  // Find matching rule
  const rule = rules.find(r => {
    const spaceMatch = String(r.space || '').toLowerCase().includes(String(roomType).toLowerCase())
    const itemMatch = String(r.item || '').toLowerCase().includes(String(itemName).toLowerCase())
    return spaceMatch && itemMatch
  })
  
  if (!rule) return null
  
  // Parse the value from your column
  const value = rule[col]
  if (!value || value === 'No') return null
  
  // Parse quantity or size preference
  let quantity = 1
  let sizePreference = null
  let priceMin = null
  let priceMax = null
  
  const valStr = String(value).toLowerCase()
  
  // Parse quantity (e.g., "1", "2", "3-seater")
  if (/^\d+$/.test(valStr)) {
    quantity = parseInt(valStr, 10)
  } else if (/(\d+)-seater/.test(valStr)) {
    const m = valStr.match(/(\d+)-seater/)
    sizePreference = m[1] + '-seater'
  } else if (/(\d+)ft/.test(valStr)) {
    const m = valStr.match(/(\d+)ft/)
    sizePreference = m[1] + 'ft'
  }
  
  // Derive price ranges based on room subtype and BHK
  if (roomType === 'bedroom' && itemType === 'bed') {
    if (roomSubtype === 'master') {
      priceMin = bhk >= 3 ? 35000 : 25000
      priceMax = bhk >= 3 ? 60000 : 45000
      sizePreference = bhk >= 3 ? 'king' : 'queen'
    } else if (roomSubtype === 'guest') {
      priceMin = bhk >= 3 ? 25000 : 20000
      priceMax = bhk >= 3 ? 45000 : 35000
      sizePreference = 'medium'
    }
  } else if (roomType === 'bathroom' && itemType === 'washstand') {
    if (roomSubtype === 'attached') {
      priceMin = bhk >= 3 ? 12000 : 10000
      priceMax = bhk >= 3 ? 22000 : 18000
    } else if (roomSubtype === 'common') {
      priceMin = bhk >= 3 ? 9000 : 8000
      priceMax = bhk >= 3 ? 16000 : 15000
    }
  } else if (roomType === 'living' && itemType === 'sofa') {
    priceMin = bhk >= 3 ? 40000 : 25000
    priceMax = bhk >= 3 ? 70000 : 45000
  }
  
  return {
    minQuantity: quantity,
    maxQuantity: null,
    recommendedQuantity: quantity,
    sizePreference,
    priceMin,
    priceMax,
    priority: 'recommended',
    notes: `From existing rules: ${roomType} - ${itemName}`
  }
}

// Determine budget tier
export async function determineBudgetTier({ propertyType = 'apartment', bhk = null, totalBudget = null } = {}) {
  const sizePricing = await getSizePricingFor({ propertyType, bhk })
  if (!sizePricing || !totalBudget) return 'economy'
  
  const budget = Number(totalBudget)
  
  // Parse budget ranges from your table
  const parseBudgetRange = (str) => {
    const s = String(str || '').replace(/[,\s]/g, '')
    const m = s.match(/(\d+)[-–](\d+)/)
    if (m) return { min: Number(m[1]), max: Number(m[2]) }
    return { min: null, max: null }
  }
  
  // Check if your table has budget columns
  if (sizePricing.budget_luxury_min_inr && budget >= sizePricing.budget_luxury_min_inr) {
    return 'luxury'
  }
  if (sizePricing.budget_premium_min_inr && budget >= sizePricing.budget_premium_min_inr) {
    return 'premium'
  }
  
  return 'economy'
}
