import { supabase } from '../config/supabase.js'
import { runPipelineV2 } from './graph/stateFlow.v2.js'
import { deriveItemConstraints } from './propertyRulesLegacy.js'

class QuotationAIServiceV2 {
  constructor() {
    this._sessionPrior = new Map()
  }

  getPrior(sessionId) {
    return this._sessionPrior.get(sessionId) || null
  }

  setPrior(sessionId, prior) {
    if (!sessionId) return
    this._sessionPrior.set(sessionId, prior || {})
  }
  resolveCategory(type, specs = {}) {
    const t = String(type || '').toLowerCase()
    const CATEGORY_MAP = {
      'sofa': 'Sofa',
      'sofa_bed': 'Sofa-bed',
      'tv_bench': 'Tv-bench',
      'table': 'Table',
      'chair': 'Chair',
      'bed': 'Bed',
      'wardrobe': 'Wardrobe',
      'mirror': 'Mirror',
      'mirror_cabinet': 'Mirror cabinet',
      'cabinet': 'Cabinet',
      'bookcase': 'Bookcase',
      'shelf': 'Shelf',
      'storage_combination': 'Storage combination',
      'stool': 'Stool',
      'lamp': 'Lamp',
      'shoe_rack': 'Shoe rack',
      'washstand': 'Wash-stand',
      'desk': 'Desk',
      'drawer': 'Drawer',
      'bedside_table': 'Table',
      'dresser': 'Drawer',
      'storage_rack': 'Shelf',
      'towel_rod': 'Shelf',
      'bedside_lamp': 'Lamp',
    }
    let category = CATEGORY_MAP[t] || null
    let subcategoryLike = null
    if (t === 'table' || t === 'bedside_table') {
      const sub = String(specs?.subtype || '').toLowerCase()
      if (/(coffee)/.test(sub)) subcategoryLike = 'coffee'
      else if (/(dining)/.test(sub)) subcategoryLike = 'dining'
      else if (/(side)/.test(sub)) subcategoryLike = 'side'
      else if (/(bedside)/.test(sub)) subcategoryLike = 'bedside'
      if (t === 'bedside_table' && !subcategoryLike) subcategoryLike = 'bedside'
    }
    if (!category) {
      if (/sofa[_\s-]?bed/.test(t)) { category = 'Sofa-bed' }
      else if (/tv[_\s-]?bench|tv[_\s-]?unit|tv[_\s-]?stand/.test(t)) { category = 'Tv-bench' }
      else if (/bedside[_\s-]?table/.test(t)) { category = 'Table'; subcategoryLike = subcategoryLike || 'bedside' }
      else if (/dining[_\s-]?table/.test(t)) { category = 'Table'; subcategoryLike = subcategoryLike || 'dining' }
      else if (/chair/.test(t)) { category = 'Chair' }
      else if (/drawer|dresser|chest/.test(t)) { category = 'Drawer' }
      else if (/rack|shelf|shelving/.test(t)) { category = 'Shelf' }
      else if (/shoe[_\s-]?rack/.test(t)) { category = 'Shoe rack' }
      else if (/mirror[_\s-]?cabinet/.test(t)) { category = 'Mirror cabinet' }
      else if (/lamp|light/.test(t)) { category = 'Lamp' }
    }
    return { category, subcategoryLike }
  }

  async fetchItemById(id) {
    try {
      const { data } = await supabase.from('interior_items').select('*').eq('id', Number(id)).single()
      return data || null
    } catch (_) {
      return null
    }
  }

