// Intent detection for natural language understanding
// Determines what the user wants to do based on their message

/**
 * Detect the primary intent of the user's message
 * @param {string} text - User's message
 * @param {boolean} hasPriorQuotation - Whether there's an existing quotation
 * @returns {Object} Intent object with type and details
 */
export function detectIntent(text, hasPriorQuotation = false) {
  const t = String(text || '').toLowerCase()
  
  // Intent categories:
  // 1. INITIAL_REQUEST - First time asking for quotation
  // 2. MODIFY_EXISTING - Modifying an existing quotation
  // 3. STYLE_CHANGE - Changing style/theme
  // 4. ROOM_MODIFICATION - Adding/removing rooms or items
  // 5. ITEM_REPLACEMENT - Replacing specific items
  // 6. CLARIFICATION - Asking questions or providing more details
  
  const intents = []
  
  // Check for modification keywords
  const modificationKeywords = /\b(now|then|also|additionally|but|however|instead|change|modify|update|adjust|alter)\b/
  const hasModificationContext = modificationKeywords.test(t)
  
  // Check for removal/deletion intent
  const removalPatterns = [
    /\b(remove|delete|take\s+out|get\s+rid\s+of|without|exclude|drop)\s+(the\s+)?(master|guest|kids?)\s+bedroom\b/,
    /\b(remove|delete|take\s+out|get\s+rid\s+of)\s+(the\s+)?bedroom\s+\d+\b/,
    /\b(remove|delete|take\s+out)\s+(?:the\s+)?([a-z\s]+)\s+from\s+(master|guest|bedroom\s+\d+)\b/,
    /\b(don't\s+need|no\s+need\s+for|skip)\s+(the\s+)?(master|guest)\s+bedroom\b/
  ]
  
  for (const pattern of removalPatterns) {
    if (pattern.test(t)) {
      intents.push({
        type: 'ROOM_MODIFICATION',
        action: 'REMOVE',
        target: extractRemovalTarget(t),
        isModification: hasPriorQuotation || hasModificationContext
      })
    }
  }
  
  // Check for addition intent
  const additionPatterns = [
    /\b(add|include|also\s+add|want|need)\s+(?:a\s+)?([a-z\s]+)\s+(?:to|in|for)\s+(master|guest|bedroom\s+\d+)\b/,
    /\b(add|include)\s+(?:a\s+)?([a-z\s]+)\b/
  ]
  
  for (const pattern of additionPatterns) {
    if (pattern.test(t)) {
      intents.push({
        type: 'ROOM_MODIFICATION',
        action: 'ADD',
        isModification: hasPriorQuotation || hasModificationContext
      })
    }
  }
  
  // Check for style change intent
  const stylePatterns = [
    /\b(change|switch|make\s+it|convert\s+to|use)\s+(?:the\s+)?style\s+(?:to\s+)?([a-z\s]+)\b/,
    /\b(modern|contemporary|traditional|minimalist|industrial|scandinavian|bohemian)\s+style\b/,
    /\bstyle\s*:\s*([a-z\s]+)\b/
  ]
  
  for (const pattern of stylePatterns) {
    if (pattern.test(t)) {
      intents.push({
        type: 'STYLE_CHANGE',
        isModification: hasPriorQuotation || hasModificationContext
      })
    }
  }
  
  // Check for replacement intent
  const replacementPatterns = [
    /\breplace\s+([a-z\s]+)\s+with\s+(?:id\s+)?(\d+)\b/,
    /\bchange\s+(?:the\s+)?([a-z\s]+)\s+to\s+([a-z\s]+)\b/
  ]
  
  for (const pattern of replacementPatterns) {
    if (pattern.test(t)) {
      intents.push({
        type: 'ITEM_REPLACEMENT',
        isModification: true
      })
    }
  }
  
  // Check for initial request (BHK, floor plan, property description)
  const initialRequestPatterns = [
    /\b\d+\s*bhk\b/,
    /\b(apartment|villa|house|flat|condo)\b/,
    /\b(floor\s*plan|layout|design)\b/,
    /\b(budget|sqft|square\s+feet)\b/
  ]
  
  let hasInitialRequestMarkers = false
  for (const pattern of initialRequestPatterns) {
    if (pattern.test(t)) {
      hasInitialRequestMarkers = true
      break
    }
  }
  
  if (hasInitialRequestMarkers && !hasPriorQuotation && intents.length === 0) {
    intents.push({
      type: 'INITIAL_REQUEST',
      isModification: false
    })
  }
  
  // Check for clarification/additional info
  const clarificationPatterns = [
    /\b(also|additionally|and|plus|furthermore)\b/,
    /\b(focus\s+on|prioritize|important|must\s+have)\b/,
    /\b(prefer|would\s+like|looking\s+for)\b/
  ]
  
  for (const pattern of clarificationPatterns) {
    if (pattern.test(t) && !intents.some(i => i.type === 'ROOM_MODIFICATION')) {
      intents.push({
        type: 'CLARIFICATION',
        isModification: hasPriorQuotation
      })
    }
  }
  
  // Default to initial request if no intents detected
  if (intents.length === 0) {
    intents.push({
      type: hasPriorQuotation ? 'CLARIFICATION' : 'INITIAL_REQUEST',
      isModification: hasPriorQuotation
    })
  }
  
  // Return primary intent (first one detected)
  return {
    primary: intents[0],
    all: intents,
    isModification: intents.some(i => i.isModification),
    hasMultipleIntents: intents.length > 1
  }
}

/**
 * Extract what the user wants to remove
 */
function extractRemovalTarget(text) {
  const t = String(text || '').toLowerCase()
  
  // Check for specific bedroom types
  if (/\b(master)\s+bedroom\b/.test(t)) return { type: 'bedroom', subtype: 'master' }
  if (/\b(guest)\s+bedroom\b/.test(t)) return { type: 'bedroom', subtype: 'guest' }
  if (/\bbedroom\s+(\d+)\b/.test(t)) {
    const m = t.match(/\bbedroom\s+(\d+)\b/)
    return { type: 'bedroom', subtype: `bedroom ${m[1]}` }
  }
  
  // Check for item from bedroom
  const itemFromBedroom = t.match(/\b(remove|delete)\s+(?:the\s+)?([a-z\s]+)\s+from\s+(master|guest|bedroom\s+\d+)\b/)
  if (itemFromBedroom) {
    return {
      type: 'item',
      itemType: itemFromBedroom[2].trim(),
      room: itemFromBedroom[3].trim()
    }
  }
  
  return { type: 'unknown' }
}

/**
 * Determine if a message is a modification command
 * This helps distinguish between:
 * - "2 BHK without master bedroom" (initial planning)
 * - "now remove the master bedroom" (modification)
 */
export function isModificationCommand(text, hasPriorQuotation = false) {
  const intent = detectIntent(text, hasPriorQuotation)
  return intent.isModification
}

/**
 * Check if removal is for initial planning or modification
 */
export function shouldExcludeFromPlanning(text, hasPriorQuotation = false) {
  const t = String(text || '').toLowerCase()
  
  // If there's already a quotation, removals are modifications, not planning exclusions
  if (hasPriorQuotation) return false
  
  // Check for modification context words
  const modificationWords = /\b(now|then|also|but|however|instead|change|modify|update)\b/
  if (modificationWords.test(t)) return false
  
  // Check for conversational removal phrases (modifications)
  const conversationalRemoval = /\b(removing|taking\s+out|getting\s+rid\s+of|don't\s+need)\s+(the\s+)?(master|guest)\s+bedroom\b/
  if (conversationalRemoval.test(t)) return false
  
  // These are planning exclusions:
  // - "2 BHK without master bedroom"
  // - "exclude the master bedroom"
  // - "no master bedroom"
  const planningExclusion = /\b(without|exclude|excluding|no)\s+(the\s+)?(master|guest)\s+bedroom\b/
  return planningExclusion.test(t)
}

/**
 * Get user-friendly explanation of detected intent
 */
export function explainIntent(text, hasPriorQuotation = false) {
  const intent = detectIntent(text, hasPriorQuotation)
  
  switch (intent.primary.type) {
    case 'INITIAL_REQUEST':
      return 'Creating new quotation based on your requirements'
    case 'ROOM_MODIFICATION':
      if (intent.primary.action === 'REMOVE') {
        return `Removing ${intent.primary.target?.subtype || 'items'} from quotation`
      }
      return 'Modifying rooms in your quotation'
    case 'STYLE_CHANGE':
      return 'Updating style preferences'
    case 'ITEM_REPLACEMENT':
      return 'Replacing specific items'
    case 'CLARIFICATION':
      return 'Adding more details to your quotation'
    default:
      return 'Processing your request'
  }
}
