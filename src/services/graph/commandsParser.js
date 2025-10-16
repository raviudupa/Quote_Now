// Shared regex-based command parser for chat intents.
// Minimal add parsing (no DB) + advanced handlers (qty/remove/replace) that may need context.

export function applyCommandParsing(userMessage, reqIn = {}) {
  const lower = String(userMessage || '').toLowerCase()
  const req = reqIn && typeof reqIn === 'object' ? { ...reqIn } : { requestedItems: [] }

  const typeAliases = {
    'sofa': 'sofa', 'couch': 'sofa',
    'tv bench': 'tv_bench', 'tv unit': 'tv_bench', 'tv table': 'tv_bench', 'tv stand': 'tv_bench',
    'coffee table': 'table', 'side table': 'table', 'bedside table': 'table', 'table': 'table',
    'bookcase': 'bookcase', 'bookshelf': 'bookcase', 'shelf': 'bookcase',
    'wardrobe': 'wardrobe', 'almirah': 'wardrobe', 'closet': 'wardrobe',
    'mirror': 'mirror', 'cabinet': 'cabinet', 'drawer': 'drawer', 'desk': 'desk', 'chair': 'chair', 'bed': 'bed'
  }
  const mapType = (raw) => {
    const r = String(raw || '').toLowerCase().trim()
    return typeAliases[r] || r.replace(/\s+/g, '_')
  }

  const items = Array.isArray(req.requestedItems) ? req.requestedItems.slice() : []
  const changes = Array.isArray(req._changes) ? req._changes.slice() : []
  const touch = new Set(req._touchedTypes instanceof Set ? Array.from(req._touchedTypes) : (Array.isArray(req._touchedTypes) ? req._touchedTypes : []))

  // add <type> with id <id>
  const addIdRe = /\badd\s+([a-z_ ]+?)\s+with\s+id\s+(\d+)\b/gi
  let m1
  while ((m1 = addIdRe.exec(lower)) !== null) {
    const rawType = m1[1].trim()
    const id = m1[2]
    const t = mapType(rawType)
    const subMatch = /(coffee|side|bedside|dining)\s*table/.exec(rawType) || (/^table\s+(coffee|side|bedside|dining)/.exec(rawType))
    const specs = subMatch ? { subtype: subMatch[1].toLowerCase() } : {}
    items.push({ type: t, quantity: 1, preferredId: id, specifications: specs })
    touch.add(t)
    const key = `${t}|${specs.seater||''}|${specs.subtype||''}|${specs.material||''}`.toLowerCase()
    changes.push({ type: t, key, prevKey: null, reason: 'added', preferredId: id })
  }

  // add <n> <type>
  const addQtyRe = /\badd\s+(\d+)\s+([a-z_ ]+?)\b/gi
  let m2
  while ((m2 = addQtyRe.exec(lower)) !== null) {
    const qty = Math.max(1, parseInt(m2[1],10) || 1)
    const rawType = m2[2].trim()
    const t = mapType(rawType)
    const subMatch = /(coffee|side|bedside|dining)\s*table/.exec(rawType) || (/^table\s+(coffee|side|bedside|dining)/.exec(rawType))
    const specs = subMatch ? { subtype: subMatch[1].toLowerCase() } : {}
    items.push({ type: t, quantity: qty, specifications: specs })
    touch.add(t)
    const key = `${t}|${specs.seater||''}|${specs.subtype||''}|${specs.material||''}`.toLowerCase()
    changes.push({ type: t, key, prevKey: null, reason: 'added' })
  }

  // add <type>
  const addOneRe = /\badd\s+([a-z_ ]+?)\b/gi
  let m3
  while ((m3 = addOneRe.exec(lower)) !== null) {
    const rawType = m3[1].trim()
    if (/\b\d+\b/.test(rawType)) continue
    const t = mapType(rawType)
    const subMatch = /(coffee|side|bedside|dining)\s*table/.exec(rawType) || (/^table\s+(coffee|side|bedside|dining)/.exec(rawType))
    const specs = subMatch ? { subtype: subMatch[1].toLowerCase() } : {}
    items.push({ type: t, quantity: 1, specifications: specs })
    touch.add(t)
    const key = `${t}|${specs.seater||''}|${specs.subtype||''}|${specs.material||''}`.toLowerCase()
    changes.push({ type: t, key, prevKey: null, reason: 'added' })
  }

  if (changes.length) {
    req.requestedItems = items
    req._changes = changes
    req._touchedTypes = new Set([...(touch || [])])
    req._skipClarify = true
  }
  return req
}