  async findBestItem(line, filters = {}, usedItemIds = new Set()) {
    const type = String(line?.type || '').toLowerCase()
    const specs = line?.specifications || {}
    const roomName = String(line?.room || '')
    
    // Apply property-specific rules if context is available
    let ruleConstraints = null
    try {
      const propCtx = filters?.propertyContext || {}
      if (propCtx.propertyType && propCtx.bhk) {
        const itemSubtype = specs?.subtype || null
        ruleConstraints = await deriveItemConstraints({
          propertyType: propCtx.propertyType,
          bhk: propCtx.bhk,
          roomName,
          itemType: type,
          itemSubtype
        })
      }
    } catch (e) {
      console.warn('[aiService.v2] deriveItemConstraints failed', e?.message || e)
    }
    
    // Prefer a per-line cap coming from the pipeline (e.g., scaled by BHK)
    const lineCap = Number(line?._maxPrice || 0) || null
    // Apply rule-based price constraints if available
    const rulePriceMax = ruleConstraints?.priceMax || null
    const maxPrice = lineCap || rulePriceMax || (Number(filters?.maxPrice || 0) || null)
    
    try {
      // If user requested a specific item id (via replace/add with id), respect it
      if (line?.preferredId) {
        const item = await this.fetchItemById(line.preferredId)
        if (item) {
          if (!usedItemIds.has(item.id)) usedItemIds.add(item.id)
          return { item, reason: 'preferred' }
        }
      }

      const { category, subcategoryLike } = this.resolveCategory(type, specs)

      const runQuery = async (priceCap) => {
        let q = supabase
          .from('interior_items')
          .select('id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,category,subcategory')
        if (category) q = q.ilike('category', category)
        if (subcategoryLike) q = q.ilike('subcategory', `%${subcategoryLike}%`)
        if (priceCap) q = q.lte('price_inr', priceCap)
        // Wider window improves chances to satisfy seat-count constraints
        q = q.order('price_inr', { ascending: !Boolean(priceCap) ? true : false }).limit(100)
        const { data } = await q
        return Array.isArray(data) ? data : []
      }

      let rows = await runQuery(maxPrice)
      
      // Apply size preference filter from property rules (e.g., queen/king bed for master bedroom)
      if (ruleConstraints?.sizePreference && Array.isArray(rows) && rows.length > 0) {
        const sizePref = String(ruleConstraints.sizePreference).toLowerCase()
        const textOf = (r) => `${r?.item_name||''} ${r?.item_description||''} ${r?.item_details||''} ${r?.variation_name||''} ${r?.subcategory||''} ${r?.keywords||''}`.toLowerCase()
        const matchesSize = (r) => {
          const txt = textOf(r)
          // For beds: queen, king, super_king
          if (type === 'bed') {
            if (sizePref === 'queen' && /queen/.test(txt)) return true
            if (sizePref === 'king' && /\bking\b/.test(txt) && !/queen/.test(txt)) return true
            if (sizePref === 'super_king' && /(super\s*king|super-king)/.test(txt)) return true
          }
          // For other items: small, medium, large
          if (/small/.test(sizePref) && /small/.test(txt)) return true
          if (/medium/.test(sizePref) && /medium/.test(txt)) return true
          if (/large/.test(sizePref) && /large/.test(txt)) return true
          return false
        }
        const sizeMatches = rows.filter(matchesSize)
        if (sizeMatches.length > 0) rows = sizeMatches
      }
      
      // Re-rank by style bias when provided; supports weighted positives, negatives, and room hints.
      try {
        const flatBias = Array.isArray(filters?.styleBias) ? filters.styleBias : []
        const bias = flatBias.map(x => (typeof x === 'string' ? { key: x.toLowerCase(), weight: 1 } : { key: String(x?.key||'').toLowerCase(), weight: Number(x?.weight||1) || 1 }))
          .filter(x => x.key)
        const negatives = Array.isArray(filters?.styleNegatives) ? filters.styleNegatives.map(s=>String(s||'').toLowerCase()).filter(Boolean) : []
        const roomHints = Array.isArray(filters?.roomHints) ? filters.roomHints.map(s=>String(s||'').toLowerCase()).filter(Boolean) : []
        if ((bias.length || negatives.length || roomHints.length) && Array.isArray(rows) && rows.length) {
          const textOf = (r) => `${r?.item_name||''} ${r?.item_description||''} ${r?.item_details||''} ${r?.variation_name||''} ${r?.category||''} ${r?.subcategory||''} ${r?.keywords||''}`.toLowerCase()
          const score = (r) => {
            const t = textOf(r)
            let s = 0
            for (const b of bias) if (b?.key && t.includes(b.key)) s += b.weight
            // small cap for hints to avoid dwarfing weights
            let hintHits = 0
            for (const h of roomHints) if (h && t.includes(h)) hintHits += 1
            s += Math.min(2, hintHits)
            for (const neg of negatives) if (neg && t.includes(neg)) s -= 2
            return s
          }
          const scored = rows.map(r => ({ r, s: score(r) }))
          const positives = scored.filter(x => x.s > 0)
          const pool = positives.length ? positives : scored
          rows = pool
            .sort((a,b) => (b.s - a.s) || (Number(b.r.price_inr||0) - Number(a.r.price_inr||0)))
            .map(x => x.r)
        }
      } catch {}
      // Sofa seaters preference by BHK
      if (type === 'sofa' && Number(line?._bhk || 0) > 0) {
        const bhk = Number(line._bhk)
        const minSeats = (bhk >= 3 ? 4 : 3)
        const srcText = (r) => `${r?.item_name||''} ${r?.item_description||''} ${r?.item_details||''} ${r?.variation_name||''} ${r?.subcategory||''} ${r?.keywords||''}`.toLowerCase()
        const parseSeats = (r) => {
          const src = srcText(r)
          // prefer patterns like '3-seat', '4 seater', '2 seat'
          let m = src.match(/(\d+)\s*(?:-?\s*seat(?:er)?|\s*seater)/)
          if (m && m[1]) return Number(m[1])
          // fallback: common patterns like '3-seat'
          const m2 = src.match(/(\d+)\s*-?\s*seat/)
          if (m2 && m2[1]) return Number(m2[1])
          return null
        }
        const withSeats = rows.map(r => ({ r, seats: parseSeats(r) }))
        // Primary: enforce minimum seats
        let eligible = withSeats.filter(x => (x.seats != null && x.seats >= minSeats))
        // Secondary: for BHK>=3, try to exclude explicit 1/2-seaters even if seat count is unknown
        if (bhk >= 3 && eligible.length === 0) {
          const notSmall = withSeats.filter(x => {
            const s = srcText(x.r)
            const twoSeat = /(\b2\s*(?:-?\s*seat(?:er)?|\s*seater)\b)/.test(s)
            const oneSeat = /(\b1\s*(?:-?\s*seat(?:er)?|\s*seater)\b)/.test(s)
            return !(twoSeat || oneSeat)
          })
          if (notSmall.length > 0) eligible = notSmall
        }
        if (eligible.length > 0) {
          // Keep order (already price-sorted), but only eligible
          rows = eligible.map(x => x.r)
        } else {
          // No sofa meets min seats; pick the highest seat count available to avoid 2-seat when 3-seat exists
          // For higher BHKs, first try relaxing the price cap before giving up
          if (bhk >= 3) {
            const relaxedCap = maxPrice ? Math.round(Number(maxPrice) * 1.5) : null
            if (relaxedCap && relaxedCap !== maxPrice) {
              const rows2 = await runQuery(relaxedCap)
              const withSeats2 = rows2.map(r => ({ r, seats: parseSeats(r) }))
              let eligible2 = withSeats2.filter(x => (x.seats != null && x.seats >= minSeats))
              if (eligible2.length === 0) {
                // Try the not-small heuristic
                const notSmall2 = withSeats2.filter(x => {
                  const s = srcText(x.r)
                  const twoSeat = /(\b2\s*(?:-?\s*seat(?:er)?|\s*seater)\b)/.test(s)
                  const oneSeat = /(\b1\s*(?:-?\s*seat(?:er)?|\s*seater)\b)/.test(s)
                  return !(twoSeat || oneSeat)
                })
                if (notSmall2.length > 0) eligible2 = notSmall2
              }
              if (eligible2.length > 0) {
                rows = eligible2.map(x => x.r)
              }
            }
            // Final attempt: drop cap entirely and prefer sectional/chaise/corner or highest seat count
            if (!rows || rows.length === 0) {
              const rows3 = await runQuery(null)
              const withSeats3 = rows3.map(r => ({ r, seats: parseSeats(r) }))
              // Prefer sectional-like forms as proxy for larger seating
              const isBigShape = (r) => /(sectional|chaise|corner|l[-\s]?shape|u[-\s]?shape|modular)/.test(srcText(r))
              let eligible3 = withSeats3.filter(x => (x.seats != null && x.seats >= minSeats))
              if (eligible3.length === 0) {
                const shapeFav = withSeats3.filter(x => isBigShape(x.r))
                if (shapeFav.length > 0) eligible3 = shapeFav
              }
              if (eligible3.length === 0) {
                // Exclude explicit 1/2 seaters if any other exists
                const notSmall3 = withSeats3.filter(x => {
                  const s = srcText(x.r)
                  const twoSeat = /(\b2\s*(?:-?\s*seat(?:er)?|\s*seater)\b)/.test(s)
                  const oneSeat = /(\b1\s*(?:-?\s*seat(?:er)?|\s*seater)\b)/.test(s)
                  return !(twoSeat || oneSeat)
                })
                if (notSmall3.length > 0) eligible3 = notSmall3
              }
              if (eligible3.length > 0) {
                // Choose highest seat count, then highest price within that
                const maxS = eligible3.reduce((acc, x) => (x.seats != null ? Math.max(acc, x.seats) : acc), -1)
                const bestSeats = maxS > 0 ? eligible3.filter(x => x.seats === maxS) : eligible3
                bestSeats.sort((a, b) => (Number(b.r.price_inr||0) - Number(a.r.price_inr||0)))
                rows = bestSeats.map(x => x.r)
              } else {
                // As absolute fallback, just pick highest price result
                const sorted = rows3.slice().sort((a,b)=>Number(b.price_inr||0)-Number(a.price_inr||0))
                rows = sorted
              }
            }
          }
          // If still nothing, pick the highest seat count available to avoid 2-seat when a 3-seat exists
          if (rows === null || rows.length === 0 || rows === undefined) rows = withSeats.map(x => x.r)
          const maxSeats = withSeats.reduce((acc, x) => (x.seats != null ? Math.max(acc, x.seats) : acc), -1)
          if (maxSeats > 0) rows = withSeats.filter(x => x.seats === maxSeats).map(x => x.r)
        }
      }
      // Diversify on style change: avoid previous item id when scores tie
      const key = `${type}|${String(specs?.subtype || '').toLowerCase()}`
      const avoidId = (filters?.diversifyOnStyleChange && filters?.prevItemIdByKey) ? Number(filters.prevItemIdByKey[key] || 0) : 0
      let pick = null
      if (Array.isArray(rows) && rows.length > 0) {
        if (avoidId) {
          pick = rows.find(r => r.id !== avoidId && !usedItemIds.has(r.id))
              || rows.find(r => r.id !== avoidId)
              || rows.find(r => !usedItemIds.has(r.id))
              || rows[0]
        } else {
          pick = rows.find(r => !usedItemIds.has(r.id)) || rows[0]
        }
      }
      if (pick) usedItemIds.add(pick.id)
      return { item: pick, reason: pick ? 'ok' : 'no_match' }
    } catch (e) {
      return { item: null, reason: 'error' }
    }
  }

