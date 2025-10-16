// Rich LLM Summarizer: produces a strict JSON summary per RichSummary schema
// Uses OpenAI Chat Completions with response_format: json_object

function clampInt(n, lo, hi) {
  const x = Number(n)
  if (!Number.isFinite(x)) return null
  return Math.max(lo, Math.min(hi, Math.round(x)))
}

const ALLOWED_ROOMS = new Set(['living','bedroom','kitchen','bathroom','dining','foyer','study','balcony','utility','toilet'])

function normalizeSummary(obj) {
  if (!obj || typeof obj !== 'object') return null
  const out = {}
  out.overview = typeof obj.overview === 'string' && obj.overview.trim() ? obj.overview.trim() : ''
  const bhkNum = clampInt(obj.bhk, 1, 10)
  out.bhk = bhkNum || null
  const sqftNum = Number(obj.sqft)
  out.sqft = Number.isFinite(sqftNum) ? sqftNum : (obj.sqft === null ? null : null)
  out.theme = (obj.theme == null || obj.theme === '') ? null : String(obj.theme)

  const rd = Array.isArray(obj.roomsDetected) ? obj.roomsDetected : []
  out.roomsDetected = rd
    .map(r => ({ room: String(r?.room || '').toLowerCase(), notes: r?.notes ? String(r.notes) : undefined }))
    .filter(r => ALLOWED_ROOMS.has(r.room))

  if (obj.budget && typeof obj.budget === 'object') {
    const scope = String(obj.budget.scope || '').toLowerCase()
    const amount = obj.budget.amount != null ? Number(obj.budget.amount) : undefined
    const perRoom = obj.budget.perRoom && typeof obj.budget.perRoom === 'object' ? obj.budget.perRoom : undefined
    out.budget = { scope }
    if (Number.isFinite(amount)) out.budget.amount = amount
    if (perRoom) out.budget.perRoom = perRoom
  } else {
    out.budget = null
  }

  const arrStr = v => Array.isArray(v) ? v.map(s => String(s)).filter(Boolean) : []
  out.constraints = arrStr(obj.constraints)
  out.priorities = arrStr(obj.priorities)

  const normItems = (list) => {
    if (!Array.isArray(list)) return []
    return list.map(it => {
      const room = it?.room ? String(it.room).toLowerCase() : undefined
      const o = {
        type: String(it?.type || '').toLowerCase(),
        subtype: it?.subtype ? String(it.subtype).toLowerCase() : undefined,
        room: room && ALLOWED_ROOMS.has(room) ? room : undefined,
        quantity: Number.isFinite(Number(it?.quantity)) ? Math.max(1, Number(it.quantity)) : undefined,
        mustHave: it?.mustHave === true,
        rationale: it?.rationale ? String(it.rationale) : undefined,
        maxPriceInr: Number.isFinite(Number(it?.maxPriceInr)) ? Number(it.maxPriceInr) : undefined
      }
      return o
    })
  }
  out.mustHaveItems = normItems(obj.mustHaveItems)
  out.niceToHaveItems = normItems(obj.niceToHaveItems)
  out.itemsSuggested = normItems(obj.itemsSuggested)
  out.notes = arrStr(obj.notes)
  if (obj.risksAndAssumptions && typeof obj.risksAndAssumptions === 'object') {
    out.risksAndAssumptions = {
      assumptions: arrStr(obj.risksAndAssumptions.assumptions),
      risks: arrStr(obj.risksAndAssumptions.risks)
    }
  } else {
    out.risksAndAssumptions = { assumptions: [], risks: [] }
  }
  out.citations = arrStr(obj.citations)
  // minimal required fields
  if (!out.overview) out.overview = ''
  if (!Array.isArray(out.roomsDetected)) out.roomsDetected = []
  return out
}

function isValidSummary(obj) {
  try {
    if (!obj || typeof obj !== 'object') return false
    if (typeof obj.overview !== 'string') return false
    if (!Array.isArray(obj.roomsDetected)) return false
    for (const r of obj.roomsDetected) {
      if (!r || typeof r !== 'object') return false
      if (!ALLOWED_ROOMS.has(String(r.room))) return false
    }
    return true
  } catch {
    return false
  }
}

export async function summarizeToJSON(
  text,
  {
    mode = 'chat',
    planRooms = [],
    planBhk = null,
    planSqft = null,
    parsedJSON = null,
    previousSummary = null
  } = {}
) {
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY
  const USE = String(import.meta.env.VITE_USE_LLM_SUMMARIZER || 'true').toLowerCase() === 'true'
  if (!USE || !apiKey) return null

  const system = `You are an interior design assistant. Output STRICT JSON only matching the provided JSON schema. Do not include markdown.`
  const schemaHint = `JSON schema fields: overview (string), bhk (int|null), sqft (number|null), theme (string|null), roomsDetected (array of {room,notes?}), budget {scope, amount?, perRoom?}|null, constraints[], priorities[], mustHaveItems[], niceToHaveItems[], itemsSuggested[], notes[], risksAndAssumptions {assumptions[], risks[]}, citations[].`

  const USER_TEXT = String(text || '').slice(0, 8000)
  const PLAN_ROOMS_JSON = JSON.stringify(Array.isArray(planRooms) ? planRooms : [])
  const PLAN_BHK_RAW = planBhk == null ? null : planBhk
  const PLAN_SQFT = planSqft == null ? null : planSqft
  const PARSED_JSON = parsedJSON ? JSON.stringify(parsedJSON) : null
  const PREV_SUMMARY_JSON = previousSummary ? JSON.stringify(previousSummary) : null

  const dev = `Rules:\n- Use only canonical room names: living, bedroom, kitchen, bathroom, dining, foyer, study, balcony, utility, toilet.\n- If BHK is ambiguous, infer conservatively from plan rooms (count bedrooms) or user text; else omit.\n- Suggest items with type and subtype (tables: dining/coffee/side/bedside). Chairs should be contextual (dining vs armchair).\n- Keep quantities modest; the orchestration layer may adjust later.\n- Provide concise overview and meaningful constraints/priorities.`

  const userPayload = {
    user_text: USER_TEXT,
    plan_rooms: JSON.parse(PLAN_ROOMS_JSON || '[]'),
    plan_bhk: PLAN_BHK_RAW,
    plan_sqft: PLAN_SQFT,
    parsed: PARSED_JSON ? JSON.parse(PARSED_JSON) : null,
    previous_summary: PREV_SUMMARY_JSON ? JSON.parse(PREV_SUMMARY_JSON) : null
  }

  const messages = [
    { role: 'system', content: system },
    { role: 'developer', content: `${schemaHint}\n${dev}` },
    { role: 'user', content: JSON.stringify(userPayload) }
  ]

  const callLLM = async () => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', response_format: { type: 'json_object' }, messages })
    })
    if (!res.ok) throw new Error(`summarizeToJSON HTTP ${res.status}`)
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content || '{}'
    return JSON.parse(content)
  }

  // Try up to 3 attempts with light guidance on failure
  let attempt = 0
  while (attempt < 3) {
    try {
      const raw = await callLLM()
      const norm = normalizeSummary(raw)
      if (isValidSummary(norm)) return norm
      // Provide feedback and retry once
      messages.push({ role: 'system', content: 'Your previous output did not conform to schema. Return STRICT JSON matching the schema with valid room names only.' })
    } catch (e) {
      console.warn('[summarizerLLM] attempt failed', e?.message || e)
      messages.push({ role: 'system', content: 'Previous request failed. Return STRICT JSON only; keep it concise and schema-compliant.' })
    }
    attempt++
  }
  return null
}
