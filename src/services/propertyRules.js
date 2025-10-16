import { supabase } from '../config/supabase.js'

let _sizePricingCache = null
let _aptRulesCache = null
let _villaRulesCache = null
let _cacheTs = 0
const CACHE_MS = 10 * 60 * 1000 // 10 minutes

// Parse room name to extract type and subtype
// Examples: "master bedroom" -> {type: "bedroom", subtype: "master"}
//           "attached bathroom" -> {type: "bathroom", subtype: "attached"}
//           "living" -> {type: "living", subtype: null}
export function parseRoomName(roomName) {
  const s = String(roomName || '').toLowerCase().trim()
  if (!s) return { type: null, subtype: null }
  
  // Bedroom patterns
  if (/bedroom/.test(s)) {
    if (/master/.test(s)) return { type: 'bedroom', subtype: 'master' }
    if (/guest/.test(s)) return { type: 'bedroom', subtype: 'guest' }
    if (/kids?/.test(s)) return { type: 'bedroom', subtype: 'kids' }
    return { type: 'bedroom', subtype: null }
  }
  
  // Bathroom patterns
  if (/bathroom|bath/.test(s)) {
    if (/attached|ensuite|en-suite/.test(s)) return { type: 'bathroom', subtype: 'attached' }
    if (/common|shared/.test(s)) return { type: 'bathroom', subtype: 'common' }
    if (/powder/.test(s)) return { type: 'bathroom', subtype: 'powder' }
    return { type: 'bathroom', subtype: null }
  }
  
  // Other rooms
  if (/living|lounge|hall/.test(s)) return { type: 'living', subtype: null }
  if (/kitchen/.test(s)) return { type: 'kitchen', subtype: null }
  if (/dining/.test(s)) return { type: 'dining', subtype: null }
  if (/balcony/.test(s)) return { type: 'balcony', subtype: null }
  if (/foyer|entry|entrance/.test(s)) return { type: 'foyer', subtype: null }
  if (/study|office/.test(s)) return { type: 'study', subtype: null }
  if (/utility|laundry/.test(s)) return { type: 'utility', subtype: null }
  if (/garden/.test(s)) return { type: 'garden', subtype: null }
  
  return { type: s, subtype: null }
}

// Fetch size and pricing rules
async function fetchSizePricing() {
  try {
    const { data, error } = await supabase
      .from('size_and_pricing')
      .select('*')
      .eq('active', true)
    if (error) throw error
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('[propertyRules] fetchSizePricing failed', e?.message || e)
    return []
  }
}

// Fetch apartment rules
async function fetchApartmentRules() {
  try {
    const { data, error } = await supabase
      .from('rules_for_apartment')
      .select('*')
      .eq('active', true)
    if (error) throw error
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('[propertyRules] fetchApartmentRules failed', e?.message || e)
    return []
  }
}

// Fetch villa rules
async function fetchVillaRules() {
  try {
    const { data, error } = await supabase
      .from('rules_for_villa')
      .select('*')
      .eq('active', true)
    if (error) throw error
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('[propertyRules] fetchVillaRules failed', e?.message || e)
    return []
  }
}

// Load all rules with caching
export async function loadPropertyRules() {
  const now = Date.now()
  if (_sizePricingCache && _aptRulesCache && _villaRulesCache && (now - _cacheTs) < CACHE_MS) {
    return {
      sizePricing: _sizePricingCache,
      apartmentRules: _aptRulesCache,
      villaRules: _villaRulesCache
    }
  }
  
  const [sizePricing, apartmentRules, villaRules] = await Promise.all([
    fetchSizePricing(),
    fetchApartmentRules(),
    fetchVillaRules()
  ])
  
  _sizePricingCache = sizePricing
  _aptRulesCache = apartmentRules
  _villaRulesCache = villaRules
  _cacheTs = now
  
  return { sizePricing, apartmentRules, villaRules }
}

