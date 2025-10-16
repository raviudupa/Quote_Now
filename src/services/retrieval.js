import { supabase } from '../config/supabase.js'
// Hybrid retrieval using existing DB RPC: search_items_hybrid
// Falls back to exact-only if embeddings are not available.

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY
const DISABLE_EMBED = String(import.meta.env.VITE_DISABLE_EMBED_QUERY || '').toLowerCase() === 'true'
const EMB_MODEL = 'text-embedding-3-small'

async function embedText(text) {
  try {
    if (!OPENAI_API_KEY) return null
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model: EMB_MODEL, input: text })
    })
    if (!res.ok) return null
    const json = await res.json()
    return json?.data?.[0]?.embedding || null
  } catch (e) {
    console.warn('embedText failed (falling back to exact only):', e)
    return null
  }
}

// --------- Simple RAG helpers (filter-only MVP) ---------

// Get top N design rules by room/item (no embeddings yet)
export async function retrieveRules({ roomType = null, itemType = null, limit = 3 }) {
  try {
    let q = supabase.from('design_rules').select('id,title,body_text,room_type,item_type,tags,created_at').limit(Math.max(1, limit))
    if (roomType) q = q.eq('room_type', String(roomType).toLowerCase())
    if (itemType) q = q.eq('item_type', String(itemType).toLowerCase())
    q = q.order('created_at', { ascending: false })
    const { data, error } = await q
    if (error) { console.error('retrieveRules error', error); return [] }
    return data || []
  } catch (e) {
    console.error('retrieveRules failed', e)
    return []
  }
}

// Get a sizing guideline by item/room
export async function retrieveSizing({ itemType, roomType = null, limit = 1 }) {
  try {
    if (!itemType) return []
    let q = supabase.from('sizing_guidelines').select('id,item_type,room_type,rule_text,ranges_json,created_at').eq('item_type', String(itemType).toLowerCase()).limit(Math.max(1, limit))
    if (roomType) q = q.eq('room_type', String(roomType).toLowerCase())
    q = q.order('created_at', { ascending: false })
    const { data, error } = await q
    if (error) { console.error('retrieveSizing error', error); return [] }
    return data || []
  } catch (e) {
    console.error('retrieveSizing failed', e)
    return []
  }
}

// Fetch room templates for seeding
export async function retrieveRoomTemplates({ roomType, theme = null, tier = null, limit = 2 }) {
  try {
    if (!roomType) return []
    let q = supabase.from('room_templates').select('id,room_type,theme,tier,description,items,created_at').eq('room_type', String(roomType).toLowerCase()).limit(Math.max(1, limit))
    if (theme) q = q.eq('theme', String(theme).toLowerCase())
    if (tier) q = q.eq('tier', String(tier))
    q = q.order('created_at', { ascending: false })
    const { data, error } = await q
    if (error) { console.error('retrieveRoomTemplates error', error); return [] }
    return data || []
  } catch (e) {
    console.error('retrieveRoomTemplates failed', e)
    return []
  }
}

