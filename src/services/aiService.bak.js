export { default } from './aiService.clean.js'
/*
  return bucket
}
const getLastSelections = (sessionId) => {
  const sid = sessionId || 'default'
  const cur = lastSelectionsBySession.get(sid)
  return Array.isArray(cur) ? cur : []
}
const setLastSelections = (sessionId, selections) => {
  const sid = sessionId || 'default'
  lastSelectionsBySession.set(sid, Array.isArray(selections) ? selections : [])
}

class InteriorDesignAI {
  constructor() {
    this.openaiApiKey = import.meta.env.VITE_OPENAI_API_KEY
  }

  // --- LLM pre-summarizer (GPT-4o-mini): summarize user intent or floorplan context ---
  async summarizeIntentLLM(text, { mode = 'chat' } = {}) {
    try {
      const USE = String(import.meta.env.VITE_USE_LLM_SUMMARIZER || 'true').toLowerCase() === 'true'
      if (!USE) return null
      if (!this.openaiApiKey) return null
      const prompt = `You are Quotation-AI, an assistant that analyzes customer-provided information (such as floor plans, house details, or requirements) and produces a detailed room-wise list of furniture and essential items.

Rules:
1. Always analyze the given ${mode === 'floorplan' ? 'floor plan' : 'customer description'} first.
2. Break down the result by ROOM (e.g., Living Room, Dining, Bedroom, Kitchen, Balcony, Study, Toilets, etc.).
3. Under each room, list Essentials (must-have items) and Optionals (nice-to-have/premium).
4. Keep the response clear, structured, and easy for quotation generation.
5. Never skip a room if it is present.
6. If dimensions are given, factor them into furniture recommendations.
7. OUTPUT STRICT JSON with keys: { summary: string, rooms: string[], areaSqft: number|null, theme: string|null, budget: { scope: 'per_item'|'total', amount: number }|null, itemsSuggested: Array<{ type: string, subtype?: string, quantity?: number, room?: string }>, clarifications: string[] }.
Use normalized item types: sofa, sofa_bed, chair, table{subtype: coffee|side|bedside|dining}, tv_bench, bed, wardrobe, mirror, cabinet, bookcase, shelf, storage_combination, lamp, stool, shoe_rack, mirror_cabinet.`
      const body = {
        model: 'gpt-4o-mini',
        input: [
          { role: 'system', content: prompt },
          { role: 'user', content: String(text || '').slice(0, 8000) }
        ],
        max_output_tokens: 600,
        temperature: 0.2
      }
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiApiKey}`
        },
        body: JSON.stringify(body)
      })
      if (!res.ok) return null
      const data = await res.json()
      const textOut = data?.output_text || data?.choices?.[0]?.message?.content || ''
      // Try parse JSON; if not JSON, fallback to plain string in summary
      let parsed = null
      try {
        const m = textOut.match(/\{[\s\S]*\}$/)
        parsed = JSON.parse(m ? m[0] : textOut)
      } catch { /* ignore */ }
      if (parsed && typeof parsed === 'object') {
        // Light normalization
        parsed.summary = String(parsed.summary || '').trim()
        parsed.rooms = Array.isArray(parsed.rooms) ? parsed.rooms : []
        parsed.itemsSuggested = Array.isArray(parsed.itemsSuggested) ? parsed.itemsSuggested : []
        return parsed
      }
      return { summary: String(textOut || '').trim().slice(0, 500), rooms: [], areaSqft: null, theme: null, budget: null, itemsSuggested: [], clarifications: [] }
    } catch (_) {
      return null
    }
  }

  // Room → categories mapping (based on user's taxonomy)
  // Keys are normalized room types coming from floor plan: living, bedroom, kitchen, bathroom, dining, foyer
  roomCatalog() {
    return {
      living: [
        { type: 'sofa' },
        { type: 'sofa_bed' },
        { type: 'chair' },
        { type: 'lamp' },
        { type: 'tv_bench' },
        { type: 'bookcase' },
        { type: 'storage_combination' },
        { type: 'shelf' },
        { type: 'cabinet' },
        { type: 'mirror' },
        { type: 'table', specifications: { subtype: 'side' } }
      ],
      bedroom: [
        { type: 'bed' },
        { type: 'wardrobe' },
        { type: 'mirror' },
        { type: 'lamp' },
        { type: 'sofa_bed' },
        { type: 'chair' },
        { type: 'shelf' },
        { type: 'cabinet' },
        { type: 'storage_combination' }
      ],
      bathroom: [
        { type: 'washstand' },
        { type: 'mirror' },
        { type: 'shelf' },
        { type: 'cabinet' },
        { type: 'stool' },
        { type: 'lamp' }
      ],
      kitchen: [
        { type: 'table' },
        { type: 'chair' },
        { type: 'cabinet' },
        { type: 'shelf' },
        { type: 'storage_combination' },
        { type: 'lamp' },
        { type: 'stool' }
      ],
      dining: [
        { type: 'table', specifications: { subtype: 'dining' } },
        { type: 'chair' },
        { type: 'lamp' },
        { type: 'cabinet' },
        { type: 'shelf' }
      ],
      foyer: [
        { type: 'mirror' },
        { type: 'cabinet' },
        { type: 'shelf' },
        { type: 'lamp' }
      ]
    }
  }

  // Essentials vs Optional kits per room
  roomKits() {
    return {
      living: {
        essentials: [
          { type: 'sofa' },
          { type: 'tv_bench' },
          { type: 'table', specifications: { subtype: 'coffee' } },
          { type: 'bookcase' },
          { type: 'lamp' } // wall lamp preferred
        ],
        optional: [
          { type: 'chair' },
          { type: 'sofa_bed' },
          { type: 'bookcase' },
          { type: 'storage_combination' },
          { type: 'shelf' },
          { type: 'cabinet' },
          { type: 'mirror' }
        ]
      },
      bedroom: {
        essentials: [
          { type: 'bed' },
          { type: 'wardrobe' },
          { type: 'table', specifications: { subtype: 'bedside' } },
          { type: 'mirror' },
          { type: 'lamp' }
        ],
        optional: [
          { type: 'chair' },
          { type: 'sofa_bed' },
          { type: 'shelf' },
          { type: 'cabinet' },
          { type: 'storage_combination' }
        ]
      },
      kitchen: {
        essentials: [
          { type: 'cabinet' }, // glass cabinet preference handled by keywords
          { type: 'table', specifications: { subtype: 'dining' } },
          { type: 'chair' },
          { type: 'lamp' }
        ],
        optional: [
          { type: 'shelf' },
          { type: 'storage_combination' },
          { type: 'stool' }
        ]
      },
      bathroom: {
        essentials: [
          { type: 'washstand' },
          { type: 'mirror' }
        ],
        optional: [
          { type: 'shelf' },
          { type: 'cabinet' },
          { type: 'stool' },
          { type: 'lamp' }
        ]
      },
      dining: {
        essentials: [
          { type: 'table', specifications: { subtype: 'dining' } },
          { type: 'chair' }
        ],
        optional: [
          { type: 'lamp' },
          { type: 'cabinet' },
          { type: 'shelf' }
        ]
      },
      foyer: {
        essentials: [
          { type: 'shoe_rack' },
          { type: 'mirror' }
        ],
        optional: [
          { type: 'shelf' },
          { type: 'lamp' }
        ]
      }
    }
  }

  // Build requested items for a single room/area from the catalog list
  buildRequestedForArea(area, { kit = 'essentials', maxOptionals = 0 } = {}) {
    const key = String(area || '').toLowerCase()
    const kits = this.roomKits()
    const defs = kits[key] || { essentials: [], optional: [] }
    const list = kit === 'all' ? [...defs.essentials, ...defs.optional] : defs.essentials
    const out = list.map((it) => ({
      type: it.type,
      quantity: 1,
      description: it.type.replace('_',' '),
      specifications: { ...(it.specifications || {}) }
    }))
    if (kit !== 'all' && maxOptionals > 0 && Array.isArray(defs.optional) && defs.optional.length) {
      for (let i = 0; i < Math.min(maxOptionals, defs.optional.length); i++) {
        const it = defs.optional[i]
        out.push({ type: it.type, quantity: 1, description: it.type.replace('_',' '), specifications: { ...(it.specifications || {}) } })
      }
    }
    return out
  }

  // --- Dedup helpers: prevent duplicate lines of the same kind in the same room ---
  lineKey(line) {
    const t = String(line?.type || '').toLowerCase()
    const sub = String(line?.specifications?.subtype || '').toLowerCase()
    const room = String(line?.room || '').toLowerCase()
    return `${room}|${t}|${sub}`
  }
  mergeRequestedLines(lines = []) {
    const map = new Map()
    for (const l of (lines || [])) {
      const k = this.lineKey(l)
      if (!map.has(k)) map.set(k, { ...l, quantity: Math.max(1, Number(l.quantity || 1)) })
      else {
        const cur = map.get(k)
        cur.quantity = Math.max(1, Number(cur.quantity || 1)) + Math.max(1, Number(l.quantity || 1))
      }
    }
    return Array.from(map.values())
  }
  mergeSelections(selections = []) {
    const map = new Map()
    for (const sel of (selections || [])) {
      const k = this.lineKey(sel.line)
      if (!map.has(k)) map.set(k, { ...sel, line: { ...(sel.line||{}), quantity: Math.max(1, Number(sel.line?.quantity || 1)) } })
      else {
        const cur = map.get(k)
        cur.line.quantity = Math.max(1, Number(cur.line.quantity || 1)) + Math.max(1, Number(sel.line?.quantity || 1))
        // keep the first picked item; optionally could choose cheaper/closer later
      }
    }
    return Array.from(map.values())
  }

  // Infer BHK count and sqft tier (small/medium/large)
  deriveBhkAndTier(rooms = [], imageUrl = '', opts = {}) {
    const counts = rooms.reduce((acc, r) => {
      const t = String(r?.type || r?.name || '').toLowerCase()
      if (t.includes('bed')) acc.bedroom++
      if (t.includes('living')) acc.living++
      if (t.includes('kitchen')) acc.kitchen++
      if (t.includes('bath')) acc.bathroom++
      if (t.includes('dining')) acc.dining++
      return acc
    }, { bedroom: 0, living: 0, kitchen: 0, bathroom: 0, dining: 0 })
    let bhk = counts.bedroom
    if (!bhk) {
      const m = String(imageUrl||'').toLowerCase().match(/\b(\d+)\s*-?\s*bhk\b/)
      if (m) bhk = parseInt(m[1], 10) || 1
    }
    if (!bhk) bhk = 1
    // sqft tier
    const totalSft = Number(opts.area || 0)
    let tier = 'medium'
    if (totalSft && isFinite(totalSft) && totalSft > 0) {
      const per = totalSft / Math.max(1, bhk)
      tier = per <= 650 ? 'small' : per <= 900 ? 'medium' : 'large'
    }
    return { bhk, tier, counts }
  }

  // Decide how many optional items to add per room based on BHK and tier
  maxOptionalsFor(room, bhk, tier) {
    const r = String(room || '').toLowerCase()
    if (bhk <= 1) return 0
    if (bhk === 2) {
      if (r === 'living' || r === 'dining') return tier === 'large' ? 2 : tier === 'medium' ? 1 : 0
      if (r === 'bedroom') return tier === 'large' ? 1 : 0
      return 0
    }
    // 3+ BHK
    if (r === 'living' || r === 'dining') return tier === 'large' ? 3 : 2
    if (r === 'bedroom') return tier === 'large' ? 2 : 1
    return tier === 'large' ? 1 : 0
  }

  // Resolve canonical catalog category and optional subcategory hint from a normalized line type + specs
  // This leverages your DB taxonomy to narrow queries early for speed and accuracy.
  // Extend here if you add more categories in your catalog.
  resolveCategory(type, specs = {}) {
    const t = String(type || '').toLowerCase()
    const sub = String(specs?.subtype || '').toLowerCase()
    // Canonical category map (DB values are case-insensitive via ilike)
    const CATEGORY_MAP = {
      'sofa': 'Sofa',
      'sofa_bed': 'Sofa-bed',
      'tv_bench': 'Tv-bench',
      'table': 'Table',
      'bed': 'Bed',
      'wardrobe': 'Wardrobe',
      'cabinet': 'Cabinet',
      'bookcase': 'Bookcase',
      'mirror': 'Mirror',
      'shoe_rack': 'Cabinet',
      // Some catalogs store mirrored storage under Wash-stand
      'mirror_cabinet': 'Wash-stand',
      'chair': 'Chair',
      'stool': 'Stool',
      'lamp': 'Lamp',
      'shelf': 'Shelf',
      'storage_combination': 'Storage combination',
      'washstand': 'Wash-stand'
    }
    const category = CATEGORY_MAP[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : null)
    // Subcategory hinting (for tables and select others)
    let subLike = null
    if (t === 'table') {
      if (/(coffee)/.test(sub)) subLike = 'coffee'
      else if (/(dining)/.test(sub)) subLike = 'dining'
      else if (/(side)/.test(sub)) subLike = 'side'
      else if (/(bedside)/.test(sub)) subLike = 'bedside'
    }
    // For cabinets/wardrobes you might store detailed subcategories like 'Glass-door Cabinet'
    // We keep it generic here; hardSpecMatch will enforce doors/drawers features.
    return { category, subcategoryLike: subLike }
  }

  // Build minimal requested items from parsed rooms (essentials only)
  buildRequestedFromVision(rooms = [], imageUrl = '', opts = {}) {
    const out = []
    const plan = []
    const { bhk, tier } = this.deriveBhkAndTier(rooms, imageUrl, opts)
    const totalSft = Number(opts.area || 0)
    const allowOptionals = isFinite(totalSft) && totalSft > 1400

    // Minimum product set policy (always applied)
    // Living
    const livingLines = [
      { type: 'sofa', quantity: 1, description: 'sofa', specifications: {} },
      { type: 'tv_bench', quantity: 1, description: 'tv bench', specifications: {} },
      { type: 'table', quantity: 1, description: 'coffee table', specifications: { subtype: 'coffee' } },
      { type: 'bookcase', quantity: 1, description: 'bookcase', specifications: {} },
      { type: 'lamp', quantity: 1, description: 'wall lamp', specifications: {} }
    ].map(l => ({ ...l, room: 'living' }))
    out.push(...livingLines)
    plan.push({ room: 'living', items: livingLines.map(l => l.type) })

    // Bedroom — scale by BHK
    const bedroomQty = Math.max(1, Math.min(3, Number(bhk || 1)))
    const bedroomLines = [
      { type: 'wardrobe', quantity: bedroomQty, description: 'wardrobe', specifications: {} },
      { type: 'bed', quantity: bedroomQty, description: 'bed', specifications: {} },
      { type: 'table', quantity: bedroomQty, description: 'bedside table', specifications: { subtype: 'bedside' } },
      { type: 'mirror', quantity: bedroomQty, description: 'normal mirror', specifications: {} }
    ].map(l => ({ ...l, room: 'bedroom' }))
    out.push(...bedroomLines)
    plan.push({ room: 'bedroom', items: bedroomLines.map(l => l.type) })

    // Kitchen
    const kitchenLines = [
      { type: 'cabinet', quantity: 1, description: 'glass cabinet', specifications: {} },
      { type: 'table', quantity: 1, description: 'dining table', specifications: { subtype: 'dining' } },
      { type: 'chair', quantity: 4, description: 'dining chairs', specifications: {} }
    ].map(l => ({ ...l, room: 'kitchen' }))
    out.push(...kitchenLines)
    plan.push({ room: 'kitchen', items: kitchenLines.map(l => l.type) })

    // Bathroom
    const bathLines = [
      { type: 'mirror', quantity: 1, description: 'mirror with light', specifications: {} },
      { type: 'washstand', quantity: 1, description: 'wash-basin', specifications: {} }
    ].map(l => ({ ...l, room: 'bathroom' }))
    out.push(...bathLines)
    plan.push({ room: 'bathroom', items: bathLines.map(l => l.type) })

    // Foyer
    const foyerLines = [
      { type: 'shoe_rack', quantity: 1, description: 'shoe rack', specifications: {} }
    ].map(l => ({ ...l, room: 'foyer' }))
    out.push(...foyerLines)
    plan.push({ room: 'foyer', items: foyerLines.map(l => l.type) })

    // Optionals: only when sqft > 1400
    if (allowOptionals) {
      const livingOpt = [
        { type: 'chair', quantity: 2, description: 'accent chairs', specifications: {} }
      ].map(l => ({ ...l, room: 'living' }))
      out.push(...livingOpt)
      plan.find(p => p.room === 'living')?.items.push(...livingOpt.map(l => l.type))

      const kitchenOpt = [
        { type: 'shelf', quantity: 1, description: 'kitchen shelf', specifications: {} }
      ].map(l => ({ ...l, room: 'kitchen' }))
      out.push(...kitchenOpt)
      plan.find(p => p.room === 'kitchen')?.items.push(...kitchenOpt.map(l => l.type))

      const foyerOpt = [
        { type: 'lamp', quantity: 1, description: 'foyer lamp', specifications: {} }
      ].map(l => ({ ...l, room: 'foyer' }))
      out.push(...foyerOpt)
      plan.find(p => p.room === 'foyer')?.items.push(...foyerOpt.map(l => l.type))
    }

    return { requestedItems: out, roomPlan: plan, bhk, tier }
  }

  // Process a floor plan image URL and route through the SAME StateGraph pipeline as chat
  async processFloorPlanFromUrl(imageUrl, opts = {}) {
    try {
      const DEBUG = String(import.meta.env.VITE_DEBUG_VISION || '').toLowerCase() === 'true'
      const analysis = await analyzeFloorPlan(imageUrl)
      if (DEBUG) console.log('[VISION] floorplan analysis:', analysis)
      let { requestedItems, roomPlan, bhk, tier } = this.buildRequestedFromVision(analysis.rooms || [], imageUrl, opts)
      // LLM pre-summarizer on floorplan context (optional)
      let llmSummary = null
      try {
        const summaryText = `Rooms: ${JSON.stringify(roomPlan || [])}\nBHK: ${bhk || ''} Tier: ${tier || ''}\nUser area: ${opts?.area || ''}\nVision: ${JSON.stringify(analysis || {})}`
        llmSummary = await this.summarizeIntentLLM(summaryText, { mode: 'floorplan' })
      } catch { /* ignore */ }
      // Fallbacks: if the vision returned no rooms/items, seed a minimal living setup so UI shows something
      if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
        if (DEBUG) console.warn('[VISION] No rooms detected. Seeding minimal living essentials as fallback.')
        requestedItems = this.buildRequestedForArea('living', { kit: 'essentials', maxOptionals: 0 }) || []
        roomPlan = [{ room: 'living', items: (requestedItems||[]).map(l => l.type) }]
        if (!bhk) bhk = 1
        if (!tier) tier = 'medium'
      }

      // Fast parallel selection path (optional): directly select items for requested lines
      // without routing through the graph, to shave latency. Falls back to graph if disabled
      // or if no items could be selected.
      // Prefer fast selection by default when we already have structured requestedItems
      const USE_FAST = (opts.fastSelect !== false) || String(import.meta.env.VITE_FAST_VISION_SELECT || '').toLowerCase() === 'true'
      if (USE_FAST && Array.isArray(requestedItems) && requestedItems.length > 0) {
        try {
          const usedItemIds = new Set()
          const filters = {}
          // Derive a conservative per-item cap similar to the seed path when user hasn't provided one
          const baseCap = (tier === 'small') ? 15000 : (tier === 'large') ? 30000 : 20000
          const bhkAdj = Math.max(0.8, Math.min(1.2, 1 + ((Number(bhk||1) - 2) * 0.1)))
          const perItemCap = Math.round(baseCap * bhkAdj)
          filters.maxPrice = perItemCap
          // Dedup requested lines before selecting
          const uniqueRequested = this.mergeRequestedLines(requestedItems)
          const tasks = uniqueRequested.map(line => this.findBestItem(line, filters, usedItemIds))
          const settled = await Promise.allSettled(tasks)
          const selections = settled
            .filter(r => r.status === 'fulfilled' && r.value && r.value.item)
            .map((r, idx) => ({ line: uniqueRequested[idx], item: r.value.item, reason: r.value.reason }))
          // Merge duplicate selections of same room/type/subtype
          const mergedSelections = this.mergeSelections(selections)
          if (mergedSelections.length > 0) {
            const items = mergedSelections.map(sel => {
              const row = sel.item
              const quantity = Math.max(1, Number(sel.line?.quantity || 1))
              const unit = Number(row.price_inr || 0)
              return { ...row, quantity, line_total_inr: unit * quantity }
            })
            const totalEstimate = items.reduce((s, it) => s + (it.line_total_inr || 0), 0)

      // Build per-item change log vs previous selections and persist selections for future turns
      let changeLog = []
      try {
        const prevSel = getLastSelections(sessionId) || []
        const byKeyPrev = new Map(prevSel.map(s => [this.lineKey(s.line), s]))
        const byKeyNow = new Map((effectiveSelections || []).map(s => [this.lineKey(s.line), s]))
        const allKeys = new Set([...byKeyPrev.keys(), ...byKeyNow.keys()])
        const summarize = (sel) => (!sel ? { id:null, qty:0, unit:0, total:0, type:null } : {
          id: sel.item?.id || null,
          qty: Math.max(1, Number(sel.line?.quantity || 1)),
          unit: Number(sel.item?.price_inr || 0),
          total: Number(sel.item?.price_inr || 0) * Math.max(1, Number(sel.line?.quantity || 1)),
          type: String(sel.line?.type || '').toLowerCase()
        })
        const logs = []
        for (const k of allKeys) {
          const a = summarize(byKeyPrev.get(k) || null)
          const b = summarize(byKeyNow.get(k) || null)
          if (a.qty === 0 && b.qty > 0) {
            logs.push({ key: k, type: b.type, prevItemId: null, newItemId: b.id, qtyPrev: 0, qtyNew: b.qty, unitPrev: 0, unitNew: b.unit, deltaLine: b.total, reason: 'added' })
          } else if (a.qty > 0 && b.qty === 0) {
            logs.push({ key: k, type: a.type, prevItemId: a.id, newItemId: null, qtyPrev: a.qty, qtyNew: 0, unitPrev: a.unit, unitNew: 0, deltaLine: -a.total, reason: 'removed' })
          } else if (a.qty > 0 && b.qty > 0) {
            if (a.id !== b.id || a.qty !== b.qty || a.unit !== b.unit) {
              logs.push({ key: k, type: b.type || a.type, prevItemId: a.id, newItemId: b.id, qtyPrev: a.qty, qtyNew: b.qty, unitPrev: a.unit, unitNew: b.unit, deltaLine: (b.total - a.total), reason: (a.id !== b.id ? 'replaced' : (a.qty !== b.qty ? 'qty' : 'price')) })
            }
          }
        }
        changeLog = logs
      } catch (_) { changeLog = [] }

      try { setLastSelections(sessionId, effectiveSelections) } catch (_) {}
            const header = (bhk ? `${bhk} BHK` : 'Plan') + (tier ? ` • ${tier}` : '')
            // Save selections for this session so subsequent 'replace' commands can merge correctly
            setLastSelections(opts?.sessionId || 'default', mergedSelections)
            return {
              message: header,
              items,
              totalEstimate,
              alternatives: null,
              filters: { maxPrice: perItemCap },
              selections: mergedSelections,
              explanations: null,
              overBudget: false,
              budgetOverBy: 0,
              roomPlan, bhk, tier,
              groupedByRoom: null
            }
          }
        } catch (_) { /* ignore and fall through to graph path */ }
      }
      // Synthesize a chat command that the parser understands so we reuse the same graph logic
      const commands = []
      // Prefer explicit 'add' commands with table subtypes and include room context to avoid parser duplication
      for (const it of requestedItems) {
        const t = String(it.type || '').toLowerCase()
        const room = String(it.room || '').toLowerCase()
        const qty = Math.max(1, Number(it.quantity || 1))
        const sub = String(it?.specifications?.subtype || '').toLowerCase()
        const base = (t === 'table' && sub) ? `${sub} table` : t.replace('_',' ')
        const withRoom = room ? `${base} for ${room}` : base
        // Add descriptive variants for clarity (e.g., mirror with light)
        const desc = String(it.description || '').toLowerCase().trim()
        const phrase = desc && !desc.includes(base) ? `${desc} (${withRoom})` : withRoom
        commands.push(`add ${phrase}`)
        if (qty > 1) commands.push(`set ${base} qty to ${qty}`)
      }
      // Create a synthetic user message to seed the plan. If user hasn't set any budget,
      // add a conservative per-item budget phrase derived from bhk/tier so totals don't explode.
      // Heuristic caps (per-item): small=15000, medium=20000, large=30000; adjust slightly with BHK.
      const baseCap = (tier === 'small') ? 15000 : (tier === 'large') ? 30000 : 20000
      const bhkAdj = Math.max(0.8, Math.min(1.2, 1 + ((Number(bhk||1) - 2) * 0.1)))
      const perItemCap = Math.round(baseCap * bhkAdj)
      const budgetPhrase = `per-item budget under ₹${perItemCap.toLocaleString('en-IN')}`
      const seedMsg = `seeded from floor plan (${bhk ? `${bhk}BHK` : 'plan'}): ${commands.join(', ')}, ${budgetPhrase}`
      const sessionId = opts?.sessionId || 'default'
      // Route through the same post-processing as chat to guarantee items/total fields
      const response = await this.processChat(seedMsg, { sessionId })
      // Ensure a concise header and return unified payload mirroring chat response
      const header = (bhk ? `${bhk} BHK` : 'Plan') + (tier ? ` • ${tier}` : '')
      return {
        message: header,
        items: Array.isArray(response?.items) ? response.items : [],
        totalEstimate: response?.totalEstimate || 0,
        alternatives: response?.alternatives || null,
        filters: response?.filters || null,
        selections: response?.selections || null,
        explanations: response?.explanations || null,
        overBudget: Boolean(response?.overBudget || false),
        budgetLimit: response?.budgetLimit ?? null,
        budgetOverBy: response?.budgetOverBy || 0,
        llmSummary,
        bhk,
        tier,
        roomPlan: roomPlan || null,
        groupedByRoom: response?.groupedByRoom || null
      }

  // Sprint 2: lightweight reranker (non-LLM by default). If VITE_USE_LLM_RERANK=true, this method reorders top candidates
  // using simple heuristic tie-breaks. Safe and synchronous.
  rerankCandidates(candidates, ctx) {
    try {
      const top = candidates.slice(0, 10)
      const rest = candidates.slice(10)
      const mat = String(ctx?.specs?.material || '').toLowerCase()
      const subtype = String(ctx?.specs?.subtype || '').toLowerCase()
      const scoreMore = (r) => {
        const h = `${r.item_name||''} ${r.item_description||''} ${r.item_details||''} ${r.keywords||''}`.toLowerCase()
        let s = 0
        if (subtype && h.includes(`${subtype} table`)) s += 1.5
        if (mat && h.includes(mat)) s += 0.5
        return s
      }
      top.sort((a,b) => scoreMore(b) - scoreMore(a))
      return top.concat(rest)
    } catch {
      return candidates
    }
  }

  // Sprint 1: Optional LLM-aided refinement for requirements.
  // - Only fills missing slots; never invents new item types
  // - Preserves strict categories (bed, sofa-bed, sofa, table{subtype}, tv_bench, mirror, wardrobe)
  // - Guarded by VITE_USE_LLM_PARSER (default false)
  async refineRequirementsLLM(initialReq, userMessage) {
    try {
      const USE = String(import.meta.env.VITE_USE_LLM_PARSER || '').toLowerCase() === 'true'
      if (!USE) return initialReq
      if (!this.openaiApiKey) return initialReq
      const sys = `You complete missing slots for interior quotation parsing. Rules:\n- Never add new item types that are not clearly mentioned.\n- Keep categories strict: bed, sofa-bed, sofa, table{subtype: coffee|side|bedside|dining}, tv_bench, mirror, wardrobe.\n- If budget scope is stated, preserve it.\n- If seater/material are present, keep them; else leave empty.\n- Output JSON with { area, theme, budget, requestedItems: [{ type, quantity, description, specifications }] }.`
      const prompt = [{ role: 'system', content: sys }, { role: 'user', content: `User: ${userMessage}\nInitialReq: ${JSON.stringify(initialReq || {}, null, 2)}` }]
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.openaiApiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: prompt, temperature: 0.1 })
      })
      if (!res.ok) return initialReq
      const json = await res.json()
      const text = json?.choices?.[0]?.message?.content || ''
      let parsed = null
      try { parsed = JSON.parse(text) } catch { /* not JSON, ignore */ }
      if (!parsed || typeof parsed !== 'object') return initialReq
      // Merge: only fill nullish values; never overwrite existing
      const out = { ...(initialReq || {}) }
      if (parsed.area && !out.area) out.area = parsed.area
      if (parsed.theme && !out.theme) out.theme = parsed.theme
      if ((parsed.budget != null) && (out.budget == null)) out.budget = parsed.budget
      if (Array.isArray(parsed.requestedItems)) {
        const cur = Array.isArray(out.requestedItems) ? out.requestedItems : []
        // Only add items that match existing types or clearly present in userMessage
        const lower = String(userMessage || '').toLowerCase()
        const allowedTypes = new Set(['bed','sofa_bed','sofa','table','tv_bench','mirror','wardrobe','bookcase','drawer','desk','chair'])
        const present = (t) => lower.includes(t.replace('_',' '))
        for (const it of parsed.requestedItems) {
          const t = String(it?.type || '').toLowerCase()
          if (!t || !allowedTypes.has(t)) continue
          if (!present(t) && !(t === 'table' && /(coffee|side|bedside|dining)/.test(lower))) continue
          // Do not duplicate existing types unless quantity explicit
          if (!cur.find(x => String(x.type).toLowerCase() === t)) cur.push(it)
        }
        out.requestedItems = cur
      }
      return out
    } catch (_) {
      return initialReq
    }
  }

  // Select the best catalog row for a single requested line using strict must-have tokens
  async findBestItem(line, filters, usedItemIds = new Set()) {
    const type = (line.type || '').toLowerCase()
    const specs = line.specifications || {}
    const userMessage = line.description || type
    const sofaBedRequested = /sofa-?bed/.test(userMessage.toLowerCase())
    // Determine the intended price band for THIS line from budget (per-item)
    // Bands (as requested):
    // - Economy: <= 15,000
    // - Luxury: <= 40,000
    // - Premium: > 40,000
    const maxPrice = Number(filters.maxPrice || 0) || null
    const budgetTier = (() => {
      if (!maxPrice) return null
      if (maxPrice <= 15000) return 'Economy'
      if (maxPrice <= 40000) return 'Luxury'
      return 'Premium'
    })()

    // 0) If a preferred (previously selected) item is provided, try to reuse it
    //    as long as it still matches current filters and constraints
    if (line.preferredId && !usedItemIds.has(line.preferredId)) {
      try {
        // Try interior_items first
        let { data: pref, error: prefErr } = await supabase
          .from('interior_items')
          .select('id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,packages,price_tier,preferred_theme,suggestive_areas,category,subcategory')
          .eq('id', line.preferredId)
          .maybeSingle()
        // If not found there, try ikea_items as a fallback
        if ((prefErr || !pref) && line.preferredId) {
          const res = await supabase
            .from('ikea_items')
            .select('id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,packages,price_tier,preferred_theme,suggestive_areas,category,subcategory')
            .eq('id', line.preferredId)
            .maybeSingle()
          pref = res.data; prefErr = res.error
        }
        if (!prefErr && pref && pref.id) {
          const text = `${pref.item_name || ''} ${pref.item_description || ''} ${pref.item_details || ''} ${pref.keywords || ''}`.toLowerCase()
          // Type compatibility
          const isSofaBedRow = /sofa-?bed/.test(text)
          const typeOk = (
            (type === 'sofa' && !isSofaBedRow) ||
            (type === 'sofa_bed' && isSofaBedRow) ||
            (type === 'tv_bench' ? /(tv|tv\s*bench|tv\s*unit|tv\s*table|tv\s*storage)/.test(text) : true) ||
            (type && text.includes(type.replace('_',' ')))
          )
          // Subtype for tables
          let subtypeOk = true
          if (type === 'table' && specs.subtype) {
            const st = String(specs.subtype).toLowerCase()
            const subcat = String(pref.subcategory || '').toLowerCase()
            subtypeOk = subcat.includes(st) || text.includes(`${st} table`)
          }

          // Package/budget constraints
          const pkg = String(pref.packages || '').toLowerCase()
          const ptier = String(pref.price_tier || '').toLowerCase()
          const wantPkg = String(filters.package || '').toLowerCase()
          const pkgOk = !wantPkg || pkg.includes(wantPkg) || ptier === wantPkg
          const priceOk = !filters.maxPrice || (Number(pref.price_inr || 0) <= Number(filters.maxPrice))
          if (typeOk && subtypeOk && pkgOk && priceOk) {
            usedItemIds.add(pref.id)
            return { item: pref, reason: 'reused previous selection' }
          }
        }
      } catch (e) { /* ignore and fall through to normal selection */ }
    }

    // Build base keyword conditions
    const typeKeywordsMap = {
      sofa: ['sofa', 'couch', 'sectional'],
      sofa_bed: ['sofa-bed', 'sofabed', 'sofa bed'],
      chair: ['chair', 'armchair', 'recliner', 'seat'],
      table: ['table', 'coffee table', 'side table', 'dining table', 'glass table'],
      bed: ['bed'],
      wardrobe: ['wardrobe', 'closet', 'cupboard', 'almirah'],
      mirror: ['mirror'],
      mirror_cabinet: ['mirror cabinet','cabinet mirror','mirror-cabinet'],
      cabinet: ['cabinet', 'storage', 'shelf'],
      drawer: ['drawer', 'dresser', 'chest'],
      tv_bench: ['tv bench', 'tv unit', 'tv storage combination', 'tv storage', 'tv bench with drawers', 'tv bench', 'tv table', 'tv-table'],
      bookcase: ['bookcase', 'bookshelf', 'shelving unit', 'shelf unit', 'shelving', 'kallax'],
      shoe_rack: ['shoe rack', 'shoe cabinet', 'shoe storage', 'shoe organiser', 'shoe organizer']
    }

    let keywords = expandKeywords(typeKeywordsMap[type] || [type])
    if (type === 'table' && specs.subtype) {
      keywords = expandKeywords([`${specs.subtype} table`, specs.subtype])
    }

    const baseConds = []
    for (const kw of keywords) {
      baseConds.push(`item_name.ilike.%${kw}%`)
      baseConds.push(`item_description.ilike.%${kw}%`)
      baseConds.push(`item_details.ilike.%${kw}%`)
      baseConds.push(`variation_name.ilike.%${kw}%`)
      baseConds.push(`base_material.ilike.%${kw}%`)
      baseConds.push(`finish_material.ilike.%${kw}%`)
      baseConds.push(`keywords.ilike.%${kw}%`)
    }

    const specConds = []
    if (specs.material) {
      const m = specs.material
      specConds.push(`item_name.ilike.%${m}%`)
      specConds.push(`item_description.ilike.%${m}%`)
      specConds.push(`item_details.ilike.%${m}%`)
      specConds.push(`variation_name.ilike.%${m}%`)
      specConds.push(`base_material.ilike.%${m}%`)
      specConds.push(`finish_material.ilike.%${m}%`)
    }
    if (type === 'sofa' && specs.seater) {
      const s = specs.seater
      specConds.push(`item_name.ilike.%${s} seat%`)
      specConds.push(`item_name.ilike.%${s}-seat%`)
      specConds.push(`item_description.ilike.%${s} seat%`)
      specConds.push(`item_description.ilike.%${s}-seat%`)
    }
    if (type === 'table' && specs.subtype) {
      const st = specs.subtype
      specConds.push(`item_name.ilike.%${st} table%`)
      specConds.push(`item_description.ilike.%${st} table%`)
    }
    const combined = baseConds.concat(specConds)
    // Note: We do not execute a DB query in this block. The combined conditions are used later
    // in the strict/relaxed DB narrowing and hybrid retrieval paths below.

    const parseDims = (row) => {
      const text = `${row.item_name || ''} ${row.item_description || ''} ${row.item_details || ''}`.toLowerCase()
      const m = text.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*(?:cm|mm|in|"))?/)
      if (!m) return null
      const a = parseFloat(m[1]); const b = parseFloat(m[2])
      if (!isFinite(a) || !isFinite(b)) return null
      return { w: a, d: b, area: a * b }
    }

    const scoreRow = (row) => {
      let score = 0
      const hay = `${row.item_name || ''} ${row.item_description || ''} ${row.item_details || ''} ${row.keywords || ''} ${row.variation_name || ''} ${row.base_material || ''} ${row.finish_material || ''}`.toLowerCase()
      if (type === 'sofa' && specs.seater) {
        if (hay.includes(`${specs.seater} seat`) || hay.includes(`${specs.seater}-seat`)) score += 2
      }
      if (type === 'table' && specs.subtype && hay.includes(`${specs.subtype} table`)) score += 2
      if (specs.material && hay.includes(specs.material)) score += 1
      if (specs.size) {
        const dims = parseDims(row)
        if (dims) {
          const area = dims.area
          if (specs.size === 'small') score += 2 - Math.min(2, area / 2500)
          else if (specs.size === 'large') score += Math.min(2, area / 2500)
        } else {
          if (specs.size === 'small' && /\b(small|compact)\b/.test(hay)) score += 0.5
          if (specs.size === 'large' && /\b(large|big)\b/.test(hay)) score += 0.5
        }
      }
      const areaPref = (filters.area || '').toLowerCase()
      const themePref = (filters.theme || '').toLowerCase()
      if (areaPref && (row.suggestive_areas || '').toLowerCase().includes(areaPref)) score += 0.5
      if (themePref && (row.preferred_theme || '').toLowerCase().includes(themePref)) score += 0.5
      // Price closeness boost: prefer items nearer to maxPrice (but still <= maxPrice)
      if (maxPrice && Number(row.price_inr)) {
        const p = Number(row.price_inr)
        if (p <= maxPrice) {
          // Scale 0..2 where closer to max gets higher boost; clamp to [0,2]
          const closeness = Math.max(0, Math.min(2, (p / maxPrice) * 2))
          score += closeness
        }
      }
      return score
    }

    const hayOf = (row) => `${row.item_name || ''} ${row.item_description || ''} ${row.item_details || ''} ${row.keywords || ''} ${row.variation_name || ''} ${row.base_material || ''} ${row.finish_material || ''} ${row.category || ''} ${row.subcategory || ''}`.toLowerCase()

    // Must-have tokens (relaxed): keep only base type and important subtype; move others to soft-preferences
    const mustGroups = []
    // Base type
    if (type) {
      if (type === 'tv_bench') mustGroups.push('tv')
      else if (type === 'mirror_cabinet') { /* handled below */ }
      else mustGroups.push(type.replace('_', ' '))
    }
    if (type === 'tv_bench') mustGroups.push('tv')
    if (type === 'mirror_cabinet') { mustGroups.push('mirror'); mustGroups.push('cabinet') }
    if (type === 'table') {
      mustGroups.push('table')
      if (specs.subtype) mustGroups.push(specs.subtype)
    }
    // Everything below becomes soft preference via scoring

    const passesGroup = (hay, g) => Array.isArray(g) ? g.some(tok => hay.includes(tok)) : hay.includes(g)
    const enforceMust = (rows) => {
      if (mustGroups.length === 0) return rows
      return rows.filter(r => {
        const h = hayOf(r)
        return mustGroups.every(g => passesGroup(h, g))
      })
    }

    // Hard-spec predicate: returns true if row matches explicitly requested specs
    const hardSpecMatch = (row) => {
      const h = hayOf(row)
      // If user did not request a sofa-bed explicitly, avoid picking sofa-bed rows for a plain sofa
      if (type === 'sofa' && !sofaBedRequested && /(sofa\s*-?\s*bed|sofa\s+bed)/.test(h)) return false
      // seater for sofa
      if (type === 'sofa' && specs.seater) {
        const tokens = [ `${specs.seater} seat`, `${specs.seater}-seat`, `${specs.seater} seater`, `${specs.seater}-seater`, `${specs.seater} seats` ]
        if (!tokens.some(t => h.includes(t))) return false
      }
      // subtype (primarily table, sometimes others via subcategory)
      if (specs.subtype) {
        const st = String(specs.subtype).toLowerCase()
        const subcat = String(row.subcategory || '').toLowerCase()
        if (!(subcat.includes(st) || h.includes(`${st} table`) || h.includes(st))) return false
      }
      // material
      if (specs.material) {
        const mat = String(specs.material).toLowerCase()
        if (!h.includes(mat)) return false
      }
      // shape (mirror)
      if (specs.shape) {
        const shp = String(specs.shape).toLowerCase()
        if (shp === 'curved') {
          if (!/(curved|round|circle|circular|oval)/.test(h)) return false
        } else if (shp === 'rectangular') {
          if (!/(rectangular|rectangle|square)/.test(h)) return false
        }
      }
      // features
      if (specs.features) {
        const f = specs.features
        if (f.drawers && !/drawer/.test(h)) return false
        if (f.doors === 'glass' && !(/glass.+door|door.+glass/.test(h))) return false
        if (f.lighting === 'built-in' && !/(light|lighting|backlit|illuminated)/.test(h)) return false
        if (f.upholstered && !/upholster/.test(h)) return false
      }
      return true
    }

    const pickBest = (rows) => {
      let filtered = enforceMust(rows)
      if (!filtered || filtered.length === 0) return null
      // Soft preference scoring
      const n = specs.seater
      const seaterTokens = n ? [
        `${n} seat`, `${n}-seat`, `${n} seater`, `${n}-seater`, `${n} seats`
      ] : []
      // If any hard specs are provided, strictly enforce them when possible
      const hardFiltered = filtered.filter(hardSpecMatch)
      if (hardFiltered.length > 0) filtered = hardFiltered
      const mat = (specs.material || '').toLowerCase()
      const subtype = (specs.subtype || '').toLowerCase()
      const addlScore = (row) => {
        const h = hayOf(row)
        let s = 0
        // Stronger preference for exact seater match
        if (seaterTokens.length && seaterTokens.some(t => h.includes(t))) s += 1.5
        if (mat && h.includes(mat)) s += 0.3
        if (subtype && h.includes(subtype)) s += 0.3
        if (specs.features?.upholstered && /upholster/.test(h)) s += 0.3
        if (specs.features?.sofabed && (h.includes('sofa-bed') || h.includes('sofa bed'))) s += 1.0
        if (specs.features?.drawers && /drawer/.test(h)) s += 0.2
        if (specs.features?.doors === 'glass' && /glass.+door|door.+glass/.test(h)) s += 0.2
        return s
      }
      let sorted = [...filtered].sort((a,b) => (scoreRow(b) + addlScore(b)) - (scoreRow(a) + addlScore(a)))
      // Optional reranker (flagged): can reorder the top few candidates
      const USE_RERANK = String(import.meta.env.VITE_USE_LLM_RERANK || '').toLowerCase() === 'true'
      if (USE_RERANK) {
        sorted = this.rerankCandidates(sorted, { type, specs, filters })
      }
      for (const row of sorted) {
        if (!usedItemIds.has(row.id)) {
          usedItemIds.add(row.id)
          return row
        }
      }
      return sorted[0] || null
    }

    // Hybrid retrieval via RPC (semantic + exact), then fetch full rows
    // Fast path: try strict DB narrowing (category eq + subcategory eq), then relaxed (subcategory ilike)
    try {
      const { category, subcategoryLike } = this.resolveCategory(type, specs)
      if (category) {
        const cols = 'id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,packages,price_tier,preferred_theme,suggestive_areas,category,subcategory'
        const applyCommon = (q) => {
          const combined = baseConds.concat(specConds)
          if (combined.length > 0) q = q.or(combined.join(','))
          if (enforceBudget && maxPrice) q = q.lte('price_inr', maxPrice)
          const preferHighEnd = (budgetTier && /premium|luxury/i.test(String(budgetTier)))
          const ascending = !preferHighEnd
          return q.order('price_inr', { ascending }).limit(20)
        }
        // Strict subcategory first
        let qStrict = supabase.from('interior_items').select(cols).eq('category', category)
        if (subcategoryLike) qStrict = qStrict.eq('subcategory', subcategoryLike)
        qStrict = applyCommon(qStrict)
        let { data: strictRows, error: strictErr } = await qStrict
        if (!strictErr && Array.isArray(strictRows) && strictRows.length) {
          const chosen = pickBest(strictRows)
          if (chosen) return { item: chosen, reason: 'db_strict' }
        }
        // Relaxed subcategory
        if (subcategoryLike) {
          let qRelax = supabase.from('interior_items').select(cols).eq('category', category)
          qRelax = qRelax.ilike('subcategory', `%${subcategoryLike}%`)
          qRelax = applyCommon(qRelax)
          const { data: relaxRows, error: relaxErr } = await qRelax
          if (!relaxErr && Array.isArray(relaxRows) && relaxRows.length) {
            const chosen = pickBest(relaxRows)
            if (chosen) return { item: chosen, reason: 'db_relaxed' }
          }
        }
      }
    } catch (_) { /* fall through to hybrid */ }

    // Hybrid retrieval via RPC (semantic + exact), then fetch full rows
    const queryParts = []
    queryParts.push(type.replace('_', ' '))
    if (specs.seater) queryParts.push(`${specs.seater}-seater`)
    if (specs.subtype) queryParts.push(specs.subtype)
    if (specs.material) queryParts.push(specs.material)
    if (specs.features?.drawers) queryParts.push('with drawers')
    if (specs.features?.doors === 'glass') queryParts.push('glass doors')
    if (specs.features?.lighting === 'built-in') queryParts.push('built-in lighting')
    if (specs.color) queryParts.push(specs.color)
    if (specs.finish) queryParts.push(specs.finish)
    if (specs.dim_token) queryParts.push(specs.dim_token)
    const queryText = queryParts.join(' ').trim()

    // For RPC, pass a minimal AND-set to maximize recall.
    // Strategy:
    // - sofa: only 'sofa' (omit seater variants at RPC level)
    // - chair: only 'chair' (omit upholstered at RPC level)
    // - table: 'table' and subtype (if any)
    // - others: first variant of each group
    let rpcMustTokens = []
    if (type === 'sofa') {
      rpcMustTokens = ['sofa']
    } else if (type === 'chair') {
      rpcMustTokens = ['chair']
    } else if (type === 'table') {
      rpcMustTokens = ['table']
      if (specs.subtype) rpcMustTokens.push(specs.subtype)
    } else {
      for (const g of mustGroups) rpcMustTokens.push(Array.isArray(g) ? g[0] : g)
    }

    let rpcCandidates = await hybridRetrieve({ queryText, mustTokens: rpcMustTokens, maxPrice: filters.maxPrice, packageFilter: filters.package, similarityThreshold: 0.7, limit: 50 })
    if (!rpcCandidates || rpcCandidates.length === 0) {
      rpcCandidates = await hybridRetrieve({ queryText, mustTokens: rpcMustTokens, maxPrice: filters.maxPrice, packageFilter: filters.package, similarityThreshold: 0.5, limit: 50 })
    }
    if (!rpcCandidates || rpcCandidates.length === 0) {
      // Try slightly lower semantic threshold before exact-only
      rpcCandidates = await hybridRetrieve({ queryText, mustTokens: rpcMustTokens, maxPrice: filters.maxPrice, packageFilter: filters.package, similarityThreshold: 0.35, limit: 50 })
    }
    if (!rpcCandidates || rpcCandidates.length === 0) {
      rpcCandidates = await hybridRetrieve({ queryText: null, mustTokens: rpcMustTokens, maxPrice: filters.maxPrice, packageFilter: filters.package, similarityThreshold: 0.0, limit: 50 })
    }
    const ids = (rpcCandidates || []).map(r => r.id)
    let data = []
    if (ids.length > 0) {
      // Try interior_items first; if empty, try ikea_items (IDs from RPC/fallback may belong there)
      let { data: fullRows, error } = await supabase.from('interior_items').select('*').in('id', ids)
      if (error) { console.error('Fetch fullRows error (interior_items):', error) }
      data = fullRows || []
      if (!data || data.length === 0) {
        const res = await supabase.from('ikea_items').select('*').in('id', ids)
        if (res.error) { console.error('Fetch fullRows error (ikea_items):', res.error); return { item: null, reason: 'query_error' } }
        data = res.data || []
      }
    }
    const debugTokens = mustGroups.flatMap(g => Array.isArray(g) ? g : [g])
    const DEBUG_RETRIEVAL = String(import.meta.env.VITE_DEBUG_RETRIEVAL || '').toLowerCase() === 'true'
    if (DEBUG_RETRIEVAL) {
      console.log('Selection debug:', { type, queryText, mustTokens: debugTokens, rpcMustTokens, rpcCount: (rpcCandidates||[]).length, fetchedCount: data.length })
    }
    if (data && data.length > 0) {
      const chosen = pickBest(data)
      if (chosen) return { item: chosen, reason: 'ok' }
    }

    // Relaxations
    {
      const rpc2 = await hybridRetrieve({ queryText, mustTokens: rpcMustTokens, maxPrice: filters.maxPrice, packageFilter: filters.package, similarityThreshold: 0.7, limit: 50 })
      const ids2 = (rpc2||[]).map(r => r.id)
      let data1b = []
      if (ids2.length > 0) {
        const { data: rows2, error } = await supabase.from('interior_items').select('*').in('id', ids2)
        if (error) { console.error('Fetch rows2 error:', error); return { item: null, reason: 'query_error' } }
        data1b = rows2 || []
      }
      const chosen = pickBest(data1b)
      if (chosen) return { item: chosen, reason: 'relaxed_specs' }
    }
    {
      const rpc3 = await hybridRetrieve({ queryText, mustTokens: rpcMustTokens, maxPrice: filters.maxPrice, packageFilter: null, similarityThreshold: 0.7, limit: 50 })
      const ids3 = (rpc3||[]).map(r => r.id)
      let data2 = []
      if (ids3.length > 0) {
        const { data: rows3, error } = await supabase.from('interior_items').select('*').in('id', ids3)
        if (error) { console.error('Fetch rows3 error:', error); return { item: null, reason: 'query_error' } }
        data2 = rows3 || []
      }
      const chosen = pickBest(data2)
      if (chosen) return { item: chosen, reason: 'relaxed_package' }
    }
    {
      const rpc4 = await hybridRetrieve({ queryText, mustTokens: rpcMustTokens, maxPrice: filters.maxPrice, packageFilter: null, similarityThreshold: 0.7, limit: 50 })
      const ids4 = (rpc4||[]).map(r => r.id)
      let data2b = []
      if (ids4.length > 0) {
        const { data: rows4, error } = await supabase.from('interior_items').select('*').in('id', ids4)
        if (error) { console.error('Fetch rows4 error:', error); return { item: null, reason: 'query_error' } }
        data2b = rows4 || []
      }
      const chosen = pickBest(data2b)
      if (chosen) return { item: chosen, reason: 'relaxed_package_and_specs' }
    }

    // Final safety net: drop budget cap and pick the cheapest matching item for this type
    try {
      const { data: cheapestAnyRows } = await supabase
        .from('interior_items')
        .select('id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,packages,price_tier,preferred_theme,suggestive_areas,category,subcategory')
        .order('price_inr', { ascending: true })
        .limit(200)
      const passType = (row) => {
        const h = hayOf(row)
        // Build safer regex with word boundaries to prevent 'bed' matching 'bedroom'
        const hasWord = (w) => new RegExp(`\\b${w}\\b`, 'i').test(h)
        if (type === 'tv_bench') return /(tv|tv\s*bench|tv\s*unit|tv\s*table|tv\s*storage)/i.test(h)
        if (type === 'table') {
          if (specs.subtype) {
            const sub = String(specs.subtype).toLowerCase()
            const inSubcat = String(row.subcategory||'').toLowerCase().includes(sub)
            return hasWord('table') && (h.includes(`${sub} table`) || inSubcat)
          }
          return hasWord('table')
        }
        if (type === 'sofa') return hasWord('sofa') || hasWord('couch')
        if (type === 'sofa_bed') return /(sofa\s*-?\s*bed|sofabed)/i.test(h)
        if (type === 'chair') return hasWord('chair') || hasWord('armchair')
        if (type === 'bed') return hasWord('bed') // will not match 'bedroom' due to word boundary
        if (type === 'wardrobe') return hasWord('wardrobe') || hasWord('almirah') || hasWord('closet')
        if (type === 'mirror') return hasWord('mirror')
        if (type === 'cabinet') return hasWord('cabinet')
        if (type === 'bookcase') return hasWord('bookcase') || /book\s*shelf|bookshelf|shelving/i.test(h)
        if (type === 'shelf') return hasWord('shelf')
        if (type === 'storage_combination') return /storage\s*combination/i.test(h)
        if (type === 'stool') return hasWord('stool')
        if (type === 'lamp') return hasWord('lamp') || /lighting|light\b/i.test(h)
        // Fallback: exact token with spaces for other types
        return hasWord(type.replace('_',' '))
      }
      let pool = (cheapestAnyRows || []).filter(passType)
      if (pool.length === 0) {
        const { data: ikeaRows } = await supabase
          .from('ikea_items')
          .select('id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,packages,price_tier,preferred_theme,suggestive_areas,category,subcategory')
          .order('price_inr', { ascending: true })
          .limit(200)
        pool = (ikeaRows || []).filter(passType)
      }
      if (pool && pool.length > 0) {
        return { item: pool[0], reason: 'no_budget_match_fallback' }
      }
    } catch (_) { /* ignore */ }

    // Probes for clarification
    let cheapestAny = null
    try {
      const { data: probeData } = await supabase
        .from('interior_items')
        .select('price_inr')
        .order('price_inr', { ascending: true })
        .limit(1)
      if (probeData && probeData.length > 0) cheapestAny = probeData[0].price_inr
    } catch (_) { /* ignore */ }
    return { item: null, reason: 'needs_clarification', suggestions: { cheapestAny } }
  }

  // Generic requirement extraction used for filters (room, theme, budget, item keywords)
  extractRequirements(message) {
    const requirements = {
      area: null,
      theme: null,
      budget: null,
      items: []
    }

    const lower = (message || '').toLowerCase()

    // Areas
    const areaMap = {
      Living: ['living', 'living room', 'lounge', 'hall'],
      Bedroom: ['bedroom', 'bed room', 'sleeping', 'master bedroom'],
      Bathroom: ['bathroom', 'bath room', 'washroom', 'toilet'],
      Kitchen: ['kitchen', 'cooking', 'pantry'],
      Dining: ['dining', 'dining room', 'eating'],
      Foyer: ['foyer', 'entrance', 'entry'],
      Balcony: ['balcony', 'terrace', 'patio', 'outdoor']
    }
    for (const [area, variants] of Object.entries(areaMap)) {
      if (variants.some(v => lower.includes(v))) { requirements.area = area; break }
    }

    // Themes
    const themeMap = {
      Modern: ['modern', 'contemporary', 'sleek', 'clean'],
      Traditional: ['traditional', 'classic', 'vintage', 'antique'],
      Scandinavian: ['scandinavian', 'nordic', 'minimalist', 'simple'],
      Industrial: ['industrial', 'urban', 'loft', 'metal'],
      Bohemian: ['bohemian', 'boho', 'eclectic', 'artistic'],
      Rustic: ['rustic', 'country', 'farmhouse', 'wooden']
    }
    for (const [theme, variants] of Object.entries(themeMap)) {
      if (variants.some(v => lower.includes(v))) { requirements.theme = theme; break }
    }

    // Budget
    const patterns = [
      /(?:under|below|less than|maximum|max|budget of|up to)\s*(?:₹|rs\.?\s*|rupees?\s*)(\d+(?:,\d+)*(?:\.\d+)?)\s*(k|thousand|lakh|lakhs?)?/i,
      /(?:₹|rs\.?\s*|rupees?\s*)(\d+(?:,\d+)*(?:\.\d+)?)\s*(k|thousand|lakh|lakhs?)?\s*(?:budget|maximum|max|limit)?/i
    ]
    for (const p of patterns) {
      const m = lower.match(p)
      if (m) {
        let amt = parseFloat(m[1].replace(/,/g, ''))
        const unit = m[2] || ''
        if (unit.includes('k') || unit.includes('thousand')) amt *= 1000
        if (unit.includes('lakh')) amt *= 100000
        requirements.budget = amt
        break
      }
    }

    // (No item extraction here; this helper only builds broad filters.)

    // Item keywords (used only as a weak hint)
    const itemKeywords = ['sofa','chair','table','bed','wardrobe','mirror','cabinet','drawer','desk']
    for (const kw of itemKeywords) if (lower.includes(kw)) requirements.items.push(kw)

    return requirements
  }


  // Extract specific quotation requirements from user message
  extractQuotationRequirements(message) {
    const requirements = {
      area: null,        // backward-compat: first area if any
      areas: [],         // NEW: multiple areas in one message
      areaSqft: null,    // NEW: parsed square footage, e.g., 1200
      theme: null,
      budget: null,
      requestedItems: [] // Changed to be more specific about quantities
    }

    // Expand synonyms in message to improve recall during parsing
    const lowerMessage = expandUserText(message)

    // Extract room/area (plural-aware)
    const areaMap = {
      living: [ 'living', 'living room', 'living rooms', 'lounge', 'hall' ],
      bedroom: [ 'bedroom', 'bedrooms', 'bed room', 'bed rooms', 'sleeping', 'master bedroom', 'masterbedroom', 'masterbed' ],
      bathroom: [ 'bathroom', 'bathrooms', 'bath room', 'washroom', 'toilet' ],
      kitchen: [ 'kitchen', 'kitchens', 'cooking', 'pantry' ],
      dining: [ 'dining', 'dining room', 'dining rooms', 'eating' ],
      foyer: [ 'foyer', 'entrance', 'entry' ]
    }
    for (const [key, variants] of Object.entries(areaMap)) {
      for (const v of variants) {
        const re = new RegExp(`\\b${v.replace(/\s+/g,'\\s*')}\\b`, 'i')
        if (re.test(lowerMessage)) {
          if (!requirements.areas.includes(key)) requirements.areas.push(key)
          break
        }
      }
    }
    if (requirements.areas.length > 0) requirements.area = requirements.areas[0]

  // Extract square footage (e.g., 1200 sqft / sq ft / sft)
  try {
    const sqftMatch = lowerMessage.match(/(\d{3,6})\s*(sq\s*ft|sqft|sft|square\s*feet)\b/i)
    if (sqftMatch) {
      const val = parseInt(sqftMatch[1].replace(/,/g, ''), 10)
      if (Number.isFinite(val) && val > 0) requirements.areaSqft = val
    }
  } catch (_) { /* ignore */ }

    // Extract theme
    const themeMap = {
      'modern': ['modern', 'contemporary', 'sleek', 'clean'],
      'traditional': ['traditional', 'classic', 'vintage', 'antique'],
      'scandinavian': ['scandinavian', 'nordic', 'minimalist', 'simple'],
      'industrial': ['industrial', 'urban', 'loft', 'metal'],
      'bohemian': ['bohemian', 'boho', 'eclectic', 'artistic'],
      'rustic': ['rustic', 'country', 'farmhouse', 'wooden'],
      'luxury': ['luxury', 'premium', 'high-end', 'elegant']
    }

    for (const [theme, variations] of Object.entries(themeMap)) {
      if (variations.some(variation => lowerMessage.includes(variation))) {
        requirements.theme = theme.charAt(0).toUpperCase() + theme.slice(1)
        break
      }
    }

    // Extract budget
    const budgetPatterns = [
      /(?:under|below|less than|maximum|max|budget of|up to)\s*(?:₹|rs\.?\s*|rupees?\s*)(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:k|thousand|lakh|lakhs?)?/i,
      /(?:₹|rs\.?\s*|rupees?\s*)(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:k|thousand|lakh|lakhs?)?\s*(?:budget|maximum|max|limit)/i,
      /(?:₹|rs\.?\s*|rupees?\s*)(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:k|thousand|lakh|lakhs?)?/i
    ]

    for (const pattern of budgetPatterns) {
      const budgetMatch = lowerMessage.match(pattern)
      if (budgetMatch) {
        let amount = parseFloat(budgetMatch[1].replace(/,/g, ''))
        if (lowerMessage.includes('k') || lowerMessage.includes('thousand')) amount *= 1000
        if (lowerMessage.includes('lakh')) amount *= 100000
        requirements.budget = amount
        break
      }
    }

    // Extract specific items with quantities (handle plurals)
    const itemPatterns = [
      // Pattern: "1 3-seater sofa", "2 glass tables", "one coffee table"
      // Allow hyphen or space between 'seater' and the item type: e.g., "3-seater-sofa" or "3-seater sofa"
      /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(\d+)-?(?:seat|seater))?[-\s]*(sofa-?beds?|sofas?|couches?|chairs?|tables?|beds?|wardrobes?|mirrors?|cabinets?|drawers?|desks?)/gi,
      // Pattern: "3 seater sofa", "coffee table", "glass table", allow optional quantity
      /(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:(glass|wooden|metal|coffee|dining|side|center|centre)\s+)?(sofa-?beds?|sofas?|couches?|chairs?|tables?|beds?|wardrobes?|mirrors?|cabinets?|drawers?|desks?)/gi
    ]

    // Extra: handle "3-seater sofa-bed" (no explicit quantity). Allow hyphen or space between 'seater' and 'sofa'.
    const sofaBedSeaterPattern = /(\d+)[ -]?(?:seat|seater)[ -]+(sofa(?:-bed)?)/gi

    // Helper to normalize plural -> singular and aliases
    const normalizeType = (raw) => {
      if (!raw) return null
      const r = raw.toLowerCase()
      if (r.includes('sofa-bed') || r.includes('sofa bed') || r.includes('sofabed')) return 'sofa_bed'
      if (r.startsWith('sofa')) return 'sofa'
      if (r.startsWith('couch')) return 'sofa'
      if (r.startsWith('chair')) return 'chair'
      if (r.startsWith('table')) return 'table'
      if (r.startsWith('bed')) return 'bed'
      if (r.startsWith('wardrobe')) return 'wardrobe'
      if (r.startsWith('mirror')) return 'mirror'
      if (r.startsWith('cabinet')) return 'cabinet'
      if (r.startsWith('drawer')) return 'drawer'
      if (r.startsWith('desk')) return 'desk'
      if (r.includes('tv bench') || r.includes('tv unit') || r.includes('tv storage') || r.includes('tv table') || r.includes('tv-table')) return 'tv_bench'
      if (r.includes('bookcase') || r.includes('bookshelf') || r.includes('shelving') || r.includes('shelf')) return 'bookcase'
      return r
    }

    const numberMap = {
      'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
      'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10
    }

    const allowedMaterials = new Set(['fabric', 'leather', 'glass', 'wooden', 'metal'])
    const sizeTokens = new Set(['small','medium','large'])
    const allowedTypes = new Set(['sofa','chair','table','bed','wardrobe','mirror','mirror_cabinet','cabinet','drawer','desk','tv_bench','bookcase'])

    for (const pattern of itemPatterns) {
      let match
      while ((match = pattern.exec(lowerMessage)) !== null) {
        const quantityStr = match[1] || '1'
        const seaterCount = match[2] || null
        // For second regex, material is group 2 and type is group 3; for first regex, type is group 3
        let materialCandidate = match[2] && isNaN(match[2]) ? match[2] : (match[3] && !/(sofa|couch|chair|table|bed|wardrobe|mirror|cabinet|drawer|desk)/.test(match[3]) ? match[3] : null)
        let subtype = null
        let size = null
        if (materialCandidate) {
          const mLower = String(materialCandidate).toLowerCase()
          if (allowedMaterials.has(mLower)) {
            materialCandidate = mLower
          } else if (/(coffee|side|dining|center|centre|bedside|nightstand)/.test(mLower)) {
            subtype = mLower.replace('centre', 'center')
            materialCandidate = null
          } else if (sizeTokens.has(mLower)) {
            size = mLower
            materialCandidate = null
          } else {
            materialCandidate = null
          }
        }
        const rawType = match[3]
        const itemType = normalizeType(rawType)

        const qKey = typeof quantityStr === 'string' ? quantityStr.toLowerCase() : quantityStr
        const quantity = numberMap[qKey] || parseInt(quantityStr) || 1

        let itemDescription = itemType
        if (seaterCount && !isNaN(seaterCount)) {
          itemDescription = `${seaterCount}-seat ${itemType}`
        } else if (materialCandidate && materialCandidate !== seaterCount) {
          itemDescription = `${materialCandidate} ${itemType}`
        }

        const baseItem = {
          type: itemType,
          quantity,
          description: itemDescription,
          specifications: {
            seater: seaterCount ? parseInt(seaterCount) : null,
            material: (materialCandidate && isNaN(materialCandidate)) ? materialCandidate : (materialCandidate || null),
            subtype: subtype,
            size: size || null,
            features: {}
          },
          line_type: itemType
        }
        requirements.requestedItems.push(baseItem)
      }
    }

    // Phrase-based detection for multi-word items not reliably caught by regex
    const mentionsTvFurniture = (lowerMessage.includes('tv bench') || lowerMessage.includes('tv unit') || lowerMessage.includes('tv storage') || lowerMessage.includes('tv table') || lowerMessage.includes('tv-table') || lowerMessage.includes('tv stand'))
    if (mentionsTvFurniture) {
      // If parser already produced a generic 'table' for 'tv table', coerce it to tv_bench
      const genericTable = requirements.requestedItems.find(it => it.type === 'table')
      if (genericTable) {
        genericTable.type = 'tv_bench'
        genericTable.description = 'tv bench'
      }
      if (!requirements.requestedItems.find(it => it.type === 'tv_bench')) {
        requirements.requestedItems.push({ type: 'tv_bench', quantity: 1, description: 'tv bench', specifications: {} })
      }
    }
    if (lowerMessage.includes('bookcase') || lowerMessage.includes('bookshelf') || lowerMessage.includes('shelving')) {
      if (!requirements.requestedItems.find(it => it.type === 'bookcase')) {
        requirements.requestedItems.push({ type: 'bookcase', quantity: 1, description: 'bookcase', specifications: {} })
      }
    }

    // Master bed detection: treat 'masterbed' / 'master bed(room)' as an explicit bed request
    if (/(master\s*bed(?:room)?|masterbed(?:room)?)/i.test(lowerMessage)) {
      if (!requirements.requestedItems.find(it => it.type === 'bed')) {
        requirements.requestedItems.push({ type: 'bed', quantity: 1, description: 'master bed', specifications: {} })
      }
    }

    // Mirror cabinet detection
    if (/(mirror\s*cabinet|cabinet\s*mirror)/.test(lowerMessage)) {
      if (!requirements.requestedItems.find(it => it.type === 'mirror_cabinet')) {
        requirements.requestedItems.push({ type: 'mirror_cabinet', quantity: 1, description: 'mirror cabinet', specifications: { features: {} } })
      }
    }

    // Explicit bed size detection: ensure a Bed line exists when user says 'queen/king size bed'
    {
      const m = /(queen|king)\s*(?:size)?\s*bed/.exec(lowerMessage)
      if (m) {
        const size = m[1]
        let bedLine = requirements.requestedItems.find(it => it.type === 'bed')
        if (!bedLine) {
          bedLine = { type: 'bed', quantity: 1, description: `${size} bed`, specifications: { size } }
          requirements.requestedItems.push(bedLine)
        } else {
          bedLine.specifications = { ...(bedLine.specifications||{}), size }
          if (!/bed/.test(bedLine.description||'')) bedLine.description = `${size} bed`
        }
      }
    }

    // Feature modifiers
    // If phrase indicates "with drawers" on TV furniture, set feature flag and drop any standalone drawer line to avoid double counting
    if (/tv\s*(bench|unit|table|stand).*drawer/.test(lowerMessage)) {
      requirements.requestedItems = requirements.requestedItems.filter(it => it.type !== 'drawer')
      const tv = requirements.requestedItems.find(it => it.type === 'tv_bench')
      if (tv) tv.specifications = { ...(tv.specifications||{}), features: { ...(tv.specifications?.features||{}), drawers: true } }
    }
    // If phrase indicates "bookshelf/bookcase with glass doors", encode features
    if (/(bookcase|bookshelf).*glass\s+doors?/.test(lowerMessage)) {
      const bc = requirements.requestedItems.find(it => it.type === 'bookcase')
      if (bc) bc.specifications = { ...(bc.specifications||{}), material: (bc.specifications?.material||'glass'), features: { ...(bc.specifications?.features||{}), doors: 'glass' } }
    }
    // If 'bedside' or 'nightstand' mentioned, coerce first table line to subtype=bedside
    if (/(bedside|nightstand)/.test(lowerMessage)) {
      const t = requirements.requestedItems.find(it => it.type === 'table')
      if (t && !t.specifications?.subtype) {
        t.specifications = { ...(t.specifications||{}), subtype: 'bedside' }
        t.description = 'bedside table'
      }
    }
    // Mirrors with built-in lighting
    if (/(mirror|mirror\s*cabinet).*built[-\s]*in\s+lighting/.test(lowerMessage)) {
      const m = requirements.requestedItems.find(it => it.type === 'mirror' || it.type === 'mirror_cabinet')
      if (m) m.specifications = { ...(m.specifications||{}), features: { ...(m.specifications?.features||{}), lighting: 'built-in' } }
    }
    // Parse simple color adjectives (e.g., white)
    if (/\bwhite\b/.test(lowerMessage)) {
      const target = requirements.requestedItems[requirements.requestedItems.length - 1]
      if (target) target.specifications = { ...(target.specifications||{}), color: 'white' }
    }
    // Parse finish adjectives (e.g., high-gloss)
    if (/(high\s*gloss|high-gloss)/.test(lowerMessage)) {
      const t = requirements.requestedItems[requirements.requestedItems.length - 1]
      if (t) t.specifications = { ...(t.specifications||{}), finish: 'high-gloss' }
    }

    // Dining set intent: "6-seater dining set with upholstered chairs"
    // If we detect dining set + N-seater, ensure one dining table line and N chairs line.
    const diningSetMatch = /(\d+)[ -]?(?:seat|seater).*(dining\s*(?:set|table)).*(upholster\w*\s+chairs|chairs|chair)/i.exec(lowerMessage)
    if (diningSetMatch) {
      const n = parseInt(diningSetMatch[1], 10) || 0
      // Ensure a dining table line exists
      let tableLine = requirements.requestedItems.find(it => it.type === 'table' && (it.specifications?.subtype === 'dining' || /dining/.test(it.description)))
      if (!tableLine) {
        tableLine = { type: 'table', quantity: 1, description: 'dining table', specifications: { subtype: 'dining' } }
        requirements.requestedItems.push(tableLine)
      } else {
        tableLine.specifications = { ...(tableLine.specifications||{}), subtype: 'dining' }
        if (!/dining/.test(tableLine.description)) tableLine.description = 'dining table'
      }
      // Add chairs line with quantity N
      if (n > 0 && !requirements.requestedItems.find(it => it.type === 'chair')) {
        const upholstered = /upholster\w*/.test(lowerMessage)
        const specs = upholstered ? { features: { upholstered: true } } : {}
        requirements.requestedItems.push({ type: 'chair', quantity: n, description: upholstered ? 'upholstered chair' : 'dining chair', specifications: specs })
      }
    }

    // Dimensions extraction: find tokens like 60x95 or 60 x 95 (optionally with cm)
    const dimRegex = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*[x×]\s*(\d+(?:\.\d+)?))?\s*(cm|centimeter|centimetre)?/gi
    const dimMatches = []
    let dm
    while ((dm = dimRegex.exec(lowerMessage)) !== null) {
      dimMatches.push({ w: dm[1], h: dm[2], d: dm[3] || null, unit: dm[4] || 'cm' })
    }
    // Attach dimensions to items in order of appearance
    for (let i = 0; i < dimMatches.length && i < requirements.requestedItems.length; i++) {
      const it = requirements.requestedItems[i]
      const d = dimMatches[i]
      it.specifications = {
        ...(it.specifications||{}),
        dimensions: { width: d.w, height: d.h, depth: d.d, unit: d.unit }
      }
      // Also store a normalized dim token for must-have matching
      it.specifications.dim_token = `${d.w}x${d.h}`
    }
    
    // Merge duplicates: same type + seater considered the same line.
    // If one mention has subtype/material and the other doesn't, keep ONE line and adopt the more specific attributes.
    const merged = []
    // Distinguish lines of the same type by core specs so multiple variants can coexist (e.g., 3-seater + 4-seater sofas, or two sofas with different materials)
