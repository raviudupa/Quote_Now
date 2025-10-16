// LLM clarifier: crafts a short clarification question when a line cannot be matched.
// It never invents items; it only references provided probes/constraints.

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY
const USE_LLM_CLARIFIER = String(import.meta.env.VITE_USE_LLM_CLARIFIER || '').toLowerCase() === 'true'

const SYSTEM_PROMPT = `You are a concise clarifier agent for an interior quotation assistant.
- NEVER invent or suggest product names, models, quantities, or prices.
- Do NOT add or remove items; only ask about attributes missing from the user's request (e.g., budget range, package tier, material, seater, subtype, doors).
- Ask ONLY ONE question at a time about the MOST important missing or ambiguous field needed to proceed.
- Keep it short, simple, and natural. Do not repeat information that is already clear in the context.
- Prefer phrasing like: "Do you mean …?" or "Could you specify …?".
- You may include up to 2–3 very short option hints using ONLY the provided facet values when relevant.
- Use the Indian currency symbol (₹) when referencing ranges; never give exact prices.
`

export async function clarifyWithLLM({ unmetLine, filters, probes, missingFields, facets, items, missingPerItem, perItemFacets }) {
  try {
    if (!USE_LLM_CLARIFIER || !OPENAI_API_KEY) return null
    const { type, description, specs } = unmetLine || {}
    const cheapestAny = probes?.cheapestAny ?? null
    const cheapestPremium = probes?.cheapestPremium ?? null
    const fields = Array.isArray(missingFields) ? missingFields : []
    const safeFacets = facets || { materials: [], subtypes: [], seaters: [], packages: [], priceBands: [] }

    const userContext = {
      type,
      description,
      specs,
      filters,
      probes: { cheapestAny, cheapestPremium },
      missingFields: fields,
      facets: safeFacets,
      // Multi-item support: if provided, the model should issue ONE instruction covering all
      multi: Array.isArray(items) && items.length > 1 ? {
        items: items.map(it => ({ type: it?.type, specs: it?.specifications || {} })),
        missingPerItem: Array.isArray(missingPerItem) ? missingPerItem : null,
        perItemFacets: Array.isArray(perItemFacets) ? perItemFacets : null
      } : null
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Ask ONE short instruction that collects ONLY the most important missing attributes. If multiple items are present, cover all items in a single instruction.
When you ask about a field (e.g., material, subtype, seater, doors, package, budget range), include up to 2–3 SHORT option hints using ONLY the facet values provided for that specific item type.
Single-item facets: materials=${safeFacets.materials.join(', ') || 'none'}, subtypes=${safeFacets.subtypes.join(', ') || 'none'}, seaters=${safeFacets.seaters.join(', ') || 'none'}, packages=${safeFacets.packages.join(', ') || 'none'}.
For multi-item, use per-item facets from context.multi.perItemFacets if present.
Never repeat information that's already clear. Do not suggest exact prices or product names. Use ₹ for ranges only.
Context: ${JSON.stringify(userContext)}` }
        ],
        temperature: 0.2
      })
    })
    if (!res.ok) return null
    const json = await res.json()
    const content = json?.choices?.[0]?.message?.content?.trim()
    return content || null
  } catch (e) {
    console.warn('clarifyWithLLM failed; falling back to deterministic clarification', e)
    return null
  }
}