// Get size and pricing info for a specific configuration
export async function getSizePricingFor({ propertyType = 'apartment', bhk = null } = {}) {
  const { sizePricing } = await loadPropertyRules()
  const config = bhk ? `${bhk} BHK` : null
  
  const matches = sizePricing.filter(sp => {
    const typeMatch = String(sp.property_type || '').toLowerCase() === String(propertyType).toLowerCase()
    const configMatch = !config || String(sp.configuration || '').toLowerCase().includes(String(config).toLowerCase())
    return typeMatch && configMatch
  })
  
  return matches[0] || null
}

// Get item rules for a specific room in a property configuration
export async function getRulesForRoom({ propertyType = 'apartment', bhk = null, roomType, roomSubtype = null } = {}) {
  const { apartmentRules, villaRules } = await loadPropertyRules()
  const rules = propertyType === 'villa' ? villaRules : apartmentRules
  const config = bhk ? `${bhk} BHK` : null
  
  const matches = rules.filter(r => {
    const configMatch = !config || String(r.configuration || '').toLowerCase().includes(String(config).toLowerCase())
    const roomMatch = String(r.room_type || '').toLowerCase() === String(roomType || '').toLowerCase()
    const subtypeMatch = !roomSubtype || !r.room_subtype || String(r.room_subtype || '').toLowerCase() === String(roomSubtype).toLowerCase()
    return configMatch && roomMatch && subtypeMatch
  })
  
  return matches
}

// Get specific rule for an item category in a room
export async function getRuleForItem({ propertyType = 'apartment', bhk = null, roomType, roomSubtype = null, itemCategory, itemSubcategory = null } = {}) {
  const roomRules = await getRulesForRoom({ propertyType, bhk, roomType, roomSubtype })
  
  const match = roomRules.find(r => {
    const catMatch = String(r.item_category || '').toLowerCase() === String(itemCategory || '').toLowerCase()
    const subcatMatch = !itemSubcategory || !r.item_subcategory || String(r.item_subcategory || '').toLowerCase() === String(itemSubcategory).toLowerCase()
    return catMatch && subcatMatch
  })
  
  return match || null
}

// Derive constraints for item selection based on property rules
export async function deriveItemConstraints({ propertyType = 'apartment', bhk = null, roomName, itemType, itemSubtype = null } = {}) {
  const { type: roomType, subtype: roomSubtype } = parseRoomName(roomName)
  if (!roomType) return null
  
  // Map item type to category (same logic as aiService.v2)
  const CATEGORY_MAP = {
    'sofa': 'Sofa', 'sofa_bed': 'Sofa-bed', 'tv_bench': 'Tv-bench',
    'table': 'Table', 'chair': 'Chair', 'bed': 'Bed', 'wardrobe': 'Wardrobe',
    'mirror': 'Mirror', 'cabinet': 'Cabinet', 'bookcase': 'Bookcase',
    'shelf': 'Shelf', 'lamp': 'Lamp', 'washstand': 'Wash-stand'
  }
  const itemCategory = CATEGORY_MAP[String(itemType || '').toLowerCase()] || null
  if (!itemCategory) return null
  
  const rule = await getRuleForItem({
    propertyType,
    bhk,
    roomType,
    roomSubtype,
    itemCategory,
    itemSubcategory: itemSubtype
  })
  
  if (!rule) return null
  
  return {
    minQuantity: rule.min_quantity || null,
    maxQuantity: rule.max_quantity || null,
    recommendedQuantity: rule.recommended_quantity || null,
    sizePreference: rule.size_preference || null,
    priceMin: rule.price_range_min_inr || null,
    priceMax: rule.price_range_max_inr || null,
    priority: rule.priority || 'optional',
    notes: rule.notes || null
  }
}

// Determine budget tier based on total budget and property configuration
export async function determineBudgetTier({ propertyType = 'apartment', bhk = null, totalBudget = null } = {}) {
  const sizePricing = await getSizePricingFor({ propertyType, bhk })
  if (!sizePricing || !totalBudget) return 'economy'
  
  const budget = Number(totalBudget)
  
  // Check luxury tier
  if (sizePricing.budget_luxury_min_inr && budget >= sizePricing.budget_luxury_min_inr) {
    return 'luxury'
  }
  
  // Check premium tier
  if (sizePricing.budget_premium_min_inr && budget >= sizePricing.budget_premium_min_inr) {
    return 'premium'
  }
  
  return 'economy'
}
