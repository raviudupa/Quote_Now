// Lightweight NLU + RAG-ish enrichment for free-form phrases
// Maps phrases like "make sofa bigger" -> sofa.seater++ and
// "curved mirror with light" -> mirror.features.lighting=true, mirror.specifications.shape='curved'
// Uses getTypeFacets to ground available values from the DB when needed.

import { getTypeFacets, hybridRetrieve } from '../retrieval.js'

// Helper to upsert nested specs safely
function ensureSpecs(line) {
  if (!line) return line
  line.specifications = line.specifications || {}
  line.specifications.features = line.specifications.features || {}
  return line
}

// Pick the next higher seater based on available seaters in DB facets
async function pickHigherSeater(currentSeater, hint, facets) {
  const seaters = Array.isArray(facets?.seaters) && facets.seaters.length > 0
    ? facets.seaters
    : [2,3,4,5,6,7]
  const desired = Number(hint) || null
  // If explicit number provided, clamp to the nearest available >= desired
  if (desired) {
    for (const s of seaters) if (s >= desired) return s
    return seaters[seaters.length - 1]
  }
  // Otherwise go to the next higher than current
  const cur = Number(currentSeater) || 0
  for (const s of seaters) if (s > cur) return s
  return seaters[Math.min(1, seaters.length - 1)]
}