  async getAlternatives(selectedLine, _filters, { limit = 500, offset = 0 } = {}) {
    try {
      const type = (selectedLine?.line?.type || '').toLowerCase()
      const specs = selectedLine?.line?.specifications || {}
      const room = String(selectedLine?.line?.room || '').toLowerCase()
      const { category, subcategoryLike } = this.resolveCategory(type, specs)
      let q = supabase
        .from('interior_items')
        .select('id,item_name,item_description,item_details,price_inr,category,subcategory')
      // Alternatives filtering:
      // - Always match category
      // - For tables: restrict by subtype when available (dining/coffee/side/bedside)
      // - For chairs: restrict by room to armchairs for living/balcony, dining chairs for dining
      if (category) q = q.ilike('category', category)
      if (type === 'table') {
        const sub = String(specs?.subtype || '').toLowerCase()
        if (sub) q = q.ilike('subcategory', `%${sub}%`)
      } else if (type === 'chair') {
        if (room === 'living' || room === 'balcony') {
          q = q.ilike('subcategory', '%armchair%')
        } else if (room === 'dining') {
          q = q.ilike('subcategory', '%dining%')
        }
      } else if (subcategoryLike) {
        // Generic fallback if resolveCategory inferred a subcategory
        q = q.ilike('subcategory', `%${subcategoryLike}%`)
      }
      // Return a large list by default; UI can paginate if needed
      const start = Math.max(0, offset)
      const end = start + Math.max(1, limit) - 1
      q = q.order('price_inr', { ascending: true }).range(start, end)
      const { data, error } = await q
      if (error || !Array.isArray(data)) return []
      const curId = selectedLine?.item?.id || null
      let out = data.filter(r => r.id !== curId)
      // Style-aware re-ranking for alternatives; supports weighted positives, negatives, room hints
      try {
        const flatBias = Array.isArray(_filters?.styleBias) ? _filters.styleBias : []
        const bias = flatBias.map(x => (typeof x === 'string' ? { key: x.toLowerCase(), weight: 1 } : { key: String(x?.key||'').toLowerCase(), weight: Number(x?.weight||1) || 1 }))
          .filter(x => x.key)
        const negatives = Array.isArray(_filters?.styleNegatives) ? _filters.styleNegatives.map(s=>String(s||'').toLowerCase()).filter(Boolean) : []
        const roomHints = Array.isArray(_filters?.roomHints) ? _filters.roomHints.map(s=>String(s||'').toLowerCase()).filter(Boolean) : []
        if ((bias.length || negatives.length || roomHints.length) && out.length) {
          const textOf = (r) => `${r?.item_name||''} ${r?.item_description||''} ${r?.item_details||''} ${r?.subcategory||''}`.toLowerCase()
          const score = (r) => {
            const t = textOf(r)
            let s = 0
            for (const b of bias) if (b?.key && t.includes(b.key)) s += b.weight
            let hintHits = 0
            for (const h of roomHints) if (h && t.includes(h)) hintHits += 1
            s += Math.min(2, hintHits)
            for (const neg of negatives) if (neg && t.includes(neg)) s -= 2
            return s
          }
          const scored = out.map(r => ({ r, s: score(r) }))
          const positives = scored.filter(x => x.s > 0)
          const pool = positives.length ? positives : scored
          out = pool
            .sort((a,b) => (b.s - a.s) || (Number(a.r.price_inr||0) - Number(b.r.price_inr||0)))
            .map(x => x.r)
        }
      } catch {}
      return out
    } catch (_) {
      return []
    }
  }

  async processChat(userMessage, opts = {}) {
    try {
      const sessionId = opts?.sessionId || 'default'
      const res = await runPipelineV2(this, sessionId, userMessage, { onProgress: opts?.onProgress })
      // Persist minimal prior for subsequent replace/remove/qty commands
      if (res && sessionId) {
        const prior = {
          selections: Array.isArray(res.selections) ? res.selections : [],
          filters: res.filters || {},
          llmSummary: res.llmSummary || null
        }
        this.setPrior(sessionId, prior)
      }
      return res || { message: '', items: [], totalEstimate: 0 }
    } catch (e) {
      console.error('processChat v2 error:', e)
      return { message: 'I am having trouble processing your request. Please try again.', items: [], totalEstimate: 0 }
    }
  }
}

export default new QuotationAIServiceV2()
