import fallbackStyles from '../data/styles.json'
import { supabase } from '../config/supabase.js'

let _stylesCache = null
let _lastLoad = 0
const CACHE_MS = 5 * 60 * 1000

async function fetchFromDB() {
  try {
    const { data, error } = await supabase
      .from('styles')
      .select('id,name,description,keywords,features,key_features,walls,floors,furniture,decor,fabrics,active')
      .eq('active', true)
    if (error) throw error
    if (!Array.isArray(data)) return null
    // Normalize keywords/features to arrays
    return data.map(row => {
      const toArr = (val, lower=false) => Array.isArray(val)
        ? val.map(x => String(x||'')[lower?'toLowerCase':'trim']()).map(s => lower?s.toLowerCase():s).filter(Boolean)
        : String(val || '')
            .split(',')
            .map(s => s.trim()[lower?'toLowerCase':'toString']?.() || s.trim())
            .map(s => (lower ? String(s).toLowerCase() : String(s)))
            .filter(Boolean)
      const keywords = toArr(row.keywords, true)
      const baseFeatures = toArr(row.features, false)
      const keyFeatures = toArr(row.key_features, false)
      const walls = toArr(row.walls, false)
      const floors = toArr(row.floors, false)
      const furniture = toArr(row.furniture, false)
      const decor = toArr(row.decor, false)
      const fabrics = toArr(row.fabrics, false)
      // Combine distinct features; keep order by priority: key_features > features > others
      const seen = new Set()
      const pushU = (arr, v) => { const s = String(v||'').trim(); if (!s) return; const k = s.toLowerCase(); if (!seen.has(k)) { arr.push(s); seen.add(k) } }
      const combinedFeatures = []
      ;[keyFeatures, baseFeatures, walls, floors, furniture, decor, fabrics].forEach(group => (group||[]).forEach(v => pushU(combinedFeatures, v)))
      return {
        id: String(row.id || '').toLowerCase(),
        name: row.name || String(row.id || '').toUpperCase(),
        description: String(row.description || ''),
        keywords,
        features: combinedFeatures
      }
    })
  } catch (_) {
    return null
  }
}

export async function loadStyles() {
  const now = Date.now()
  if (_stylesCache && (now - _lastLoad) < CACHE_MS) return _stylesCache
  const db = await fetchFromDB()
  _stylesCache = Array.isArray(db) && db.length ? db : fallbackStyles
  _lastLoad = now
  return _stylesCache
}

// Normalize a free-form style/theme string to a canonical style id
export async function normalizeStyle(input) {
  const styles = await loadStyles()
  const t = String(input || '').toLowerCase()
  if (!t) return null
  for (const s of styles) {
    if (s.id === t) return s.id
    if (String(s.name||'').toLowerCase() === t) return s.id
    if ((s.keywords||[]).some(k => t.includes(k))) return s.id
  }
  return null
}

// Derive style bias keywords array (for ranking items) from parsed theme and styleKeywords
export async function deriveStyleBias({ theme, styleKeywords = [] } = {}) {
  const styles = await loadStyles()
  const norm = await normalizeStyle(theme)
  const sdef = styles.find(s => s.id === norm) || null
  const bias = new Set()
  if (sdef) (sdef.keywords||[]).forEach(k => bias.add(String(k||'').toLowerCase()))
  for (const kw of (styleKeywords || [])) {
    const t = String(kw || '').toLowerCase()
    if (!t) continue
    // Match against all style buckets and add related keywords
    for (const s of styles) {
      if ((s.keywords||[]).some(k => t.includes(k))) {
        (s.keywords||[]).forEach(k => bias.add(String(k||'').toLowerCase()))
      }
    }
  }
  return Array.from(bias)
}

export async function getStyleProfile({ theme, styleKeywords = [] } = {}) {
  const styles = await loadStyles()
  const id = await normalizeStyle(theme)
  const sdef = styles.find(s => s.id === id) || null
  if (!sdef) return null
  return { id: sdef.id, name: sdef.name, features: (sdef.features||[]).slice(0, 3), description: sdef.description || '' }
}

// Weighted bias from style buckets. Higher weight = stronger preference in ranking
export async function deriveStyleWeights({ theme, styleKeywords = [] } = {}) {
  const styles = await loadStyles()
  const id = await normalizeStyle(theme)
  const sdef = styles.find(s => s.id === id) || null
  const weights = new Map()
  const add = (k, w=1) => { const t = String(k||'').toLowerCase(); if (!t) return; weights.set(t, (weights.get(t) || 0) + w) }
  if (sdef) {
    // Derive rough buckets by matching combined features to likely sources
    // We don't have the original buckets here (they were merged). Use heuristics:
    const kws = Array.isArray(sdef.keywords) ? sdef.keywords : []
    const feats = Array.isArray(sdef.features) ? sdef.features : []
    for (const k of kws) add(k, 2) // keywords moderate weight
    // First few features are more important
    feats.slice(0, 3).forEach(f => add(f, 3))
    feats.slice(3).forEach(f => add(f, 1))
  }
  // Also mix in user-provided styleKeywords lightly
  for (const k of (styleKeywords||[])) add(k, 1)
  // Convert to array of { key, weight } for portability, but consumers may accept Map/object too
  return Array.from(weights.entries()).map(([key, weight]) => ({ key, weight }))
}

