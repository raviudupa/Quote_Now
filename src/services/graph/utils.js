// Graph utilities
// Normalizes LLM item names/specs to internal catalog schema/types

export function normalizeLLMItem(it) {
  const tRaw = String(it.type || '').toLowerCase()
  let type = tRaw
  const specs = { ...(it.specs || {}) }
  let description = it.description || tRaw

  if (tRaw.includes('tv unit') || tRaw.includes('tv table') || tRaw.includes('tv stand') || tRaw.includes('tv storage')) {
    type = 'tv_bench'; description = 'tv bench'
  }
  if (tRaw === 'mirror cabinet' || tRaw === 'mirror_cabinet' || /cabinet.*mirror|mirror.*cabinet/.test(tRaw)) {
    type = 'mirror_cabinet'; description = 'mirror cabinet'
  }
  if (tRaw === 'bedside table' || tRaw.includes('nightstand')) {
    type = 'table'; specs.subtype = specs.subtype || 'bedside'; description = 'bedside table'
  }
  if (tRaw === 'side table') {
    type = 'table'; specs.subtype = specs.subtype || 'side'; description = 'side table'
  }
  if (tRaw === 'coffee table') {
    type = 'table'; specs.subtype = specs.subtype || 'coffee'; description = 'coffee table'
  }
  if (tRaw === 'dining table') {
    type = 'table'; specs.subtype = specs.subtype || 'dining'; description = 'dining table'
  }

  // Sofa-bed normalization: treat as sofa with a sofabed feature
  if (tRaw.includes('sofa bed') || tRaw.includes('sofa-bed')) {
    type = 'sofa';
    description = 'sofa bed'
    specs.features = specs.features || {}
    specs.features.sofabed = true
  }

  return {
    type,
    quantity: it.quantity || 1,
    description,
    specifications: {
      seater: specs.seater || null,
      material: specs.material || null,
      subtype: specs.subtype || null,
      size: specs.size || null,
      color: specs.color || null,
      finish: specs.finish || null,
      features: specs.features || {},
      dimensions: specs.dimensions || null,
      dim_token: (specs.dimensions && specs.dimensions.width && specs.dimensions.height)
        ? `${specs.dimensions.width}x${specs.dimensions.height}`
        : null
    }
  }
}
