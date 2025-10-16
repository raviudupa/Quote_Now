// Vision floor plan analyzer (flagged)
// Produces a minimal room list from a floor plan image URL.
// Non-breaking: if the feature flag is off or model unavailable, returns an empty result.

export async function analyzeFloorPlan(imageUrl) {
  const USE = String(import.meta.env.VITE_USE_VISION_FLOORPLAN || '').toLowerCase() === 'true'
  if (!USE) return { rooms: [], notes: 'vision disabled', confidence: 0 }
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY
  if (!apiKey || !imageUrl) return { rooms: [], notes: 'missing key or image', confidence: 0 }
  try {
    const sys = 'You are an assistant that reads architectural floor plans from images and outputs JSON of rooms with simple labels. Only return JSON with the shape {"bhk":integer,"rooms":[{"type":"bedroom|living|kitchen|bathroom|dining|foyer|balcony","width_m":number|null,"depth_m":number|null}],"confidence":0.0-1.0}. Count bedrooms to compute bhk; if unsure, best estimate as an integer.'
    const userText = `Analyze the floor plan at this URL and return JSON only. URL: ${imageUrl}. If dimensions are visible, add width_m and depth_m in meters. If unknown, set them null. Include a top-level integer field \'bhk\' equal to the number of bedrooms (1 for 1 BHK, 2 for 2 BHK, etc.).`

    // Primary: text-only call with response_format json_object (most reliable in browser)
    const textOnly = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userText }
        ],
        temperature: 0.1,
        max_tokens: 300
      })
    })
    if (textOnly.ok) {
      const j = await textOnly.json()
      const raw = j?.choices?.[0]?.message?.content || '{}'
      try {
        const parsed = JSON.parse(raw)
        const rooms = Array.isArray(parsed.rooms) ? parsed.rooms : []
        const bhk = Number.isFinite(Number(parsed.bhk)) ? Number(parsed.bhk) : null
        if (rooms.length > 0) return { rooms, bhk, confidence: Number(parsed.confidence || 0.6), notes: 'ok-text-only' }
      } catch { /* fall through */ }
    } else {
      try { const err = await textOnly.json(); console.error('[VISION] OpenAI text-only error', err) } catch { /* ignore */ }
    }

    // Secondary: multimodal message (may be rejected on some orgs; use as best-effort)
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: [
            { type: 'text', text: 'Analyze the floor plan image and return JSON only.' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ] }
        ],
        temperature: 0.1,
        max_tokens: 300
      })
    })
    if (!res.ok) {
      try { const err = await res.json(); console.error('[VISION] OpenAI error', err) } catch { /* ignore */ }
      // fall through to text-only attempt below
    }
    if (res.ok) {
      const json = await res.json()
      let txt = json?.choices?.[0]?.message?.content || '{}'
      // Strip JSON fences if present
      const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i)
      if (fence && fence[1]) txt = fence[1]
      let parsed = {}
      try { parsed = JSON.parse(txt) } catch { parsed = {} }
      const rooms = Array.isArray(parsed.rooms) ? parsed.rooms : []
      const bhk = Number.isFinite(Number(parsed.bhk)) ? Number(parsed.bhk) : null
      const confidence = Number(parsed.confidence || 0.6)
      if (rooms.length > 0) return { rooms, bhk, confidence, notes: 'ok' }
    }

    // Fallback 2: text-only prompt with response_format json_object
    const res2 = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `${userText}\nImage URL: ${imageUrl}\nReturn JSON only.` }
        ],
        temperature: 0.1,
        max_tokens: 300
      })
    })
    if (res2.ok) {
      const json2 = await res2.json()
      let txt2 = json2?.choices?.[0]?.message?.content || '{}'
      let parsed2 = {}
      try { parsed2 = JSON.parse(txt2) } catch { parsed2 = {} }
      const rooms2 = Array.isArray(parsed2.rooms) ? parsed2.rooms : []
      const confidence2 = Number(parsed2.confidence || 0.5)
      if (rooms2.length > 0) return { rooms: rooms2, confidence: confidence2, notes: 'ok-text-only' }
    } else {
      try { const err2 = await res2.json(); console.error('[VISION] OpenAI text-only error', err2) } catch { /* ignore */ }
    }

    // Fallback 3: heuristic by filename (very rough)
    try {
      const name = String(imageUrl).split('/').pop().toLowerCase()
      const m = name.match(/(\d)\s*-?\s*bhk/)
      const bhk = m ? parseInt(m[1], 10) : 0
      const approxRooms = []
      if (bhk > 0) {
        for (let i=0;i<bhk;i++) approxRooms.push({ type: 'bedroom', width_m: null, depth_m: null })
        approxRooms.push({ type: 'living', width_m: null, depth_m: null })
        approxRooms.push({ type: 'kitchen', width_m: null, depth_m: null })
        approxRooms.push({ type: 'bathroom', width_m: null, depth_m: null })
        return { rooms: approxRooms, bhk, confidence: 0.2, notes: 'heuristic-filename' }
      }
    } catch { /* ignore */ }
    return { rooms: [], bhk: null, notes: 'model error', confidence: 0 }
  } catch {
    return { rooms: [], bhk: null, notes: 'exception', confidence: 0 }
  }
}
