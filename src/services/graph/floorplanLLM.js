// Floor plan specific LLM analyzer (image -> strict JSON)
// Uses OpenAI Chat Completions with image_url and response_format: json_object

export async function analyzeFloorPlanLLM(imageUrl) {
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY
  const USE = String(import.meta.env.VITE_USE_VISION_FLOORPLAN || 'true').toLowerCase() === 'true'
  if (!USE || !apiKey || !imageUrl) return null

  const system = `You are a floor plan analyzer.\nLook at the image and extract:\n- Number of bedrooms (bhk)\n- Approximate square feet if mentioned\n- List of rooms with subtypes where applicable:\n  * For bedrooms: specify "master bedroom", "guest bedroom 1", "guest bedroom 2", "kids bedroom", etc.\n  * For bathrooms: specify "attached bathroom" (if connected to bedroom), "common bathroom", "powder room", etc.\n  * For other rooms: "living", "kitchen", "dining", "foyer", "study", "balcony", "utility"\n- For each detected room, include a roomDimensions entry with room name matching the rooms list. If dimensions are not legible, set width=null, height=null, unit=null and add a short notes string.\n- Property type: "apartment" or "villa" (infer from layout, size, and features like garden/multiple floors)\nReturn STRICT JSON only with keys:\n{\n  "bhk": integer|null,\n  "sqft": integer|null,\n  "propertyType": "apartment"|"villa"|null,\n  "rooms": [string],\n  "roomDimensions": [ { "room": string, "width": number|null, "height": number|null, "unit": ("ft"|"m"|null), "notes"?: string } ]\n}.` 

  const mkMessages = (img) => ([
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Analyze this floor plan and return JSON only.' },
        { type: 'image_url', image_url: { url: img } }
      ]
    }
  ])
  // Simple retry helper
  const withRetry = async (fn, { retries = 2, delay = 400 } = {}) => {
    let lastErr
    for (let i = 0; i <= retries; i++) {
      try { return await fn() } catch (e) { lastErr = e }
      await new Promise(r => setTimeout(r, delay * (i + 1)))
    }
    throw lastErr
  }

  try {
    // Pre-convert http(s) images to base64 data URLs to avoid OpenAI remote download timeouts.
    let preparedImg = imageUrl
    try {
      if (/^https?:\/\//i.test(imageUrl)) {
        const imgRes = await fetch(imageUrl)
        const blob = await imgRes.blob()
        preparedImg = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
      }
    } catch (prefErr) {
      console.warn('[floorplanLLM] pre-convert to data URL failed, will try URL directly', prefErr?.message || prefErr)
      preparedImg = imageUrl
    }
    // Support multiple models in case org/project lacks access to one
    const MODELS = ['gpt-4o-mini', 'gpt-4o']
    const tryOnce = async (model, img) => withRetry(() => fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages: mkMessages(img) })
    }))

    // Attempt matrix: model x [original url, base64 data url]
    let lastErr = null
    for (const model of MODELS) {
      try {
        let res = await tryOnce(model, preparedImg)
        if (!res.ok) {
          let errText = ''
          try { errText = await res.text() } catch {}
          console.warn('[floorplanLLM]', model, 'primary attempt failed', res.status, errText?.slice(0,200))
          // Alternate path: if primary was data URL, try original URL; if primary was URL, try data URL
          try {
            let alt = imageUrl
            if (/^data:image\//i.test(preparedImg) && /^https?:\/\//i.test(imageUrl)) {
              alt = imageUrl
            } else if (/^https?:\/\//i.test(preparedImg)) {
              // prepared was URL, try to build data URL
              const imgRes = await withRetry(() => fetch(imageUrl))
              const blob = await imgRes.blob()
              alt = await new Promise((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => resolve(reader.result)
                reader.onerror = reject
                reader.readAsDataURL(blob)
              })
            }
            res = await tryOnce(model, alt)
          } catch (prepErr) {
            console.warn('[floorplanLLM] base64 prep failed', prepErr?.message || prepErr)
          }
        }
        if (res && res.ok) {
          const data = await res.json()
          const content = data?.choices?.[0]?.message?.content || '{}'
          const parsed = JSON.parse(content)
          const out = {
            bhk: Number(parsed.bhk || 0) || null,
            sqft: Number((parsed.sqft || '').toString().replace(/[^0-9]/g, '')) || null,
            propertyType: parsed.propertyType ? String(parsed.propertyType).toLowerCase() : null,
            rooms: Array.isArray(parsed.rooms) ? parsed.rooms.map(r => String(r)).filter(Boolean) : [],
            roomDimensions: Array.isArray(parsed.roomDimensions) ? parsed.roomDimensions.map(d => {
              const room = String(d?.room || '').toLowerCase()
              const rawW = d?.width
              const rawH = d?.height
              const width = rawW === null || rawW === undefined ? null : Number(rawW)
              const height = rawH === null || rawH === undefined ? null : Number(rawH)
              const unitRaw = d?.unit == null ? null : String(d.unit).toLowerCase()
              const unit = unitRaw === 'm' ? 'm' : (unitRaw === 'ft' ? 'ft' : null)
              const notes = d?.notes ? String(d.notes) : undefined
              if (!room) return null
              return { room, width: Number.isFinite(width) ? width : null, height: Number.isFinite(height) ? height : null, unit, ...(notes ? { notes } : {}) }
            }).filter(Boolean) : []
          }
          return out
        } else if (res) {
          const txt = await res.text().catch(()=> '')
          lastErr = new Error(`HTTP ${res.status}: ${txt?.slice(0,200)}`)
        }
      } catch (e) {
        lastErr = e
      }
    }
    if (lastErr) throw lastErr
    return null
  } catch (e) {
    console.warn('[floorplanLLM] failed', e?.message || e)
    return null
  }
}