// Derive negatives (avoid-list). If your DB adds a 'negatives' column, include it in fetchFromDB and here.
export async function deriveNegatives({ theme } = {}) {
  const styles = await loadStyles()
  const id = await normalizeStyle(theme)
  const sdef = styles.find(s => s.id === id) || null
  const negatives = []
  // If your DB has sdef.negatives, prefer that. Otherwise infer some generic opposites.
  // Minimalist: avoid ornate, heavy carving; Industrial: avoid frilly, floral.
  const name = String(sdef?.name || '').toLowerCase()
  if (/minimal/.test(name)) negatives.push('ornate','heavy carving','baroque','floral')
  if (/industrial/.test(name)) negatives.push('floral','pastel','ornate')
  if (/scandinav/.test(name)) negatives.push('baroque','heavy carving')
  if (/traditional/.test(name)) negatives.push('ultra-modern')
  return Array.from(new Set(negatives.map(s => String(s).toLowerCase()).filter(Boolean)))
}

// Produce 2-3 room-specific hints from style name/features to guide subtype/feature choices
export async function deriveRoomHints({ theme, room } = {}) {
  const id = await normalizeStyle(theme)
  const styles = await loadStyles()
  const sdef = styles.find(s => s.id === id) || null
  const out = []
  const feats = Array.isArray(sdef?.features) ? sdef.features.map(x=>String(x).toLowerCase()) : []
  const name = String(sdef?.name || '').toLowerCase()
  const add = (s) => { s = String(s||'').trim(); if (s && !out.includes(s)) out.push(s) }
  const has = (kw) => feats.some(f => f.includes(kw)) || name.includes(kw)
  const r = String(room||'').toLowerCase()
  if (r === 'living') {
    if (has('industrial') || has('metal')) { add('metal frame'); add('exposed bulb') }
    if (has('minimal')) { add('low-profile'); add('neutral fabric') }
    if (has('scandinav')) { add('light wood'); add('linen fabric') }
  } else if (r === 'bedroom') {
    if (has('industrial')) { add('leather'); add('black metal') }
    if (has('minimal')) { add('handle-less'); add('matte') }
    if (has('scandinav')) { add('oak'); add('textured fabric') }
  } else if (r === 'dining') {
    if (has('industrial')) { add('solid wood top'); add('metal legs') }
    if (has('minimal')) { add('slim profile'); add('neutral finish') }
  }
  return out.slice(0, 3)
}

// --- Multi-style helpers (themes: [{ name, weight }]) ---
function normThemes(themes = []) {
  const arr = Array.isArray(themes) ? themes : []
  const cleaned = arr
    .map(t => ({ name: String(t?.name||t||'').trim(), weight: Number(t?.weight||1) || 1 }))
    .filter(t => t.name)
  const sum = cleaned.reduce((s, t) => s + (t.weight || 0), 0) || 1
  return cleaned.map(t => ({ ...t, weight: (t.weight || 1) / sum }))
}

export async function blendStyleWeights({ themes = [], styleKeywords = [] } = {}) {
  const tlist = normThemes(themes)
  if (!tlist.length) return []
  const weights = new Map()
  for (const t of tlist) {
    const part = await deriveStyleWeights({ theme: t.name, styleKeywords })
    for (const { key, weight } of (part || [])) {
      const k = String(key||'').toLowerCase()
      if (!k) continue
      weights.set(k, (weights.get(k) || 0) + (Number(weight||1) * t.weight))
    }
  }
  const maxW = Math.max(1, ...Array.from(weights.values()))
  return Array.from(weights.entries()).map(([key, w]) => ({ key, weight: Math.max(1, Math.round((w / maxW) * 3)) }))
}

export async function blendNegatives({ themes = [] } = {}) {
  const tlist = normThemes(themes)
  const out = new Set()
  for (const t of tlist) {
    const neg = await deriveNegatives({ theme: t.name })
    for (const n of (neg || [])) out.add(String(n||'').toLowerCase())
  }
  return Array.from(out)
}

export async function blendRoomHints({ themes = [], room } = {}) {
  const tlist = normThemes(themes)
  const out = new Set()
  for (const t of tlist) {
    const hints = await deriveRoomHints({ theme: t.name, room })
    for (const h of (hints || [])) out.add(String(h||'').toLowerCase())
  }
  return Array.from(out).slice(0, 3)
}