// DB-grounded facets for a given type to inform clarifier options
export async function getTypeFacets(type) {
  try {
    if (!type) return { materials: [], subtypes: [], seaters: [], packages: [], priceBands: [] }
    const t = String(type).toLowerCase()
    // Build a simple filter by type token in textual columns
    const typeTokens = t === 'tv_bench' ? ['tv']
      : t === 'bookcase' ? ['bookcase', 'bookshelf']
      : t === 'sofa' ? ['sofa', 'couch', 'sofa-bed']
      : t === 'table' ? ['table', 'coffee', 'side', 'bedside', 'dining']
      : [t.replace('_',' ')]

    // Fetch a bounded sample
    const { data: rows, error } = await supabase
      .from('interior_items')
      .select('item_name,item_description,item_details,keywords,base_material,finish_material,price_inr,packages,price_tier')
      .limit(1000)
    if (error) { console.error('getTypeFacets error', error); return { materials: [], subtypes: [], seaters: [], packages: [], priceBands: [] } }

    const matchType = (r) => {
      const hay = `${r.item_name||''} ${r.item_description||''} ${r.item_details||''} ${r.keywords||''}`.toLowerCase()
      return typeTokens.some(tok => hay.includes(tok))
    }

    const matched = (rows || []).filter(matchType)
    const materialsSet = new Set()
    const subtypesSet = new Set()
    const seatersSet = new Set()
    const packagesSet = new Set()
    let minPrice = Infinity, maxPrice = 0

    const normMat = (s) => {
      const v = String(s||'').toLowerCase()
      if (!v) return null
      if (/fabric|cloth|textile/.test(v)) return 'fabric'
      if (/leather|leatherette|faux/.test(v)) return 'leather'
      if (/glass/.test(v)) return 'glass'
      if (/wood/.test(v)) return 'wooden'
      if (/metal|steel|iron/.test(v)) return 'metal'
      return null
    }
    const inferSubtype = (r) => {
      const h = `${r.item_name||''} ${r.item_description||''} ${r.item_details||''} ${r.keywords||''}`.toLowerCase()
      if (/coffee/.test(h)) return 'coffee'
      if (/(bedside|night\s*stand|side\s*table)/.test(h)) return 'bedside'
      if (/side\s*table/.test(h)) return 'side'
      if (/dining/.test(h)) return 'dining'
      return null
    }
    const inferSeater = (r) => {
      const h = `${r.item_name||''} ${r.item_description||''} ${r.item_details||''} ${r.keywords||''}`.toLowerCase()
      const m = h.match(/(\d+)\s*(?:-\s*)?(?:seater|seat)s?/)
      return m ? parseInt(m[1], 10) : null
    }

    for (const r of matched) {
      const m1 = normMat(r.base_material); if (m1) materialsSet.add(m1)
      const m2 = normMat(r.finish_material); if (m2) materialsSet.add(m2)
      if (t === 'table') { const st = inferSubtype(r); if (st) subtypesSet.add(st) }
      if (t === 'sofa') { const s = inferSeater(r); if (s) seatersSet.add(s) }
      const pkg = String(r.packages || r.price_tier || '').trim()
      if (pkg) {
        if (/economy/i.test(pkg)) packagesSet.add('Economy')
        if (/premium/i.test(pkg)) packagesSet.add('Premium')
        if (/luxury/i.test(pkg)) packagesSet.add('Luxury')
      }
      const p = Number(r.price_inr || 0)
      if (isFinite(p) && p > 0) { if (p < minPrice) minPrice = p; if (p > maxPrice) maxPrice = p }
    }

    // Build price bands around observed min/max
    const bands = []
    if (isFinite(minPrice) && maxPrice > 0) {
      const b1 = 10000, b2 = 20000, b3 = 40000
      const pushIf = (label, upper) => { if (maxPrice >= 1 && (upper == null || minPrice < upper)) bands.push(label) }
      pushIf('under ₹10,000', 10000)
      pushIf('₹10,000–₹20,000', 20000)
      pushIf('₹20,000–₹40,000', 40000)
      bands.push('above ₹40,000')
    }

    return {
      materials: Array.from(materialsSet),
      subtypes: Array.from(subtypesSet),
      seaters: Array.from(seatersSet).sort((a,b)=>a-b),
      packages: Array.from(packagesSet),
      priceBands: bands
    }
  } catch (e) {
    console.error('getTypeFacets failed', e)
    return { materials: [], subtypes: [], seaters: [], packages: [], priceBands: [] }
  }
}

export async function hybridRetrieve({ queryText, mustTokens = [], maxPrice = null, packageFilter = null, similarityThreshold = 0.7, limit = 20 }) {
  // Short-circuit if embeddings are disabled: skip RPC entirely
  if (DISABLE_EMBED) {
    return await exactOnlyFallback({ mustTokens, maxPrice, packageFilter, limit })
  }

  const embedding = queryText ? await embedText(queryText) : null
  const finalEmbedding = embedding // when null, RPC should degrade gracefully; if not, we will fallback
  const params = {
    query_embedding: finalEmbedding,
    must_have_tokens: mustTokens,
    max_price: maxPrice,
    package_filter: packageFilter,
    similarity_threshold: similarityThreshold,
    result_limit: limit
  }
  const { data, error } = await supabase.rpc('search_items_hybrid', params)
  if (!error && data) return data

  // If RPC missing columns (e.g., 42703), or any failure, fall back to exact-only local filtering
  console.error('search_items_hybrid error', error)
  return await exactOnlyFallback({ mustTokens, maxPrice, packageFilter, limit })
}

async function exactOnlyFallback({ mustTokens = [], maxPrice = null, packageFilter = null, limit = 20 }) {
  try {
    const { data: rows, error: selErr } = await supabase
      .from('interior_items')
      .select('id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,packages,price_tier,preferred_theme,suggestive_areas,category,subcategory')
      .limit(500) // keep it bounded
    if (selErr) { console.error('fallback select error', selErr); return [] }

    const tokens = (mustTokens || []).flatMap(t => Array.isArray(t) ? t : [t]).filter(Boolean).map(s => String(s).toLowerCase())
    const passTokens = (row) => {
      if (tokens.length === 0) return true
      const hay = `${row.item_name || ''} ${row.item_description || ''} ${row.item_details || ''} ${row.keywords || ''} ${row.variation_name || ''} ${row.base_material || ''} ${row.finish_material || ''}`.toLowerCase()
      return tokens.every(tok => hay.includes(tok))
    }
    const passPrice = (row) => {
      if (!maxPrice) return true
      const p = Number(row.price_inr || 0)
      return !isNaN(p) && p <= Number(maxPrice)
    }
    const passPackage = (row) => {
      if (!packageFilter) return true
      const a = String(row.packages || '').toLowerCase()
      const b = String(row.price_tier || '').toLowerCase()
      const want = String(packageFilter).toLowerCase()
      return a.includes(want) || b.includes(want)
    }
    const filtered = (rows || []).filter(r => passTokens(r) && passPrice(r) && passPackage(r))
    // Shape similar to RPC rows (must include id)
    return filtered.slice(0, limit)
  } catch (e) {
    console.error('fallback hybrid retrieve failed', e)
    return []
  }
}