const keyOf = (it) => {
  const s = it.specifications || {}
  const parts = [it.type || '', s.seater || '', s.subtype || '', s.material || '']
  return parts.map(v => String(v).toLowerCase()).join('|')
}
    for (const it of requirements.requestedItems) {
      const key = keyOf(it)
      const existing = merged.find(x => keyOf(x) === key)
      if (!existing) {
        merged.push({ ...it })
      } else {
        const exSpecs = existing.specifications || {}
        const newSpecs = it.specifications || {}
        const existingMat = exSpecs.material || null
        const newMat = newSpecs.material || null
        const existingSubtype = exSpecs.subtype || null
        const newSubtype = newSpecs.subtype || null

        const rank = (m) => (m === 'glass' ? 3 : m === 'metal' ? 2 : m === 'wooden' ? 1 : 0)
        const betterMat = rank(newMat) >= rank(existingMat) ? newMat : existingMat

        // Merge specifics without increasing quantity when both were single mentions
        if (existing.quantity === 1 && it.quantity === 1) {
          const chosenSubtype = existingSubtype || newSubtype || null
          existing.specifications = { ...exSpecs, material: betterMat, subtype: chosenSubtype }
          // Update description to reflect chosen subtype/material when present
          if (chosenSubtype && !existing.description.includes(chosenSubtype)) {
            existing.description = `${chosenSubtype} ${existing.type}`
          } else if (betterMat && !existing.description.includes(betterMat)) {
            existing.description = `${betterMat} ${existing.type}`
          }
        } else {
          // Do NOT auto-sum quantities for duplicate mentions; keep the higher quantity only
          const chosenSubtype = existingSubtype || newSubtype || null
          const nextQty = Math.max(Number(existing.quantity || 1), Number(it.quantity || 1))
          existing.quantity = nextQty
          existing.specifications = { ...exSpecs, material: betterMat, subtype: chosenSubtype }
        }
      }
    }

    // Special case: if the message mentions a sofa-bed, collapse separate 'sofa' and 'bed' into one 'sofa' line
    if (lowerMessage.includes('sofa-bed') || lowerMessage.includes('sofa bed')) {
      const sofaIdx = merged.findIndex(it => it.type === 'sofa')
      const bedIdx = merged.findIndex(it => it.type === 'bed')
      if (sofaIdx !== -1 && bedIdx !== -1) {
        // Keep sofa line, drop bed line
        merged.splice(bedIdx, 1)
        // Optionally enrich description
        merged[sofaIdx].description = `${merged[sofaIdx].description} (sofa-bed)`
      }
    }

    // Do NOT allow multiple sofa variants unless explicitly asked (e.g., "two sofas", "another sofa").
    // Keep a single sofa line, preferring the most specific one.
    const wantsMultipleSofas = /(two|2|another|one\s*more)\s+sofa/.test(lowerMessage)
    if (!wantsMultipleSofas) {
      const sofas = requirements.requestedItems.filter(it => it.type === 'sofa')
      if (sofas.length > 1) {
        // Keep the most specific sofa (with seater/material), drop others
        const scoreSofa = (it) => {
          const s = it.specifications || {}
          let sc = 0
          if (s.seater) sc += 2
          if (s.material) sc += 1
          if (s.subtype) sc += 1
          return sc
        }
        const best = sofas.slice().sort((a,b) => scoreSofa(b) - scoreSofa(a))[0]
        requirements.requestedItems = requirements.requestedItems.filter(it => it.type !== 'sofa').concat([best])
      }
    }

    // Suppress generic mirror if mirror_cabinet present (unless mirror has explicit features/specs)
    const hasMirrorCab = requirements.requestedItems.some(it => it.type === 'mirror_cabinet')
    if (hasMirrorCab) {
      requirements.requestedItems = requirements.requestedItems.filter(it => {
        if (it.type !== 'mirror') return true
        const s = it.specifications || {}
        const hasSpecs = s.color || s.finish || s.material || s.dim_token || s.dimensions || (s.features && (s.features.doors || s.features.drawers || s.features.lighting))
        return !!hasSpecs // keep only if genuinely separate
      })
    }

    // Remove false-positive 'bed' created from the area word 'bedroom'
    const explicitBedMention = /\bbed(?!room)\b/.test(lowerMessage)
    if (!explicitBedMention) {
      requirements.requestedItems = requirements.requestedItems.filter(it => it.type !== 'bed')
    }

    // After merge: enforce one line per type by keeping the most specific line
    const specScore = (it) => {
      const s = it.specifications || {}
      let score = 0
      if (s.seater) score += 2
      if (s.subtype) score += 2
      if (s.material) score += 1
      if (s.color) score += 1
      if (s.finish) score += 1
      if (s.size) score += 1
      if (s.dimensions || s.dim_token) score += 2
      const f = s.features || {}
      if (f.drawers) score += 2
      if (f.doors) score += 2
      if (f.lighting) score += 2
      return score
    }
    const byType = {}
    for (const it of merged) {
      const t = it.type
      if (!byType[t]) { byType[t] = it; continue }
      const cur = byType[t]
      const better = specScore(it) > specScore(cur) ? it : cur
      // If same score, prefer the one with explicit higher quantity
      byType[t] = (specScore(it) === specScore(cur) && (it.quantity||1) > (cur.quantity||1)) ? it : better
    }
    requirements.requestedItems = Object.values(byType)

    // FIX: Treat 'N-seater' as seater count, not quantity. Also flag sofa-bed feature.
    try {
      const lm = (lowerMessage || '')
      const seaterMatch = lm.match(/(\d+)\s*(?:-\s*)?(?:seater|seat)s?/i)
      const seats = seaterMatch ? parseInt(seaterMatch[1], 10) : null
      const wantsSofaBed = /sofa-?bed/i.test(lm)
      for (const it of requirements.requestedItems) {
        if (it.type === 'sofa') {
          it.specifications = it.specifications || {}
          if (seats && (!it.specifications.seater || Number(it.specifications.seater) !== seats)) {
            it.specifications.seater = seats
          }
          // If user specified 'seater', we should not assume quantity from that number
          if (seats && (it.quantity || 1) > 1) {
            it.quantity = 1
          }
          if (wantsSofaBed) {
            it.specifications.features = it.specifications.features || {}
            it.specifications.features.sofabed = true
          }
        }
      }
    } catch {}

    // Guard: remove any unintended types not in allowedTypes
    requirements.requestedItems = requirements.requestedItems.filter(it => allowedTypes.has(it.type))
    const DEBUG_RETRIEVAL = String(import.meta.env.VITE_DEBUG_RETRIEVAL || '').toLowerCase() === 'true'
    if (DEBUG_RETRIEVAL) {
      console.log('Extracted quotation requirements:', requirements)
    }
    return requirements
  }

  // Get alternatives for a selected item
  async getAlternatives(selectedLine, filters, { limit = 3, offset = 0, sessionId = 'default', showAll = false } = {}) {
    const type = (selectedLine?.line?.type || '').toLowerCase()
    const currentId = selectedLine?.item?.id || null
    const maxPrice = Number(filters?.maxPrice || 0) || null

    // Fast path: strict category + strict-then-relaxed subcategory to keep result set tiny
    try {
      const { category, subcategoryLike } = this.resolveCategory(type, selectedLine?.line?.specifications || {})
      if (category) {
        const cols = 'id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,category,subcategory'
        const applyCommon = (q) => {
          if (currentId) q = q.neq('id', currentId)
          if (maxPrice) q = q.lte('price_inr', maxPrice)
          return q.order('price_inr', { ascending: true }).limit(Math.max(3, Math.min(16, limit || 12))).range(offset || 0, (offset || 0) + Math.max(3, Math.min(16, limit || 12)) - 1)
        }
        // Strict first
        let qStrict = supabase.from('interior_items').select(cols).eq('category', category)
        if (subcategoryLike) qStrict = qStrict.eq('subcategory', subcategoryLike)
        qStrict = applyCommon(qStrict)
        const { data: strictRows, error: strictErr } = await qStrict
        if (!strictErr && Array.isArray(strictRows) && strictRows.length) {
          // Return early; caller will score/diversify as before
          return strictRows
        }
        // Relaxed subcategory
        if (subcategoryLike) {
          let qRelax = supabase.from('interior_items').select(cols).eq('category', category)
          qRelax = qRelax.ilike('subcategory', `%${subcategoryLike}%`)
          qRelax = applyCommon(qRelax)
          const { data: relaxRows, error: relaxErr } = await qRelax
          if (!relaxErr && Array.isArray(relaxRows) && relaxRows.length) {
            return relaxRows
          }
        }
      }
    } catch (_) { /* fall back to broad flow */ }

    // Broad fetch under budget (and some light hints), then filter client-side for robustness
    let q = supabase
      .from('interior_items')
      .select('id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,category,subcategory')
    // Narrow by canonical category/subcategory for precision (as hints)
    try {
      const specs = selectedLine?.line?.specifications || {}
      const { category, subcategoryLike } = this.resolveCategory(type, specs)
      if (category) q = q.ilike('category', category)
      if (subcategoryLike) q = q.ilike('subcategory', `%${subcategoryLike}%`)
    } catch (_) { /* ignore */ }
    if (currentId) q = q.neq('id', currentId)
    if (maxPrice && !showAll) q = q.lte('price_inr', maxPrice)
    q = q.order('price_inr', { ascending: true })
    q = q.range(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit) - 1)
    const { data, error } = await q
    if (error || !Array.isArray(data)) return []

    const hay = (r) => `${r.item_name||''} ${r.item_description||''} ${r.item_details||''} ${r.keywords||''} ${r.variation_name||''} ${r.base_material||''} ${r.finish_material||''} ${r.category||''} ${r.subcategory||''}`.toLowerCase()
    const mat = (selectedLine?.line?.specifications?.material || '').toLowerCase()

    // Type tokens and synonyms
    const tokensByType = {
      // Do not bias by seater count; use generic sofa tokens only
      sofa: ['sofa','couch'],
      chair: ['chair','armchair','dining chair'],
      table: ['table','coffee table','side table','dining table','bedside'],
      bed: ['bed','frame','bed frame'],
      wardrobe: ['wardrobe','closet'],
      mirror: ['mirror'],
      cabinet: ['cabinet','cupboard','storage'],
      drawer: ['drawer','chest of drawers','dresser'],
      desk: ['desk','workspace','work desk','office desk'],
      tv_bench: ['tv bench','tv unit','tv stand','tv table','tv storage','tv-bench','tv bench'],
      bookcase: ['bookcase','book case','bookshelf','book shelf','shelving','shelving unit','shelf','shelf unit','kallax']
    }
    const toks = (() => {
      const base = tokensByType[type] || [type]
      const sub = String(selectedLine?.line?.specifications?.subtype || '').toLowerCase()
      if (type === 'table') {
        if (sub === 'bedside') return [...base, 'bedside', 'bedside table', 'nightstand', 'night stand', 'night table']
        if (sub === 'coffee') return [...base, 'coffee', 'coffee table']
        if (sub === 'side') return [...base, 'side table']
        if (sub === 'dining') return [...base, 'dining table']
      }
      return base
    })()

    // Build candidate set
    let candidates = data.filter(r => r.id !== currentId)
    // Enforce budget cap client-side as well unless showAll
    if (maxPrice && !showAll) candidates = candidates.filter(r => Number(r.price_inr || 0) <= maxPrice)
    // Filter out alternatives already shown for this session and type unless showAll is requested
    if (!showAll) {
      const servedBucket = getServedForSession(sessionId)
      const typeKey = type || 'unknown'
      const servedSet = servedBucket[typeKey] || new Set()
      servedBucket[typeKey] = servedSet
      candidates = candidates.filter(r => !servedSet.has(r.id))
    }

    // Primary filter: always keep to the same type tokens; when showAll is true, we still restrict by type
    let filtered
    {
      const isSofaQuery = toks.includes('sofa')
      filtered = candidates.filter(r => {
        const h = hay(r)
        const typeHit = toks.some(t => h.includes(t))
        if (typeHit) return true
        // For sofa queries, also accept couch/sofa-bed and ignore seaters in tokens
        if (isSofaQuery && /(\bsofa\b|\bcouch\b|sofa\s*-?\s*bed|\bsofabed\b)/.test(h)) return true
        return false
      })
      // Do NOT fall back to unrelated categories; keep it empty to avoid mixing types
      if (filtered.length === 0) {
        // Same-family fallback: broaden within the family for known types
        const famFiltered = candidates.filter(r => {
          const h = hay(r)
          if (type === 'tv_bench') return /(\btv\b|television|tv\s*(unit|stand|table|storage|bench))/i.test(h)
          if (type === 'bookcase') return /(book\s*case|book\s*shelf|bookshelf|shelving|shelf|kallax)/i.test(h)
          if (type === 'table') {
            const sub = String(selectedLine?.line?.specifications?.subtype || '').toLowerCase()
            if (sub === 'bedside') return /(bedside|night\s*stand|nightstand|night\s*table)/i.test(h)
            if (sub === 'coffee') return /(coffee\s*table)/i.test(h)
            if (sub === 'side') return /(side\s*table)/i.test(h)
            if (sub === 'dining') return /(dining\s*table)/i.test(h)
            return /\btable\b/i.test(h)
          }
          return false
        })
        filtered = famFiltered
      }

      // If still empty, run a second DB query with token ilike ORs to avoid page-range gaps
      if (filtered.length === 0) {
        try {
          const cols = ['item_name','item_description','item_details','keywords','category','subcategory']
          const orParts = []
          for (const t of toks) {
            const tok = String(t).trim()
            if (!tok) continue
            for (const c of cols) orParts.push(`${c}.ilike.%${tok}%`)
          }
          // Special tv umbrella token
          if (type === 'tv_bench') {
            for (const c of cols) orParts.push(`${c}.ilike.%tv%`)
          }
          let q2 = supabase
            .from('ikea_items')
            .select('id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,category,subcategory')
            .order('id', { ascending: true })
            .limit(Math.max(50, limit))
          if (orParts.length) q2 = q2.or(orParts.join(','))
          const { data: data2, error: err2 } = await q2
          if (!err2 && Array.isArray(data2)) {
            const extra = data2.filter(r => r.id !== currentId)
            filtered = extra.filter(r => {
              const h = hay(r)
              const typeHit = toks.some(t => h.includes(t))
              if (typeHit) return true
              if (type === 'tv_bench' && /(\btv\b|television|tv\s*(unit|stand|table|storage|bench))/i.test(h)) return true
              if (type === 'bookcase' && /(book\s*case|book\s*shelf|bookshelf|shelving|shelf|kallax)/i.test(h)) return true
              return false
            })
          }
        } catch (_) { /* ignore */ }
      }

      // Final fallback: try interior_items if ikea_items produced nothing (projects that only loaded one table)
      if (filtered.length === 0) {
        try {
          const cols = ['item_name','item_description','item_details','keywords','category','subcategory']
          const orParts = []
          for (const t of toks) {
            const tok = String(t).trim()
            if (!tok) continue
            for (const c of cols) orParts.push(`${c}.ilike.%${tok}%`)
          }
          if (type === 'tv_bench') {
            for (const c of cols) orParts.push(`${c}.ilike.%tv%`)
          }
          let q3 = supabase
            .from('interior_items')
            .select('id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,category,subcategory')
            .order('id', { ascending: true })
            .limit(Math.max(50, limit))
          if (orParts.length) q3 = q3.or(orParts.join(','))
          const { data: data3, error: err3 } = await q3
          if (!err3 && Array.isArray(data3)) {
            const extra = data3.filter(r => r.id !== currentId)
            filtered = extra.filter(r => {
              const h = hay(r)
              const typeHit = toks.some(t => h.includes(t))
              if (typeHit) return true
              if (type === 'tv_bench' && /(\btv\b|television|tv\s*(unit|stand|table|storage|bench))/i.test(h)) return true
              if (type === 'bookcase' && /(book\s*case|book\s*shelf|bookshelf|shelving|shelf|kallax)/i.test(h)) return true
              return false
            })
          }
        } catch (_) { /* ignore */ }
      }
    }

    // Scoring: type relevance + price closeness to maxPrice (no material boost)
    const score = (r) => {
      const h = hay(r)
      let s = 0
      if (!showAll) {
        for (const t of toks) if (h.includes(t)) s += 2
      }
      if (!showAll && maxPrice && Number(r.price_inr)) {
        const p = Number(r.price_inr)
        if (p <= maxPrice) s += Math.max(0, Math.min(2, (p / maxPrice) * 2))
      }
      return s
    }
    // Sort by relevance
    const sorted = filtered.sort((a,b) => score(b) - score(a))

    // De-duplicate very similar entries (same item_name and variation_name)
    const seenKeys = new Set()
    const unique = []
    const keyOf = (r) => `${String(r.item_name||'').toLowerCase().trim()}|${String(r.variation_name||'').toLowerCase().trim()}`
    for (const r of sorted) {
      const k = keyOf(r)
      if (seenKeys.has(k)) continue
      seenKeys.add(k)
      unique.push(r)
    }

    // Diversify by seater buckets first for sofas, then by material to avoid monoculture lists
    const seatBucket = (r) => {
      const h = hay(r)
      const m = h.match(/(\d+)\s*(?:-\s*)?(?:seater|seat)s?/) ;
      if (/sofa\s*-?\s*bed|sofabed|sofa\s+bed/.test(h)) return 'bed'
      if (m) return `s${m[1]}`
      return 'sother'
    }
    const bucketOf = (r) => {
      const h = hay(r)
      if (/fabric|cloth|textile/.test(h)) return 'fabric'
      if (/leather|leatherette|faux/.test(h)) return 'leather'
      if (/glass/.test(h)) return 'glass'
      if (/metal|steel|iron|aluminium/.test(h)) return 'metal'
      if (/wood/.test(h)) return 'wood'
      return 'other'
    }
    // First: seater buckets (applies mainly to sofas)
    const seatBuckets = new Map()
    for (const r of unique) {
      const sb = seatBucket(r)
      if (!seatBuckets.has(sb)) seatBuckets.set(sb, [])
      seatBuckets.get(sb).push(r)
    }
    const seatOrder = ['bed','s4','s3','s2','s5','s6','s7','sother']
    const seatMixed = []
    {
      let advancedAny = true
      while (advancedAny && seatMixed.length < unique.length) {
        advancedAny = false
        for (const sKey of seatOrder) {
          const arr = seatBuckets.get(sKey)
          if (arr && arr.length) {
            seatMixed.push(arr.shift())
            advancedAny = true
          }
        }
      }
    }
    // Second: material buckets on the seat-mixed list
    const buckets = new Map()
    for (const r of seatMixed) {
      const b = bucketOf(r)
      if (!buckets.has(b)) buckets.set(b, [])
      buckets.get(b).push(r)
    }
    const order = ['fabric','leather','wood','metal','glass','other']
    const paged = []
    let picked = 0
    const start = Math.max(0, Number(offset) || 0)
    while (picked < seatMixed.length && paged.length < (limit + start)) {
      let advanced = false
      for (const b of order) {
        const arr = buckets.get(b)
        if (arr && arr.length) {
          paged.push(arr.shift())
          picked++
          advanced = true
          if (paged.length >= (limit + start)) break
        }
      }
      if (!advanced) break
    }
    const result = paged.slice(start, start + limit)
    return result
  }

  // Main chat processing function
  async processChat(userMessage, opts = {}) {
    try {
      // Route through the LangGraph StateGraph with in-process RAM memory
      const sessionId = opts?.sessionId || 'default'
      // Sprint 1: optional debug pre-parse log
      const DEBUG_RETRIEVAL = String(import.meta.env.VITE_DEBUG_RETRIEVAL || '').toLowerCase() === 'true'
      if (DEBUG_RETRIEVAL) {
        console.log('[DEBUG] Incoming userMessage:', userMessage)
      }
      // Optional LLM pre-summarizer for user intent (safe: ignores on failure or when disabled)
      let llmSummary = null
      try {
        const USE_SUM = String(import.meta.env.VITE_USE_LLM_SUMMARIZER || '').toLowerCase() === 'true'
        if (USE_SUM && this.openaiApiKey) {
          llmSummary = await this.summarizeIntentLLM(String(userMessage || ''), { mode: 'chat' })
        }
      } catch { /* ignore summarizer issues */ }
      const { req, filters, selections, unmet, clarification } = await runStateGraph(this, sessionId, userMessage)
      // Note: refineRequirementsLLM remains available but not altering the graph mid-turn to avoid regressions.
      // Future: we can invoke it before the graph when we plumb a hook into parse_requirements.

      // If the graph produced a clarification, surface it immediately (no products yet)
      if (clarification) {
        return { message: clarification, items: [], totalEstimate: 0 }
      }
      // If some lines are unmet, prepare a short clarifier question but DO NOT return early.
      // We will still return any selected items so the user sees the full quotation updated.
      let unmetMessage = ''
      if (unmet && unmet.length > 0) {
        const first = unmet[0]
        const t = (first.line?.type || 'item')
        const specs = first.line?.specifications || {}
        const budgetAnswered = !!(filters?.maxPrice) || (req && req._budgetType === 'above') || !!(filters?.package)
        if (t === 'sofa' && !specs.material && budgetAnswered) {
          unmetMessage = 'Which style/material do you prefer for the sofa (e.g., fabric or leather)?'
        } else {
          if (t === 'sofa') {
            unmetMessage = 'What budget range should I target for the sofa (under ₹10,000, ₹10,000–₹20,000, ₹20,000–₹40,000, above ₹40,000)?'
          } else if (t === 'tv_bench') {
            unmetMessage = 'What budget range should I use for the TV bench (under ₹20,000, ₹20,000–₹40,000, above ₹40,000)?'
          } else if (t === 'table') {
            unmetMessage = 'What budget range should I aim for the table (under ₹10,000, ₹10,000–₹20,000, ₹20,000–₹40,000, above ₹40,000)?'
          } else {
            unmetMessage = `What budget range should I target for the ${t} (under ₹10,000, ₹10,000–₹20,000, ₹20,000–₹40,000, above ₹40,000)?`
          }
        }
      }

      // If selections are missing or incomplete, build them in parallel from requested lines
      let effectiveSelections = Array.isArray(selections) ? [...selections] : []
      // Declare intent flags in outer scope so they're available after the try block
      let lowerMsg = String(userMessage || '').toLowerCase()
      let isReplace = /\breplace\b/i.test(lowerMsg)
      let isAdd = /\badd\b/i.test(lowerMsg)
      let isRemove = /\bremove\b/i.test(lowerMsg)
      try {
        // If user asked for N BHK (and/or wrote 'essentials') but parser produced no requested lines,
        // seed the same essentials set used by the floor planner.
        lowerMsg = String(userMessage || '').toLowerCase()
        const mBhk = lowerMsg.match(/\b(\d+)\s*-?\s*bhk\b/)
        const mArea = lowerMsg.match(/\b(\d{3,5})\s*(?:sq\s*\.? ?ft|sft|square\s*feet)\b/i)
        const askedEssentials = /\bessential(s)?\b/i.test(userMessage || '')
        isReplace = /\breplace\b/i.test(lowerMsg)
        isAdd = /\badd\b/i.test(lowerMsg)
        isRemove = /\bremove\b/i.test(lowerMsg)
        const parsedBhk = mBhk ? parseInt(mBhk[1], 10) : null
        const parsedArea = mArea ? parseInt(mArea[1], 10) : (opts?.area || null)
        let requested = (req && Array.isArray(req.requestedItems)) ? req.requestedItems : []
        const canSeedEssentials = !(isReplace || isAdd || isRemove) && (requested.length === 0) && (parsedBhk != null || askedEssentials)
        if (canSeedEssentials) {
          requested = this.buildEssentialsByBhk(parsedBhk || 1, { area: parsedArea || 0 })
        }

        // Replace fallback: if message says "replace <type> with id <id>" but that type doesn't exist yet,
        // add a new requested line carrying preferredId so selection proceeds correctly.
        var replaceFallback = false
        var addFallback = false
        try {
          const mReplace = /\breplace\s+([a-z_ ]+?)\s+with\s+id\s+(\d+)\b/i.exec(lowerMsg)
          if (mReplace) {
            const rawType = (mReplace[1] || '').trim()
            const id = Number(mReplace[2])
            const normType = rawType.replace(/\s+/g, '_').toLowerCase()
            const hasType = Array.isArray(requested) && requested.some(it => String(it.type||'').toLowerCase() === normType)
            if (!hasType) {
              const subMatch = /(coffee|side|bedside|dining)\s*table/.exec(rawType) || (/^table\s+(coffee|side|bedside|dining)/.exec(rawType))
              const specs = subMatch ? { subtype: String(subMatch[1]).toLowerCase() } : {}
              requested = Array.isArray(requested) ? requested.slice() : []
              requested.push({ type: normType, quantity: 1, preferredId: id, specifications: specs })
              replaceFallback = true
            }
          }
          // Add fallback: if message says "add <type> with id <id>" ensure a new requested line is present
          const mAdd = /\badd\s+([a-z_ ]+?)\s+with\s+id\s+(\d+)\b/i.exec(lowerMsg)
          if (mAdd) {
            const rawType = (mAdd[1] || '').trim()
            const id = Number(mAdd[2])
            const normType = rawType.replace(/\s+/g, '_').toLowerCase()
            const subMatch = /(coffee|side|bedside|dining)\s*table/.exec(rawType) || (/^table\s+(coffee|side|bedside|dining)/.exec(rawType))
            const specs = subMatch ? { subtype: String(subMatch[1]).toLowerCase() } : {}
            requested = Array.isArray(requested) ? requested.slice() : []
            requested.push({ type: normType, quantity: 1, preferredId: id, specifications: specs })
            addFallback = true
          }
        } catch (_) { /* ignore */ }
        // Dedup requested lines before selection
        // Skip for explicit replace/add/remove to avoid collapsing intent, EXCEPT when replaceFallback is true
        if (replaceFallback || !(isReplace || isAdd || isRemove)) requested = this.mergeRequestedLines(requested)
        const needBuild = (!effectiveSelections || effectiveSelections.length === 0)
          || effectiveSelections.some(s => !s || !s.item || !s.line)
        // For replace/add/remove intents, rely on graph selections to keep the rest of the plan intact
        if (((replaceFallback || addFallback) || !(isReplace || isAdd || isRemove)) && requested.length > 0 && needBuild) {
          const usedItemIds = new Set()
          const tasks = requested.map(async (line) => {
            const r = await this.findBestItem(line, (filters || {}), usedItemIds)
            return { line, item: r?.item || null, reason: r?.reason || 'ok' }
          })
          const results = await Promise.allSettled(tasks)
          effectiveSelections = results
            .filter(r => r.status === 'fulfilled' && r.value && r.value.item)
            .map(r => r.value)
          // Merge duplicate selections of same room/type/subtype (skip for replace/add/remove)
          if (!(isReplace || isAdd || isRemove)) effectiveSelections = this.mergeSelections(effectiveSelections)
        }
      } catch (_) { /* fallback: keep original selections */ }

      // On replace/add/remove intents, reconcile with last selections to preserve the full plan and quantities
      if (isReplace || isAdd || isRemove) {
        const prev = getLastSelections(sessionId)
        if (Array.isArray(prev) && prev.length > 0 && Array.isArray(effectiveSelections) && effectiveSelections.length > 0) {
          const byKey = new Map(prev.map(p => [this.lineKey(p.line), { ...p }]))
          if (isRemove) {
            // Try to remove targeted types based on message tokens
            const lower = (userMessage || '').toLowerCase()
            const targetTypes = ['sofa','tv bench','tv_bench','table','bed','wardrobe','mirror','cabinet','bookcase','washstand','shoe rack','shoe_rack','chair','lamp']
            const toRemove = new Set(targetTypes.filter(t => lower.includes(t)))
            for (const k of Array.from(byKey.keys())) {
              const t = k.split('|')[1]
              if (toRemove.has(t)) byKey.delete(k)
            }
            // If graph also returned explicit empties (rare), respect them by removing their keys
            for (const sel of effectiveSelections) {
              const k = this.lineKey(sel.line)
              if (!sel.item) byKey.delete(k)
            }
          } else if (isAdd || isReplace) {
            // Merge/overwrite the affected lines, preserve quantities unless new specifies
            for (const sel of effectiveSelections) {
              let k = this.lineKey(sel.line)
              const existing = byKey.get(k)
              if (existing) {
                const existingQ = Math.max(1, Number(existing.line?.quantity || 1))
                const newQ = Number(sel.line?.quantity)
                sel.line.quantity = (isFinite(newQ) && newQ > 0) ? newQ : existingQ
                // If this was an explicit add with a concrete preferredId, avoid overwriting existing line; keep as a separate new line
                const prefId = sel.line?.preferredId || sel.item?.id
                if (isAdd && prefId) {
                  k = `${k}|id:${prefId}`
                }
              }
              byKey.set(k, sel)
            }
          }
          effectiveSelections = Array.from(byKey.values())
        }
      }

      // Assemble quotation object from selections for ChatBot.jsx
      const items = (effectiveSelections || []).map(sel => {
        const row = sel.item
        const line = sel.line
        const quantity = Number(line.quantity || 1)
        const unit = Number(row.price_inr || 0)
        const line_total_inr = unit * quantity
        return { ...row, quantity, line_total_inr }
      })
      const totalEstimate = items.reduce((s, it) => s + (it.line_total_inr || 0), 0)

      // Sprint 2 (part): add lightweight explanations for each line (optional UI use)
      const explanations = (effectiveSelections || []).map(sel => {
        const row = sel.item || {}
        const line = sel.line || {}
        const specs = line.specifications || {}
        const hits = []
        if (line.type) hits.push(`type: ${String(line.type).replace('_',' ')}`)
        if (specs.seater) hits.push(`${specs.seater}-seater`)
        if (specs.subtype) hits.push(`${specs.subtype} table`)
        if (specs.material) hits.push(specs.material)
        if (row.preferred_theme && (row.preferred_theme||'').toLowerCase().includes(String((opts?.theme||'')||'').toLowerCase())) hits.push('theme match')
        if (filters?.maxPrice && Number(row.price_inr||0) <= Number(filters.maxPrice)) hits.push('under per-item cap')
        return { id: row.id, why: hits }
      })

      // Compute budget flags for UI
      let budgetLimit = null
      let overBudget = false
      let budgetOverBy = 0
      try {
        const scope = req?._budgetScope || null
        if (scope === 'total' && req?.budget) {
          budgetLimit = Number(req.budget)
        } else if (scope === 'per_item' && filters?.maxPrice) {
          budgetLimit = Number(filters.maxPrice) * Math.max(1, items.length)
        }
        if (budgetLimit != null && isFinite(budgetLimit)) {
          if (totalEstimate > budgetLimit) {
            overBudget = true
            budgetOverBy = totalEstimate - budgetLimit
          }
        }
      } catch (_) { /* ignore budget calc errors */ }
      // We no longer include a verbose text header with per-item breakdown in the message.
      // The UI shows a Quotation card; keep message minimal.
      const readableLines = []
      const header = ''
      const footer = ''

      // If user requested reduce-to-budget and we're over budget with a computable budgetLimit, try to swap expensive lines
      const wantsReduce = /\breduce\s+to\s+budget\b/i.test(String(userMessage||''))
      if (wantsReduce && overBudget && budgetLimit && isFinite(budgetLimit) && Array.isArray(selections) && selections.length > 0) {
        try {
          // Prepare working copies
          const workSelections = selections.map(s => ({ line: { ...(s.line||{}) }, item: { ...(s.item||{}) }, reason: s.reason }))
          let total = totalEstimate
          // Sort by line_total desc to replace the most expensive lines first
          const getLineTotal = (sel) => Number(sel.item?.price_inr || 0) * Math.max(1, Number(sel.line?.quantity || 1))
          const orderIdx = [...workSelections.keys()].sort((a,b) => getLineTotal(workSelections[b]) - getLineTotal(workSelections[a]))
          let replacedCount = 0
          for (const idx of orderIdx) {
            if (total <= budgetLimit) break
            const sel = workSelections[idx]
            const currentPrice = Number(sel.item?.price_inr || 0)
            const qty = Math.max(1, Number(sel.line?.quantity || 1))
            // Pull a large page of cheaper alternatives (showAll) of the same type and pick the best cheaper one
            const alts = await this.getAlternatives({ line: sel.line, item: sel.item }, filters || {}, { limit: 100, offset: 0, showAll: true })
            if (!alts || alts.length === 0) continue
            const cheaper = alts.filter(r => Number(r.price_inr || 0) < currentPrice)
            if (cheaper.length === 0) continue
            // Choose the cheapest alternative available
            const best = cheaper.sort((a,b) => Number(a.price_inr||0) - Number(b.price_inr||0))[0]
            // Update total and selection
            const oldLineTotal = currentPrice * qty
            const newLineTotal = Number(best.price_inr || 0) * qty
            if (newLineTotal >= oldLineTotal) continue
            total = total - oldLineTotal + newLineTotal
            workSelections[idx] = { ...sel, item: { ...best } }
            replacedCount++
          }
          // If we achieved improvement, propagate to response
          if (replacedCount > 0) {
            const newItems = workSelections.map(sel => ({ ...sel.item, quantity: Math.max(1, Number(sel.line?.quantity || 1)), line_total_inr: Number(sel.item?.price_inr||0) * Math.max(1, Number(sel.line?.quantity || 1)) }))
            const newTotal = newItems.reduce((s, it) => s + (it.line_total_inr || 0), 0)
            const saved = totalEstimate - newTotal
            const stillOver = budgetLimit && newTotal > budgetLimit
            // Update response payload overrides
            Object.assign((filters||{}))
            return {
              message: stillOver
                ? `I reduced the total by ₹${Math.max(0, Math.round(saved)).toLocaleString('en-IN')}, but it's still over budget by ₹${Math.max(0, Math.round(newTotal - budgetLimit)).toLocaleString('en-IN')}.`
                : `Reduced to budget. Saved ₹${Math.max(0, Math.round(saved)).toLocaleString('en-IN')}.`,
              items: newItems,
              totalEstimate: newTotal,
              filters,
              selections: workSelections,
              alternatives: {},
              overBudget: Boolean(stillOver),
              budgetLimit,
              budgetOverBy: stillOver ? (newTotal - budgetLimit) : 0
            }
          }
        } catch (_) { /* fallback to normal flow */ }
      }

      // Heuristic clarification: if key items lack style/material or budget/package, append one concise question.
      // Do NOT append if this was an explicit replace turn (_skipClarify true), to avoid noise.
      const requested = (req && req.requestedItems) || []
      const hasSofaReq = requested.some(r => r.type === 'sofa')
      const hasTvBenchReq = requested.some(r => r.type === 'tv_bench')
      const hasCoffeeTableReq = requested.some(r => r.type === 'table' && (r.specifications?.subtype === 'coffee'))

      const sofaLine = requested.find(r => r.type === 'sofa') || null
      const sofaHasMaterial = !!(sofaLine && sofaLine.specifications && sofaLine.specifications.material)
      const lacksBudget = !filters?.maxPrice
      let clarifierTail = ''
      if (!req?._skipClarify) {
        // Only append heuristic clarifier if LLM clarifier did not run
        if (!clarification && hasSofaReq && (!sofaHasMaterial || lacksBudget)) {
          const needsAny = ['sofa'].filter(t => !requested.find(r => r.type === t && r.specifications?.material))
          clarifierTail = needsAny ? ` To tailor this better, which style/material do you prefer for the ${needsAny[0]} (e.g., fabric, leather, modern, traditional) and what budget should I work within?` : ''
        } else if (!clarification && hasTvBenchReq && (lacksBudget)) {
          clarifierTail = ' Would you like me to work within a budget for the TV bench (e.g., under ₹20,000, ₹20,000–₹40,000, above ₹40,000)?'
        } else if (!clarification && hasCoffeeTableReq && (lacksBudget)) {
          clarifierTail = ' What budget range should I target for the coffee table (e.g., under ₹10,000, ₹10,000–₹20,000, above ₹20,000)?'
        }
      }

      // Build alternatives for each selected line with pagination support
      const alternatives = {}
      let altNotice = ''
      const wantsType = (req && req.altForType) ? String(req.altForType).toLowerCase() : null
      const reqOffset = (req && req.altOffset != null) ? Number(req.altOffset) : 0
      for (let i = 0; i < effectiveSelections.length; i++) {
        const s = effectiveSelections[i]
        // Apply offset only to the requested type; others use the first page
        const isTarget = wantsType && String(s.line?.type || '').toLowerCase() === wantsType
        const offset = isTarget ? Math.max(0, reqOffset) : 0
        // If user explicitly asked alternatives for this type, fetch a broader set from the whole catalog
        const altLimit = isTarget ? 24 : 3
        const altShowAll = Boolean(isTarget)
        try {
          const alts = await this.getAlternatives(s, filters, { limit: altLimit, offset, sessionId, showAll: altShowAll })
          if (alts && alts.length) {
            alternatives[i] = alts.map(r => ({ id: r.id, item_name: r.item_name, price_inr: r.price_inr }))
            // Mark these alternatives as served for this session/type to avoid repeats next time
            const servedBucket = getServedForSession(sessionId)
            const typeKey = String(s.line?.type || 'unknown').toLowerCase()
            const servedSet = servedBucket[typeKey] || new Set()
            for (const r of alts) servedSet.add(r.id)
            servedBucket[typeKey] = servedSet
          } else {
            alternatives[i] = []
            if (isTarget) altNotice = ` No more alternatives found under the current budget for ${wantsType.replace('_',' ')}.`
          }
        } catch (_) { /* ignore suggestion errors */ }
      }

      return {
        // Include unmetMessage if present while returning the updated quotation
        message: String(unmetMessage || '').trim(),
        items,
        totalEstimate,
        // expose filters and selections to allow UI to persist client-only memory
        filters,
        selections: effectiveSelections,
        explanations,
        alternatives,
        overBudget,
        budgetLimit,
        budgetOverBy,
        llmSummary,
        changeLog
      }
    } catch (error) {
      console.error('Error processing chat:', error)
      return {
        message: "I apologize, but I'm having trouble processing your request right now. Please try again or contact support.",
        items: [],
        totalEstimate: 0
      }
    }
  }
}

export default new InteriorDesignAI()
*/