export async function enrichFromText(userText, req, prior) {
  try {
    const lower = String(userText || '').toLowerCase()
    if (!req || !Array.isArray(req.requestedItems)) return req

    const findLine = (t) => req.requestedItems.find(it => (it.type || '').toLowerCase() === t)
    const priorFindLine = (t) => Array.isArray(prior?.reqItems) ? prior.reqItems.find(it => (it.type || '').toLowerCase() === t) : null

    // 1) Sofa "bigger" / seater intents
    if (/\b(bigger|more\s*seats|increase\s*seats|one\s*more\s*seat)\b/.test(lower) || /\b(\d+)\s*-?\s*seater\b.*\bsofa\b/.test(lower)) {
      const sofa = findLine('sofa') || priorFindLine('sofa')
      if (sofa) {
        const m = lower.match(/\b(\d+)\s*-?\s*seater\b.*\bsofa\b/)
        const hint = m ? Number(m[1]) : null
        const facets = await getTypeFacets('sofa')
        const target = await pickHigherSeater(sofa?.specifications?.seater, hint, facets)
        const own = findLine('sofa')
        const line = own || { ...sofa }
        ensureSpecs(line)
        line.specifications.seater = target
        if (!own) req.requestedItems.push(line)
        // Track that sofa is the only touched type here
        const prevTouched = req._touchedTypes instanceof Set ? Array.from(req._touchedTypes) : (Array.isArray(req._touchedTypes) ? req._touchedTypes : [])
        req._touchedTypes = new Set([...(prevTouched || []), 'sofa'])
        req._skipClarify = true
      }
    }

    // 2) Mirror with lighting / curved / glass intents
    if (/\bmirror\b/.test(lower)) {
      const own = findLine('mirror') || { type: 'mirror', quantity: 1, specifications: {} }
      ensureSpecs(own)
      if (/(light|lighting|backlit|illuminated)/.test(lower)) own.specifications.features.lighting = true
      if (/curved|round|circle|circular|oval/.test(lower)) own.specifications.shape = own.specifications.shape || 'curved'
      if (/glass/.test(lower)) own.specifications.material = own.specifications.material || 'glass'
      if (!findLine('mirror')) req.requestedItems.push(own)
      const prevTouched = req._touchedTypes instanceof Set ? Array.from(req._touchedTypes) : (Array.isArray(req._touchedTypes) ? req._touchedTypes : [])
      req._touchedTypes = new Set([...(prevTouched || []), 'mirror'])
    }

    // 3) BHK intents: "design 3bhk", "plan 2 bhk flat"
    // Seed a minimal, opinionated set of lines across core areas.
    {
      const m = lower.match(/(\d)\s*bhk/)
      if (m) {
        const bhk = Number(m[1])
        const addIfMissing = (type, specs = {}) => {
          const existing = req.requestedItems.find(it => (it.type || '').toLowerCase() === type)
          if (existing) return
          req.requestedItems.push({ type, quantity: 1, specifications: { ...specs } })
          const prevTouched = req._touchedTypes instanceof Set ? Array.from(req._touchedTypes) : (Array.isArray(req._touchedTypes) ? req._touchedTypes : [])
          req._touchedTypes = new Set([...(prevTouched || []), type])
        }
        // Living
        addIfMissing('sofa', {})
        addIfMissing('tv_bench', {})
        addIfMissing('table', { subtype: 'coffee' })
        // Bedroom (at least one set)
        addIfMissing('bed', {})
        addIfMissing('wardrobe', {})
        // Kitchen
        addIfMissing('cabinet', {})
        // Bathroom
        addIfMissing('mirror', {})
        // For larger BHK, we won't multiply items automatically yet; users can say "for all bedrooms" later.
      }
    }

    // 4) Retrieval-backed enrichment for touched types (sofa, mirror)
    {
      const maxPrice = prior?.filters?.maxPrice ? Number(prior.filters.maxPrice) : null
      const touched = req._touchedTypes instanceof Set ? req._touchedTypes : new Set(Array.isArray(req._touchedTypes) ? req._touchedTypes : [])
      const considerTypes = touched.size > 0 ? Array.from(touched) : ['sofa','mirror']

      // Helper to tally by key
      const topKey = (arr) => {
        const map = new Map()
        for (const v of arr) {
          if (!v) continue
          const k = String(v).toLowerCase()
          map.set(k, (map.get(k) || 0) + 1)
        }
        let best = null, bestN = 0
        for (const [k, n] of map) { if (n > bestN) { best = k; bestN = n } }
        return best
      }

      const ensureLine = (t) => {
        let line = req.requestedItems.find(it => (it.type || '').toLowerCase() === t)
        if (!line) { line = { type: t, quantity: 1, specifications: {} }; req.requestedItems.push(line) }
        return ensureSpecs(line)
      }

      for (const t of considerTypes) {
        if (!['sofa','mirror'].includes(t)) continue
        let rows = []
        try {
          rows = await hybridRetrieve({ queryText: userText, mustTokens: [], maxPrice, limit: 40 })
        } catch (_) { rows = [] }
        if (!Array.isArray(rows) || rows.length === 0) continue
        const hay = (r) => `${r.item_name||''} ${r.item_description||''} ${r.item_details||''} ${r.keywords||''}`.toLowerCase()

        if (t === 'sofa') {
          const seaters = []
          const mats = []
          for (const r of rows) {
            const h = hay(r)
            const sm = h.match(/(\d+)\s*(?:-\s*)?(?:seater|seat)s?/) ; if (sm) seaters.push(parseInt(sm[1],10))
            if (/fabric|cloth|textile/.test(h)) mats.push('fabric')
            if (/leather|leatherette|faux/.test(h)) mats.push('leather')
            if (/wood/.test(h)) mats.push('wood')
            if (/metal|steel|iron/.test(h)) mats.push('metal')
          }
          const bestSeater = topKey(seaters)
          const bestMat = topKey(mats)
          const line = ensureLine('sofa')
          if (!line.specifications.seater && bestSeater) line.specifications.seater = Number(bestSeater)
          // Default to 'fabric' if user did not specify and retrieval didn't yield a strong material signal
          if (!line.specifications.material) {
            if (bestMat) {
              line.specifications.material = bestMat
            } else {
              line.specifications.material = 'fabric'
              line._metaDefaultedMaterial = 'fabric'
            }
          }
        }
        if (t === 'mirror') {
          let sawLighting = false
          const shapes = []
          for (const r of rows) {
            const h = hay(r)
            if (/light|lighting|backlit|illuminated/.test(h)) sawLighting = true
            if (/curved|round|circle|circular|oval/.test(h)) shapes.push('curved')
            if (/rectangular|rectangle|square/.test(h)) shapes.push('rectangular')
          }
          const bestShape = topKey(shapes)
          const line = ensureLine('mirror')
          if (sawLighting) line.specifications.features.lighting = true
          if (!line.specifications.shape && bestShape) line.specifications.shape = bestShape
        }
      }
    }

    return req
  } catch (_) {
    return req
  }
}
