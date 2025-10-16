 
// Sequential, parser-first pipeline (v2)
// Steps: detect image -> floorplanLLM -> parserLLM -> summarizeLLM (strict JSON) -> essentialsLLM -> select -> assemble

import { analyzeFloorPlanLLM } from './floorplanLLM.js'
import { parseWithLLM } from './parserLLM.js'
import { summarizeToJSON } from './summarizerLLM.js'
import { proposeEssentialsJSON, essentialsToRequested } from './essentialsLLM.js'
import { deriveStyleBias, getStyleProfile, deriveStyleWeights, deriveNegatives, deriveRoomHints, blendStyleWeights, blendNegatives, blendRoomHints } from '../styles.js'
import { deriveRuleFor } from '../rules.js'
import { generateItemImage } from '../imageGen.js'
import { parseRoomName, deriveItemConstraints, determineBudgetTier } from '../propertyRulesLegacy.js'
import { detectIntent, isModificationCommand, shouldExcludeFromPlanning, explainIntent } from '../intentDetector.js'

const USE_LLM_PARSER = String(import.meta.env.VITE_USE_LLM_PARSER || 'true').toLowerCase() === 'true'
const USE_LLM_SUMMARIZER = String(import.meta.env.VITE_USE_LLM_SUMMARIZER || 'true').toLowerCase() === 'true'
const USE_LLM_ESSENTIALS = String(import.meta.env.VITE_USE_LLM_ESSENTIALS || 'true').toLowerCase() === 'true'
const USE_IMAGE_SEARCH = String(import.meta.env.VITE_USE_IMAGE_SEARCH || 'false').toLowerCase() === 'true'

function extractImageFromMessage(text) {
  const dataUrl = (text.match(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/) || [null])[0]
  const httpUrl = (text.match(/https?:\/\/\S+/) || [null])[0]
  return { dataUrl, httpUrl }
}

// Parse multi-style commands like:
// - styles: minimalist, industrial
// - set styles to minimalist 60, industrial 40
// - use styles minimalist and industrial
function extractStylesList(text) {
  const t = String(text || '').toLowerCase()
  let m = t.match(/\bstyles?\s*:\s*([^\n\.;]+)/)
  if (!m) m = t.match(/\bset\s+styles?\s+to\s+([^\n\.;]+)/)
  if (!m) m = t.match(/\buse\s+styles?\s+([^\n\.;]+)/)
  if (!m || !m[1]) return []
  const raw = m[1]
  return raw.split(/,|\band\b/).map(s => {
    const part = String(s || '').trim()
    if (!part) return null
    const mm = part.match(/([a-z\s-]+)\s*(\d{1,3})?/) // optional weight percent
    if (!mm) return null
    const name = String(mm[1] || '').trim()
    const w = mm[2] ? Math.max(1, Math.min(100, parseInt(mm[2], 10))) : 0
    return { name, weight: w || 0 }
  }).filter(Boolean)
}

// Detect explicit style override commands in user's message
function extractStyleOverride(text) {
  const t = String(text || '').toLowerCase()
  // Patterns: "set style to modern", "use style modern", "style: modern"
  let m = t.match(/\bset\s+style\s+to\s+([a-z\s-]+)/)
  if (m && m[1]) return m[1].trim()
  m = t.match(/\buse\s+style\s+([a-z\s-]+)/)
  if (m && m[1]) return m[1].trim()
  m = t.match(/\bstyle\s*:\s*([a-z\s-]+)/)
  if (m && m[1]) return m[1].trim()
  return null
}

// Parse user's room intent from natural language.
// If rooms are mentioned (e.g., "only living room", "for living and dining"), we will restrict to those rooms.
// Returns a unique normalized list of rooms, or an empty array if none detected.
// Now supports specific bedrooms: "bedroom 1", "bedroom 2", "master bedroom", etc.
function parseRoomIntent(text) {
  let t = String(text || '').toLowerCase()
  // Remove negative clauses so positives don't get falsely detected from them
  try {
    const trig = /(without|except|exclude|excluding|not\s+including|no|remove)\s+([^\.\;\n]+)/g
    t = t.replace(trig, '')
  } catch {}
  const roomList = []
  const push = (r) => { if (r && !roomList.includes(r)) roomList.push(r) }
  
  // Check for specific bedroom mentions first
  const bedroomMatches = t.matchAll(/\b(master|guest|kids?)\s+bedroom\b|\bbedroom\s+(\d+)\b/g)
  for (const m of bedroomMatches) {
    if (m[1]) push(`${m[1]} bedroom`)
    else if (m[2]) push(`bedroom ${m[2]}`)
  }
  
  const candidates = [
    { re: /\bliving\s*room\b|\bliving\b|\blounge\b|\bhall\b/, key: 'living' },
    { re: /\bkitchen\b/, key: 'kitchen' },
    { re: /\bbath\b|\bbathroom\b|\bwashroom\b|\btoilet\b|\blavatory\b/, key: 'bathroom' },
    { re: /\bdining\b|\bdining\s*room\b/, key: 'dining' },
    { re: /\bfoyer\b|\bentry\b|\bentrance\b/, key: 'foyer' },
    { re: /\bstudy\b|\boffice\b|\bwork\s*station\b/, key: 'study' },
    { re: /\bbalcony\b|\bveranda\b|\bpatio\b/, key: 'balcony' },
    { re: /\butility\b|\blaundry\b/, key: 'utility' }
  ]
  for (const c of candidates) { if (c.re.test(t)) push(c.key) }
  
  // Only add generic "bedroom" if no specific bedrooms were mentioned
  if (roomList.length === 0 || !roomList.some(r => /bedroom/.test(r))) {
    if (/\bbed\s*room\b|\bbedroom\b/.test(t)) push('bedroom')
  }
  
  return roomList
}

// Negative room intent, e.g., "without living room", "exclude bedroom", "except kitchen"
// NOTE: This is for initial room planning, NOT for removing specific bedroom items
function parseRoomExclusions(text, hasPriorQuotation = false) {
  const t = String(text || '').toLowerCase()
  const out = []
  const push = (r) => { if (r && !out.includes(r)) out.push(r) }
  
  // Use intent detector to determine if this is planning exclusion or modification
  // If it's a modification command, don't exclude rooms from planning
  if (isModificationCommand(text, hasPriorQuotation)) {
    return [] // Empty exclusions - this is a modification, not planning
  }
  
  // Capture the clause after the negative trigger up to punctuation
  const trig = /(without|except|exclude|excluding|not\s+including|no)\s+([^\.\;\n]+)/g
  
  const candidates = [
    { re: /\bliving(?:\s*room)?\b/, key: 'living' },
    { re: /\bbed\s*room\b|\bbedrooms?\b/, key: 'bedroom' },
    { re: /\bkitchen\b/, key: 'kitchen' },
    { re: /\bbath(?:room)?\b|\bwashroom\b|\btoilet\b|\bwc\b|\brestroom\b|\blavatory\b/, key: 'bathroom' },
    { re: /\bdining(?:\s*room)?\b/, key: 'dining' },
    { re: /\bfoyer\b|\bentry\b|\bentrance\b|\blobby\b/, key: 'foyer' },
    { re: /\bstudy\b|\boffice\b|\bwork\s*station\b/, key: 'study' },
    { re: /\bbalcony\b|\bveranda\b|\bpatio\b|\bterrace\b/, key: 'balcony' },
    { re: /\butility\b|\blaundry\b/, key: 'utility' }
  ]
  let m
  while ((m = trig.exec(t)) !== null) {
    const clause = m[2] || ''
    for (const c of candidates) { 
      if (c.re.test(clause)) push(c.key) 
    }
  }
  return out
}

