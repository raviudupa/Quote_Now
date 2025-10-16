import { supabase } from '../config/supabase.js'
import { runStateGraph } from './graph/stateGraph.js'
import { analyzeFloorPlan } from './vision/floorplan.js'

// In-process memory for last LLM summary per session
const lastSummaryBySession = new Map()

class QuotationAIService {
  constructor() {
    this.openaiApiKey = import.meta.env.VITE_OPENAI_API_KEY
  }

  // LLM pre-summarizer using your Quotation-AI prompt
  async summarizeIntentLLM(text, { mode = 'chat' } = {}) {
    try {
      const USE = String(import.meta.env.VITE_USE_LLM_SUMMARIZER || 'true').toLowerCase() === 'true'
      if (!USE) return null
      if (!this.openaiApiKey) return null
      const sys = `You are Quotation-AI, an assistant that analyzes customer-provided information (such as floor plans, house details, or requirements) and produces a detailed room-wise list of furniture and essential items.\n\nRules:\n1. Always analyze the given ${mode === 'floorplan' ? 'floor plan' : 'customer description'} first.\n2. Break down the result by ROOM. Common rooms include: living, bedroom, kitchen, bathroom, dining, foyer, study, balcony, toilets. Use lowercase room names in the output.\n3. Under each room, think in terms of Essentials (must-have) and Optionals (nice-to-have), but return a single consolidated JSON as specified below.\n4. Keep the response clear, structured, and easy for quotation generation.\n5. Never skip a room if it is mentioned or present in the plan.\n6. If dimensions are given, factor them into furniture recommendations.\n7. OUTPUT STRICT JSON with keys: { summary: string, rooms: string[], areaSqft: number|null, theme: string|null, budget: { scope: 'per_item'|'total', amount: number }|null, itemsSuggested: Array<{ type: string, subtype?: string, quantity?: number, room?: string }>, clarifications: string[] }.\nUse normalized item types: sofa, sofa_bed, chair, table{subtype: coffee|side|bedside|dining}, tv_bench, bed, wardrobe, mirror, cabinet, bookcase, shelf, storage_combination, lamp, stool, shoe_rack, mirror_cabinet.`
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.openaiApiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: String(text || '').slice(0, 8000) }
          ],
          temperature: 0.2,
          max_tokens: 600
        })
      })
      if (!res.ok) return null
      const data = await res.json()
      const raw = data?.choices?.[0]?.message?.content || '{}'
      let parsed = null
      try { parsed = JSON.parse(raw) } catch { parsed = null }
      if (parsed && typeof parsed === 'object') return parsed
      return null
    } catch (_) { return null }
  }

  // Lightweight resolver from normalized type -> catalog category
  resolveCategory(type, specs = {}) {
    const t = String(type || '').toLowerCase()
    const CATEGORY_MAP = {
      'sofa': 'Sofa',
      'sofa_bed': 'Sofa-bed',
      'tv_bench': 'Tv-bench',
      'table': 'Table',
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
      // Additional common lines we generate in the graph
      'bedside_table': 'Table',          // use subcategoryLike 'bedside'
      'dresser': 'Drawer',               // map to chest/drawers category
      'storage_rack': 'Shelf',           // map to shelving
      'towel_rod': 'Shelf',              // approximate to shelf/accessory
      'bedside_lamp': 'Lamp',            // lamp variants
    }
    let category = CATEGORY_MAP[t] || null
    let subcategoryLike = null
    // Subcategory for tables
    if (t === 'table' || t === 'bedside_table') {
      const sub = String(specs?.subtype || '').toLowerCase()
      if (/(coffee)/.test(sub)) subcategoryLike = 'coffee'
      else if (/(dining)/.test(sub)) subcategoryLike = 'dining'
      else if (/(side)/.test(sub)) subcategoryLike = 'side'
      else if (/(bedside)/.test(sub)) subcategoryLike = 'bedside'
      // If explicit bedside_table, ensure bedside subcategory
      if (t === 'bedside_table' && !subcategoryLike) subcategoryLike = 'bedside'
    }

    // Heuristic fallbacks when category is null or DB uses different naming
    if (!category) {
      if (/(^|\b)tv(\b|\s)|(tv[-_ ]?(bench|unit|stand))/.test(t)) { category = 'Tv-bench' }
      else if (/coffee[_\s-]?table/.test(t)) { category = 'Table'; subcategoryLike = subcategoryLike || 'coffee' }
      else if (/bedside[_\s-]?table/.test(t)) { category = 'Table'; subcategoryLike = subcategoryLike || 'bedside' }
      else if (/dining[_\s-]?table/.test(t)) { category = 'Table'; subcategoryLike = subcategoryLike || 'dining' }
      else if (/drawer|dresser|chest/.test(t)) { category = 'Drawer' }
      else if (/rack|shelf|shelving/.test(t)) { category = 'Shelf' }
      else if (/shoe[_\s-]?rack/.test(t)) { category = 'Shoe rack' }
      else if (/mirror[_\s-]?cabinet/.test(t)) { category = 'Mirror cabinet' }
      else if (/lamp|light/.test(t)) { category = 'Lamp' }
    }
    return { category, subcategoryLike }
  }

  // Optional LLM to propose essentials by room (strict JSON). Guarded by VITE_USE_LLM_ESSENTIALS.
  async proposeEssentialsLLM({ rooms = [], areaSqft = 0, bhk = 1, tier = 'medium', theme = null }) {
    try {
      const USE = String(import.meta.env.VITE_USE_LLM_ESSENTIALS || '').toLowerCase() === 'true'
      if (!USE || !this.openaiApiKey) return null
      const allowedRooms = ['living','bedroom','kitchen','bathroom','dining','foyer']
      const taxonomy = ['sofa','sofa_bed','chair','table','tv_bench','bed','wardrobe','mirror','cabinet','bookcase','shelf','storage_combination','lamp','stool','shoe_rack','mirror_cabinet']
      const sys = `You generate essentials for interior quotations.
Rules:
- Output JSON array only. No prose. Shape: [{"type":string,"quantity":number,"room":string,"specifications":{"subtype?":"coffee|side|bedside|dining","material?":string,"size?":string,"features?":{}}}]
- type must be one of: ${taxonomy.join(', ')}
- room must be one of: ${allowedRooms.join(', ')}
- Quantity must be >=1.
- For tables, set specifications.subtype to one of coffee|side|bedside|dining when applicable.
- Do NOT include duplicates of the same (type+room+subtype). If needed, increase quantity.
- Base the count on BHK ${bhk} and tier ${tier}, and area ${areaSqft} sqft.
- Keep it concise: essentials first; add limited optionals if space allows.
- Do not add appliances or construction materials.`
      const user = `Rooms: ${rooms.join(', ')}${theme ? `\nTheme: ${theme}` : ''}\nBHK: ${bhk}\nTier: ${tier}\nAreaSqft: ${areaSqft}`
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.openaiApiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user }
          ],
          temperature: 0.1,
          max_tokens: 600
        })
      })
      if (!res.ok) return null
      const j = await res.json()
      const content = j?.choices?.[0]?.message?.content || '[]'
      let parsed = null
      try { parsed = JSON.parse(content) } catch { parsed = null }
      if (!parsed) return null
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : [])
      if (!Array.isArray(arr)) return null
      // Normalize and filter to taxonomy/rooms
      const norm = []
      const seen = new Set()
      for (const it of arr) {
        const type = String(it?.type || '').toLowerCase().trim()
        const room = String(it?.room || '').toLowerCase().trim()
        if (!taxonomy.includes(type)) continue
        if (!allowedRooms.includes(room)) continue
        const specifications = it?.specifications || {}
        const sub = String(specifications?.subtype || '').toLowerCase()
        if (type === 'table' && sub && !/(coffee|side|bedside|dining)/.test(sub)) delete specifications.subtype
        const key = `${room}|${type}|${specifications?.subtype || ''}`
        if (seen.has(key)) continue
        seen.add(key)
        norm.push({ type, quantity: Math.max(1, Number(it?.quantity || 1)), room, description: it?.description || type, specifications })
      }
      return norm
    } catch (_) {
      return null
    }
  }

  // Get alternatives for a selected item (broad but paginated)
  async getAlternatives(selectedLine, filters, { limit = 3, offset = 0, sessionId = 'default', showAll = false } = {}) {
    try {
      const type = (selectedLine?.line?.type || '').toLowerCase()
      const { category, subcategoryLike } = this.resolveCategory(type, selectedLine?.line?.specifications || {})
      let q = supabase
        .from('interior_items')
        .select('id,item_name,item_description,item_details,price_inr,category,subcategory')
      if (category) q = q.ilike('category', category)
      if (subcategoryLike) q = q.ilike('subcategory', `%${subcategoryLike}%`)
      if (filters?.maxPrice && !showAll) q = q.lte('price_inr', Number(filters.maxPrice))
      q = q.order('price_inr', { ascending: true }).range(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit) - 1)
      const { data, error } = await q
      if (error || !Array.isArray(data)) return []
      // Remove the current item
      const curId = selectedLine?.item?.id || null
      return data.filter(r => r.id !== curId)
    } catch (_) { return [] }
  }

  // Main chat processing function (unified)
  async processChat(userMessage, opts = {}) {
    try {
      const sessionId = opts?.sessionId || 'default'
      // Delegate to LangGraph first: this handles add/replace/remove/qty, parsing, clarifications, and selection
      const graphRes = await runStateGraph(this, sessionId, userMessage)
      if (graphRes) {
        const { clarification, selections, filters } = graphRes
        if (clarification) {
          return { message: clarification, items: [], totalEstimate: 0, llmSummary: lastSummaryBySession.get(sessionId) || null }
        }
        const effectiveSelections = Array.isArray(selections) ? selections.filter(s => s && s.item && s.line) : []
        if (effectiveSelections.length > 0) {
          const items = effectiveSelections.map(sel => {
            const q = Math.max(1, Number(sel.line?.quantity || 1))
            const unit = Number(sel.item?.price_inr || 0)
            return { ...sel.item, quantity: q, line_total_inr: q * unit, line_type: sel.line?.type || null, room: sel.line?.room || null }
          })
          const totalEstimate = items.reduce((s, it) => s + (it.line_total_inr || 0), 0)
          return { message: '', items, totalEstimate, filters: filters || {}, selections: effectiveSelections, explanations: null, overBudget: false, budgetOverBy: 0, llmSummary: lastSummaryBySession.get(sessionId) || null }
        }
        // No selections yet. If we have a summary from plan or chat, surface a helpful hint.
        const sum = graphRes?.llmSummary || lastSummaryBySession.get(sessionId) || null
        let msg = ''
        if (sum) {
          const rooms = Array.isArray(sum.rooms) ? sum.rooms : []
          const bhkTxt = sum.bhk ? `${sum.bhk} BHK` : null
          const roomsTxt = rooms.length ? `Rooms detected: ${rooms.join(', ')}` : null
          const header = [bhkTxt, roomsTxt].filter(Boolean).join(' • ')
          msg = header ? `${header}. Reply "confirm" to generate your quotation.` : 'Reply "confirm" to generate your quotation.'
        }
        return { message: msg, items: [], totalEstimate: 0, llmSummary: sum }
      }
      // If the graph did not return a result, do not run any non-graph fallbacks.
      return { message: '', items: [], totalEstimate: 0 }
    } catch (e) {
      console.error('processChat error:', e)
      return { message: 'I am having trouble processing your request. Please try again.', items: [], totalEstimate: 0 }
    }
  }

  // Floorplan flow -> unified through processChat
  async processFloorPlanFromUrl(imageUrl, opts = {}) {
    try {
      const analysis = await analyzeFloorPlan(imageUrl)
      const rooms = (analysis?.rooms || []).map(r => String(r?.type || r?.name || '')).filter(Boolean)
      // Derive bhk/tier from rooms and optional sqft in opts
      const { bhk, tier } = this.deriveBhkAndTier((analysis?.rooms || []), imageUrl, { area: opts?.areaSqft || 0 })
      const desc = `Rooms: ${rooms.join(', ')}${bhk ? `, ${bhk}BHK` : ''}${tier ? `, ${tier}` : ''}`
      let llmSummary = null
      try { llmSummary = await this.summarizeIntentLLM(desc, { mode: 'floorplan' }) } catch {}
      // Synthesize a minimal summary if LLM is unavailable but rooms were detected
      if (!llmSummary && Array.isArray(rooms) && rooms.length > 0) {
        llmSummary = {
          summary: `Detected rooms: ${rooms.join(', ')}`,
          rooms: rooms.map(r => String(r).toLowerCase()),
          areaSqft: null,
          theme: null,
          budget: null,
          itemsSuggested: [],
          clarifications: []
        }
      }
      const sessionId = opts?.sessionId || 'default'
      if (llmSummary) lastSummaryBySession.set(sessionId, llmSummary)

      // Return summary first; UI will call processChat('confirm') to generate
      if (!opts?.confirm) {
        return { message: 'Detected rooms. Review the summary and reply "confirm" to generate your quotation.', items: [], totalEstimate: 0, llmSummary, bhk, tier, roomPlan: rooms.map(r => ({ room: r })) }
      }

      // Build requested items per room (LLM-based if enabled) else essentials based on bhk/tier)
      let requested = []
      const allowed = new Set(['living','bedroom','kitchen','bathroom','dining','foyer'])
      const USE_LLM_ESS = String(import.meta.env.VITE_USE_LLM_ESSENTIALS || '').toLowerCase() === 'true'
      if (USE_LLM_ESS && this.openaiApiKey) {
        try {
          const proposed = await this.proposeEssentialsLLM({ rooms, areaSqft: opts?.areaSqft || 0, bhk, tier, theme: llmSummary?.theme || null })
          if (Array.isArray(proposed)) {
            requested = proposed.map(x => ({ type: String(x.type||'').toLowerCase(), quantity: Math.max(1, Number(x.quantity||1)), description: x.description || x.type, specifications: { ...(x.specifications||{}) }, room: String(x.room||'').toLowerCase() || null })).filter(l => l.type)
          }
        } catch { /* fall back */ }
      }
      if (!Array.isArray(requested) || requested.length === 0) {
        const tmp = []
        for (const r of rooms) {
          const areaName = String(r).toLowerCase()
          if (!allowed.has(areaName)) continue
          const maxOpt = this.maxOptionalsFor(areaName, bhk, tier)
          const lines = this.buildRequestedForArea(areaName, { kit: 'essentials', maxOptionals: maxOpt })
          for (const l of (lines || [])) tmp.push({ ...l, room: areaName })
        }
        requested = tmp
      }
      // Optionally merge contextual suggestions from summary (if available for floorplan)
      const USE_SUG2 = String(import.meta.env.VITE_USE_SUMMARY_SUGGESTIONS || '').toLowerCase() === 'true'
      if (USE_SUG2 && Array.isArray(llmSummary?.itemsSuggested) && llmSummary.itemsSuggested.length) {
        const allowed = new Set(['living','bedroom','kitchen','bathroom','dining','foyer'])
        for (const s of llmSummary.itemsSuggested.slice(0, 12)) {
          const t = String(s?.type || '').toLowerCase(); if (!t) continue
          const room = String(s?.room || '').toLowerCase()
          const line = { type: t, quantity: Math.max(1, Number(s?.quantity || 1)), description: s?.type || t, specifications: {} }
          if (s?.subtype) line.specifications.subtype = String(s.subtype).toLowerCase()
          if (allowed.has(room)) line.room = room
          requested.push(line)
        }
      }
      // Fallback: if no rooms detected, seed a minimal living setup
      if (requested.length === 0) {
        const lines = this.buildRequestedForArea('living', { kit: 'essentials', maxOptionals: 0 })
        for (const l of (lines || [])) requested.push({ ...l, room: 'living' })
      }

      // Select catalog items for each requested line with a conservative per-item cap
      const baseCap = (tier === 'small') ? 15000 : (tier === 'large') ? 30000 : 20000
      const bhkAdj = Math.max(0.8, Math.min(1.2, 1 + ((Number(bhk||1) - 2) * 0.1)))
      const perItemCap = Math.round(baseCap * bhkAdj)
      const filters = { maxPrice: perItemCap }
      const used = new Set()
      const tasks = requested.map(line => this.findBestItem(line, filters, used))
      const settled = await Promise.allSettled(tasks)
      const selections = []
      for (let i=0;i<settled.length;i++) {
        const r = settled[i]
        if (r.status === 'fulfilled' && r.value && r.value.item) {
          selections.push({ line: requested[i], item: r.value.item, reason: r.value.reason })
        }
      }
      const items = selections.map(sel => {
        const q = Math.max(1, Number(sel.line?.quantity || 1))
        const unit = Number(sel.item?.price_inr || 0)
        return { ...sel.item, quantity: q, line_total_inr: q * unit, line_type: sel.line?.type || null, room: sel.line?.room || null }
      })
      const totalEstimate = items.reduce((s, it) => s + (it.line_total_inr || 0), 0)

      const header = (bhk ? `${bhk} BHK` : 'Plan') + (tier ? ` • ${tier}` : '')
      return {
        message: header,
        items,
        totalEstimate,
        alternatives: {},
        filters,
        selections,
        explanations: null,
        overBudget: false,
        budgetOverBy: 0,
        llmSummary,
        bhk, tier,
        roomPlan: rooms.map(r => ({ room: r })),
        groupedByRoom: null
      }
    } catch (e) {
      console.error('processFloorPlanFromUrl error:', e)
      return { message: 'Could not analyze the floor plan', items: [], totalEstimate: 0 }
    }
  }

  // --- Minimal APIs expected by StateGraph/agents ---
  extractQuotationRequirements(message) {
    const requirements = { area: null, areas: [], areaSqft: null, theme: null, budget: null, requestedItems: [] }
    const lower = String(message || '').toLowerCase()
    const areaMap = {
      living: ['living','living room','lounge','hall'],
      bedroom: ['bedroom','bed room','sleeping','master bedroom'],
      kitchen: ['kitchen','cooking','pantry'],
      bathroom: ['bathroom','bath room','washroom','toilet'],
      dining: ['dining','dining room'],
      foyer: ['foyer','entrance','entry']
    }
    for (const [k, vars] of Object.entries(areaMap)) if (vars.some(v => lower.includes(v))) requirements.areas.push(k)
    if (requirements.areas.length > 0) requirements.area = requirements.areas[0]
    const mS = lower.match(/(\d{3,6})\s*(sq\s*ft|sqft|sft|square\s*feet)\b/i)
    if (mS) { const n = parseInt(mS[1].replace(/,/g,''), 10); if (Number.isFinite(n) && n>0) requirements.areaSqft = n }
    if (/modern|contemporary/.test(lower)) requirements.theme = 'Modern'
    else if (/traditional|classic|vintage/.test(lower)) requirements.theme = 'Traditional'
    const mb = lower.match(/(?:rs\.?|₹)?\s*([0-9][0-9,\.]+)/)
    if (mb) { const n = Number(mb[1].replace(/[,]/g,'')); if (isFinite(n) && n>0) requirements.budget = n }
    return requirements
  }

  // Broad filters (graph sometimes calls this name too)
  extractRequirements(message) { return this.extractQuotationRequirements(message) }

  buildRequestedForArea(area, { kit = 'essentials', maxOptionals = 0 } = {}) {
    const key = String(area || '').toLowerCase()
    const defs = {
      living: { essentials: [ { type: 'sofa' }, { type: 'tv_bench' }, { type: 'table', specifications: { subtype: 'coffee' } }, { type: 'bookcase' }, { type: 'lamp' } ], optional: [ { type: 'chair' } ] },
      bedroom: { essentials: [ { type: 'bed' }, { type: 'wardrobe' }, { type: 'table', specifications: { subtype: 'bedside' } }, { type: 'mirror' } ], optional: [ { type: 'lamp' } ] },
      kitchen: { essentials: [ { type: 'cabinet' }, { type: 'table' }, { type: 'chair' } ], optional: [ { type: 'shelf' } ] },
      bathroom: { essentials: [ { type: 'mirror' }, { type: 'washstand' } ], optional: [ { type: 'shelf' } ] },
      dining: { essentials: [ { type: 'table', specifications: { subtype: 'dining' } }, { type: 'chair' } ], optional: [ { type: 'lamp' } ] },
      foyer: { essentials: [ { type: 'shoe_rack' }, { type: 'mirror' } ], optional: [ { type: 'lamp' } ] }
    }[key] || { essentials: [], optional: [] }
    const base = defs.essentials.map(it => ({ type: it.type, quantity: 1, description: it.type.replace('_',' '), specifications: { ...(it.specifications||{}) } }))
    const opt = []
    for (let i=0;i<Math.min(maxOptionals, defs.optional.length);i++) {
      const it = defs.optional[i]
      opt.push({ type: it.type, quantity: 1, description: it.type.replace('_',' '), specifications: { ...(it.specifications||{}) } })
    }
    return kit === 'all' ? base.concat(opt) : base
  }

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
    let bhk = counts.bedroom || 1
    const totalSft = Number(opts.area || 0)
    let tier = 'medium'
    if (totalSft && isFinite(totalSft) && totalSft > 0) {
      const per = totalSft / Math.max(1, bhk)
      tier = per <= 650 ? 'small' : per <= 900 ? 'medium' : 'large'
    }
    return { bhk, tier, counts }
  }

  maxOptionalsFor(room, bhk, tier) {
    const r = String(room || '').toLowerCase()
    if (bhk <= 1) return 0
    if (bhk === 2) {
      if (r==='living' || r==='dining') return tier==='large' ? 2 : (tier==='medium' ? 1 : 0)
      if (r==='bedroom') return tier==='large' ? 1 : 0
      return 0
    }
    if (r==='living' || r==='dining') return tier==='large' ? 3 : 2
    if (r==='bedroom') return tier==='large' ? 2 : 1
    return tier==='large' ? 1 : 0
  }

  async findBestItem(line, filters = {}, usedItemIds = new Set()) {
    const type = String(line?.type || '').toLowerCase()
    const specs = line?.specifications || {}
    const maxPrice = Number(filters?.maxPrice || 0) || null
    try {
      const { category, subcategoryLike } = this.resolveCategory(type, specs)
      let q = supabase
        .from('interior_items')
        .select('id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,category,subcategory')
      if (category) q = q.ilike('category', category)
      if (subcategoryLike) q = q.ilike('subcategory', `%${subcategoryLike}%`)
      if (maxPrice) q = q.lte('price_inr', maxPrice)
      q = q.order('price_inr', { ascending: true }).limit(20)
      const { data } = await q
      const rows = Array.isArray(data) ? data : []
      let pick = rows.find(r => !usedItemIds.has(r.id)) || rows[0] || null
      if (pick) usedItemIds.add(pick.id)
      return { item: pick, reason: pick ? 'ok' : 'no_match' }
    } catch (e) {
      return { item: null, reason: 'error' }
    }
  }
}

export default new QuotationAIService()
