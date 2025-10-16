import { supabase } from '../config/supabase.js'

let _catCache = null
let _subCache = null
let _suggestCache = new Map()
let _ts = 0
const CACHE_MS = 5 * 60 * 1000

async function fetchDistinct(column) {
  const { data, error } = await supabase.from('interior_items').select(column)
  if (error || !Array.isArray(data)) return []
  const vals = data.map(r => String(r?.[column] || '').trim()).filter(Boolean)
  return Array.from(new Set(vals))
}

export async function getDistinctCategories() {
  const now = Date.now()
  if (_catCache && (now - _ts) < CACHE_MS) return _catCache
  _catCache = await fetchDistinct('category')
  _ts = now
  return _catCache
}

export async function getDistinctSubcategories() {
  const now = Date.now()
  if (_subCache && (now - _ts) < CACHE_MS) return _subCache
  _subCache = await fetchDistinct('subcategory')
  _ts = now
  return _subCache
}

// Simple room -> preferred categories map as a fallback
const ROOM_DEFAULTS = {
  living: ['Sofa', 'Tv-bench', 'Table', 'Lamp', 'Chair'],
  bedroom: ['Bed', 'Wardrobe', 'Table', 'Mirror', 'Lamp'],
  kitchen: ['Cabinet', 'Shelf', 'Table'],
  bathroom: ['Wash-stand', 'Mirror', 'Shelf'],
  dining: ['Table', 'Chair', 'Cabinet'],
  balcony: ['Chair', 'Table'],
  study: ['Desk', 'Chair', 'Shelf'],
  foyer: ['Cabinet', 'Mirror']
}

export async function getRoomScopedSuggestions(room, { styleBias = [] } = {}) {
  const key = `${room}|${(styleBias||[]).join(',')}`
  const now = Date.now()
  const cached = _suggestCache.get(key)
  if (cached && (now - cached.ts) < CACHE_MS) return cached.val

  // Fetch a lightweight slice and rank by style keywords
  const { data, error } = await supabase
    .from('interior_items')
    .select('category,subcategory,item_name,item_description,item_details,keywords')
    .order('price_inr', { ascending: true })
    .limit(200)
  const rows = (error || !Array.isArray(data)) ? [] : data

  const bias = (Array.isArray(styleBias) ? styleBias : []).map(s => String(s||'').toLowerCase()).filter(Boolean)
  const textOf = (r) => `${r?.item_name||''} ${r?.item_description||''} ${r?.item_details||''} ${r?.keywords||''}`.toLowerCase()
  const score = (r) => {
    const t = textOf(r)
    let s = 0
    for (const k of bias) if (k && t.includes(k)) s += 1
    return s
  }
  const catScores = new Map()
  const subScores = new Map()
  for (const r of rows) {
    const c = String(r?.category || '').trim()
    const sc = String(r?.subcategory || '').trim()
    const s = score(r)
    if (c) catScores.set(c, (catScores.get(c) || 0) + s)
    if (sc) subScores.set(sc, (subScores.get(sc) || 0) + s)
  }

  // Merge room defaults at the top
  const defaults = ROOM_DEFAULTS[String(room||'').toLowerCase()] || []
  const rankedCats = Array.from(catScores.entries()).sort((a,b)=>b[1]-a[1]).map(([k])=>k)
  const rankedSubs = Array.from(subScores.entries()).sort((a,b)=>b[1]-a[1]).map(([k])=>k)
  const merged = Array.from(new Set([ ...defaults, ...rankedCats, ...rankedSubs ]))

  const val = merged.slice(0, 12)
  _suggestCache.set(key, { ts: now, val })
  return val
}
