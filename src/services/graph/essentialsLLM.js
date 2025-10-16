// LLM Essentials Generator (Upgraded): strict JSON, grounded by rooms, exclusions, style, and budget.
// Keeps previous deterministic essentials as comments for comparison and testing.

/*
Previous deterministic baseline (for reference only; implemented in stateFlow.v2.js fallback):
- living: sofa (1), tv_bench (1), table:coffee (1), lamp (1)
- bedroom: bed (BHK-scaled), wardrobe (BHK-scaled), table:bedside (BHK-scaled), mirror (BHK-scaled)
- kitchen: table:dining (when no dedicated dining), shelf (1)
- bathroom: washstand (1), mirror (1)
- dining: table:dining (1)
- balcony: chair (2), table:side (1)
- utility: shelf (1), cabinet (1)
*/

const SYSTEM = `You are a strict JSON generator for interior design essentials.\n- Output ONLY valid JSON.\n- NEVER include rooms that are excluded or not in the allowed list.\n- Use the provided catalog types and subtypes only; do not invent new categories.\n- Respect budget tier when proposing counts and price intensity.\n- Strongly bias choices using the provided style name, style features, and style keywords.\n- When style is present, prefer subtypes and accents consistent with the style, and include 1-2 of the most relevant style features in each item's specifications.features.\n\nSchema:\n{\n  "bhk": number|null,\n  "sqft": number|null,\n  "items": [\n    {\n      "room": "living|bedroom|kitchen|bathroom|dining|foyer|study|balcony|utility",\n      "type": string,\n      "quantity": number,\n      "specifications": { "subtype"?: string, "features"?: string[] },\n      "priority": "must"|"nice",\n      "maxPriceHint"?: number\n    }\n  ],\n  "notes"?: string\n}\n\nAllowed types/subtypes examples per room (not exhaustive):\n- living: sofa, tv_bench, table:coffee, lamp, chair\n- bedroom: bed, wardrobe, table:bedside, mirror\n- kitchen: shelf, cabinet, table:dining (only when no dedicated dining)\n- bathroom: washstand, mirror\n- dining: table:dining, chair\n- balcony: chair, table:side\n- study: desk, chair\n- utility: shelf, cabinet\n`

function pickModel() {
  return 'gpt-4o-mini'
}

async function callOpenAI(messages) {
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('Missing VITE_OPENAI_API_KEY')
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: pickModel(), temperature: 0, response_format: { type: 'json_object' }, messages })
  })
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`)
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content || '{}'
  return JSON.parse(content)
}

export async function proposeEssentialsJSON({ rooms = [], excludedRooms = [], bhk = null, sqft = null, budget = null, styleProfile = null, styleBias = [], rulesHint = null } = {}) {
  const USE = String(import.meta.env.VITE_USE_LLM_ESSENTIALS || 'false').toLowerCase() === 'true'
  if (!USE) return null
  const user = {
    rooms,
    excludedRooms,
    bhk,
    sqft,
    budget,
    style: styleProfile?.name || null,
    styleFeatures: Array.isArray(styleProfile?.features) ? styleProfile.features.slice(0, 5) : [],
    styleKeywords: Array.isArray(styleBias) ? styleBias.slice(0, 20) : [],
    rules: rulesHint || null
  }
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify(user) }
  ]
  try {
    let parsed = await callOpenAI(messages)
    if (!Array.isArray(parsed?.items)) throw new Error('missing items')
    return { bhk: Number(bhk) || null, sqft: Number(sqft) || null, items: parsed.items }
  } catch (e1) {
    try {
      const repair = [
        ...messages,
        { role: 'system', content: 'Your previous output was invalid. Return STRICT JSON that matches the schema and excludes disallowed rooms.' }
      ]
      const fixed = await callOpenAI(repair)
      if (!Array.isArray(fixed?.items)) throw new Error('repair missing items')
      return { bhk: Number(bhk) || null, sqft: Number(sqft) || null, items: fixed.items }
    } catch (e2) {
      console.warn('[essentialsLLM] failed', e1?.message || e1, e2?.message || e2)
      return null
    }
  }
}

// Map LLM essentials to requested lines
export function essentialsToRequested(ess) {
  const requested = []
  const norm = (s) => String(s||'').toLowerCase().trim()
  const items = Array.isArray(ess?.items) ? ess.items : []
  for (const it of items) {
    const room = norm(it.room)
    const type = norm(it.type)
    const qty = Math.max(1, Number(it.quantity || 1))
    const sub = norm(it?.specifications?.subtype || '')
    const features = Array.isArray(it?.specifications?.features) ? it.specifications.features : []
    const specifications = {}
    if (sub) specifications.subtype = sub
    if (features.length) specifications.features = features

    const push = (t, q=1, spec={}) => requested.push({ type: t, quantity: q, specifications: spec, room })
    if (type === 'table' && sub === 'dining') push('table', qty, { subtype: 'dining' })
    else if (type === 'table' && sub === 'coffee') push('table', qty, { subtype: 'coffee' })
    else if (type === 'table' && sub === 'side') push('table', qty, { subtype: 'side' })
    else if (type === 'tv_bench' || type === 'tv-unit' || type === 'tv_unit') push('tv_bench', qty, specifications)
    else if (type === 'washstand') push('washstand', qty, specifications)
    else if (['sofa','chair','bed','wardrobe','desk','shelf','cabinet','lamp','mirror','table'].includes(type)) push(type, qty, specifications)
  }
  return requested
}
