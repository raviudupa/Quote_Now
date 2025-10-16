// LangChain tools wrapper for interior-quotation-ai
// These are thin wrappers around existing services so we can plug into an Agent if available.

import { supabase } from '../../config/supabase.js'
import aiService from '../aiService.clean.js'

// Fetch top candidates using the same constraints as findBestItem but without consuming usedItemIds
export async function fetchCandidates({ type, specifications = {}, maxPrice = null, limit = 50 }) {
  const t = (type || '').toLowerCase()
  const specs = specifications || {}
  const baseConds = []
  const add = (kw) => {
    baseConds.push(`item_name.ilike.%${kw}%`)
    baseConds.push(`item_description.ilike.%${kw}%`)
    baseConds.push(`item_details.ilike.%${kw}%`)
    baseConds.push(`variation_name.ilike.%${kw}%`)
    baseConds.push(`base_material.ilike.%${kw}%`)
    baseConds.push(`finish_material.ilike.%${kw}%`)
    baseConds.push(`keywords.ilike.%${kw}%`)
  }
  if (t === 'table' && specs.subtype) {
    add(`${specs.subtype} table`)
    add(specs.subtype)
  } else if (t) {
    add(t.replace('_',' '))
  }
  if (specs.material) add(specs.material)
  if (t === 'sofa' && specs.seater) add(`${specs.seater} seat`)

  let q = supabase
    .from('interior_items')
    .select('id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,category,subcategory')
  if (baseConds.length > 0) q = q.or(baseConds.join(','))
  if (maxPrice) q = q.lte('price_inr', Number(maxPrice))
  const preferHighEnd = maxPrice ? (Number(maxPrice) > 15000) : true
  q = q.order('price_inr', { ascending: !preferHighEnd }).limit(limit)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

// Score candidates using aiService's internal heuristics by calling getAlternatives-like scoring
export function scoreCandidates(rows, { type, specifications = {} }) {
  const specs = specifications || {}
  const mat = String(specs.material || '').toLowerCase()
  const subtype = String(specs.subtype || '').toLowerCase()
  const seater = specs.seater
  const textScore = (r) => {
    const h = `${r.item_name || ''} ${r.item_description || ''} ${r.item_details || ''} ${r.keywords || ''}`.toLowerCase()
    let s = 0
    if (mat && h.includes(mat)) s += 0.5
    if (subtype && h.includes(subtype)) s += 0.5
    if ((type||'').toLowerCase() === 'sofa' && seater && (h.includes(`${seater} seat`) || h.includes(`${seater}-seat`) || h.includes(`${seater} seater`))) s += 0.8
    return s
  }
  return [...(rows||[])].sort((a,b) => textScore(b) - textScore(a))
}

// Get alternatives for a selected line (delegates to aiService)
export async function getAlternativesTool({ line, filters, limit = 3 }) {
  const selectedLine = { line, item: { id: line?.preferredId || null } }
  const alts = await aiService.getAlternatives(selectedLine, filters || {}, { limit })
  return alts
}

// Apply update to a single line spec (returns a new requestedItems array)
export function applyUpdateTool({ requestedItems, type, value }) {
  const items = Array.isArray(requestedItems) ? [...requestedItems] : []
  const normType = String(type || '').toLowerCase().replace(/\s+/g,'_')
  const idx = items.findIndex(it => (it.type || '').toLowerCase() === normType)
  if (idx < 0) return items
  const it = { ...items[idx], specifications: { ...(items[idx].specifications || {}), features: { ...(items[idx].specifications?.features || {}) } } }
  if (normType === 'table' && /(coffee|side|dining|bedside)/.test(value)) it.specifications.subtype = value
  else if (/(glass|wood|wooden|metal|fabric|leather)/.test(value)) it.specifications.material = value.replace('wood','wooden')
  else if (/(small|medium|large)/.test(value)) it.specifications.size = value
  items[idx] = it
  return items
}

// Apply replace by id (returns a new requestedItems array)
export function applyReplaceTool({ requestedItems, type, id }) {
  const items = Array.isArray(requestedItems) ? [...requestedItems] : []
  const normType = String(type || '').toLowerCase().replace(/\s+/g,'_')
  const idx = items.findIndex(it => (it.type || '').toLowerCase() === normType)
  if (idx < 0) return items
  items[idx] = { ...items[idx], preferredId: Number(id) }
  return items
}
