// Image retrieval via Tavily image search with strict, subtype-aware queries.
// Falls back to Unsplash Source if nothing relevant is found.

export async function generateItemImage({ name, description = '', room = '', theme = '', type = '', subtype = '' }) {
  // Build a constrained query to increase accuracy
  const keyType = normalizeTypeKeyword(type || name || '')
  const derivedSubs = deriveSubKeywords({ type: keyType, name, description })
  const keySub = normalizeTypeKeyword(subtype || derivedSubs[0] || '')
  const mustWords = [keyType, keySub, ...derivedSubs.slice(1), room, theme]
    .map(w => String(w||'').trim().toLowerCase())
    .filter(Boolean)

  const disallow = ['anime', 'cartoon', 'illustration', 'drawing', '3d render', 'cgi', 'lowres', 'nsfw', 'person', 'people']
  const baseQuery = [name, description, keyType, keySub, ...derivedSubs, room, theme, 'photorealistic', 'product photo', 'catalog', 'studio lighting']
    .filter(Boolean)
    .join(' ')
  const q = encodeURIComponent(baseQuery)

  // Tavily image search
  try {
    const apiKey = import.meta.env.VITE_TAVILY_API_KEY
    if (!apiKey) throw new Error('Missing VITE_TAVILY_API_KEY')

    const payload = {
      api_key: apiKey,
      query: decodeURIComponent(q),
      include_sources: false,
      include_images: true,
      max_results: 6,
      search_depth: 'basic'
    }
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!res.ok) throw new Error('Tavily search failed')
    const data = await res.json()
    // Collect possible image urls from various shapes Tavily might return
    const fromTop = Array.isArray(data?.images) ? data.images : []
    const fromImageResults = Array.isArray(data?.image_results) ? data.image_results.map(r => r?.url || r?.image || r?.src).filter(Boolean) : []
    const fromResults = Array.isArray(data?.results)
      ? data.results.flatMap(r => (Array.isArray(r?.images) ? r.images : [])).filter(Boolean)
      : []
    const imgs = [...fromTop, ...fromImageResults, ...fromResults]
      .map(u => (typeof u === 'string' ? { url: u, prompt: baseQuery } : u))

    if (!imgs.length) throw new Error('No images')

    // Score: keyword overlap in URL/alt/context, plus subtype/type words
    const scoreImage = (img) => {
      const src = String(img?.url || img?.image || img?.src || '').toLowerCase()
      const ctx = String(img?.title || img?.alt || img?.prompt || '').toLowerCase()
      const p = `${src} ${ctx}`
      let score = 0
      for (const w of mustWords) if (w && p.includes(w)) score += 3
      if (/photo|product|studio|catalog/.test(p)) score += 1
      for (const neg of disallow) if (p.includes(neg)) score -= 3
      if (/human|hand|face|woman|man|people|model\b/.test(p)) score -= 2
      return score
    }

    const ranked = imgs
      .map(img => ({ url: img.url || img.image || img.src, score: scoreImage(img) }))
      .filter(r => typeof r.url === 'string')
      .sort((a,b) => b.score - a.score)

    const best = ranked[0]
    if (best && best.score >= 3 && best.url) return best.url
    // If nothing scored high, fall back to Unsplash constrained query
    return unsplashSourceUrl({ keyType, keySub, derivedSubs, room, theme, name, description })
  } catch (_) {
    // Fallback to Unsplash Source
    return unsplashSourceUrl({ keyType, keySub, derivedSubs, room, theme, name, description })
  }
}

function unsplashSourceUrl({ keyType, keySub, derivedSubs, room, theme, name, description }) {
  const parts = [keyType, keySub, ...(derivedSubs||[]), room, theme]
  // add 1-2 material/style hints from description to help accuracy slightly
  const desc = String(description||'').toLowerCase()
  if (/walnut|oak|teak|sheesham|wood/i.test(desc)) parts.push('wood furniture')
  if (/metal|steel|iron/i.test(desc)) parts.push('metal')
  if (/marble/i.test(desc)) parts.push('marble')
  if (/leather/i.test(desc)) parts.push('leather')
  if (/fabric|linen|cotton|velvet/.test(desc)) parts.push('fabric')
  parts.push('photography')
  const query = encodeURIComponent(Array.from(new Set(parts.filter(Boolean))).join(','))
  // 512x512 square; Unsplash Source returns a direct image
  return `https://source.unsplash.com/512x512/?${query}`
}

function hashString(str) {
  let h = 2166136261 >>> 0 // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

function normalizeTypeKeyword(s) {
  const t = String(s||'').toLowerCase().replace(/_/g,' ').trim()
  if (!t) return ''
  // Keep core furniture nouns
  const keep = ['sofa','couch','tv bench','tv unit','table','coffee table','dining table','side table','bedside table','bed','wardrobe','bookcase','shelf','cabinet','lamp','washstand','mirror','chair','dining chair','armchair','floor lamp','table lamp']
  for (const k of keep) if (t.includes(k)) return k
  // Fallback: first word
  return t.split(/\s+/)[0]
}

function deriveSubKeywords({ type, name, description }) {
  const text = `${String(name||'')} ${String(description||'')} ${String(type||'')}`.toLowerCase()
  const out = []
  const has = (re) => re.test(text)
  // Tables
  if (/\bcoffee\b/.test(text)) out.push('coffee table')
  if (/\bbedside\b/.test(text)) out.push('bedside table')
  if (/\bside\b/.test(text)) out.push('side table')
  if (/\bdining\b/.test(text)) {
    if (/\bchair\b/.test(text)) out.push('dining chair')
    out.push('dining table')
  }
  // Chairs
  if (/(arm\s*chair|armchair)/.test(text)) out.push('armchair')
  if (/\bdining\s*chair\b/.test(text)) out.push('dining chair')
  // Lamps
  if (/floor\s*lamp/.test(text)) out.push('floor lamp')
  if (/table\s*lamp/.test(text)) out.push('table lamp')
  // Mirrors
  if (/vanity\s*mirror/.test(text)) out.push('vanity mirror')
  // Wardrobe sizes
  if (/sliding\s*door/.test(text)) out.push('sliding wardrobe')
  // Remove duplicates while preserving order
  return Array.from(new Set(out))
}
