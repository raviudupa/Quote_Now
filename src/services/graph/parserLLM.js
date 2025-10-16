// LLM-based parser (schema-constrained) with safe fallback at callsite
// This module ONLY parses user text into structured JSON. It does NOT select items.

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY
const USE_LLM_PARSER = String(import.meta.env.VITE_USE_LLM_PARSER || '').toLowerCase() === 'true'

const SYSTEM_PROMPT = `You are a strict JSON parser for interior design quotations.
- Output ONLY valid JSON.
- Do NOT invent product names or prices.
- Map free text into the provided fields. If unknown, use null.
- Recognize room names and synonyms, including: living (lounge, hall), bedroom (master, guest), bathroom (toilet, wc, washroom, restroom), dining, kitchen, foyer (entry, entrance, lobby), study (office), balcony (veranda, patio, terrace), utility (laundry).
- Recognize "only"/"just" qualifiers to indicate exclusive room selection.
- Normalize area to sqft if units are given in m².
- Currency defaults to INR when unspecified.
`

const USER_INSTRUCTIONS = `Return STRICT JSON with this schema:
{
  "rooms": string[],               // e.g., ["living", "dining"]
  "onlyRooms": boolean,            // true if user said ONLY/just these rooms
  "bhk": number|null,              // bedrooms count if specified
  "areaSqft": number|null,         // numeric sqft; convert from m2 to sqft when needed
  "theme": string|null,            // e.g., "modern", "contemporary"
  "budget": { "amount": number, "currency": "INR" } | null,
  "constraints": string[]|null,    // e.g., ["kid-friendly", "pet-friendly"]
  "priorities": string[]|null,     // e.g., ["storage", "low-maintenance"]
  "styleKeywords": string[]|null,  // extracted style descriptors from the text
  "clarificationsNeeded": string[]|null
}

Rules:
- rooms must be lowercase from this list only: ["living","bedroom","kitchen","bathroom","dining","foyer","study","balcony","utility"].
- onlyRooms is true if the user implies exclusive scope (e.g., "only living room", "just the kitchen").
- If neither rooms nor onlyRooms are specified, use [] and false respectively.
- areaSqft must be a number or null. If the user wrote m2/m², convert to sqft via 1 m2 = 10.7639 sqft and round to nearest integer.
- budget.amount must be a number (INR). If the user gave L/Cr, normalize (e.g., 10L => 1000000).
- Output ONLY JSON, no extra text.`

const FEW_SHOTS = [
  { role: 'user', content: 'only living room modern neutral' },
  { role: 'assistant', content: JSON.stringify({ rooms:['living'], onlyRooms:true, bhk:null, areaSqft:null, theme:'modern', budget:null, constraints:[], priorities:[], styleKeywords:['neutral'], clarificationsNeeded:[] }) },
  { role: 'user', content: '2 bhk, budget 10L, living and dining, contemporary' },
  { role: 'assistant', content: JSON.stringify({ rooms:['living','dining'], onlyRooms:false, bhk:2, areaSqft:null, theme:'contemporary', budget:{amount:1000000,currency:'INR'}, constraints:[], priorities:[], styleKeywords:['contemporary'], clarificationsNeeded:[] }) },
  { role: 'user', content: 'kitchen and foyer, 110 m2, modern' },
  { role: 'assistant', content: JSON.stringify({ rooms:['kitchen','foyer'], onlyRooms:false, bhk:null, areaSqft:1184, theme:'modern', budget:null, constraints:[], priorities:[], styleKeywords:['modern'], clarificationsNeeded:[] }) },
]

async function callOpenAI(messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0,
      response_format: { type: 'json_object' }
    })
  })
  if (!res.ok) return null
  const json = await res.json()
  const content = json?.choices?.[0]?.message?.content
  return content || null
}

function normalizeOut(obj) {
  if (!obj || typeof obj !== 'object') return null
  const out = {
    rooms: Array.isArray(obj.rooms) ? obj.rooms.map(x=>String(x||'').toLowerCase()) : [],
    onlyRooms: Boolean(obj.onlyRooms),
    bhk: Number.isFinite(Number(obj.bhk)) ? Number(obj.bhk) : null,
    areaSqft: Number.isFinite(Number(obj.areaSqft)) ? Math.round(Number(obj.areaSqft)) : null,
    theme: obj.theme ? String(obj.theme) : null,
    budget: (obj.budget && Number.isFinite(Number(obj.budget.amount))) ? { amount: Number(obj.budget.amount), currency: 'INR' } : null,
    constraints: Array.isArray(obj.constraints) ? obj.constraints.map(String) : [],
    priorities: Array.isArray(obj.priorities) ? obj.priorities.map(String) : [],
    styleKeywords: Array.isArray(obj.styleKeywords) ? obj.styleKeywords.map(String) : [],
    clarificationsNeeded: Array.isArray(obj.clarificationsNeeded) ? obj.clarificationsNeeded.map(String) : []
  }
  // Back-compat fields for stateFlow.v2.js
  out.areas = out.rooms
  out.areaSqft = out.areaSqft
  out.theme = out.theme
  out.budget = out.budget ? out.budget.amount : null
  out.onlyRoomsFlag = out.onlyRooms
  return out
}

export async function parseWithLLM(userMessage) {
  try {
    if (!USE_LLM_PARSER || !OPENAI_API_KEY || !userMessage) return null
    const base = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...FEW_SHOTS,
      { role: 'user', content: `${USER_INSTRUCTIONS}\n\nUser: ${userMessage}` }
    ]
    let content = await callOpenAI(base)
    if (!content) return null
    try {
      const parsed = JSON.parse(content)
      return normalizeOut(parsed)
    } catch (e) {
      // Attempt one repair: ask model to fix to strict JSON
      const repair = [
        { role: 'system', content: 'Fix the following into STRICT JSON matching the schema. Output ONLY JSON.' },
        { role: 'user', content }
      ]
      content = await callOpenAI(repair)
      if (!content) return null
      const parsed2 = JSON.parse(content)
      return normalizeOut(parsed2)
    }
  } catch (e) {
    console.warn('parseWithLLM failed; falling back to deterministic parser', e)
    return null
  }
}
