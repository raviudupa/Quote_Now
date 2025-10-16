// Lightweight Agent wrapper. Uses LangChain if available, otherwise falls back to simple heuristics.

import aiService from '../aiService.clean.js'
import { fetchCandidates, scoreCandidates, getAlternativesTool, applyUpdateTool, applyReplaceTool } from './tools.js'

// Normalized interface
// runAgent(userMessage, { req, filters, selections }) => { message, updates?, alternatives? }
export async function runAgent(userMessage, context = {}) {
  const lower = String(userMessage || '').toLowerCase()
  const { req = { requestedItems: [] }, filters = {}, selections = [] } = context

  // Detect intents
  const showAltFor = (() => {
    const m = lower.match(/(?:show|more|different|other)\s+(?:alternatives|options)\s+(?:for\s+)?([a-z\- ]+)/)
    if (m) return m[1].trim()
    const m2 = lower.match(/(?:show|more|different|other)\s+([a-z\- ]+)\s+(?:alternatives|options)/)
    return m2 ? m2[1].trim() : null
  })()
  const replaceMatch = lower.match(/\breplace\s+([a-z\- ]+?)\s+with\s+id\s+(\d+)\b/)
  const updateMatch = lower.match(/\b(?:update|change|make|switch|set)\s+([a-z\- ]+?)(?:\s+(?:material|subtype|size))?\s+(?:to|as|into)\s+([a-z\-]+)/)

  // Replace by id
  if (replaceMatch) {
    const typeText = replaceMatch[1].trim()
    const id = Number(replaceMatch[2])
    const items = applyReplaceTool({ requestedItems: req.requestedItems, type: typeText, id })
    return { message: `Replaced ${typeText} with item #${id}.`, updates: { requestedItems: items } }
  }
  // Update single line
  if (updateMatch) {
    const typeText = updateMatch[1].trim()
    const value = updateMatch[2].trim()
    const items = applyUpdateTool({ requestedItems: req.requestedItems, type: typeText, value })
    return { message: `Updated ${typeText} to ${value}.`, updates: { requestedItems: items } }
  }
  // Show alternatives for a specific type (best effort)
  if (showAltFor) {
    const norm = showAltFor.replace(/\s+/g, '_')
    const selIdx = selections.findIndex(s => (s.line?.type || '').toLowerCase() === norm)
    if (selIdx >= 0) {
      const alt = await aiService.getAlternatives(selections[selIdx], filters, { limit: 3 })
      return { message: `Here are alternatives for ${showAltFor}.`, alternatives: { [selIdx]: alt.map(r => ({ id: r.id, item_name: r.item_name, price_inr: r.price_inr })) } }
    }
  }

  // Fallback: no special intent
  return { message: 'No agent action needed.' }
}
