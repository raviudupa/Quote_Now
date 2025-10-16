// Real LangGraph StateGraph with in-process RAM memory keyed by sessionId
// Uses @langchain/langgraph v0.4.x

import { StateGraph } from "@langchain/langgraph/web"
import { analyzeFloorPlan } from "../vision/floorplan.js"
import { analyzeFloorPlanLLM } from "./floorplanLLM.js"
import { supabase } from "../../config/supabase.js"
import { parseWithLLM } from "./parserLLM.js"
import { clarifyWithLLM } from "./clarifierLLM.js"
import { normalizeLLMItem } from "./utils.js"
import { getTypeFacets, retrieveRules } from "../retrieval.js"
import { summarizeToJSON } from "./summarizerLLM.js"
import { proposeEssentialsJSON, essentialsToRequested } from "./essentialsLLM.js"
import { loadPrior, saveGraphState } from "./storage.js"
import { enrichFromText } from "../nlu/enrich.js"
import { runAgent } from "../agents/agent.js"
import { applyCommandParsing, applyAdvancedCommands } from "./commandsParser.js"

// App instance and simple in-module session memory (browser-safe)
let app = null
const sessionMemory = new Map()

const USE_LLM_PARSER = String(import.meta.env.VITE_USE_LLM_PARSER || '').toLowerCase() === 'true'
const USE_LLM_CLARIFIER = String(import.meta.env.VITE_USE_LLM_CLARIFIER || '').toLowerCase() === 'true'
const MAX_CLARIFY = Math.max(1, Number(import.meta.env.VITE_MAX_CLARIFY_QUESTIONS || 2))

// normalizeLLMItem imported from utils.js