function extractBhkDeterministic(text) {
  const t = String(text || '').toLowerCase()
  let m = t.match(/(\d+)\s*-?\s*bhk\b/)
  if (m) {
    const n = parseInt(m[1], 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  // Also handle "2 bedroom(s)" forms
  m = t.match(/(\d+)\s*bed\s*rooms?\b|(?:(\d+)\s*bedrooms?\b)/)
  if (m) {
    const n = parseInt(m[1] || m[2], 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  return null
}

function mergeRooms(...lists) {
  const set = new Set()
  for (const l of lists) {
    for (const r of (l || [])) {
      let s = String(r || '').toLowerCase().trim()
      if (s) {
        if (/^hall$|^lounge$/.test(s)) s = 'living'
        if (/^rest\s*room$/.test(s)) s = 'bathroom'
        if (/^(toilet|wc|washroom|lavatory)$/.test(s)) s = 'bathroom'
        if (/^living\s*room$/.test(s)) s = 'living'
        if (/^dining\s*room$/.test(s)) s = 'dining'
        set.add(s)
      }
    }
  }
  return Array.from(set)
}

function safeNumber(n) {
  const x = Number(n)
  return Number.isFinite(x) && x > 0 ? x : null
}

// Convert numeric words to numbers; supports digits and common words
function numberFromWord(token) {
  const s = String(token || '').trim().toLowerCase()
  if (!s) return null
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  const map = {
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'both': 2, 'couple': 2, 'few': 3, 'several': 4
  }
  if (s in map) return map[s]
  if (s === 'all') return -1 // special: all
  return null
}

// Extract an intended bedroom target count from text.
// Examples:
// - "only 2 bedrooms" => 2
// - "include two bedrooms" => 2
// - "exclude 2 bedrooms" or "remove 2 bedrooms" => totalBedrooms - 2
// - "exclude bedrooms" => 0
function extractBedroomTarget(text, totalBedrooms) {
  const t = String(text || '').toLowerCase()
  const wordNum = '(?:one|two|three|four|five|six|seven|eight|nine|ten|both|couple|few|several|all|\\d+)'
  // only/include N bedrooms
  let m = t.match(new RegExp(`\\b(?:only|include|with)\\s+(${wordNum})\\s+bed\\s*rooms?\\b|\\b(?:only|include|with)\\s+(${wordNum})\\s+bedrooms?\\b`))
  if (m) {
    const tok = m[1] || m[2]
    const n = numberFromWord(tok)
    if (n != null) {
      if (n === -1) return safeNumber(totalBedrooms) || null // "all" => keep all
      return Math.max(0, n)
    }
  }
  // exclude/remove N bedrooms
  m = t.match(new RegExp(`\\b(?:exclude|excluding|without|remove)\\s+(${wordNum})\\s+bed\\s*rooms?\\b|\\b(?:exclude|excluding|without|remove)\\s+(${wordNum})\\s+bedrooms?\\b`))
  if (m) {
    const tok = m[1] || m[2]
    const n = numberFromWord(tok)
    const tb = safeNumber(totalBedrooms) || 0
    if (n != null) {
      if (n === -1) return 0 // "exclude all bedrooms"
      return Math.max(0, tb - Math.max(0, n))
    }
  }
  // exclude bedrooms (no number) => 0
  if (/\b(?:exclude|excluding|without|remove)\s+bed\s*rooms?\b|\b(?:exclude|excluding|without|remove)\s+bedrooms?\b/.test(t)) {
    return 0
  }
  return null
}

function extractRoomsDeterministic(text) {
  const t = String(text || '').toLowerCase()
  const out = new Set()
  const addIf = (re, label) => { if (re.test(t)) out.add(label) }
  addIf(/\bliving\s*room\b|\bliving\b|\blounge\b|\bhall\b/, 'living')
  addIf(/\bbed\s*room\b|\bbedroom\b|\bmaster\s*bed(room)?\b|\bmasterbedroom\b|\bguest\s*room\b/, 'bedroom')
  addIf(/\bkitchen\b/, 'kitchen')
  addIf(/\bbath\b|\bbathroom\b|\bwashroom\b|\btoilet\b|\blavatory\b/, 'bathroom')
  addIf(/\bdining\b|\bdining\s*room\b/, 'dining')
  addIf(/\bfoyer\b|\bentry\b|\bentrance\b/, 'foyer')
  addIf(/\bstudy\b|\boffice\b|\bwork\s*station\b/, 'study')
  addIf(/\bbalcony\b|\bveranda\b|\bpatio\b/, 'balcony')
  addIf(/\butility\b|\blaundry\b/, 'utility')
  addIf(/\btoilet\b|\bwc\b/, 'toilet')
  return Array.from(out)
}

function extractRequestedFromText(text, rooms = []) {
  const t = String(text || '').toLowerCase()
  const has = (re) => re.test(t)
  const inRooms = (want) => rooms.includes(want) ? want : null
  const out = []
  // Queen size bed in master bedroom
  if (has(/queen\s*size\s*bed/)) {
    out.push({ type: 'bed', quantity: 1, specifications: { size: 'queen' }, room: inRooms('bedroom') || 'bedroom' })
  }
  // New sofa set → sofa in living
  if (has(/sofa\s*set|new\s+sofa/)) {
    out.push({ type: 'sofa', quantity: 1, specifications: {}, room: inRooms('living') || 'living' })
  }
  // TV unit → tv_bench in living
  if (has(/tv\s*(unit|bench|table|stand)/)) {
    out.push({ type: 'tv_bench', quantity: 1, specifications: {}, room: inRooms('living') || 'living' })
  }
  // Library unit → bookcase (prefer study else living)
  if (has(/library\s*(unit|shelf|shelving|book)|bookshelf|book\s*case/)) {
    out.push({ type: 'bookcase', quantity: 1, specifications: {}, room: inRooms('study') || inRooms('living') || 'living' })
  }
  return out
}

export async function runPipelineV2(aiInstance, sessionId, userMessage, opts = {}) {
  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null
  const text = String(userMessage || '')
  // Lightweight prior for deterministic commands (no clarifiers)
  const prior = aiInstance?.getPrior ? (aiInstance.getPrior(sessionId) || {}) : {}
  // 1) Vision (if present)
  const { dataUrl, httpUrl } = extractImageFromMessage(text)
  if (onProgress) try { onProgress({ stage: 'start', message: 'Starting pipeline' }) } catch {}
  let fpRooms = []
  let fpBhk = null
  let fpSqft = null
  let fpRoomDims = []
  let fpPropertyType = null
  if (dataUrl || httpUrl) {
    try {
      const img = dataUrl || httpUrl
      const fp = await analyzeFloorPlanLLM(img)
      if (fp) {
        fpRooms = Array.isArray(fp.rooms) ? fp.rooms.map(r => String(r)) : []
        fpBhk = safeNumber(fp.bhk)
        fpSqft = safeNumber(fp.sqft)
        fpPropertyType = fp.propertyType || null
        fpRoomDims = Array.isArray(fp.roomDimensions) ? fp.roomDimensions : []
      }
      if (onProgress) try { onProgress({ stage: 'vision', rooms: fpRooms, bhk: fpBhk, sqft: fpSqft, propertyType: fpPropertyType, roomDimensions: fpRoomDims }) } catch {}
    } catch (_) {}
  }

  // 2) Parse user text (rooms/theme/budget)
  let parsedRooms = []
  let parseAreaSqft = null
  let parseTheme = null
  let parseBudget = null
  if (USE_LLM_PARSER) {
    try {
      const p = await parseWithLLM(text)
      if (p) {
        parsedRooms = Array.isArray(p.areas) ? p.areas.map(r => String(r)) : []
        parseAreaSqft = safeNumber(p.areaSqft)
        parseTheme = p.theme || null
        parseBudget = safeNumber(p.budget)
      }
    } catch (_) {}
  }
  if (onProgress) try { onProgress({ stage: 'parsed', parsedRooms, parseAreaSqft, parseTheme, parseBudget }) } catch {}

  // 3) Summarize (strict JSON) on the raw message (optional)
  let sumRooms = []
  let sumSqft = null
  let sumBudget = null
  let sumTheme = null
  let sumBhk = null
  let sumRich = null
  if (USE_LLM_SUMMARIZER) {
    try {
      const s = await summarizeToJSON(text, { mode: 'chat', planRooms: fpRooms, planBhk: fpBhk, planSqft: fpSqft, parsedJSON: null, previousSummary: prior?.llmSummary || null })
      if (s) {
        sumRich = s
        // Back-compat extracted fields used by pipeline
        sumRooms = Array.isArray(s.roomsDetected) ? s.roomsDetected.map(r => String(r?.room || r)).filter(Boolean) : []
        sumSqft = safeNumber(s.sqft)
        sumTheme = s.theme || null
        sumBhk = safeNumber(s.bhk)
        if (s.budget && typeof s.budget === 'object' && safeNumber(s.budget.amount)) {
          sumBudget = safeNumber(s.budget.amount)
        }
      }
      if (onProgress) try { onProgress({ stage: 'summary', summary: sumRich || null }) } catch {}
    } catch (_) {}
  }

  // 4) Merge summary
  // Preserve bedroom/bathroom subtypes from floor plan (master/guest/attached/common)
  const normalizeRoomName = (name) => {
    const s = String(name || '').toLowerCase().trim()
    if (!s) return ''
    // Preserve subtypes for bedrooms and bathrooms
    if (/bedroom/.test(s)) return s // keep "master bedroom", "guest bedroom", etc.
    if (/bathroom/.test(s) || /bath\b/.test(s)) return s // keep "attached bathroom", "common bathroom", etc.
    // Normalize other rooms
    if (/^hall$|^lounge$/.test(s)) return 'living'
    if (/^rest\s*room$/.test(s)) return 'bathroom'
    if (/^(toilet|wc|washroom|lavatory)$/.test(s)) return 'bathroom'
    if (/^living\s*room$/.test(s)) return 'living'
    if (/^dining\s*room$/.test(s)) return 'dining'
    return s
  }
  const normalizeRooms = (arr) => Array.from(new Set((arr || []).map(normalizeRoomName).filter(Boolean)))

  const detRooms = normalizeRooms(extractRoomsDeterministic(text))
  const fpRoomsNorm = fpRooms.map(r => normalizeRoomName(r)).filter(Boolean) // Don't dedupe floor plan rooms
  const parsedRoomsNorm = normalizeRooms(parsedRooms)
  const sumRoomsNorm = normalizeRooms(sumRooms)
  let rooms = mergeRooms(detRooms, fpRoomsNorm, parsedRoomsNorm, sumRoomsNorm)
  try {
    if (import.meta && import.meta.env && import.meta.env.DEV) {
      console.debug('[v2] detRooms=', detRooms, 'fpRooms=', fpRooms, 'parsedRooms=', parsedRooms, 'sumRooms=', sumRooms, 'merged=', rooms)
    }
  } catch {}

  // Emit debug counts for requested lines per room (post-filter)
  try {
    if (onProgress && Array.isArray(requested)) {
      const counts = requested.reduce((acc, l) => { const r = String(l?.room||'').toLowerCase(); acc[r] = (acc[r]||0)+1; return acc }, {})
      onProgress({ stage: 'rooms_requested', rooms: [...rooms], excluded: __excludedRooms, counts })
    }
  } catch {}

  // Ensure balcony and utility get minimal essentials even if LLM essentials omitted them
  try {
    const need = new Set((requested || []).map(l => `${String(l.room||'')}:${String(l.type||'')}:${String(l?.specifications?.subtype||'')}`))
    const addIfMissing = (line) => {
      const key = `${line.room}:${line.type}:${line?.specifications?.subtype||''}`
      if (!need.has(key)) { requested.push(line); need.add(key) }
    }
    if (rooms.includes('balcony')) {
      addIfMissing({ type: 'chair', quantity: 2, specifications: {}, room: 'balcony' })
      addIfMissing({ type: 'table', quantity: 1, specifications: { subtype: 'side' }, room: 'balcony' })
    }
    if (rooms.includes('utility')) {
      addIfMissing({ type: 'shelf', quantity: 1, specifications: {}, room: 'utility' })
      addIfMissing({ type: 'cabinet', quantity: 1, specifications: {}, room: 'utility' })
    }
  } catch {}

  // Apply sofa budget boost to LLM-essential-produced lists as well
  const areaSqft = safeNumber(parseAreaSqft) || safeNumber(fpSqft) || safeNumber(sumSqft)
  const budget = safeNumber(parseBudget) || safeNumber(sumBudget)
  const theme = parseTheme || null
  // Compute style profile and bias from LLM summary, honoring explicit override from the user's message
  const styleOverride = extractStyleOverride(text)
  const multiStyles = extractStylesList(text)
  let styleProfile = null
  let styleBias = [] // legacy flat keywords for LLM essentials
  let styleWeights = [] // weighted for selector
  let styleNegatives = []
  const roomHintsMap = new Map()
  try {
    const primaryTheme = (multiStyles[0]?.name) || styleOverride || parseTheme || sumTheme || (llmSummary?.theme) || null
    styleProfile = await getStyleProfile({ theme: primaryTheme, styleKeywords: (llmSummary?.styleKeywords)||[] })
  } catch {}
  try {
    // legacy flat bias for prompts
    const primaryTheme = (multiStyles[0]?.name) || styleOverride || parseTheme || sumTheme || (llmSummary?.theme) || null
    styleBias = await deriveStyleBias({ theme: primaryTheme, styleKeywords: (llmSummary?.styleKeywords)||[] })
  } catch {}
  try {
    if (multiStyles.length) {
      const themes = multiStyles.map(s => ({ name: s.name, weight: s.weight || 1 }))
      styleWeights = await blendStyleWeights({ themes, styleKeywords: (llmSummary?.styleKeywords)||[] })
      styleNegatives = await blendNegatives({ themes })
      // build room hints per room detected
      for (const r of rooms) {
        const rh = await blendRoomHints({ themes, room: r })
        roomHintsMap.set(String(r).toLowerCase(), rh)
      }
    } else {
      const primaryTheme = styleOverride || parseTheme || sumTheme || (llmSummary?.theme) || null
      styleWeights = await deriveStyleWeights({ theme: primaryTheme, styleKeywords: (llmSummary?.styleKeywords)||[] })
      styleNegatives = await deriveNegatives({ theme: primaryTheme })
      for (const r of rooms) {
        const rh = await deriveRoomHints({ theme: primaryTheme, room: r })
        roomHintsMap.set(String(r).toLowerCase(), rh)
      }
    }
  } catch {}

  // Detect user intent to understand if this is initial planning or modification
  const hasPriorQuotation = Boolean(prior?.selections && prior.selections.length > 0)
  const userIntent = detectIntent(text, hasPriorQuotation)
  
  // Log intent for debugging
  try {
    if (import.meta && import.meta.env && import.meta.env.DEV) {
      console.log('[Intent Detection]', {
        text: text.substring(0, 100),
        hasPriorQuotation,
        intent: userIntent.primary.type,
        isModification: userIntent.isModification,
        explanation: explainIntent(text, hasPriorQuotation)
      })
    }
  } catch {}
  
  // Notify progress with intent explanation
  if (onProgress) try { 
    onProgress({ 
      stage: 'intent', 
      intent: userIntent.primary.type,
      explanation: explainIntent(text, hasPriorQuotation),
      isModification: userIntent.isModification
    }) 
  } catch {}
  
  // If the user specified room(s) explicitly in the message, restrict to those rooms only.
  let __userSpecifiedRooms = false
  let __excludedRooms = []
  try {
    const intentRooms = parseRoomIntent(text)
    const exclRooms = parseRoomExclusions(text, hasPriorQuotation)
    __excludedRooms = Array.isArray(exclRooms) ? exclRooms.map(r=>String(r||'').toLowerCase()) : []
    if (Array.isArray(intentRooms) && intentRooms.length > 0) {
      __userSpecifiedRooms = true
      // Intersect with detected rooms when available; otherwise use intent directly
      const detectedSet = new Set(rooms)
      const filtered = intentRooms.filter(r => detectedSet.has(r))
      rooms = filtered.length > 0 ? filtered : intentRooms
      // Apply exclusions as well
      if (__excludedRooms.length) rooms = rooms.filter(r => !__excludedRooms.includes(r))
    } else if (Array.isArray(exclRooms) && exclRooms.length > 0) {
      __userSpecifiedRooms = true
      // No positives; apply negatives to merged rooms
      rooms = rooms.filter(r => !__excludedRooms.includes(r))
    }
  } catch {}

  // If BHK is present, ensure a minimal set of rooms: living, kitchen, bathroom, and bedrooms
  const bhkFromText = extractBhkDeterministic(text)
  const bhkFromPlan = (typeof fpBhk === 'string') ? extractBhkDeterministic(fpBhk) : safeNumber(fpBhk)
  const bedroomsFromPlan = Array.isArray(fpRooms) ? fpRooms.filter(r => /bed\s*room|bedroom|master\s*bed(room)?|kids\s*room/i.test(String(r||''))).length : 0
  const totalBedrooms = safeNumber(bhkFromPlan) || (bedroomsFromPlan > 0 ? bedroomsFromPlan : 0) || safeNumber(bhkFromText) || 0
  // Numeric include/exclude for bedrooms from user text (supports "remove" as synonym)
  const bedroomTarget = extractBedroomTarget(text, totalBedrooms)
  // Respect explicit room mentions: if the user explicitly listed rooms in the description,
  // do NOT expand via BHK. Only expand when rooms could not be extracted from text.
  const hasExplicitRooms = detRooms.length > 0 || parsedRooms.length > 0 || sumRooms.length > 0

  // Tiering by BHK and budget (approx ranges) → economy/premium/luxury
  const BUDGET_TABLE = {
    1: { economy: [300000, 400000], premium: [600000, 700000], luxury: [800000, 1200000] },
    2: { economy: [400000, 600000], premium: [700000, 900000], luxury: [1000000, 1200000] },
    3: { economy: [600000, 800000], premium: [900000, 1200000], luxury: [1400000, 1800000] },
    4: { economy: [900000, 1200000], premium: [1400000, 1800000], luxury: [2000000, 2500000] }
  }
  const pickTier = (nbhk, totalBudget) => {
    const b = Math.max(1, Math.min(4, Number(nbhk||0) || 1))
    const tbl = BUDGET_TABLE[b]
    const n = Number(totalBudget||0)
    if (n > 0) {
      if (n >= tbl.luxury[0]) return 'luxury'
      if (n >= tbl.premium[0]) return 'premium'
      return 'economy'
    }
    // No budget → default by size
    return (b >= 3) ? 'premium' : 'economy'
  }
  const tier = pickTier(totalBedrooms || 1, budget)
  const tierMultiplier = (t) => (t === 'luxury' ? 1.9 : (t === 'premium' ? 1.4 : 1.0))
  const __tierFactor = tierMultiplier(tier)

  // Ensure bedroom is in rooms list if we have BHK or if it's a residential property
  const hasBedroomInRooms = rooms.some(r => /bedroom/.test(String(r).toLowerCase()))
  
  if (totalBedrooms > 0) {
    // Do not expand rooms if the user explicitly specified rooms in text
    if (!hasExplicitRooms && !__userSpecifiedRooms) {
      rooms = mergeRooms(rooms, ['living','kitchen','bathroom','bedroom'])
    } else if (!__userSpecifiedRooms) {
      // Even with explicit rooms from other detectors, ensure a minimal set when BHK is known
      const need = []
      if (!rooms.includes('living')) need.push('living')
      if (!hasBedroomInRooms && !rooms.includes('bedroom')) need.push('bedroom')
      // Do not force kitchen/bathroom here; we already handle missing bathroom below
      if (need.length) rooms = mergeRooms(rooms, need)
    }
  } else if (!hasBedroomInRooms && !__userSpecifiedRooms) {
    // No BHK detected but we have other rooms - likely a residential property
    // Add bedroom if we have living/kitchen (residential indicators)
    if (rooms.includes('living') || rooms.includes('kitchen')) {
      // Default to 2 bedrooms for residential properties without BHK info
      rooms = mergeRooms(rooms, ['bedroom'])
    }
  }

  // Heuristic: add bathroom only when the user did NOT explicitly specify rooms
  if (!__userSpecifiedRooms) {
    if (!rooms.includes('bathroom') && (rooms.includes('bedroom') || rooms.includes('kitchen'))) {
      rooms = mergeRooms(rooms, ['bathroom'])
    }
  }

  // Enforce exclusions once more after bathroom safety
  try {
    if (__excludedRooms.length) rooms = rooms.filter(r => !__excludedRooms.includes(r))
  } catch {}

  // Notify UI which rooms will be processed (finalized set)
  try { if (onProgress) onProgress({ stage: 'rooms', rooms: [...rooms] }) } catch {}

  // --- Deterministic command helpers ---
  const TYPE_ALIASES = {
    'tv unit': 'tv_bench', 'tv bench': 'tv_bench', 'tv table': 'tv_bench', 'tv stand': 'tv_bench',
    'coffee table': 'table', 'side table': 'table', 'bedside table': 'table', 'dining table': 'table',
    'sofa bed': 'sofa_bed'
  }
  const normalizeType = (raw) => {
    const r = String(raw||'').toLowerCase().trim()
    if (TYPE_ALIASES[r]) return TYPE_ALIASES[r]
    return r.replace(/\s+/g, '_')
  }
  const inferSubtype = (raw) => {
    const s = String(raw||'').toLowerCase()
    const m = /(coffee|side|bedside|dining)/.exec(s)
    return m ? m[1] : null
  }
  const inferRoomForType = (t) => {
    switch (t) {
      case 'sofa':
      case 'tv_bench':
      case 'table': return 'living'
      case 'bed':
      case 'wardrobe':
      case 'mirror': return 'bedroom'
      case 'washstand': return 'bathroom'
      case 'bookcase': return rooms.includes('study') ? 'study' : 'living'
      case 'cabinet': return rooms.includes('kitchen') ? 'kitchen' : 'living'
      case 'shelf': return rooms.includes('kitchen') ? 'kitchen' : 'living'
      case 'lamp': return rooms.includes('living') ? 'living' : (rooms[0] || 'living')
      default: return rooms[0] || 'living'
    }
  }
  const linesFromSelections = (selections) => {
    if (!Array.isArray(selections)) return []
    return selections.map(s => {
      const line = { ...(s?.line || {}) }
      line.quantity = Math.max(1, Number(line.quantity || 1))
      // Pin to previous chosen item so non-targeted lines don't churn
      const prevItemId = s?.item?.id
      if (Number.isFinite(prevItemId)) line.preferredId = prevItemId
      // Carry over previous item text so we can make BHK-aware decisions later
      const prevTxt = `${s?.item?.item_name||''} ${s?.item?.item_description||''} ${s?.item?.item_details||''} ${s?.item?.variation_name||''}`.trim()
      if (prevTxt) line.__prevItemText = prevTxt
      return line
    })
  }
  const applyDeterministicCommands = (txt, baseLines) => {
    const lower = String(txt||'').toLowerCase()
    const out = Array.isArray(baseLines) ? baseLines.map(l => ({ ...l })) : []
    
    console.log('[Deterministic Commands] Called with text:', txt.substring(0, 100))
    console.log('[Deterministic Commands] Input items:', out.length, 'items')
    
    // Enhanced findIdx to support room-specific targeting
    const findIdx = (t, sub=null, targetRoom=null) => {
      return out.findIndex(it => {
        const typeMatch = String(it.type||'').toLowerCase()===t
        const subMatch = !sub || String(it?.specifications?.subtype||'')===sub
        const roomMatch = !targetRoom || String(it.room||'').toLowerCase().includes(targetRoom)
        return typeMatch && subMatch && roomMatch
      })
    }
    const ensureSpecs = (l) => { l.specifications = { ...(l.specifications||{}) }; return l }
    
    // Extract room target from command (e.g., "bedroom 2", "master bedroom")
    const extractRoomTarget = (txt) => {
      const t = String(txt||'').toLowerCase()
      // Match patterns like "bedroom 2", "bedroom 1", "master bedroom", "guest bedroom"
      let m = t.match(/\b(master|guest|kids?)\s+bedroom\b/)
      if (m) return m[0]
      m = t.match(/\bbedroom\s+(\d+)\b/)
      if (m) return `bedroom ${m[1]}`
      return null
    }
    const roomTarget = extractRoomTarget(txt)

    // replace <type> with id <id>
    let m
    m = lower.match(/\breplace\s+([a-z_\- ]+?)\s+with\s+id\s+(\d+)\b/)
    if (m) {
      const typeRaw = m[1]; const id = Number(m[2])
      let sub = inferSubtype(typeRaw)
      // Disambiguate tables by context if subtype wasn't explicit
      if (!sub && /\btable\b/.test(typeRaw)) {
        if (lower.includes('dining')) sub = 'dining'
        else if (lower.includes('coffee')) sub = 'coffee'
        else if (lower.includes('bedside')) sub = 'bedside'
        else if (lower.includes('side')) sub = 'side'
      }
      const t = normalizeType(typeRaw)
      const idx = findIdx(t, sub)
      if (idx >= 0 && Number.isFinite(id)) { out[idx] = ensureSpecs({ ...out[idx], preferredId: id }) }
      return out
    }
    // remove bedroom <n> | remove master bedroom | remove <type> from bedroom <n>
    // Handle room-specific removal first (supports "remove", "removing", "delete", etc.)
    if (/\b(remove|removing|delete|deleting|drop|dropping)\s+(the\s+)?(master|guest|kids?)\s+bedroom\b/.test(lower)) {
      const m = lower.match(/\b(remove|removing|delete|deleting|drop|dropping)\s+(the\s+)?(master|guest|kids?)\s+bedroom\b/)
      const bedroomType = m[3] // 'master', 'guest', or 'kids'
      console.log('[Deterministic Command] Removing bedroom type:', bedroomType, 'from', out.length, 'items')
      // Remove all items from bedrooms that start with this type
      let removedCount = 0
      for (let i = out.length - 1; i >= 0; i--) {
        const roomLower = String(out[i].room||'').toLowerCase()
        // Match "guest bedroom", "guest bedroom 1", "guest bedroom 2", etc.
        if (roomLower.startsWith(`${bedroomType} bedroom`)) {
          console.log('[Deterministic Command] Removing item:', out[i].type, 'from room:', out[i].room)
          out.splice(i, 1)
          removedCount++
        }
      }
      console.log('[Deterministic Command] Removed', removedCount, 'items. Remaining:', out.length)
      return out
    }
    if (/\b(remove|removing|delete|deleting)\s+(the\s+)?bedroom\s+(\d+)\b/.test(lower)) {
      const m = lower.match(/\b(remove|removing|delete|deleting)\s+(the\s+)?bedroom\s+(\d+)\b/)
      const roomName = `bedroom ${m[3]}`
      // Remove all items from this specific bedroom
      for (let i = out.length - 1; i >= 0; i--) {
        if (String(out[i].room||'').toLowerCase() === roomName) {
          out.splice(i, 1)
        }
      }
      return out
    }
    
    // remove <n> <type> | remove <type> [from bedroom <n>]
    m = lower.match(/\bremove\s+(?:([0-9]+)\s+)?([a-z_\- ]+)\b/)
    if (m) {
      const qty = m[1] ? Math.max(1, parseInt(m[1],10)||1) : null
      const typeRaw = m[2]
      let sub = inferSubtype(typeRaw)
      if (!sub && /\btable\b/.test(typeRaw)) {
        if (lower.includes('dining')) sub = 'dining'
        else if (lower.includes('coffee')) sub = 'coffee'
        else if (lower.includes('bedside')) sub = 'bedside'
        else if (lower.includes('side')) sub = 'side'
      }
      const t = normalizeType(typeRaw)
      const idx = findIdx(t, sub, roomTarget)
      if (idx >= 0) {
        if (qty && Number(out[idx].quantity||1) > qty) out[idx].quantity = Number(out[idx].quantity||1) - qty
        else out.splice(idx,1)
      }
      return out
    }
    // set/make qty
    m = lower.match(/\b(?:set|make)\s+([a-z_\- ]+?)\s+(?:qty|quantity|count)\s*(?:to\s*)?(\d+)\b/)
    if (m) {
      const typeRaw = m[1]; const n = Math.max(1, parseInt(m[2],10)||1)
      let sub = inferSubtype(typeRaw)
      if (!sub && /\btable\b/.test(typeRaw)) {
        if (lower.includes('dining')) sub = 'dining'
        else if (lower.includes('coffee')) sub = 'coffee'
        else if (lower.includes('bedside')) sub = 'bedside'
        else if (lower.includes('side')) sub = 'side'
      }
      const t = normalizeType(typeRaw)
      const idx = findIdx(t, sub)
      if (idx >= 0) out[idx].quantity = n
      return out
    }
    // increase/decrease qty
    m = lower.match(/\b(?:increase|add)\s+([a-z_\- ]+?)\s+(?:qty|quantity|count)?\s*(?:by\s*)?(\d+)\b/)
    if (m) {
      const typeRaw = m[1]; const n = Math.max(1, parseInt(m[2],10)||1)
      let sub = inferSubtype(typeRaw)
      if (!sub && /\btable\b/.test(typeRaw)) {
        if (lower.includes('dining')) sub = 'dining'
        else if (lower.includes('coffee')) sub = 'coffee'
        else if (lower.includes('bedside')) sub = 'bedside'
        else if (lower.includes('side')) sub = 'side'
      }
      const t = normalizeType(typeRaw)
      const idx = findIdx(t, sub); if (idx >= 0) out[idx].quantity = Math.max(1, Number(out[idx].quantity||1)+n)
      return out
    }
    m = lower.match(/\b(?:decrease|reduce)\s+([a-z_\- ]+?)\s+(?:qty|quantity|count)?\s*(?:by\s*)?(\d+)\b/)
    if (m) {
      const typeRaw = m[1]; const n = Math.max(1, parseInt(m[2],10)||1)
      let sub = inferSubtype(typeRaw)
      if (!sub && /\btable\b/.test(typeRaw)) {
        if (lower.includes('dining')) sub = 'dining'
        else if (lower.includes('coffee')) sub = 'coffee'
        else if (lower.includes('bedside')) sub = 'bedside'
        else if (lower.includes('side')) sub = 'side'
      }
      const t = normalizeType(typeRaw)
      const idx = findIdx(t, sub); if (idx >= 0) out[idx].quantity = Math.max(1, Number(out[idx].quantity||1)-n)
      return out
    }
    // add <n> <type> | add <type>
    // also support: add <type> with id <id>
    let mAddId = lower.match(/\badd\s+([a-z_\- ]+?)\s+with\s+id\s+(\d+)\b/)
    if (mAddId) {
      const typeRaw = mAddId[1]
      const id = Number(mAddId[2])
      let sub = inferSubtype(typeRaw)
      if (!sub && /\btable\b/.test(typeRaw)) {
        if (lower.includes('dining')) sub = 'dining'
        else if (lower.includes('coffee')) sub = 'coffee'
        else if (lower.includes('bedside')) sub = 'bedside'
        else if (lower.includes('side')) sub = 'side'
      }
      const t = normalizeType(typeRaw)
      const room = inferRoomForType(t)
      const specs = sub ? { subtype: sub } : {}
      const line = { type: t, quantity: 1, specifications: specs, room, preferredId: Number.isFinite(id) ? id : undefined }
      out.push(line)
      return out
    }
    m = lower.match(/\badd\s+(?:([0-9]+)\s+)?([a-z_\- ]+?)\b/)
    if (m) {
      const n = m[1] ? Math.max(1, parseInt(m[1],10)||1) : 1
      const typeRaw = m[2]
      let sub = inferSubtype(typeRaw)
      if (!sub && /\btable\b/.test(typeRaw)) {
        if (lower.includes('dining')) sub = 'dining'
        else if (lower.includes('coffee')) sub = 'coffee'
        else if (lower.includes('bedside')) sub = 'bedside'
        else if (lower.includes('side')) sub = 'side'
      }
      const t = normalizeType(typeRaw)
      const idx = findIdx(t, sub)
      if (idx >= 0) out[idx].quantity = Math.max(1, Number(out[idx].quantity||1) + n)
      else {
        const room = inferRoomForType(t)
        const specs = sub ? { subtype: sub } : {}
        out.push({ type: t, quantity: n, specifications: specs, room })
      }
      return out
    }
    return out
  }

  // 5) Requested lines initialization
  // If the user explicitly switched style (single or multi) this turn, avoid carrying over prior selections
  let requested = []
  try {
    const styleChanged = Boolean(styleOverride) || (Array.isArray(multiStyles) && multiStyles.length > 0)
    // Mark a fresh style run to slightly relax caps and skip min-seat heuristic once
    var freshStyleRun = styleChanged
    if (styleChanged) {
      // Keep the same structure derived from floorplan/description (types/qty/rooms)
      // but drop item pinning so we re-select items according to the new styles.
      const prev = linesFromSelections(prior?.selections)
      requested = prev.map(l => {
        const { preferredId, __prevItemText, ...rest } = l
        // Remove any lingering per-line caps or heuristics from previous run
        const cleaned = { ...rest }
        delete cleaned._maxPrice
        delete cleaned._minSeats
        delete cleaned._bhk
        delete cleaned._features
        // Also drop any other private fields prefixed with '_'
        for (const k of Object.keys(cleaned)) {
          if (k.startsWith('_')) delete cleaned[k]
        }
        return cleaned
      })
    } else {
      // No style change → carry over with pinning to reduce churn
      requested = linesFromSelections(prior?.selections)
    }
  } catch {}
  requested = applyDeterministicCommands(text, requested)
  // If the user explicitly specified rooms this turn, drop any carried-over lines outside those rooms
  try {
    if (__userSpecifiedRooms && Array.isArray(requested)) {
      requested = requested.filter(l => {
        const rm = String(l?.room || '').toLowerCase()
        if (__excludedRooms.includes(rm)) return false
        return rooms.includes(rm)
      })
    }
  } catch {}

  // Helper: apply BHK-based price caps to requested lines
  const applyBhkPriceCaps = (nb, { skipMinSeat = false } = {}) => {
    const cap = (lo, mid, hi) => (nb <= 2 ? lo : (nb === 3 ? mid : hi))
    // Compute living width from floor plan dims if available
    let livingWidthFt = null
    try {
      const dim = (fpRoomDims || []).find(d => String(d?.room||'').toLowerCase() === 'living')
      if (dim) {
        const w = Number(dim.width || 0)
        const h = Number(dim.height || 0)
        const unit = String(dim.unit || 'ft').toLowerCase()
        const toFt = (x) => unit === 'm' ? (x * 3.28084) : x
        livingWidthFt = Math.max(toFt(w), toFt(h)) // use larger side as width proxy
      }
    } catch {}
    for (const line of (requested || [])) {
      // Attach BHK so selectors can make size-aware choices (e.g., sofa seaters)
      line._bhk = nb
      const t = String(line?.type || '').toLowerCase()
      const sub = String(line?.specifications?.subtype || '').toLowerCase()
      // If living room is wide, enforce a minimum seater requirement on sofas (skip on fresh style run)
      if (!skipMinSeat && t === 'sofa' && String(line?.room||'').toLowerCase() === 'living' && livingWidthFt) {
        let minByWidth = 0
        if (livingWidthFt >= 14) minByWidth = 5
        else if (livingWidthFt >= 12) minByWidth = 4
        else if (livingWidthFt >= 10) minByWidth = 3
        if (minByWidth > 0) line._minSeats = Math.max(Number(line._minSeats||0), minByWidth)
      }
      // If prior pinned a too-small sofa for high BHK, unpin to allow upgrade
      if (t === 'sofa' && nb >= 3 && line.preferredId) {
        const txt = String(line.__prevItemText || '').toLowerCase()
        const seatsMatch = txt.match(/(\d+)\s*(?:-?\s*seat(?:er)?|\s*seater)/) || txt.match(/(\d+)\s*-?\s*seat/)
        const seats = seatsMatch && seatsMatch[1] ? Number(seatsMatch[1]) : null
        if (seats != null && seats < 4) {
          delete line.preferredId
        }
      }
      // Sofa
      if (t === 'sofa') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(35000, 55000, 80000) * __tierFactor))
      // TV bench
      else if (t === 'tv_bench') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(15000, 22000, 30000) * __tierFactor))
      // Tables by subtype
      else if (t === 'table') {
        if (sub === 'coffee') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(8000, 12000, 18000) * __tierFactor))
        else if (sub === 'side' || sub === 'bedside') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(5000, 8000, 12000) * __tierFactor))
        else if (sub === 'dining') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(25000, 40000, 60000) * __tierFactor))
      }
      // Bed / Wardrobe
      else if (t === 'bed') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(30000, 45000, 70000) * __tierFactor))
      else if (t === 'wardrobe') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(30000, 50000, 80000) * __tierFactor))
      // Chairs
      else if (t === 'chair') {
        const roomName = String(line?.room || '').toLowerCase()
        if (roomName === 'dining') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(5000, 8000, 12000) * __tierFactor))
        else line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(7000, 12000, 18000) * __tierFactor))
      }
      // Mirror / Shelf / Cabinet / Bookcase / Lamp
      else if (t === 'mirror') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(3000, 5000, 8000) * __tierFactor))
      else if (t === 'shelf') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(6000, 9000, 14000) * __tierFactor))
      else if (t === 'cabinet') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(12000, 18000, 28000) * __tierFactor))
      else if (t === 'bookcase') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(10000, 15000, 22000) * __tierFactor))
      else if (t === 'lamp') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(2500, 4000, 7000) * __tierFactor))
      else if (t === 'washstand') line._maxPrice = Math.max(Number(line._maxPrice || 0), Math.round(cap(9000, 14000, 22000) * __tierFactor))
    }
  }

  // If no rooms and no command-driven requested lines, return silent summary
  const llmSummary = (() => {
    const base = {
      summary: sumRich?.overview || null,
      rooms,
      areaSqft: areaSqft || sumSqft || null,
      theme: theme || sumTheme || null,
      bhk: safeNumber(sumBhk) || null,
      tier,
      budget: budget ? { scope: 'total', amount: budget } : (sumRich?.budget?.amount ? { scope: String(sumRich?.budget?.scope||'total'), amount: Number(sumRich.budget.amount) } : null),
      constraints: Array.isArray(sumRich?.constraints) ? sumRich.constraints : [],
      priorities: Array.isArray(sumRich?.priorities) ? sumRich.priorities : [],
      mustHaveItems: Array.isArray(sumRich?.mustHaveItems) ? sumRich.mustHaveItems : [],
      niceToHaveItems: Array.isArray(sumRich?.niceToHaveItems) ? sumRich.niceToHaveItems : [],
      itemsSuggested: Array.isArray(sumRich?.itemsSuggested) ? sumRich.itemsSuggested : []
    }
    // Attach roomDimensions from floor plan if available
    if (Array.isArray(fpRoomDims) && fpRoomDims.length > 0) {
      // Ensure we have an entry for every detected room
      const dimMap = new Map(fpRoomDims.map(d => [String(d?.room||'').toLowerCase(), d]))
      for (const r of rooms) {
        const key = String(r).toLowerCase()
        if (!dimMap.has(key)) {
          dimMap.set(key, { room: key, width: null, height: null, unit: null, notes: 'not legible from plan' })
        }
      }
      base.roomDimensions = Array.from(dimMap.values())
    }
    return base
  })()
  if (onProgress) try { onProgress({ stage: 'llmSummary', llmSummary }) } catch {}
  if (!rooms.length && requested.length === 0) {
    return { message: '', items: [], totalEstimate: 0, selections: [], filters: {}, llmSummary }
  }

  // 5) Essentials
  // 5b) Heuristic: extract specific requested items from free text (sofa set, tv unit, queen bed, library unit)
  if (requested.length === 0) {
    try {
      const heur = extractRequestedFromText(text, rooms)
      if (heur.length > 0) requested = heur
    } catch {}
  }
  if (requested.length === 0 && USE_LLM_ESSENTIALS) {
    try {
      // Derive a compact rules hint from DB (based on BHK and area) to ground the LLM
      let rulesHint = null
      try {
        rulesHint = await deriveRuleFor({ propertyType: 'apartment', bhk: fpBhk || null, sqft: areaSqft || null })
      } catch {}
      const prop = await proposeEssentialsJSON({
        rooms,
        excludedRooms: Array.isArray(__excludedRooms) ? __excludedRooms : [],
        sqft: areaSqft || null,
        bhk: fpBhk || null,
        budget: budget || null,
        styleProfile: styleProfile || null,
        styleBias: Array.isArray(styleBias) ? styleBias : [],
        rulesHint
      })
      if (prop) requested = essentialsToRequested(prop)
    } catch (_) {}
    // Apply price caps to LLM-essential-produced lists
    try { const nb = safeNumber(bhkFromPlan) || safeNumber(bhkFromText) || 0; if (nb) applyBhkPriceCaps(nb, { skipMinSeat: Boolean(freshStyleRun) }) } catch {}
  }
  // Re-apply deterministic commands after essentials/baseline so removals like "remove 1 bedroom" always take effect
  try { requested = applyDeterministicCommands(text, requested) } catch {}
  if (onProgress) try { onProgress({ stage: 'essentials', requested: requested.slice(0, 10) }) } catch {}
  // Deterministic minimal fallback if LLM essentials were empty
  if (!Array.isArray(requested) || requested.length === 0) {
    // If bedroom is in rooms but totalBedrooms is 0, default to 2 bedrooms
    let numBedrooms = (bedroomTarget != null ? bedroomTarget : totalBedrooms) || 0
    if (numBedrooms === 0 && rooms.includes('bedroom')) {
      numBedrooms = 2 // Default to 2 bedrooms for residential properties
    }
    const hasDining = rooms.includes('dining')
    const diningChairQty = (nb) => (nb <= 2 ? 4 : (nb === 3 ? 6 : 8))
    const sofaMaxPrice = (nb) => (nb <= 2 ? 25000 : (nb === 3 ? 40000 : 50000))
    const baseline = (room) => {
      switch (room) {
        case 'living':
          return [
            // Boost sofa budget based on BHK size
            { type: 'sofa', quantity: 1, specifications: {}, room: 'living', _maxPrice: sofaMaxPrice(numBedrooms) },
            { type: 'tv_bench', quantity: 1, specifications: {}, room: 'living' },
            { type: 'table', quantity: 1, specifications: { subtype: 'coffee' }, room: 'living' },
            { type: 'lamp', quantity: 1, specifications: {}, room: 'living' }
          ]
        case 'bedroom':
          // Don't return bedroom items here - they'll be created individually below
          return []
        case 'kitchen':
          return [
            // Only add dining table under kitchen when there is no dedicated dining room
            ...(!hasDining ? [{ type: 'table', quantity: 1, specifications: { subtype: 'dining' }, room: 'kitchen' }] : []),
            { type: 'shelf', quantity: 1, specifications: {}, room: 'kitchen' }
          ]
        case 'bathroom':
          return [
            { type: 'washstand', quantity: 1, specifications: {}, room: 'bathroom' },
            { type: 'mirror', quantity: 1, specifications: {}, room: 'bathroom' }
          ]
        case 'dining':
          return [
            { type: 'table', quantity: 1, specifications: { subtype: 'dining' }, room: 'dining' }
          ]
        case 'balcony':
          return [
            { type: 'chair', quantity: 2, specifications: {}, room: 'balcony' },
            { type: 'table', quantity: 1, specifications: { subtype: 'side' }, room: 'balcony' }
          ]
        case 'utility':
          return [
            { type: 'shelf', quantity: 1, specifications: {}, room: 'utility' },
            { type: 'cabinet', quantity: 1, specifications: {}, room: 'utility' }
          ]
        default:
          return []
      }
    }
    // Apply caps after baseline assembly
    try { if (numBedrooms) applyBhkPriceCaps(numBedrooms, { skipMinSeat: Boolean(freshStyleRun) }) } catch {}
    
    // Create individual bedroom entries from the start
    const bedroomRooms = []
    // Check if floor plan already has differentiated bedrooms
    const floorPlanBedrooms = rooms.filter(r => /master bedroom|guest bedroom|kids bedroom|bedroom \d+/.test(String(r).toLowerCase()))
    const hasDifferentiatedBedrooms = floorPlanBedrooms.length > 0
    
    if (hasDifferentiatedBedrooms) {
      // Use bedrooms from floor plan
      bedroomRooms.push(...floorPlanBedrooms)
    } else if (numBedrooms > 0 && rooms.includes('bedroom')) {
      // Create individual bedroom entries: bedroom 1, bedroom 2, etc.
      for (let i = 1; i <= Math.min(numBedrooms, 5); i++) {
        const bedroomName = i === 1 ? 'master bedroom' : `bedroom ${i}`
        bedroomRooms.push(bedroomName)
      }
    }
    
    // Process all rooms including individual bedrooms (exclude generic 'bedroom' and specific bedroom names)
    const allRooms = [...rooms.filter(r => {
      const rl = String(r).toLowerCase()
      return rl !== 'bedroom' && !/master bedroom|guest bedroom|kids bedroom|bedroom \d+/.test(rl)
    }), ...bedroomRooms]
    
    for (const r of allRooms) {
      const lines = baseline(r)
      for (const l of lines) {
        let qty = 1
        if (l._qtyByBedrooms) qty = Math.max(1, Number(numBedrooms || 1))
        if (l._qtyFixed) qty = l._qtyFixed
        const spec = { ...(l.specifications || {}) }
        if (l._features) spec.features = { ...(spec.features || {}), ...(l._features || {}) }
        requested.push({ type: l.type, quantity: qty, specifications: spec, room: l.room || r })
      }
    }
    
    // Add bedroom essentials for each individual bedroom
    for (const bedroomName of bedroomRooms) {
      requested.push(
        { type: 'bed', quantity: 1, specifications: {}, room: bedroomName },
        { type: 'wardrobe', quantity: 1, specifications: {}, room: bedroomName },
        { type: 'table', quantity: 1, specifications: { subtype: 'bedside' }, room: bedroomName },
        { type: 'mirror', quantity: 1, specifications: {}, room: bedroomName }
      )
    }
    // Bedroom essentials are now created individually above, no need for this block
    // Individual bedrooms already created above if needed
  }

  // Re-apply deterministic commands after minimal fallback as well
  try { requested = applyDeterministicCommands(text, requested) } catch {}
  // No need to expand bedrooms - they're already individual entries
  // 6) Select items per requested line
  const baseCapRaw = (areaSqft && areaSqft > 0) ? (areaSqft < 800 ? 15000 : areaSqft < 1400 ? 20000 : 30000) : 20000
  const baseCap = Boolean(freshStyleRun) ? Math.round(baseCapRaw * 1.2) : baseCapRaw
  // Debug note to confirm relaxed caps used on a fresh style run
  if (Boolean(freshStyleRun)) {
    try {
      const stylesList = Array.isArray(multiStyles) && multiStyles.length ? multiStyles.map(s => s.name) : (styleOverride ? [styleOverride] : [])
      console.log('[style-applied]', {
        freshStyleRun: true,
        styles: stylesList,
        baseCapRaw,
        baseCap,
        skipMinSeat: true,
        styleWeightsCount: Array.isArray(styleWeights) ? styleWeights.length : 0
      })
    } catch (_) {}
  }
  const appliedStyles = (Array.isArray(multiStyles) && multiStyles.length)
    ? multiStyles.map(s => s.name)
    : (styleOverride ? [styleOverride] : [])
  // Build prev-item-id map by line key type|subtype to help diversify on style change
  let prevItemIdByKey = {}
  try {
    if (freshStyleRun && Array.isArray(prior?.selections)) {
      for (const s of prior.selections) {
        const t = String(s?.line?.type || '').toLowerCase()
        const sub = String(s?.line?.specifications?.subtype || '').toLowerCase()
        const key = `${t}|${sub}`
        const id = Number(s?.item?.id || 0)
        if (id) prevItemIdByKey[key] = id
      }
    }
  } catch {}
  // Property context for rule-based selection
  const propertyContext = {
    propertyType: fpPropertyType || 'apartment',
    bhk: fpBhk || bhkFromText || null,
    sqft: areaSqft || null,
    budget: budget || null
  }
  const filters = { maxPrice: baseCap, styleBias: styleWeights, styleNegatives, styleApplied: Boolean(freshStyleRun), appliedStyles, diversifyOnStyleChange: Boolean(freshStyleRun), prevItemIdByKey, propertyContext }
  const used = new Set()
  const results = await Promise.allSettled((requested || []).map(line => {
    const rm = String(line?.room || '').toLowerCase()
    const roomHints = roomHintsMap.get(rm) || []
    return aiInstance.findBestItem(line, { ...filters, roomHints }, used)
  }))
  let selections = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled' && r.value && r.value.item) {
      selections.push({ line: requested[i], item: r.value.item, reason: r.value.reason })
    }
  }

  // Final safety: if user specified rooms/exclusions, keep only selections for allowed rooms
  try {
    if (__userSpecifiedRooms && Array.isArray(selections)) {
      selections = selections.filter(s => {
        const rm = String(s?.line?.room || '').toLowerCase()
        if (__excludedRooms.includes(rm)) return false
        return rooms.includes(rm)
      })
    }
  } catch {}

  // 7) Assemble items and totals
  const items = selections.map(sel => {
    const q = Math.max(1, Number(sel.line?.quantity || 1))
    const unit = Number(sel.item?.price_inr || 0)
    return { ...sel.item, quantity: q, line_total_inr: q * unit, line_type: sel.line?.type || null, room: sel.line?.room || null }
  })
  const totalEstimate = items.reduce((s, it) => s + (it.line_total_inr || 0), 0)

  // 8) Generate images for items missing visuals using description only (optional)
  if (USE_IMAGE_SEARCH) {
    try {
      const themeForGen = llmSummary?.theme || ''
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const hasImg = Boolean(it?.image_url || it?.image || it?.image_url_small)
        if (hasImg) continue
        const url = await generateItemImage({
          name: String(it?.item_name || it?.variation_name || it?.category || 'furniture'),
          description: String(it?.item_description || it?.item_details || ''),
          room: String(it?.room || ''),
          theme: String(themeForGen || ''),
          type: String(it?.line_type || ''),
          subtype: String((selections[i]?.line?.specifications?.subtype) || items[i]?.subcategory || '')
        })
        if (url) {
          items[i] = { ...items[i], image_url: url }
          if (onProgress) try { onProgress({ stage: 'img_gen', index: i, itemId: items[i].id, imageUrl: url }) } catch {}
        }
      }
    } catch (_) {}
  }

  return {
    message: '',
    items,
    totalEstimate,
    selections,
    filters: { ...filters, roomHints: undefined },
    llmSummary,
    styleProfile,
  }
}