// Advanced commands that may require DB/context
// Expects: { userMessage, req, state, aiInstance }
export async function applyAdvancedCommands({ userMessage, req: reqIn = {}, state = {}, aiInstance }) {
  let req = reqIn && typeof reqIn === 'object' ? { ...reqIn } : { requestedItems: [] }
  const lower = String(userMessage || '').toLowerCase()

  // --- Quantity changes: set/increase/decrease ---
  {
    const typeAliases = {
      'sofa': 'sofa', 'couch': 'sofa',
      'tv bench': 'tv_bench', 'tv unit': 'tv_bench', 'tv table': 'tv_bench', 'tv stand': 'tv_bench',
      'coffee table': 'table', 'side table': 'table', 'bedside table': 'table', 'table': 'table',
      'bookcase': 'bookcase', 'bookshelf': 'bookcase', 'shelf': 'bookcase',
      'wardrobe': 'wardrobe', 'almirah': 'wardrobe', 'closet': 'wardrobe',
      'mirror': 'mirror', 'cabinet': 'cabinet', 'drawer': 'drawer', 'desk': 'desk', 'chair': 'chair', 'bed': 'bed'
    }
    const mapType = (raw) => {
      const r = String(raw || '').toLowerCase().trim(); return typeAliases[r] || r.replace(/\s+/g, '_')
    }
    const setRe = /\b(?:set|make)\s+([a-z\- ]+?)\s+(?:qty|quantity|count)\s+(?:to\s*)?(\d+)\b/.exec(lower)
    const incRe = /\b(?:increase|add)\s+(?:the\s*)?([a-z\- ]+?)\s+(?:qty|quantity|count|more)?\s*(?:by\s*)?(\d+)\b/.exec(lower)
    const decRe = /\b(?:decrease|reduce|remove)\s+(?:the\s*)?([a-z\- ]+?)\s+(?:qty|quantity|count)\s*(?:by\s*)?(\d+)\b/.exec(lower)
    const needRe = /\b(?:need|want|require|for)\s+(\d+)\s+([a-z\- ]+?)\b/.exec(lower)
    const applyQty = (t, mode, n) => {
      const items = Array.isArray(req.requestedItems) ? req.requestedItems.slice() : []
      const idx = items.findIndex(it => (it.type || '').toLowerCase() === t)
      if (idx < 0) return false
      const it = { ...items[idx] }
      const cur = Number(it.quantity || 1)
      let q = cur
      const v = Number(n)
      if (!Number.isFinite(v) || v <= 0) return false
      if (mode === 'set') q = v
      else if (mode === 'inc') q = cur + v
      else if (mode === 'dec') q = Math.max(1, cur - v)
      it.quantity = q
      items[idx] = it
      req.requestedItems = items
      req._touchedTypes = new Set([...(req._touchedTypes || []), t])
      req._skipClarify = true
      return true
    }
    if (setRe) applyQty(mapType(setRe[1]), 'set', setRe[2])
    else if (incRe) applyQty(mapType(incRe[1]), 'inc', incRe[2])
    else if (decRe) applyQty(mapType(decRe[1]), 'dec', decRe[2])
    else if (needRe) {
      const noun = needRe[2]; if (!/seater/.test(noun)) applyQty(mapType(noun), 'set', needRe[1])
    }
  }

  // --- Removals: "remove X", "no coffee table", etc. ---
  const parseRemovalCommands = (txt) => {
    const removals = []
    const mapName = (name) => {
      const r = name.trim().toLowerCase()
      if (/sofa-?bed/.test(r)) return { type: 'sofa_bed' }
      if (/^sofa\b|^couch\b/.test(r)) return { type: 'sofa' }
      if (/tv\s*(bench|unit|table|storage)/.test(r)) return { type: 'tv_bench' }
      if (/book\s*case|bookshelf|book\s*shelf/.test(r)) return { type: 'bookcase' }
      if (/\bshelf\b/.test(r)) return { type: 'shelf' }
      if (/wardrobe|almirah|closet/.test(r)) return { type: 'wardrobe' }
      if (/mirror\s*cabinet/.test(r)) return { type: 'mirror_cabinet' }
      if (/\bmirror\b/.test(r)) return { type: 'mirror' }
      if (/cabinet/.test(r)) return { type: 'cabinet' }
      if (/\blamp\b|\blighting\b|\blight\b/.test(r)) return { type: 'lamp' }
      if (/drawer|dresser|chest/.test(r)) return { type: 'drawer' }
      if (/desk/.test(r)) return { type: 'desk' }
      if (/chair/.test(r)) return { type: 'chair' }
      if (/bed\b/.test(r)) return { type: 'bed' }
      if (/storage\s*combination/.test(r)) return { type: 'storage_combination' }
      if (/table/.test(r)) {
        const subtype = /coffee|side|bedside|dining/.exec(r)?.[0] || null
        return { type: 'table', subtype }
      }
      return null
    }
    const patterns = [
      /(remove|delete|exclude|without|no)\s+(?:\b(\d+)\s+)?([a-zA-Z\-\s]+?)(?=(?:\band\b|,|\.|\?|$))/g,
      /(remove|delete|exclude|without|no)\s+(?:\b(\d+)\s+)?([a-zA-Z\-\s]+)$/g
    ]
    for (const p of patterns) {
      let m
      while ((m = p.exec(txt)) !== null) {
        const qty = m[2] ? Number(m[2]) : null
        let rawName = (m[3] || '').trim()
        rawName = rawName.replace(/^(the|a|an)\s+/i, '')
        rawName = rawName.replace(/\s+(?:as|for now|right now|please|thanks).*$/i, '')
        const mapped = mapName(rawName)
        if (mapped) removals.push({ ...mapped, quantity: qty })
      }
    }
    return removals
  }
  const applyRemovals = (items, removals) => {
    if (!Array.isArray(items) || items.length === 0 || !Array.isArray(removals) || removals.length === 0) return items
    const out = []
    for (const it of items) out.push({ ...it, specifications: { ...(it.specifications || {}) } })
    for (const r of removals) {
      for (let i = out.length - 1; i >= 0; i--) {
        const line = out[i]; if (!line) continue
        if (line.type !== r.type) continue
        if (r.type === 'table' && r.subtype) {
          const st = (line.specifications && line.specifications.subtype) || null
          if (st !== r.subtype) continue
        }
        if (r.quantity && Number(line.quantity) > r.quantity) {
          line.quantity = Number(line.quantity) - r.quantity
          break
        } else {
          out.splice(i, 1)
        }
      }
    }
    return out
  }
  const removals = parseRemovalCommands(lower)
  if (removals.length > 0) {
    req._touchedTypes = new Set([...(req._touchedTypes || []), ...removals.map(r => r.type)])
    const nextItems = applyRemovals(req.requestedItems || [], removals)
    req.requestedItems = nextItems
    req._skipClarify = true
  }

  // --- Replace handlers ---
  // replace <type> with id <id>
  {
    const replaceMatch = lower.match(/\breplace\s+([a-z\- ]+?)\s+with\s+id\s+(\d+)\b/)
    if (replaceMatch) {
      const rawType = replaceMatch[1].trim()
      const id = parseInt(replaceMatch[2], 10)
      const normType = rawType.replace(/\s+/g,'_')
      const items = Array.isArray(req.requestedItems) ? req.requestedItems : []
      const idx = items.findIndex(it => (it.type || '').toLowerCase() === normType)
      if (idx >= 0 && Number.isFinite(id)) {
        req._touchedTypes = new Set([...(req._touchedTypes || []), normType])
        const it = { ...items[idx], preferredId: id }
        items[idx] = it
        req.requestedItems = items
        req._skipClarify = true
      }
    }
  }

  // replace <type> with <name>
  {
    const replaceByName = lower.match(/\breplace\s+([a-z\- ]+?)\s+with\s+(?!id\b)([a-z0-9\-\s]+)/)
    if (replaceByName && state?.prior?.filters != null && Array.isArray(state?.prior?.selections) != null && aiInstance?.getAlternatives) {
      // We will attempt a name-based lookup via alternatives from the first matching selection's line type
      try {
        const rawType = replaceByName[1].trim().replace(/\s+/g,'_')
        const namePart = replaceByName[2].trim()
        const items = req.requestedItems || []
        const idx = items.findIndex(it => (it.type || '').toLowerCase() === rawType)
        if (idx >= 0) {
          const sel = state?.prior?.selections?.find(s => (s.line?.type || '').toLowerCase() === rawType)
          if (sel) {
            const alts = await aiInstance.getAlternatives(sel, state.prior?.filters || {}, { limit: 10 })
            const hit = (alts || []).find(a => String(a?.item_name||'').toLowerCase().includes(namePart))
            if (hit?.id) {
              req._touchedTypes = new Set([...(req._touchedTypes || []), rawType])
              items[idx] = { ...items[idx], preferredId: hit.id }
              req.requestedItems = items
              req._skipClarify = true
            }
          }
        }
      } catch {}
    }
  }

  // bare replace: "replace sofa" → use first alternative
  {
    const replaceBare = lower.match(/\breplace\s+([a-z\- ]+?)\b(?!\s+with)/)
    if (replaceBare && Array.isArray(state?.prior?.selections)) {
      const rawType = replaceBare[1].trim().replace(/\s+/g,'_')
      const items = req.requestedItems || []
      const idx = items.findIndex(it => (it.type || '').toLowerCase() === rawType)
      if (idx >= 0) {
        const sel = state.prior.selections.find(s => (s.line?.type || '').toLowerCase() === rawType)
        if (sel && aiInstance?.getAlternatives) {
          try {
            const alts = await aiInstance.getAlternatives(sel, state.prior?.filters || {}, { limit: 3 })
            if (alts && alts[0]?.id) {
              req._touchedTypes = new Set([...(req._touchedTypes || []), rawType])
              items[idx] = { ...items[idx], preferredId: alts[0].id }
              req.requestedItems = items
              req._skipClarify = true
            }
          } catch {}
        }
      }
    }
  }

  return req
}