// Build the graph once
function getApp(aiInstance) {
  if (app) return app

  const g = new StateGraph({
    channels: {
      userMessage: 'string',
      req: 'any',
      filters: 'any',
      selections: 'any',
      unmet: 'any',
      clarification: 'any',
      prior: 'any'
    }
  })

  // detect_plan: if message contains an image URL to analyze, produce a plan-based llmSummary first
  g.addNode('detect_plan', async (state) => {
    try {
      const text = String(state.userMessage || '')
      // Prefer data URL if present, else fall back to http(s)
      const dataUrlMatch = text.match(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/)
      const httpUrlMatch = text.match(/https?:\/\/\S+/)
      const url = dataUrlMatch ? dataUrlMatch[0] : (httpUrlMatch ? httpUrlMatch[0] : null)
      const looksPlan = /analy\w*\s*plan|floor\s*plan|attach(ed)?\s*plan/i.test(text)
      if (!url) return {}
      // Be permissive: if user posts an URL alongside plan wording, run analyzer
      if (!looksPlan && !/^data:image\//.test(url) && /\.(png|jpg|jpeg|webp|gif|bmp|tiff)$/i.test(url) === false) return {}
      // 1) Try the floorplan-specific LLM first for strict JSON
      // Prefer the in-message data URL (zero-latency, avoids OpenAI remote download timeouts).
      // If only http(s) exists, use that; we'll still fallback later to whichever alternative we didn't try first.
      const primaryUrl = dataUrlMatch ? dataUrlMatch[0] : (httpUrlMatch ? httpUrlMatch[0] : url)
      let fp = await analyzeFloorPlanLLM(primaryUrl)
      let rooms = Array.isArray(fp?.rooms) ? fp.rooms.map(r => String(r)).filter(Boolean) : []
      let bhk = Number(fp?.bhk || 0) || null
      let sqft = Number(fp?.sqft || 0) || null
      // 2) Fallback to previous analyzer (if available).
      // If the primary URL is a data URL but an http(s) URL is also present in the message (e.g., from storage upload),
      // prefer using the http(s) URL for the legacy analyzer.
      const altHttp = httpUrlMatch ? httpUrlMatch[0] : null
      const tryUrls = [primaryUrl, altHttp].filter(Boolean)
      if ((!fp || rooms.length===0) && typeof analyzeFloorPlan === 'function' && tryUrls.length) {
        // Try primary first (data URL preferred), then alt http(s)
        let analysis = null
        for (const u of tryUrls) {
          try { analysis = await analyzeFloorPlan(u) } catch { analysis = null }
          if (analysis && Array.isArray(analysis.rooms)) break
        }
        const aRooms = (analysis?.rooms || []).map(r => String(r?.type || r?.name || '')).filter(Boolean)
        rooms = rooms.length ? rooms : aRooms
        if (!bhk || !sqft) {
          const meta = aiInstance.deriveBhkAndTier((analysis?.rooms || []), tryUrls[0], { area: 0 })
          bhk = bhk || meta?.bhk || null
        }
      }
      let llmSummary = null
      // 3) Build summary directly if we have basics
      if (rooms.length || bhk || sqft) {
        llmSummary = {
          summary: null,
          rooms: rooms.map(r => r.toLowerCase()),
          areaSqft: sqft || null,
          bhk: bhk || null,
          theme: null,
          budget: null,
          itemsSuggested: []
        }
      } else {
        // 4) As a last resort, pass URL text to the generic summarizer
        try {
          const jsonSum = await summarizeToJSON(url, { mode: 'floorplan' })
          if (jsonSum) {
            llmSummary = {
              summary: null,
              rooms: jsonSum.rooms || [],
              areaSqft: jsonSum.sqft || null,
              bhk: bhk || null,
              theme: (Array.isArray(jsonSum.preferences) && jsonSum.preferences[0]) || null,
              budget: jsonSum.budget || null,
              itemsSuggested: jsonSum.itemsSuggested || []
            }
          }
        } catch {}
      }
      if (llmSummary) return { llmSummary }
      // If nothing could be parsed, return an empty summary to trigger confirm_gate guidance
      try { console.warn('[detect_plan] failed floor plan parsing', { url, fp }) } catch {}
      return { llmSummary: { summary: null, rooms: [], areaSqft: null, theme: null, budget: null, itemsSuggested: [] } }
    } catch (_) { return {} }
  })

  // vision_extract: OCR-like regex fallback parsing from message text/URL/filename
  // Extracts BHK, sqft, and room keywords even if the LLM fetch fails
  g.addNode('vision_extract', async (state) => {
    try {
      const text = String(state.userMessage || '')
      const lower = text.toLowerCase()
      // Prefer to parse from URL/filename tokens present in the message
      // e.g., 2.5-bhk-1550-sq-ft.webp or 3bhk_1200sqft
      const url = (text.match(/data:image\/[a-z]+;base64,[a-z0-9+/=]+/i) || text.match(/https?:\/\/\S+/i) || [null])[0]
      const src = (url || '') + ' ' + lower
      // bhk: allow decimals like 2.5
      const bhkMatch = src.match(/(\d+(?:\.\d+)?)\s*-?\s*bhk\b/i)
      const sqftMatch = src.match(/(\d{3,5})\s*-?\s*(sq\.?\s*ft|square\s*feet)\b/i)
      let bhk = bhkMatch ? Number(bhkMatch[1]) : null
      let sqft = sqftMatch ? Number(sqftMatch[1]) : null
      // room keywords
      const rooms = new Set()
      const addIf = (re, label) => { if (re.test(src)) rooms.add(label) }
      addIf(/\bliving\b|\bhall\b/, 'living')
      addIf(/\bdining\b/, 'dining')
      addIf(/\bkitchen\b/, 'kitchen')
      // bedrooms: infer count from bhk if explicit tokens absent
      const bedTokens = (src.match(/bed\s*room|bedroom|\bbr\b/gi) || []).length
      if (bedTokens > 0) rooms.add('bedroom')
      addIf(/\bstudy\b|office/, 'study')
      addIf(/\btoilet\b|\bbath\b|washroom/, 'toilet')
      addIf(/\bbalcony\b/, 'balcony')
      addIf(/\butility\b/, 'utility')
      addIf(/\bfoyer\b|entry/, 'foyer')
      // If we have bhk but no explicit bedrooms tokens, at least include 'bedroom'
      if (!rooms.has('bedroom') && bhk && bhk > 0) rooms.add('bedroom')
      const outRooms = Array.from(rooms)
      // If nothing detected, do nothing
      if (!bhk && !sqft && outRooms.length === 0) return {}
      // Merge with existing summary if present
      const curr = state.llmSummary || {}
      const merged = {
        summary: curr.summary || null,
        rooms: Array.from(new Set([...(Array.isArray(curr.rooms)?curr.rooms:[]), ...outRooms])).map(r => String(r).toLowerCase()),
        areaSqft: curr.areaSqft || sqft || null,
        theme: curr.theme || null,
        budget: curr.budget || null,
        itemsSuggested: Array.isArray(curr.itemsSuggested) ? curr.itemsSuggested : []
      }
      return { llmSummary: merged }
    } catch { return {} }
  })

  // summarize: produce llmSummary for the current turn when appropriate
  g.addNode('summarize', async (state) => {
    const text = String(state.userMessage || '')
    const lower = text.toLowerCase()
    const isConfirm = /(confirm|go ahead|generate|ok|okay|proceed|yes)\b/.test(lower)
    // IMPORTANT: if detect_plan/vision_extract already produced an llmSummary,
    // preserve it unless we successfully compute a better one here.
    let llmSummary = state.llmSummary || state.prior?.llmSummary || null
    // 0) Parser-first deterministic summary from current req
    try {
      const req = state.req || {}
      const roomsFromReq = Array.isArray(req.areas) ? req.areas.map(r => String(r)).filter(Boolean) : []
      const baseSum = {
        summary: null,
        rooms: roomsFromReq.map(r => r.toLowerCase()),
        areaSqft: Number(req.areaSqft || 0) || null,
        theme: req.theme || null,
        budget: req.budget ? { scope: 'total', amount: Number(req.budget) } : null,
        itemsSuggested: []
      }
      // Merge parser summary with any existing llmSummary (union rooms, prefer non-null fields)
      if (baseSum.rooms.length || baseSum.areaSqft || baseSum.theme || baseSum.budget) {
        const prev = llmSummary || {}
        const unionRooms = Array.from(new Set([...(Array.isArray(prev.rooms)?prev.rooms:[]), ...baseSum.rooms]))
        llmSummary = {
          summary: prev.summary || baseSum.summary,
          rooms: unionRooms,
          areaSqft: prev.areaSqft || baseSum.areaSqft || null,
          theme: prev.theme || baseSum.theme || null,
          budget: prev.budget || baseSum.budget || null,
          itemsSuggested: Array.isArray(prev.itemsSuggested) ? prev.itemsSuggested : []
        }
      }
    } catch (_) { /* ignore parser merge issues */ }
    // Only try to summarize when not a pure confirmation
    if (!isConfirm) {
      try {
        // Prefer strict JSON summarizer if enabled; fall back to existing
        const jsonSum = await summarizeToJSON(text, { mode: 'chat' })
        if (jsonSum) {
          llmSummary = {
            summary: null,
            rooms: jsonSum.rooms || [],
            areaSqft: jsonSum.sqft || null,
            theme: (Array.isArray(jsonSum.preferences) && jsonSum.preferences[0]) || null,
            budget: jsonSum.budget || null,
            itemsSuggested: jsonSum.itemsSuggested || []
          }
        } else {
          const parsed = await aiInstance.summarizeIntentLLM(text, { mode: 'chat' })
          if (parsed) llmSummary = parsed
        }
      } catch (_) { /* ignore summarizer errors */ }
    }
    return { llmSummary, confirmed: isConfirm }
  })

  // confirm gate: if user hasn't confirmed yet and we have a summary, stop here and ask to confirm
  g.addNode('confirm_gate', async (state) => {
    // No-op: do not auto-confirm and do not send clarification prompts
    // The UI may still send an explicit "confirm" message when desired
    return {}
  })

  // propose_essentials: generate initial requestedItems via LLM (or fallback) after confirmation
  g.addNode('propose_essentials', async (state) => {
    try {
      // If items already exist for this turn, do nothing
      if (Array.isArray(state.req?.requestedItems) && state.req.requestedItems.length > 0) return {}
      // Gather rooms from summary or parsed areas
      const normRoom = (r) => {
        const t = String(r||'').toLowerCase().trim()
        if (/master\s*bed/.test(t)) return 'bedroom'
        if (/bed\s*room|bedroom/.test(t)) return 'bedroom'
        if (/living/.test(t)) return 'living'
        if (/dining/.test(t)) return 'dining'
        if (/kitchen/.test(t)) return 'kitchen'
        if (/toilet|bath|wash/i.test(t)) return 'toilet'
        if (/bathroom/.test(t)) return 'bathroom'
        if (/balcony/.test(t)) return 'balcony'
        if (/study|office/.test(t)) return 'study'
        if (/utility/.test(t)) return 'utility'
        if (/foyer|entry/.test(t)) return 'foyer'
        return t
      }
      // Merge rooms from llmSummary and regex-extracted areas to avoid under-detection by either path
      const sumRooms = Array.isArray(state.llmSummary?.rooms) ? state.llmSummary.rooms.map(r => String(r)).filter(Boolean) : []
      const areaRooms = Array.isArray(state.req?.areas) ? state.req.areas.map(a => String(a)) : []
      const roomsRaw = Array.from(new Set([...sumRooms, ...areaRooms]))
      let rooms = roomsRaw.map(normRoom)
      // Derive bedrooms from BHK conservatively: only when user did NOT explicitly
      // restrict rooms (e.g., "living room only"). If the user specified rooms and
      // they do not include bedroom, do not inject bedrooms from BHK.
      const bhkFromSum = Number(state.llmSummary?.bhk || 0) || null
      const areaSqft = Number(state.req?.areaSqft || state.llmSummary?.areaSqft || 0) || 0
      const wholeBedrooms = bhkFromSum ? Math.floor(bhkFromSum) : null
      const hasHalf = bhkFromSum ? (bhkFromSum - Math.floor(bhkFromSum) >= 0.5) : false
      const hasExplicitAreas = Array.isArray(state.req?.areas) && state.req.areas.length > 0
      const explicitHasBedroom = hasExplicitAreas && state.req.areas.some(r => String(r).toLowerCase()==='bedroom')
      const summaryHasBedroom = Array.isArray(state.llmSummary?.rooms) && state.llmSummary.rooms.some(r => String(r).toLowerCase()==='bedroom')
      const allowDerivedBedrooms = (!hasExplicitAreas) || explicitHasBedroom || summaryHasBedroom
      if (allowDerivedBedrooms && wholeBedrooms && !rooms.some(r => r==='bedroom')) {
        for (let i=0;i<wholeBedrooms;i++) rooms.push('bedroom')
      }
      if (allowDerivedBedrooms && hasHalf && !rooms.includes('study')) rooms.push('study')
      // If area is large, ensure dining presence
      if (areaSqft > 1000 && !rooms.includes('dining') && rooms.includes('living')) rooms.push('dining')
      const allowed = new Set(['living','bedroom','kitchen','bathroom','dining','foyer','study','balcony','toilet','utility'])
      const filteredRooms = Array.from(new Set(rooms.map(r => r.trim()).filter(r => allowed.has(r))))
      let requested = []
      // Try LLM-based essentials when enabled (strict JSON)
      const USE_LLM_ESS = String(import.meta.env.VITE_USE_LLM_ESSENTIALS || '').toLowerCase() === 'true'
      if (USE_LLM_ESS) {
        try {
          const meta = aiInstance.deriveBhkAndTier((filteredRooms || []).map(r => ({ type: r })), '', { area: Number(state.req?.areaSqft || 0) || 0 })
          const json = await proposeEssentialsJSON({ bhk: meta?.bhk || state.llmSummary?.bhk || null, sqft: Number(state.req?.areaSqft || 0) || state.llmSummary?.areaSqft || null, rooms: filteredRooms })
          if (json) requested = essentialsToRequested(json)
        } catch (_) { /* fall back */ }
      }
      // If no rooms detected, do not seed defaults. Let the flow continue without items.
      if (!filteredRooms.length) return {}

      // Area-based tiers
      const tierByArea = (a) => {
        if (a < 800) return 'small'
        if (a < 1200) return 'medium'
        if (a < 1800) return 'large'
        return 'xl'
      }
      const areaTier = tierByArea(areaSqft)

      // Build a tiered baseline for all rooms (used ONLY when LLM essentials are empty)
      const buildTierBaseline = (rooms, tier) => {
        const out = []
        for (const r of rooms) {
          if (r === 'living') {
            // Living seating scales by tier
            if (tier === 'small') out.push({ type: 'sofa', quantity: 1, specifications: { size: '2-seater' }, room: r })
            else if (tier === 'medium') {
              out.push({ type: 'sofa', quantity: 1, specifications: { size: '3-seater' }, room: r })
              out.push({ type: 'chair', quantity: 1, specifications: { subtype: 'lounge' }, room: r })
            } else {
              out.push({ type: 'sofa', quantity: 1, specifications: { size: 'sectional' }, room: r })
              out.push({ type: 'chair', quantity: 2, specifications: { subtype: 'lounge' }, room: r })
            }
            out.push({ type: 'tv_bench', quantity: 1, specifications: {}, room: r })
          } else if (r === 'dining') {
            out.push({ type: 'table', quantity: 1, specifications: { subtype: 'dining' }, room: r })
            let chairs = 2
            if (tier === 'medium') chairs = 4
            else if (tier === 'large') chairs = 6
            else if (tier === 'xl') chairs = 8
            for (let i=0;i<chairs;i++) out.push({ type: 'chair', quantity: 1, specifications: {}, room: r })
          } else if (r === 'kitchen') {
            out.push({ type: 'cabinet', quantity: 1, specifications: {}, room: r })
            if (tier === 'large' || tier === 'xl') out.push({ type: 'cabinet', quantity: 1, specifications: { subtype: 'tall' }, room: r })
          } else if (r === 'bedroom') {
            out.push({ type: 'bed', quantity: 1, specifications: {}, room: r })
            if (tier === 'xl') out.push({ type: 'bedside_table', quantity: 2, specifications: {}, room: r })
            else if (tier === 'large') out.push({ type: 'bedside_table', quantity: 2, specifications: {}, room: r })
            else if (tier === 'medium') out.push({ type: 'bedside_table', quantity: 1, specifications: {}, room: r })
            out.push({ type: 'wardrobe', quantity: (tier === 'large' || tier === 'xl') ? 2 : 1, specifications: {}, room: r })
            if (tier === 'xl') out.push({ type: 'dresser', quantity: 1, specifications: {}, room: r })
          } else if (r === 'study') {
            out.push({ type: 'desk', quantity: 1, specifications: {}, room: r })
            out.push({ type: 'chair', quantity: 1, specifications: { subtype: 'ergonomic' }, room: r })
            if (tier !== 'small') out.push({ type: 'bookcase', quantity: 1, specifications: {}, room: r })
          } else if (r === 'bathroom' || r === 'toilet') {
            out.push({ type: 'mirror_cabinet', quantity: 1, specifications: {}, room: r })
            out.push({ type: 'towel_rod', quantity: 1, specifications: {}, room: r })
            if (tier !== 'small') out.push({ type: 'shelf', quantity: 1, specifications: {}, room: r })
          } else if (r === 'balcony') {
            out.push({ type: 'chair', quantity: 2, specifications: { subtype: 'outdoor' }, room: r })
            if (tier !== 'small') out.push({ type: 'table', quantity: 1, specifications: { subtype: 'outdoor' }, room: r })
          } else if (r === 'utility') {
            out.push({ type: 'storage_rack', quantity: 1, specifications: {}, room: r })
          }
        }
        return out
      }

      // When LLM produced essentials, only supplement bathrooms/balcony/utility.
      // When LLM failed (requested empty), apply the full tiered baseline.
      let baseline = []
      if (Array.isArray(requested) && requested.length > 0) {
        const supplementRooms = filteredRooms.filter(r => (r==='bathroom' || r==='toilet' || r==='balcony' || r==='utility'))
        baseline = buildTierBaseline(supplementRooms, areaTier)
      } else {
        baseline = buildTierBaseline(filteredRooms, areaTier)
      }

      // Merge baseline and any LLM-requested without duplicates
      const key = (it) => [it.type, it.specifications?.subtype||'', it.room||''].join('|').toLowerCase()
      const seen = new Set()
      const merged = []
      for (const it of [...baseline, ...(Array.isArray(requested)?requested:[])]) {
        const k = key(it)
        if (seen.has(k)) continue
        seen.add(k)
        merged.push(it)
      }
      requested = merged
      if (requested.length > 0) {
        // Dev logging to verify essentials
        try {
          if (import.meta && import.meta.env && import.meta.env.DEV) {
            console.debug('[graph] propose_essentials rooms=', filteredRooms, 'bhk=', bhkFromSum, 'areaSqft=', areaSqft)
            console.debug('[graph] propose_essentials requested types=', requested.map(x => ({ room: x.room, type: x.type, sub: x?.specifications?.subtype||null, qty: x.quantity })))
          }
        } catch {}
        const touch = new Set(state.req?._touchedTypes instanceof Set ? Array.from(state.req._touchedTypes) : [])
        for (const it of requested) touch.add(String(it.type||'').toLowerCase())
        const nextReq = { ...(state.req || {}), requestedItems: requested, _touchedTypes: touch, _justSeededPlan: true }
        // Surface plan metadata for UI panels
        const meta = aiInstance.deriveBhkAndTier((filteredRooms || []).map(r => ({ type: r })), '', { area: Number(state.req?.areaSqft || 0) || 0 })
        const bhkOut = meta?.bhk || state.llmSummary?.bhk || null
        const tierOut = meta?.tier || null
        const roomPlan = filteredRooms.map(r => ({ room: r }))
        return { req: nextReq, roomPlan, bhk: bhkOut, tier: tierOut }
      }
    } catch (_) {}
    return {}
  })

  // parse_requirements
  g.addNode('parse_requirements', async (state) => {
    const userMessage = state.userMessage || ''
    let req = null
    // Define lowercase message early; multiple parsers below depend on it
    const lower = String(userMessage || '').toLowerCase()
    const hasPlanCmd = /(analy\w*\s*plan|floor\s*plan)/.test(lower)
    const lowerNoUrls = lower.replace(/https?:\/\/\S+/g, '')
    // Hoisted type alias map and mapper for consistent normalization across this node
    const typeAliases = {
      // Sofas
      'sofa': 'sofa', 'couch': 'sofa',
      'sofa-bed': 'sofa_bed', 'sofabed': 'sofa_bed', 'sofa bed': 'sofa_bed',

      // TV units
      'tv bench': 'tv_bench', 'tv unit': 'tv_bench', 'tv table': 'tv_bench', 'tv stand': 'tv_bench', 'tv cabinet': 'tv_bench', 'tv': 'tv_bench',

      // Tables (subtype handled separately)
      'coffee table': 'table', 'side table': 'table', 'bedside table': 'table', 'dining table': 'table', 'table': 'table',

      // Storage & shelves
      'bookcase': 'bookcase', 'bookshelf': 'bookcase', 'book shelf': 'bookcase', 'shelving': 'bookcase', 'shelf': 'shelf',
      'storage combination': 'storage_combination', 'storage-combination': 'storage_combination',

      // Wardrobe family
      'wardrobe': 'wardrobe', 'almirah': 'wardrobe', 'closet': 'wardrobe',

      // Mirrors / wash-stand
      'mirror': 'mirror', 'mirror cabinet': 'mirror_cabinet', 'cabinet mirror': 'mirror_cabinet',
      'washstand': 'washstand', 'wash stand': 'washstand', 'wash-stand': 'washstand',

      // Other seating / items
      'cabinet': 'cabinet', 'drawer': 'drawer', 'desk': 'desk', 'chair': 'chair', 'armchair': 'chair', 'stool': 'stool', 'bed': 'bed', 'lamp': 'lamp'
    }
    const mapType = (raw) => {
      const r = String(raw || '').toLowerCase().trim()
      return typeAliases[r] || r.replace(/\s+/g, '_')
    }
    if (USE_LLM_PARSER) {
      const parsed = await parseWithLLM(userMessage)
      if (parsed) {
        const normalized = Array.isArray(parsed.requestedItems)
          ? parsed.requestedItems.map((it) => normalizeLLMItem(it))
          : []
        req = {
          area: parsed.area || null,
          theme: parsed.theme || null,
          package: parsed.package || null,
          budget: parsed.budget || null,
          requestedItems: normalized
        }
      }
    }

    if (!req) req = aiInstance.extractQuotationRequirements(userMessage)
    // Merge areas/areaSqft/theme/budget from lightweight extractor to ensure rooms are captured even if LLM parser omitted them
    {
      const base = aiInstance.extractQuotationRequirements(userMessage) || {}
      const areasMerged = Array.from(new Set([...
        (Array.isArray(req?.areas) ? req.areas : []),
        (Array.isArray(base.areas) ? base.areas : [])
      ]))
      req = {
        ...req,
        areas: areasMerged,
        area: req?.area || base?.area || (areasMerged[0] || null),
        areaSqft: req?.areaSqft || base?.areaSqft || null,
        theme: req?.theme || base?.theme || null,
        budget: req?.budget || base?.budget || null
      }
      // If user clearly listed multiple rooms but LLM returned a tiny ad-hoc list, drop it to allow multi-room essentials
      const roomCount = (areasMerged || []).length
      if (roomCount >= 2 && Array.isArray(req.requestedItems) && req.requestedItems.length > 0 && req.requestedItems.length <= 3) {
        req.requestedItems = []
      }
    }

    // Now parse explicit add intents from this message (supports multiple commands)
    {
      if (USE_LLM_PARSER) {
        // When LLM parser is enabled, skip manual regex-based parsing here.
      } else {
        req = applyCommandParsing(userMessage, req)
      }
      // Apply advanced commands (qty/remove/replace) using shared module
      req = await applyAdvancedCommands({ userMessage, req, state, aiInstance })
    }

    // Remove single-area auto seeding. We rely on rooms list and essentials generation instead.

    // If the user sent only a short clarifier reply (e.g., "fabric, under 40k"), reuse previous requested items
    // from prior memory and just update preferences.
    const priorReqItems = Array.isArray(state.prior?.reqItems) ? state.prior.reqItems : []
    const onlyPrefs = !req?.requestedItems || (Array.isArray(req.requestedItems) && req.requestedItems.length === 0)
    const lowerMsgForReuse = lower
    const reuseSameItemsPhrases = /(same items|same as above|as mentioned above|keep same|same setup|same ones|same products|same list|same configuration)/
    const wantsReuse = reuseSameItemsPhrases.test(lowerMsgForReuse)
    if ((onlyPrefs || wantsReuse) && priorReqItems.length > 0) {
      req.requestedItems = priorReqItems.map(it => ({ ...it }))
    } else if (Array.isArray(req.requestedItems) && req.requestedItems.length > 0 && priorReqItems.length > 0) {
      // Decide whether user intends to replace the list (fresh intent) or add to it
      const lowerMsg = String(userMessage || '').toLowerCase()
      const addKeywords = /(add|also|include|plus|and add|along with|as well)/
      const replaceKeywords = /(only|just|replace|change to|new list|fresh)/
      const explicitAdd = addKeywords.test(lowerMsg)
      const explicitReplace = replaceKeywords.test(lowerMsg)
      const defaultReplaceHeuristic = !explicitAdd && !explicitReplace
      // Heuristic: treat as fresh list when the message enumerates items or specifies a seater count
      const listNouns = '(sofa|table|bench|chair|tv|bookcase|bookshelf)'
      const hasNumberThenNoun = new RegExp(`\\b\\d+\\s*${listNouns}`).test(lowerMsg)
      const hasSeaterPattern = /\b\d+(?:\s*|-)?(?:seater|seat)s?\b.*\bsofa\b/.test(lowerMsg)
      const hasFreshPhrases = /(\bi need\b|\bfor my\b|\brequire\b|\bnew\b|\bonly\b)/.test(lowerMsg)
      const looksLikeFreshList = defaultReplaceHeuristic && (hasNumberThenNoun || hasSeaterPattern || hasFreshPhrases)
      // IMPORTANT: if this message contains a 'replace' command, we do NOT treat it as a fresh list.
      // We will apply replace later while keeping the prior cart intact.
      const containsReplaceWord = /\breplace\b/.test(lowerMsg)
      const shouldReplace = (!containsReplaceWord) && (explicitReplace || looksLikeFreshList)
      if (shouldReplace) {
        // Do not merge; use only the new items
        // (prior items are dropped unless user explicitly says 'add')
      } else {
        // Merge: keep new items, and bring forward prior items whose spec-key is not overridden.
        // This allows multiple variants of the same type (e.g., 3-seater + 4-seater sofas).
        const keyOf = (it) => {
          const s = it?.specifications || {}
          const parts = [it?.type || '', s.seater || '', s.subtype || '', s.material || '']
          return parts.map(v => String(v).toLowerCase()).join('|')
        }
        const newKeys = new Set((req.requestedItems || []).map(keyOf))
        const merged = [...req.requestedItems]
        for (const pit of priorReqItems) {
          const k = keyOf(pit)
          if (!newKeys.has(k)) merged.push({ ...pit })
        }
        req.requestedItems = merged
        // Mark any types present in both prior and new with different keys as touched
        const priorTypeSet = new Set((priorReqItems || []).map(it => (it.type || '').toLowerCase()))
        const newTypeSet = new Set((req.requestedItems || []).map(it => (it.type || '').toLowerCase()))
        const both = [...newTypeSet].filter(t => priorTypeSet.has(t))
        if (both.length) {
          const existing = req._touchedTypes instanceof Set ? Array.from(req._touchedTypes) : (Array.isArray(req._touchedTypes) ? req._touchedTypes : [])
          req._touchedTypes = new Set([...(existing || []), ...both])
        }
      }
    }

    // Remove minimal baseline top-up for N-BHK; rely on rooms or explicit items
    // Explicit replace intent: "replace <type> with id <id>" → do not add a new line, set preferredId on existing line
    {
      const re = /\breplace\s+([a-z_ ]+?)\s+with\s+id\s+(\d+)\b/i.exec(lower)
      if (re) {
        const rawType = re[1].trim()
        const id = re[2]
        const t = mapType(rawType)
        const items = Array.isArray(req.requestedItems) ? req.requestedItems : []
        const idx = items.findIndex(it => (it.type||'').toLowerCase() === t)
        if (idx >= 0) {
          const it = { ...items[idx] }
          it.preferredId = id
          items[idx] = it
          req.requestedItems = items
          req._touchedTypes = new Set([...(req._touchedTypes || []), t])
          req._skipClarify = true
          // Track change so selector will reselect this exact line
          const s = it.specifications || {}
          const key = `${it.type||''}|${s.seater||''}|${s.subtype||''}|${s.material||''}`.toLowerCase()
          const prev = state.prior?.reqItems?.find(pl => (pl.type||'').toLowerCase()===t) || null
          const prevS = prev?.specifications || {}
          const prevKey = prev ? `${prev.type||''}|${prevS.seater||''}|${prevS.subtype||''}|${prevS.material||''}`.toLowerCase() : null
          const changes = Array.isArray(req._changes) ? req._changes.slice() : []
          changes.push({ type: t, key, prevKey, reason: 'replace', preferredId: id })
          req._changes = changes
        }
      }
    }

    // Remove multi-room seeding for bare N-BHK statements; require rooms or explicit items

    // If message says 'with 4-seater sofa' (or similar) and sofa not present yet, add sofa with seater
    {
      const msg = lowerNoUrls
      const withSofa = msg.match(/with\s+(\d+)\s*-?\s*seater\s+sofa\b/)
      const hasSofa = Array.isArray(req.requestedItems) && req.requestedItems.some(it => (it.type||'').toLowerCase()==='sofa')
      if (withSofa && !hasSofa) {
        const items = Array.isArray(req.requestedItems) ? req.requestedItems.slice() : []
        const seater = parseInt(withSofa[1],10)
        items.unshift({ type: 'sofa', quantity: 1, specifications: { seater, features: {} } })
        req.requestedItems = items
        req._touchedTypes = new Set([...(req._touchedTypes || []), 'sofa'])
        req._skipClarify = true
      }
    }
    // Detect updates vs prior (build a changeset so downstream can reselect only changed lines)
    {
      const prior = Array.isArray(priorReqItems) ? priorReqItems : []
      const curr = Array.isArray(req.requestedItems) ? req.requestedItems : []
      const keyOf = (it) => {
        const s = it?.specifications || {}
        const parts = [it?.type || '', s.seater || '', s.subtype || '', s.material || '']
        return parts.map(v => String(v).toLowerCase()).join('|')
      }
      const specEqual = (a,b) => {
        const sa = a?.specifications || {}; const sb = b?.specifications || {}
        const eq = (x,y) => String(x||'').toLowerCase() === String(y||'').toLowerCase()
        return eq(sa.material,sb.material) && eq(sa.subtype,sb.subtype) && eq(sa.shape,sb.shape) && eq(sa.size,sb.size) && String(sa.seater||'')===String(sb.seater||'')
      }
      // Map prior by type and by key for targeted diff
      const byTypePrior = new Map()
      const byKeyPrior = new Map()
      for (const it of prior) {
        const t = (it.type||'').toLowerCase()
        if (!byTypePrior.has(t)) byTypePrior.set(t, [])
        byTypePrior.get(t).push(it)
        byKeyPrior.set(keyOf(it), it)
      }
      const changes = []
      const touched = new Set(req._touchedTypes instanceof Set ? Array.from(req._touchedTypes) : (Array.isArray(req._touchedTypes) ? req._touchedTypes : []))
      for (const it of curr) {
        const t = (it.type||'').toLowerCase()
        const key = keyOf(it)
        const prevSameKey = byKeyPrior.get(key)
        if (prevSameKey) {
          // Same logical line; check quantity only
          const qtyChanged = Number(prevSameKey.quantity||1) !== Number(it.quantity||1)
          if (qtyChanged) { touched.add(t); changes.push({ type: t, key, prevKey: key, reason: 'qty', item: it, prev: prevSameKey }) }
          continue
        }
        const candidates = byTypePrior.get(t) || []
        if (candidates.length === 0) { touched.add(t); changes.push({ type: t, key, reason: 'added', item: it }); continue }
        // Compare against first candidate of this type (merge already prevents uncontrolled growth)
        const prev = candidates[0]
        const qtyChanged = Number(prev.quantity||1) !== Number(it.quantity||1)
        const specChanged = !specEqual(prev, it)
        if (qtyChanged || specChanged) { touched.add(t); changes.push({ type: t, key, prevKey: keyOf(prev), reason: specChanged ? 'modified' : 'qty', item: it, prev }) }
      }
      if (changes.length) {
        req._changes = changes
        req._touchedTypes = new Set([...(touched || [])])
      }
    }

    // Generic update intent: change/update/set/make <type> <attribute> to <value>
    {
      const lowerMsg = lower
      // use hoisted mapType
      const normMaterial = (s) => {
        const v = String(s||'').toLowerCase()
        if (/fabric|cloth|textile/.test(v)) return 'fabric'
        if (/leather|leatherette|faux/.test(v)) return 'leather'
        if (/glass/.test(v)) return 'glass'
        if (/metal|steel|iron/.test(v)) return 'metal'
        if (/wood|wooden/.test(v)) return 'wooden'
        return v
      }
      const pickLineIdx = (items, t, attr) => {
        let idx = items.findIndex(it => (it.type||'').toLowerCase()===t && it.specifications && it.specifications[attr]!=null)
        if (idx < 0) idx = items.findIndex(it => (it.type||'').toLowerCase()===t)
        return idx
      }
      const applyUpdate = (t, attr, val) => {
        const items = req.requestedItems || []
        const idx = pickLineIdx(items, t, attr)
        if (idx < 0) return false
        const it = { ...items[idx] }
        it.specifications = { ...(it.specifications || {}), features: { ...(it.specifications?.features || {}) } }
        if (attr === 'quantity') {
          const n = Number(val); if (!isFinite(n) || n <= 0) return false
          it.quantity = n
        } else if (attr === 'seater') {
          const m = String(val).match(/(\d+)/); if (!m) return false
          it.specifications.seater = Number(m[1])
        } else if (attr === 'material') {
          it.specifications.material = normMaterial(val)
        } else if (attr === 'subtype') {
          it.specifications.subtype = String(val).toLowerCase()
        } else if (attr === 'shape') {
          it.specifications.shape = /(curved|round|circle|circular|oval)/.test(String(val)) ? 'curved' : 'rectangular'
        } else if (attr === 'size') {
          it.specifications.size = String(val).toLowerCase()
        } else {
          return false
        }
        items[idx] = it
        req.requestedItems = items
        req._touchedTypes = new Set([...(req._touchedTypes || []), t])
        req._skipClarify = true
        return true
      }

      // change/update/set/make the <type> <attribute> to <value>
      const re = /\b(?:change|update|set|make)\s+(?:the\s+)?([a-z\- ]+?)\s+(seater|material|subtype|shape|size|qty|quantity|count)\s+(?:to\s*|as\s*|into\s*)?([a-z0-9\- ]+)/.exec(lowerMsg)
      if (re) {
        const t = mapType(re[1])
        const attrRaw = re[2]
        const value = re[3]
        const attr = /qty|quantity|count/.test(attrRaw) ? 'quantity' : attrRaw
        applyUpdate(t, attr, value)
      }

      // shorthand: '<material> <type>' or '<shape> mirror'
      const shMat = /(fabric|leather|leatherette|faux|glass|metal|steel|iron|wood|wooden)\s+([a-z\- ]+)\b/.exec(lowerMsg)
      if (shMat) {
        const t = mapType(shMat[2]); const mat = shMat[1]
        applyUpdate(t, 'material', mat)
      }
      const shShape = /(curved|round|circle|circular|oval|rectangular|rectangle|square)\s+mirror\b/.exec(lowerMsg)
      if (shShape) {
        applyUpdate('mirror', 'shape', shShape[1])
      }

      // table subtype quick form: '<subtype> table'
      const shTable = /(coffee|side|bedside|dining)\s+table\b/.exec(lowerMsg)
      if (shTable) {
        applyUpdate('table', 'subtype', shTable[1])
      }
    }

    // Budget scope disambiguation: if user says only scope ("total budget" / "total" / "per-item budget" / "per-item"),
    // carry forward the prior numeric budget so we don't ask again.
    {
      const msg = lowerNoUrls
      const saysTotal = /\b((total|overall|whole|entire)\s*(budget|cost|quotation)|whole\b|entire\b|total\b)\b/.test(msg)
      const saysPerItem = /\b(per\s*-?\s*item\s*budget|per\s*-?\s*item)\b/.test(msg)
      if ((saysTotal || saysPerItem)) {
        // Reuse the previously mentioned numeric budget when user only specifies the scope now.
        const priorItemCount = Array.isArray(state.prior?.reqItems) ? state.prior.reqItems.length : 0
        const priorPerItem = Number(state.prior?.filters?.maxPrice)
        const priorTotal = Number(state.prior?.reqBudget)
        // Prefer the exact total previously mentioned; else derive a total from per-item cap and item count when user chooses "total" now.
        let priorBudget = Number.isFinite(priorTotal) && priorTotal > 0
          ? priorTotal
          : (Number.isFinite(priorPerItem) && priorPerItem > 0 && priorItemCount > 0
              ? priorPerItem * priorItemCount
              : NaN)
        if (!req.budget && isFinite(priorBudget) && priorBudget > 0) {
          req.budget = priorBudget
        } else if (!req.budget) {
          // Remember that we need only the numeric amount for the chosen scope
          req._needBudgetAmount = true
        }
        req._budgetType = saysTotal ? 'total' : 'per-item'
        // User has specified scope now; do not ask scope again this turn
        req._askBudgetScope = false
        // Also capture a number if present in the same message
        const numMatch = msg.match(/(?:rs\.?|₹)\s*([0-9][0-9,\.]+)/)
        if (numMatch) {
          const raw = numMatch[1].replace(/[,]/g,'')
          const n = Number(raw)
          if (isFinite(n) && n > 0) {
            req.budget = n
            req._needBudgetAmount = false
          }
        }
      }
    }

    // If user provided a budget number with scope words in any order, parse directly
    {
      const msg = lowerNoUrls
      const totalNum = msg.match(/\b(total|overall)\b[^0-9]*([0-9][0-9,\.]+)/)
      const perNum = msg.match(/\bper\s*-?\s*item\b[^0-9]*([0-9][0-9,\.]+)/)
      if (!hasPlanCmd && !req.budget && totalNum) {
        const n = Number(totalNum[2].replace(/[,]/g,''))
        if (isFinite(n) && n > 0) {
          req.budget = n
          req._budgetType = 'total'
          req._budgetScope = 'total'
          req._needBudgetAmount = false
          req._askBudgetScope = false
        }
      }
      if (!hasPlanCmd && !req.budget && perNum) {
        const n = Number(perNum[1].replace(/[,]/g,''))
        if (isFinite(n) && n > 0) {
          req.budget = n
          req._budgetType = 'per-item'
          req._budgetScope = 'per_item'
          req._needBudgetAmount = false
          req._askBudgetScope = false
        }
      }
    }

    // If no concrete items or area yet and user is talking about designing, ask project scope (flat/room/office/etc.) in clarify
    {
      const msg = String(userMessage || '').toLowerCase()
      const mentionsDesign = /(design|plan|renovat|setup|furnish)/.test(msg)
      const hasAnyItems = Array.isArray(req.requestedItems) && req.requestedItems.length > 0
      const hasArea = !!req.area
      const mentionsBHK = /\bbhk\b/.test(msg)
      if (mentionsDesign && !hasAnyItems && !hasArea && !mentionsBHK) {
        req._askProjectScope = true
      }
    }

    // If user answered the project scope (flat/room/office/retail/restaurant), seed minimal items when none exist yet
    {
      const msg = String(userMessage || '').toLowerCase().trim()
      const hasAnyItems = Array.isArray(req.requestedItems) && req.requestedItems.length > 0
      const isScopeAnswer = /(flat|apartment|room|office|retail|store|shop|restaurant)/.test(msg)
      if (!hasAnyItems && isScopeAnswer) {
        const items = []
        const touch = new Set(req._touchedTypes instanceof Set ? Array.from(req._touchedTypes) : (Array.isArray(req._touchedTypes) ? req._touchedTypes : []))
        const add = (type, specifications={}) => { items.push({ type, quantity: 1, specifications }); touch.add(type) }
        if (/flat|apartment/.test(msg)) {
          // Minimal flat: living + 1 bedroom + kitchen + bathroom
          add('sofa', {})
          add('tv_bench', {})
          add('table', { subtype: 'coffee' })
          add('bed', {})
          add('wardrobe', {})
          add('cabinet', {})
          add('mirror', {})
          req.area = 'living'
        } else if (/room/.test(msg)) {
          // Minimal room: sofa or bed depending on hint; default to bed
          add('bed', {})
          add('wardrobe', {})
          add('mirror', {})
        } else if (/office/.test(msg)) {
          add('desk', {})
          add('chair', {})
          add('cabinet', {})
        } else if (/retail|store|shop/.test(msg)) {
          add('cabinet', {})
          add('table', { subtype: 'side' })
          add('mirror', {})
        } else if (/restaurant/.test(msg)) {
          add('table', { subtype: 'dining' })
          add('chair', {})
          add('cabinet', {})
        }
        if (items.length > 0) {
          req.requestedItems = items
          req._touchedTypes = touch
          req._askProjectScope = false
          req._justSeededPlan = true
        }
      }
    }

    // Multi-area seeding: if multiple rooms were requested in this message,
    // and we don't yet have explicit requestedItems from add/replace, seed
    // essentials for each mentioned area so the quotation covers all rooms.
    {
      const hadItems = Array.isArray(req?.requestedItems) && req.requestedItems.length > 0
      const areas = Array.isArray(req?.areas) ? req.areas.map(a => String(a).toLowerCase()) : []
      const allowed = new Set(['living','bedroom','kitchen','bathroom','dining','foyer'])
      if (areas.length > 0) {
        try {
          const additions = []
          // Derive BHK and tier similar to floor-plan flow so optionals can scale with area
          let bhk = 1, tier = 'medium'
          // Parse sqft locally if available in this message
          let areaSqft = Number(req?.areaSqft || 0) || 0
          try {
            const m = (userMessage || '').match(/(\d{3,6})\s*(sq\s*ft|sqft|sft|square\s*feet)\b/i)
            if (m) {
              const v = parseInt(m[1].replace(/,/g,''), 10)
              if (Number.isFinite(v) && v > 0) areaSqft = v
            }
          } catch (_) {}
          if (!req.areaSqft && areaSqft) req.areaSqft = areaSqft
          if (typeof aiInstance.deriveBhkAndTier === 'function') {
            const rooms = areas.map(a => ({ type: a }))
            const meta = aiInstance.deriveBhkAndTier(rooms, '', { area: areaSqft })
            bhk = meta?.bhk || 1
            tier = meta?.tier || 'medium'
          }
          // Detect explicit counts e.g., '2 bedrooms', '3 bathrooms'
          const counts = {}
          try {
            const L = (userMessage || '').toLowerCase()
            const patterns = [
              /(\d+)\s*(bedrooms?)/g,
              /(\d+)\s*(living\s*rooms?)/g,
              /(\d+)\s*(bathrooms?|washrooms?|toilets?)/g,
              /(\d+)\s*(kitchens?)/g,
              /(\d+)\s*(dining\s*rooms?)/g,
            ]
            for (const p of patterns) {
              let m
              while ((m = p.exec(L)) !== null) {
                const n = Math.max(1, parseInt(m[1], 10) || 1)
                const label = m[2]
                if (/bedroom/.test(label)) counts['bedroom'] = n
                else if (/living/.test(label)) counts['living'] = n
                else if (/bath|wash|toilet/.test(label)) counts['bathroom'] = n
                else if (/kitchen/.test(label)) counts['kitchen'] = n
                else if (/dining/.test(label)) counts['dining'] = n
              }
            }
          } catch (_) {}
          for (const area of areas) {
            if (!allowed.has(area)) continue
            if (typeof aiInstance.buildRequestedForArea === 'function') {
              const maxOpt = (typeof aiInstance.maxOptionalsFor === 'function') ? aiInstance.maxOptionalsFor(area, bhk, tier) : 0
              const lines = aiInstance.buildRequestedForArea(area, { kit: 'essentials', maxOptionals: maxOpt }) || []
              const count = Math.max(1, Number(counts[area] || 1))
              for (const l of lines) {
                const q = Math.max(1, Number(l.quantity || 1)) * count
                additions.push({ ...l, quantity: q, room: area })
              }
            }
          }
          if (additions.length) {
            const prev = Array.isArray(req.requestedItems) ? req.requestedItems.slice() : []
            const seen = new Set(prev.map(it => `${String(it.type||'').toLowerCase()}|${String(it?.specifications?.subtype||'').toLowerCase()}`))
            const merged = prev.slice()
            for (const it of additions) {
              const key = `${String(it.type||'').toLowerCase()}|${String(it?.specifications?.subtype||'').toLowerCase()}`
              if (!seen.has(key)) { merged.push(it); seen.add(key) }
            }
            req.requestedItems = merged
            const touch = new Set(req._touchedTypes instanceof Set ? Array.from(req._touchedTypes) : (Array.isArray(req._touchedTypes) ? req._touchedTypes : []))
            for (const it of additions) touch.add(String(it.type||'').toLowerCase())
            req._touchedTypes = new Set([...(touch || [])])
            if (!hadItems) req._justSeededPlan = true
          }
        } catch (_) { /* non-fatal */ }
      }
    }

    // Mark newly added item types as touched so clarify will focus on them
    {
      const priorTypes = new Set((priorReqItems || []).map(it => (it.type || '').toLowerCase()))
      const nowTypes = new Set((req.requestedItems || []).map(it => (it.type || '').toLowerCase()))
      const added = []
      for (const t of nowTypes) if (!priorTypes.has(t)) added.push(t)
      if (added.length) {
        const existing = req._touchedTypes instanceof Set ? Array.from(req._touchedTypes) : (Array.isArray(req._touchedTypes) ? req._touchedTypes : [])
        req._touchedTypes = new Set([...(existing || []), ...added])
      }
    }

    // Quantity updates handled in commandsParser.applyAdvancedCommands

    // Lightweight preference updater based on plain-text tokens in the reply
    // 'lower' already defined above
    const setMaterial = (mat) => {
      for (const it of (req.requestedItems || [])) {
        // Apply to any item type that can reasonably have a material, if not already set
        const t = it.type
        const materialApplicable = ['sofa','chair','table','wardrobe','cabinet','tv_bench','bookcase','desk','drawer','mirror'].includes(t)
        if (materialApplicable) {
          it.specifications = it.specifications || {}
          if (!it.specifications.material) it.specifications.material = mat
        }
      }
    }
    if (/\bfabric\b/.test(lower)) setMaterial('fabric')
    if (/\bleather\b/.test(lower)) setMaterial('leather')

    // Package words are ignored; we operate purely on per-item budgets now

    // Budget parsing from short replies: under/below X, X–Y, above/over X, or lone amount
    const amt = (s) => Number(String(s).replace(/[^0-9]/g, '')) || null
    const under = /(under|below|less than)\s*([₹]?[0-9][0-9,]*)/i.exec(userMessage)
    const over = /(above|over|more than)\s*([₹]?[0-9][0-9,]*)/i.exec(userMessage)
    const range = /([₹]?[0-9][0-9,]*)\s*(?:–|-|to)\s*([₹]?[0-9][0-9,]*)/i.exec(userMessage)
    const lone = /(?:^|\b)([₹]?[0-9][0-9,]{3,})(?:\b|$)/.exec(userMessage)
    if (under) {
      const v = amt(under[2]); if (v) { req.budget = v; req._budgetType = 'under' }
    } else if (range) {
      const lo = amt(range[1]); const hi = amt(range[2]); if (hi) { req.budget = hi; req._budgetType = 'range' }
    } else if (over) {
      const v = amt(over[2]); if (v) { req.budget = v; req._budgetType = 'above' }
    } else if (lone) {
      // Avoid interpreting square footage as budget: if surrounding text includes sqft markers, skip
      const idx = lone.index || userMessage.indexOf(lone[1])
      const ctx = userMessage.slice(Math.max(0, idx - 12), Math.min(userMessage.length, idx + String(lone[1]).length + 12)).toLowerCase()
      const seemsSqft = /(sq\s*ft|sqft|sft|square\s*feet)/.test(ctx)
      if (!seemsSqft) {
        const v = amt(lone[1]); if (v) { req.budget = v; req._budgetType = 'amount' }
      }
    }

    // Budget scope parsing: detect total vs per-item intent
    if (req.budget) {
      const L = lower
      const mentionsTotal = /(total|overall|entire|whole|full)\s+(budget|cost|quotation|spend)/.test(L) || /for the (room|project|quotation)/.test(L) || /\btotal\b/.test(L)
      const mentionsPerItem = /(per\s*item|each|per-item|per piece|per-piece)/.test(L)
      if (mentionsPerItem) { req._budgetScope = 'per_item'; req._askBudgetScope = false }
      else if (mentionsTotal) { req._budgetScope = 'total'; req._askBudgetScope = false }
      else { req._budgetScope = 'ambiguous'; req._askBudgetScope = true }
      if (req._budgetScope !== 'ambiguous') {
        try { if (state.prior) state.prior.reqBudget = req.budget } catch (_) {}
      }
    }

    // Removals handled in commandsParser.applyAdvancedCommands

    // Targeted updates and replacements based on user phrasing
    const updateMatch = lower.match(/\b(?:update|change|make|switch|set)\s+([a-z\- ]+?)(?:\s+(?:material|subtype|size))?\s+(?:to|as|into)\s+([a-z\-]+)/)
    if (updateMatch) {
      const rawType = updateMatch[1].trim()
      const value = updateMatch[2].trim()
      const normType = mapType(rawType)
      const items = req.requestedItems || []
      const idx = items.findIndex(it => (it.type || '').toLowerCase() === normType)
      if (idx >= 0) {
        req._touchedTypes = new Set([...(req._touchedTypes || []), normType])
        const it = { ...items[idx] }
        it.specifications = { ...(it.specifications || {}), features: { ...(it.specifications?.features || {}) } }
        if (normType === 'table' && /(coffee|side|dining|bedside)/.test(value)) {
          it.specifications.subtype = value
        } else if (/(glass|wood|wooden|metal|fabric|leather)/.test(value)) {
          it.specifications.material = value.replace('wood', 'wooden')
        } else if (/(small|medium|large)/.test(value)) {
          it.specifications.size = value
        }
        items[idx] = it
        req.requestedItems = items
        // Mutation confirmed — skip clarifier this turn and show updated quotation
        req._skipClarify = true
      }
    }
    // Seater intent for sofa:
    // - "add a 4 seater sofa" => ADD a new sofa line with seater=4
    // - "change/make/set sofa to 4 seater" or bare "4-seater sofa" => UPDATE existing sofa line
    {
      const applySofaSeaterUpdate = (n) => {
        const items = req.requestedItems || []
        const idx = items.findIndex(it => (it.type || '').toLowerCase() === 'sofa')
        if (idx >= 0 && Number(n)) {
          req._touchedTypes = new Set([...(req._touchedTypes || []), 'sofa'])
          const it = { ...items[idx] }
          it.specifications = { ...(it.specifications || {}), features: { ...(it.specifications?.features || {}) } }
          it.specifications.seater = Number(n)
          items[idx] = it
          req.requestedItems = items
          req._skipClarify = true
          return true
        }
        return false
      }
      const applySofaSeaterAdd = (n) => {
        if (!Number(n)) return false
        const items = req.requestedItems || []
        const line = { type: 'sofa', quantity: 1, specifications: { seater: Number(n), features: {} } }
        items.push(line)
        req.requestedItems = items
        req._touchedTypes = new Set([...(req._touchedTypes || []), 'sofa'])
        req._skipClarify = true
        return true
      }
      const addCmd = /\b(?:add|also add|include|plus|another)\b.*?(\d+)\s*-?\s*seater\b.*\bsofa\b/.exec(lower)
      const seaterCmd = /\b(?:update|change|make|switch|set)\s+sofa\s+(?:to|as|into)\s*(\d+)\s*-?\s*seater\b/.exec(lower)
      const seaterNoun = /\b(\d+)\s*-?\s*seater\b.*\bsofa\b/.exec(lower)
      const replaceSeater = /\breplace\s+(\d+)\s*-?\s*seater\s+sofa\s+(?:to|with)\s+(\d+)\s*-?\s*seater\b/.exec(lower)
      if (addCmd && applySofaSeaterAdd(addCmd[1])) { /* added */ }
      else if (seaterCmd && applySofaSeaterUpdate(seaterCmd[1])) { /* updated */ }
      else if (replaceSeater) {
        const fromN = parseInt(replaceSeater[1], 10)
        const toN = parseInt(replaceSeater[2], 10)
        const items = req.requestedItems || []
        // Prefer sofa matching the 'from' seater; fallback to first sofa
        let idx = items.findIndex(it => (it.type||'').toLowerCase()==='sofa' && Number(it.specifications?.seater||0)===fromN)
        if (idx < 0) idx = items.findIndex(it => (it.type||'').toLowerCase()==='sofa')
        if (idx >= 0 && Number(toN)) {
          req._touchedTypes = new Set([...(req._touchedTypes || []), 'sofa'])
          const it = { ...items[idx] }
          it.specifications = { ...(it.specifications || {}), features: { ...(it.specifications?.features || {}) } }
          it.specifications.seater = Number(toN)
          items[idx] = it
          req.requestedItems = items
          req._skipClarify = true
        }
      }
      else if (!/\badd\b/.test(lower) && seaterNoun && applySofaSeaterUpdate(seaterNoun[1])) { /* updated via bare noun */ }
    }

    // Generic: add another variant of a type with material/subtype details
    {
      const lowerMsg = lower
      const typeAliases = {
        'sofa': 'sofa', 'couch': 'sofa',
        'tv bench': 'tv_bench', 'tv unit': 'tv_bench', 'tv table': 'tv_bench', 'tv stand': 'tv_bench', 'tv': 'tv_bench',
        'coffee table': 'table', 'side table': 'table', 'bedside table': 'table', 'dining table': 'table', 'table': 'table',
        'bookcase': 'bookcase', 'bookshelf': 'bookcase', 'shelf': 'bookcase',
        'wardrobe': 'wardrobe', 'almirah': 'wardrobe', 'closet': 'wardrobe',
        'mirror': 'mirror', 'cabinet': 'cabinet', 'drawer': 'drawer', 'desk': 'desk', 'chair': 'chair', 'bed': 'bed'
      }
      const mapType = (raw) => {
        const r = String(raw || '').toLowerCase().trim()
        return typeAliases[r] || r.replace(/\s+/g,'_')
      }
      const matFrom = (txt) => {
        if (/leather|leatherette|faux/.test(txt)) return 'leather'
        if (/fabric|cloth|textile/.test(txt)) return 'fabric'
        if (/glass/.test(txt)) return 'glass'
        if (/wood|wooden/.test(txt)) return 'wooden'
        if (/metal|steel|iron/.test(txt)) return 'metal'
        return null
      }
      const subtypeFrom = (t, txt) => {
        if (t === 'table') {
          if (/coffee/.test(txt)) return 'coffee'
          if (/(bedside|night\s*stand)/.test(txt)) return 'bedside'
          if (/side\s*table/.test(txt)) return 'side'
          if (/dining/.test(txt)) return 'dining'
        }
        return null
      }
      const shapeFrom = (t, txt) => {
        if (t === 'mirror') {
          if (/curved|round|circle|circular|oval/.test(txt)) return 'curved'
          if (/rectangular|rectangle|square/.test(txt)) return 'rectangular'
        }
        return null
      }

      // Patterns
      const addWithRe = /\b(?:add|also add|include|plus|another|one more)\s+([a-z\- ]+?)(?:\s+with\s+([a-z\- ,]+)|\s+in\s+([a-z\- ,]+)|\s+but\s+([a-z\- ,]+))?\b/.exec(lowerMsg)
      const sameButRe = /\bsame\s+([a-z\- ]+?)\s+(?:but|in|with)\s+([a-z\- ,]+)\b/.exec(lowerMsg)
      const applyNewVariant = (tLabel, detailTxt) => {
        const t = mapType(tLabel)
        if (!t) return false
        const items = req.requestedItems || []
        const specs = {}
        const mat = matFrom(detailTxt || '')
        if (mat) specs.material = mat
        const st = subtypeFrom(t, detailTxt || '')
        if (st) specs.subtype = st
        const sh = shapeFrom(t, detailTxt || '')
        if (sh) specs.shape = sh
        const lighting = /(light|lighting|backlit|illuminated)/.test(detailTxt || '')
        if (lighting) specs.features = { ...(specs.features||{}), lighting: true }
        items.push({ type: t, quantity: 1, specifications: specs })
        req.requestedItems = items
        req._touchedTypes = new Set([...(req._touchedTypes || []), t])
        req._skipClarify = true
        return true
      }
      if (addWithRe) {
        const d = addWithRe[2] || addWithRe[3] || addWithRe[4] || ''
        applyNewVariant(addWithRe[1], d)
      } else if (sameButRe) {
        // "same sofa but leather" => clone last existing line of that type and change detail
        const t = mapType(sameButRe[1])
        const items = req.requestedItems || []
        const idx = [...items].reverse().findIndex(it => (it.type || '').toLowerCase() === t)
        if (idx >= 0) {
          const realIdx = items.length - 1 - idx
          const base = items[realIdx]
          const clone = { type: t, quantity: 1, specifications: { ...(base.specifications || {}) } }
          const det = sameButRe[2] || ''
          const mat = matFrom(det)
          if (mat) clone.specifications.material = mat
          const st = subtypeFrom(t, det)
          if (st) clone.specifications.subtype = st
          const sh = shapeFrom(t, det)
          if (sh) clone.specifications.shape = sh
          if (/(light|lighting|backlit|illuminated)/.test(det)) {
            clone.specifications.features = { ...(clone.specifications.features||{}), lighting: true }
          }
          items.push(clone)
          req.requestedItems = items
          req._touchedTypes = new Set([...(req._touchedTypes || []), t])
          req._skipClarify = true
        }
      }
    }
    // Add a new line by explicit catalog id (from Alternatives dialog Add Item)
    {
      const addIdMatch = lower.match(/\badd\s+([a-z\- ]+?)\s+with\s+id\s+(\d+)\b/)
      if (addIdMatch) {
        const rawType = addIdMatch[1].trim()
        const id = parseInt(addIdMatch[2], 10)
        const normType = mapType(rawType)
        if (Number.isFinite(id)) {
          const items = req.requestedItems || []
          items.push({ type: normType, quantity: 1, preferredId: id, specifications: {} })
          req.requestedItems = items
          req._touchedTypes = new Set([...(req._touchedTypes || []), normType])
          req._skipClarify = true
        }
      }
    }
    // Replace-by-id handled in commandsParser.applyAdvancedCommands

    // Replace by name: "replace <type> with <name>"
    // Replace-by-name handled in commandsParser.applyAdvancedCommands

    // Replace without specifying id/name: "replace <type>"
    // Bare replace handled in commandsParser.applyAdvancedCommands

    // "More options" requests: generic or type-specific; increments a per-type offset used by aiService.getAlternatives
    {
      const moreAny = /(more|show|different|alternative).*(options|alternatives)/.test(lower)
      if (moreAny) {
        // Determine target type: explicit in message or default to last selected line type
        const typeMatch = lower.match(/for\s+([a-z\- ]+)$/)
        let targetType = null
        if (typeMatch) targetType = typeMatch[1].trim().replace(/\s+/g,'_')
        if (!targetType && Array.isArray(state.prior?.selections) && state.prior.selections.length > 0) {
          const last = state.prior.selections[state.prior.selections.length - 1]
          targetType = (last.line?.type || '').toLowerCase()
        }
        if (targetType) {
          req.altForType = targetType
          const prev = (state.prior?.altOffsets && state.prior.altOffsets[targetType]) ? Number(state.prior.altOffsets[targetType]) : 0
          req.altOffset = prev + 3 // advance by the same batch size we show
        }
      }
    }

    // If any preferences provided this turn, clear clarify meta to avoid repeating the same question
    const providedPrefs = /fabric|leather|economy|premium|luxury|under|below|less than|above|over|\d/.test(lower)
    if (providedPrefs && state.prior?.clarifyMeta) {
      // signal a fresh start for clarification cycle
      // (assemble will set a new clarifyMeta as needed)
      return { req, clarifyMeta: null }
    }
    return { req }
  })

  // agent_assist: lets a small Agent adjust the req (e.g., apply update/replace) before selection
  g.addNode('agent_assist', async (state) => {
    const userMessage = state.userMessage || ''
    const req = state.req || { requestedItems: [] }
    const filters = state.filters || {}
    const priorSelections = state.prior?.selections || []
    try {
      const agentOut = await runAgent(userMessage, { req, filters, selections: priorSelections })
      if (agentOut?.updates?.requestedItems) {
        return { req: { ...req, requestedItems: agentOut.updates.requestedItems } }
      }
    } catch (_) { /* ignore agent errors to preserve stability */ }
    return {}
  })

  // build_filters
  g.addNode('build_filters', async (state) => {
    const userMessage = state.userMessage || ''
    const req = state.req || {}
    const generic = aiInstance.extractRequirements(userMessage)
    const filters = {}
    if (req.area || generic.area) filters.area = (req.area || generic.area)
    if (req.theme || generic.theme) filters.theme = (req.theme || generic.theme)
    const budgetMax = req.budget || generic.budget
    if (budgetMax && !isNaN(budgetMax)) {
      // Only set per-item cap when scope is per_item or when scope is total (use average cap)
      const hasUpper = req._budgetType === 'under' || req._budgetType === 'range' || req._budgetType === 'amount' || !req._budgetType
      if (hasUpper) {
        let scope = req._budgetScope || 'per_item'
        // If the plan was just seeded from a BHK/flat intent and scope is ambiguous, assume TOTAL budget and distribute.
        if (scope === 'ambiguous' && req._justSeededPlan) {
          scope = 'total'
        }
        if (scope === 'per_item') {
          filters.maxPrice = Number(budgetMax)
        } else if (scope === 'total') {
          const count = Array.isArray(req.requestedItems) && req.requestedItems.length > 0 ? req.requestedItems.length : 1
          filters.maxPrice = Math.floor(Number(budgetMax) / Math.max(1, count))
        } else {
          // ambiguous: do not set per-item cap; clarifier will ask
        }
      }
    }

    // Derive a display-only tier label from budget to help differentiate lines visually
    if (filters.maxPrice) {
      const mp = Number(filters.maxPrice)
      filters.displayTier = mp <= 15000 ? 'Economy' : (mp <= 40000 ? 'Luxury' : 'Premium')
    }

    // merge prior defaults from memory
    const prior = state.prior || null
    if (prior && prior.filters) {
      if (!filters.area && prior.filters.area) filters.area = prior.filters.area
      if (!filters.theme && prior.filters.theme) filters.theme = prior.filters.theme
      if (!filters.maxPrice && prior.filters.maxPrice) filters.maxPrice = prior.filters.maxPrice
      if (!filters.displayTier && prior.filters.displayTier) filters.displayTier = prior.filters.displayTier
    }
    // If we defaulted ambiguous scope to total (because of just-seeded plan) we should also clear _askBudgetScope to skip clarifier.
    let nextReq = req
    if ((req._budgetScope === 'ambiguous') && req._justSeededPlan && filters.maxPrice) {
      nextReq = { ...req, _askBudgetScope: false, _budgetScope: 'total' }
    }
    return { filters, req: nextReq }
  })

  // Helper: build a stable key for a requested line to track selections across turns
  const lineKey = (line) => {
    const t = (line?.type || '').toLowerCase()
    const s = line?.specifications || {}
    const f = s.features || {}
    const parts = [
      t,
      s.subtype ? `sub:${String(s.subtype).toLowerCase()}` : '',
      s.seater ? `seat:${s.seater}` : '',
      s.material ? `mat:${String(s.material).toLowerCase()}` : '',
      s.size ? `size:${String(s.size).toLowerCase()}` : '',
      f.doors ? `doors:${String(f.doors).toLowerCase()}` : '',
      f.drawers ? `drawers:${String(f.drawers).toLowerCase()}` : '',
      f.upholstered ? 'uphol:1' : ''
    ].filter(Boolean)
    return parts.join('|')
  }

  const equalSpecs = (a, b) => {
    const sa = a?.specifications || {}
    const sb = b?.specifications || {}
    const fa = sa.features || {}
    const fb = sb.features || {}
    const same = (
      (a?.type || '').toLowerCase() === (b?.type || '').toLowerCase() &&
      String(sa.subtype || '').toLowerCase() === String(sb.subtype || '').toLowerCase() &&
      String(sa.material || '').toLowerCase() === String(sb.material || '').toLowerCase() &&
      String(sa.size || '').toLowerCase() === String(sb.size || '').toLowerCase() &&
      Number(sa.seater || 0) === Number(sb.seater || 0) &&
      String(fa.doors || '').toLowerCase() === String(fb.doors || '').toLowerCase() &&
      String(fa.drawers || '').toLowerCase() === String(fb.drawers || '').toLowerCase() &&
      Boolean(fa.upholstered) === Boolean(fb.upholstered)
    )
    return same
  }

  // select_per_line
  g.addNode('select_per_line', async (state) => {
    const req = state.req || { requestedItems: [] }
    const filters = state.filters || {}
    const selections = []
    const unmet = []
    // Track duplicates only within this turn; do not seed with prior ids or reuse will be blocked
    const usedItemIds = new Set()
    const priorSelByKey = state.prior?.selByKey || {}
    const priorReqItems = Array.isArray(state.prior?.reqItems) ? state.prior.reqItems : []
    const touchedTypes = (() => {
      if (!req?._touchedTypes) return new Set()
      // _touchedTypes may be a Set or array depending on serialization
      return req._touchedTypes instanceof Set ? req._touchedTypes : new Set(Array.from(req._touchedTypes))
    })()
    // If a changeset exists, prefer it to decide which exact lines must reselect
    const changedTypes = (() => {
      if (!Array.isArray(req?._changes) || req._changes.length === 0) return null
      const s = new Set()
      for (const c of req._changes) if (c && c.type) s.add(String(c.type).toLowerCase())
      return s
    })()
    const changedKeys = (() => {
      if (!Array.isArray(req?._changes) || req._changes.length === 0) return null
      const s = new Set(); const prev = new Map()
      for (const c of req._changes) {
        if (c?.key) s.add(String(c.key))
        if (c?.prevKey) prev.set(String(c.key), String(c.prevKey))
      }
      return { curr: s, prevMap: prev }
    })()
    for (const line of req.requestedItems || []) {
      // Prefer the previously selected item for this logical line if still valid
      const key = lineKey(line)
      // If this line explicitly carries a preferredId (e.g., from a 'replace X with id Y'), use it first
      let preferredId = line?.preferredId || priorSelByKey[key]
      // If key changed this turn, try previous key based on changeset mapping
      if (!preferredId && changedKeys && changedKeys.prevMap.has(key)) {
        const prevKey = changedKeys.prevMap.get(key)
        if (prevKey && priorSelByKey[prevKey]) preferredId = priorSelByKey[prevKey]
      }
      // If the line's type was NOT touched this turn, try to reuse prior id even if minor specs changed
      const typeLower = (line.type || '').toLowerCase()
      const prevLine = priorReqItems.find(pl => (pl.type || '').toLowerCase() === typeLower)
      // If key changed (preferredId undefined), try to recover prior id by previous key or prior selections by type
      if (!preferredId && prevLine) {
        const prevKey = lineKey(prevLine)
        preferredId = priorSelByKey[prevKey]
      }
      if (!preferredId && Array.isArray(state.prior?.selections)) {
        const prevSel = state.prior.selections.find(s => (s.line?.type || '').toLowerCase() === (line.type || '').toLowerCase())
        if (prevSel?.item?.id) preferredId = prevSel.item.id
      }
      // Must reselect if either the type was changed or this exact line key changed
      const mustReselect = changedKeys ? changedKeys.curr.has(key) : (changedTypes ? changedTypes.has(typeLower) : touchedTypes.has(typeLower))
      const canForceReuse = preferredId && !mustReselect
      const strictMatch = preferredId && prevLine && equalSpecs(prevLine, line)
      if (canForceReuse || strictMatch) {
        try {
          const { data: row, error } = await supabase
            .from('interior_items')
            .select('id,item_name,item_description,item_details,keywords,variation_name,base_material,finish_material,price_inr,packages,price_tier,preferred_theme,suggestive_areas,category,subcategory')
            .eq('id', preferredId)
            .maybeSingle()
          if (!error && row && row.id && !usedItemIds.has(row.id)) {
            usedItemIds.add(row.id)
            const reason = strictMatch ? 'reused prior selection (unchanged specs)' : 'reused prior selection (type unchanged)'
            selections.push({ line, item: row, reason })
            continue
          }
        } catch (_) { /* fall through to search */ }
      }
      const lineWithPref = preferredId ? { ...line, preferredId } : line
      const pick = await aiInstance.findBestItem(lineWithPref, filters, usedItemIds)
      if (pick?.item) selections.push({ line, item: pick.item, reason: pick.reason })
      else unmet.push({ line, reason: pick?.reason, suggestions: pick?.suggestions })
    }
    return { selections, unmet }
  })

  // clarify
  g.addNode('clarify', async (state) => {
    // If clarifier is disabled globally, never ask any clarifying questions
    if (!USE_LLM_CLARIFIER) return { clarification: null }
    // If this turn contained a direct replace, skip asking any clarifying questions
    if (state.req?._skipClarify) return { clarification: null }
    // Ask explicit budget scope question when ambiguous
    if (state.req?._askBudgetScope && state.req?.budget && (state.req?._budgetScope === 'ambiguous' || !state.req?._budgetScope)) {
      const amt = Number(state.req.budget).toLocaleString('en-IN')
      return { clarification: `You mentioned a budget of ₹${amt}. Should I treat this as the total budget for the whole quotation, or as a per-item budget? Please reply with "total budget" or "per-item budget".` }
    }
    const unmet = state.unmet || []
    const filters = state.filters || {}
    const req = state.req || {}
    const priorMeta = state.prior?.clarifyMeta || { count: 0, lastKey: null }
    let clarification = null
    // High-level project scope question when ambiguous
    if (req._askProjectScope) {
      return { clarification: 'What space are you designing? Please choose one: Flat/Apartment, Single Room, Office, Retail Store, Restaurant, Other.' }
    }
    // If we have items but no budget yet, prefer targeted ask when scope is known
    if ((!state.filters?.maxPrice && !req.budget) && Array.isArray(req.requestedItems) && req.requestedItems.length > 0) {
      if (req._budgetType === 'total') {
        return { clarification: 'Please share the total budget amount (e.g., ₹2,50,000).' }
      }
      if (req._budgetType === 'per-item') {
        return { clarification: 'Please share the per-item budget (e.g., under ₹20,000 per item).' }
      }
      return { clarification: 'What budget should I target? You can reply like "total ₹2,50,000" or "per-item under ₹20,000".' }
    }
    // If we JUST seeded a plan, do not ask any other questions in this turn beyond budget (already handled above)
    if (req._justSeededPlan) {
      return { clarification: null }
    }
    if (unmet.length > 0) {
      const first = unmet[0]
      clarification = await clarifyWithLLM({ unmetLine: first.line, filters, probes: first.suggestions || {} })
    }
    // preference-gap even when matched
    if (!clarification) {
      const requestedAll = req.requestedItems || []
      // Focus clarification only on items touched/added this turn. If none, try prior clarify key type; else all.
      const touched = req._touchedTypes instanceof Set ? req._touchedTypes : new Set(Array.isArray(req._touchedTypes) ? req._touchedTypes : [])
      let focusTypes = null
      if (touched.size > 0) {
        focusTypes = new Set(Array.from(touched))
      } else if (state.prior?.clarifyMeta?.lastKey) {
        const k = String(state.prior.clarifyMeta.lastKey)
        const t = k.split(':')[0]
        if (t) focusTypes = new Set([t])
      }
      const requested = focusTypes
        ? requestedAll.filter(r => focusTypes.has((r.type || '').toLowerCase()))
        : requestedAll
      // Treat 'above' budget as satisfying the budget question (no upper bound, but user answered)
      const isAbove = req?._budgetType === 'above'
      const lacksBudget = !filters?.maxPrice && !isAbove
      const sofaLine = requested.find(r => r.type === 'sofa')
      const sofaNeedsMat = !!sofaLine && !(sofaLine.specifications && sofaLine.specifications.material)
      const hasTvBench = requested.some(r => r.type === 'tv_bench')
      const hasCoffee = requested.some(r => r.type === 'table' && (r.specifications?.subtype === 'coffee'))
      const anyRequested = requested[0]

      // General missing field detector (applies to ALL item types)
      const missingFieldsFor = (line) => {
        const s = line?.specifications || {}
        const m = []
        // Common: budget if missing
        if (lacksBudget) m.push('budget')
        // Type-specific
        switch (line?.type) {
          case 'sofa':
            if (!s.material) m.push('material')
            if (!s.seater) m.push('seater')
            break
          case 'chair':
            if (!s.material) m.push('material')
            break
          case 'table':
            if (!s.subtype) m.push('subtype')
            if (!s.material) m.push('material')
            break
          case 'wardrobe':
          case 'cabinet':
            if (!s.features || !s.features.doors) m.push('doors')
            break
          case 'bookcase':
            // open vs glass doors
            if (!s.features || !('doors' in (s.features))) m.push('doors')
            break
          case 'tv_bench':
            if (!s.material) m.push('material')
            break
          default:
            // For unknown types, at least ask material if not present
            if (!s.material) m.push('material')
        }
        return m
      }
      const itemsNeeding = requested.filter(r => missingFieldsFor(r).length > 0)
      const lineToClarify = itemsNeeding[0] || anyRequested

      // If we have multiple items needing details or the plan was just seeded, auto-apply sane defaults
      // to avoid a long clarifier loop. Keep the flow moving and only ask for budget if it's missing.
      if ((itemsNeeding.length >= 2 || req._justSeededPlan) && itemsNeeding.length > 0) {
        const applyDefaults = (ln) => {
          if (!ln || !ln.type) return
          ln.specifications = ln.specifications || {}
          const s = ln.specifications
          switch (ln.type) {
            case 'sofa':
              if (!s.material) s.material = 'fabric'
              if (!s.seater) s.seater = 3
              break
            case 'chair':
              if (!s.material) s.material = 'fabric'
              break
            case 'table':
              if (!s.subtype) s.subtype = 'coffee'
              if (!s.material) s.material = 'wooden'
              break
            case 'tv_bench':
              if (!s.material) s.material = 'wooden'
              break
            case 'wardrobe':
            case 'cabinet':
            case 'bookcase':
              s.features = s.features || {}
              if (!('doors' in s.features)) s.features.doors = 'solid'
              break
            case 'mirror':
              if (!s.shape) s.shape = 'rectangular'
              break
            default:
              if (!s.material) s.material = 'wooden'
          }
        }
        for (const ln of itemsNeeding) applyDefaults(ln)
        // With defaults applied, skip per-item clarification; only ask budget if missing
        if (lacksBudget) {
          clarification = 'What budget should I target? You can reply like "total ₹2,50,000" or "per-item under ₹20,000".'
          const key = 'defaults_applied:bud'
          const nextMeta = { lastKey: key, count: (state.prior?.clarifyMeta?.lastKey === key) ? ((state.prior?.clarifyMeta?.count||0) + 1) : 1 }
          return { clarification, clarifyMeta: nextMeta, req }
        }
        return { clarification: null, req }
      }

      // Build a clarification key to detect repeats
      const key = sofaLine ? `sofa:${sofaNeedsMat ? 'mat' : ''}${lacksBudget ? 'bud' : ''}`
        : hasTvBench ? `tv:${lacksBudget ? 'bud' : ''}`
        : hasCoffee ? `coffee:${lacksBudget ? 'bud' : ''}`
        : anyRequested ? `${anyRequested.type || 'item'}:${lacksBudget ? 'bud' : ''}`
        : null

      // If we are asking the same question again and we've already asked once, apply defaults and skip asking
      const isRepeat = key && priorMeta.lastKey === key
      if (isRepeat && priorMeta.count >= MAX_CLARIFY) {
        // Apply sensible defaults to break the loop (generic across types)
        if (sofaLine && sofaNeedsMat) {
          sofaLine.specifications = sofaLine.specifications || {}
          sofaLine.specifications.material = sofaLine.specifications.material || 'fabric'
        }
        // Seating defaults for chairs if material missing
        const chairLine = requested.find(r => r.type === 'chair' && !(r.specifications && r.specifications.material))
        if (chairLine) {
          chairLine.specifications = chairLine.specifications || {}
          chairLine.specifications.material = chairLine.specifications.material || 'fabric'
        }
        // Do not force maxPrice for 'above' budgets; proceed with existing filters
        return { clarification: null, req }
      }
      // Deterministic fallback question composed from missing fields (works for all types)
      const mf = lineToClarify ? missingFieldsFor(lineToClarify) : []
      if (itemsNeeding.length > 1) {
        // Ask about ALL items in one shot to avoid losing context
        const lines = []
        for (const ln of itemsNeeding) {
          const need = missingFieldsFor(ln)
          if (need.length === 0) continue
          const label = ln.type || 'item'
          const parts = []
          if (need.includes('material')) parts.push('material')
          if (need.includes('subtype')) parts.push('subtype')
          if (need.includes('seater')) parts.push('seater')
          if (need.includes('doors')) parts.push('doors')
          lines.push(`- ${label}: ${parts.join(', ')}`)
        }
        const needsBudgetAny = lacksBudget
        const tail = `${needsBudgetAny ? '\nBudget range? (under ₹10,000, ₹10,000–₹20,000, ₹20,000–₹40,000, above ₹40,000)' : ''}`
        clarification = `To proceed, could you specify the following details?\n${lines.join('\n')}${tail}`
      } else if (lineToClarify && mf.length > 0) {
        const t = lineToClarify.type || 'item'
        if (mf.includes('material') && mf.length === 1) {
          clarification = `Which material would you prefer for the ${t}? (fabric, leather, wood, metal)`
        } else if (mf.includes('subtype') && mf.length === 1 && t === 'table') {
          clarification = 'Which table subtype should I target? (coffee, side, bedside, dining)'
        } else if (mf.includes('seater') && mf.length === 1 && t === 'sofa') {
          clarification = 'How many seats should the sofa have? (2-seater, 3-seater, 4-seater)'
        } else {
          // Generic combined prompt including budget when present
          const needsBudget = mf.includes('budget')
          const parts = []
          if (mf.includes('material')) parts.push('material')
          if (mf.includes('subtype')) parts.push('subtype')
          if (mf.includes('seater')) parts.push('seater')
          if (needsBudget) parts.push('budget')
          clarification = `To proceed with the ${t}, could you specify ${parts.join(', ')}?${needsBudget ? ' (Budget ranges: under ₹10,000, ₹10,000–₹20,000, ₹20,000–₹40,000, above ₹40,000)' : ''}`
        }
      }

      // If LLM clarifier is enabled, upgrade to a conversational, context-aware question
      if (clarification && USE_LLM_CLARIFIER) {
        try {
          let llm = null
          if (itemsNeeding.length === 1) {
            const missingFields = mf
            const facets = await getTypeFacets(lineToClarify?.type)
            llm = await clarifyWithLLM({ unmetLine: lineToClarify, filters, probes: {}, missingFields, facets })
          } else if (itemsNeeding.length > 1) {
            // Multi-item: ask ONE instruction covering all missing fields
            const missingPerItem = []
            const perItemFacets = []
            for (const it of itemsNeeding) {
              missingPerItem.push({ type: it.type, missing: missingFieldsFor(it) })
              try {
                const f = await getTypeFacets(it.type)
                perItemFacets.push({ type: it.type, facets: f || {} })
              } catch { perItemFacets.push({ type: it.type, facets: {} }) }
            }
            llm = await clarifyWithLLM({ unmetLine: itemsNeeding[0], filters, probes: {}, missingFields: [], facets: null, items: itemsNeeding, missingPerItem, perItemFacets })
          }
          if (llm) clarification = llm
        } catch (e) { /* fallback to deterministic clarification already set */ }
      }

      // Append concise design tips from design_rules to make the clarifier more helpful and less repetitive
      try {
        const roomType = String(filters?.area || req?.area || '').toLowerCase() || null
        const itemType = String(lineToClarify?.type || '').toLowerCase() || null
        const tips = await retrieveRules({ roomType, itemType, limit: 2 })
        if (clarification && Array.isArray(tips) && tips.length > 0) {
          const bullets = tips.map(r => {
            const title = String(r?.title || '').trim()
            const body = String(r?.body_text || '').trim()
            const summary = title || (body ? body.slice(0, 100) : '')
            return summary ? `• ${summary}` : null
          }).filter(Boolean)
          if (bullets.length) {
            clarification = `${clarification}\n\nTips:\n${bullets.join('\n')}`
          }
        }
      } catch (_) { /* ignore tip errors to keep UX smooth */ }
      // Update clarify meta if we are asking a question
      if (clarification && key) {
        const nextMeta = { lastKey: key, count: priorMeta.lastKey === key ? (priorMeta.count + 1) : 1 }
        return { clarification, clarifyMeta: nextMeta }
      }
    }
    return { clarification }
  })

  // assemble (also writes next prior into memory via return)
  g.addNode('assemble', async (state) => {
    const filters = state.filters || {}
    const selections = state.selections || []
    const clarification = state.clarification || null
    const llmSummary = state.llmSummary || state.prior?.llmSummary || null
    const selectedIds = selections.map(s => s.item?.id).filter(Boolean)
    // Persist a mapping from lineKey -> selected item id to keep items stable across turns
    const selByKey = {}
    for (const s of selections) {
      const k = lineKey(s.line)
      if (k && s.item?.id) selByKey[k] = s.item.id
    }
    // Persist alternatives offsets per type so that repeated "more options" paginates
    const altOffsets = { ...(state.prior?.altOffsets || {}) }
    if (state.req?.altForType && (state.req?.altOffset != null)) {
      altOffsets[String(state.req.altForType).toLowerCase()] = Number(state.req.altOffset)
    }
    const prior = { 
      filters, 
      selectedIds, 
      selections, 
      selByKey, 
      altOffsets, 
      reqItems: (state.req?.requestedItems || []).map(it => ({ ...it })), 
      clarifyMeta: state.clarifyMeta || null,
      // Persist last known numeric budget to help interpret scope-only replies like "whole quotation"
      reqBudget: Number(state.req?.budget || state.prior?.reqBudget || 0) || null,
      llmSummary
    }
    return { prior, clarification, llmSummary }
  })

  // Edges
  g.setEntryPoint('parse_requirements')
  g.addEdge('parse_requirements', 'detect_plan')
  g.addEdge('detect_plan', 'vision_extract')
  g.addEdge('vision_extract', 'summarize')
  g.addEdge('summarize', 'confirm_gate')
  g.addEdge('confirm_gate', 'propose_essentials')
  g.addEdge('propose_essentials', 'agent_assist')
  g.addEdge('agent_assist', 'build_filters')
  g.addEdge('build_filters', 'select_per_line')
  g.addEdge('select_per_line', 'clarify')
  g.addEdge('clarify', 'assemble')
  g.setFinishPoint('assemble')

  app = g.compile()
  return app
}

// Public runner: execute graph with a sessionId and userMessage
export async function runStateGraph(aiInstance, sessionId, userMessage) {
  const app = getApp(aiInstance)
  const config = { configurable: { thread_id: sessionId || 'default' } }
  const memPrior = sessionMemory.get(sessionId || 'default') || null
  // Load durable prior from Supabase and merge with in-memory cache
  let durablePrior = {}
  try { durablePrior = await loadPrior(sessionId) } catch { durablePrior = {} }
  const prior = { ...(memPrior || {}), ...(durablePrior || {}) }
  const initial = { userMessage, prior }
  const DEBUG = String(import.meta.env.VITE_DEBUG_RETRIEVAL || '').toLowerCase() === 'true'
  if (DEBUG) {
    console.log('[Graph] sessionId:', sessionId || 'default', 'hasPrior:', !!prior, 'prior:', prior)
  }
  const result = await app.invoke(initial, config)
  // persist next prior (returned by assemble) in our browser-safe map
  const nextPrior = result.prior || {
    filters: result.filters || {},
    selectedIds: (result.selections || []).map(s => s.item?.id).filter(Boolean),
    selections: result.selections || [],
    selByKey: {},
    reqItems: (result.req?.requestedItems || []).map(it => ({ ...it })),
    clarifyMeta: null
  }
  sessionMemory.set(sessionId || 'default', nextPrior)
  if (DEBUG) {
    console.log('[Graph] persisted prior for', sessionId || 'default', nextPrior)
  }
  // Also persist to Supabase as single source of truth (non-blocking UX)
  try {
    const effectiveSelections = Array.isArray(result.selections) ? result.selections.filter(s => s && s.item && s.line) : []
    const items = effectiveSelections.map(sel => {
      const q = Math.max(1, Number(sel.line?.quantity || 1))
      const unit = Number(sel.item?.price_inr || 0)
      return { ...sel.item, quantity: q, line_total_inr: q * unit, line_type: sel.line?.type || null, room: sel.line?.room || null }
    })
    const totalEstimate = items.reduce((s, it) => s + (it.line_total_inr || 0), 0)
    await saveGraphState(sessionId, {
      llmSummary: result.llmSummary || prior.llmSummary || null,
      filters: result.filters || {},
      selections: result.selections || [],
      items,
      totalEstimate,
      reqItems: result.req?.requestedItems || [],
      reqBudget: nextPrior?.reqBudget || null
    })
  } catch (e) {
    if (DEBUG) console.warn('[Graph] saveGraphState error', e?.message || e)
  }
  return {
    req: result.req,
    filters: result.filters,
    selections: result.selections,
    unmet: result.unmet,
    clarification: result.clarification,
    llmSummary: result.llmSummary || prior.llmSummary || null
  }
}
