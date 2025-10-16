# Intelligent Intent Detection System

## Overview

The chatbot now understands user intent contextually, distinguishing between:
- **Initial planning** ("2 BHK without master bedroom")
- **Modifications** ("now remove the master bedroom")
- **Style changes** ("change to modern style")
- **Item replacements** ("replace sofa with id 12345")
- **Clarifications** ("focus on living room")

## How It Works

### Intent Detection (`src/services/intentDetector.js`)

The system analyzes:
1. **Context words**: "now", "then", "also", "but", "however", "instead"
2. **Prior quotation**: Whether user already has a quotation
3. **Action verbs**: "remove", "add", "change", "replace", "modify"
4. **Specificity**: Generic vs specific targets (e.g., "bedroom" vs "master bedroom")

### Intent Types

#### 1. INITIAL_REQUEST
**Triggers:**
- BHK mentions: "2 BHK apartment"
- Property type: "villa", "apartment", "flat"
- Floor plan uploads
- Budget/size mentions

**Behavior:**
- Creates new quotation from scratch
- All room exclusions apply to planning
- Example: "2 BHK without master bedroom" → Creates only 1 bedroom

#### 2. ROOM_MODIFICATION
**Triggers:**
- "now remove the master bedroom"
- "removing the guest bedroom"
- "take out bedroom 2"
- "add a bookcase to bedroom 3"

**Behavior:**
- Modifies existing quotation
- Doesn't affect room planning
- Only removes/adds specific items
- Example: "now removing master bedroom" → Removes master bedroom items, keeps other bedrooms

#### 3. STYLE_CHANGE
**Triggers:**
- "change style to modern"
- "use minimalist style"
- "make it contemporary"

**Behavior:**
- Re-selects items with new style
- Keeps same rooms and structure
- Updates style weights

#### 4. ITEM_REPLACEMENT
**Triggers:**
- "replace sofa with id 12345"
- "change the bed to a king size"

**Behavior:**
- Swaps specific items
- Maintains quotation structure

#### 5. CLARIFICATION
**Triggers:**
- "also focus on living room"
- "prioritize storage"
- "prefer wooden furniture"

**Behavior:**
- Adds constraints/preferences
- Refines existing quotation

## Examples

### Example 1: Initial Planning vs Modification

**Scenario A - Initial Planning:**
```
User: "2 BHK apartment without master bedroom"

Intent: INITIAL_REQUEST
Behavior: Creates quotation with only 1 bedroom (guest bedroom)
Rooms: living, kitchen, bathroom, bedroom (1x)
```

**Scenario B - Modification:**
```
User: "2 BHK apartment"
[Quotation created with master bedroom + bedroom 2]

User: "now remove the master bedroom"

Intent: ROOM_MODIFICATION (action: REMOVE)
Behavior: Removes master bedroom items, keeps bedroom 2
Rooms: living, kitchen, bathroom, bedroom 2
```

### Example 2: Conversational Removal

**User says:**
```
"2 BHK apartment with a focus on maximizing functional space 
and aesthetic coherence, now removing the master bedroom."
```

**System understands:**
- Primary intent: INITIAL_REQUEST (2 BHK apartment)
- Secondary intent: ROOM_MODIFICATION (removing master bedroom)
- Context: "now" indicates modification
- Action: Create 2 BHK, then remove master bedroom items

**Result:**
- Creates full 2 BHK quotation
- Applies removal command to master bedroom
- Final quotation shows: bedroom 2 only

### Example 3: Multiple Intents

**User says:**
```
"Change to modern style and remove the guest bedroom"
```

**System detects:**
- Intent 1: STYLE_CHANGE
- Intent 2: ROOM_MODIFICATION (remove)
- Both are modifications

**Behavior:**
1. Re-selects all items with modern style
2. Removes guest bedroom items
3. Keeps master bedroom and other rooms

## Technical Implementation

### Key Functions

#### `detectIntent(text, hasPriorQuotation)`
Returns:
```javascript
{
  primary: { type: 'ROOM_MODIFICATION', action: 'REMOVE', isModification: true },
  all: [...], // All detected intents
  isModification: true,
  hasMultipleIntents: false
}
```

#### `isModificationCommand(text, hasPriorQuotation)`
Returns `true` if the command modifies existing quotation, not initial planning.

#### `shouldExcludeFromPlanning(text, hasPriorQuotation)`
Returns `true` only for initial planning exclusions like "2 BHK without master bedroom".

#### `explainIntent(text, hasPriorQuotation)`
Returns human-readable explanation:
- "Creating new quotation based on your requirements"
- "Removing master bedroom from quotation"
- "Updating style preferences"

### Integration Points

#### 1. Room Exclusions (`parseRoomExclusions`)
```javascript
function parseRoomExclusions(text, hasPriorQuotation) {
  // If modification command, return empty (don't exclude from planning)
  if (isModificationCommand(text, hasPriorQuotation)) {
    return []
  }
  // Otherwise, parse exclusions for initial planning
  ...
}
```

#### 2. Progress Notifications
```javascript
onProgress({ 
  stage: 'intent', 
  intent: 'ROOM_MODIFICATION',
  explanation: 'Removing master bedroom from quotation',
  isModification: true
})
```

#### 3. Console Logging (Dev Mode)
```javascript
console.log('[Intent Detection]', {
  text: "now removing master bedroom",
  hasPriorQuotation: true,
  intent: 'ROOM_MODIFICATION',
  isModification: true,
  explanation: 'Removing master bedroom from quotation'
})
```

## Benefits

### 1. Natural Conversation
Users can speak naturally:
- ✅ "2 BHK, now remove master bedroom"
- ✅ "removing the guest bedroom"
- ✅ "also add a bookcase"
- ✅ "change to modern style"

### 2. Context Awareness
System understands:
- First message vs follow-up
- Planning vs modification
- Generic vs specific targets

### 3. Reduced Errors
Prevents:
- ❌ Removing all bedrooms when user meant one
- ❌ Excluding rooms from planning during modifications
- ❌ Misinterpreting conversational phrases

### 4. Better UX
- Clear intent explanations
- Predictable behavior
- Fewer surprises

## Testing

### Test Cases

#### Test 1: Initial Planning Exclusion
```
Input: "2 BHK without master bedroom"
Expected: 1 bedroom in quotation
Actual: ✅ Creates bedroom 2 only
```

#### Test 2: Modification Removal
```
Input 1: "2 BHK apartment"
Input 2: "now remove master bedroom"
Expected: Master bedroom removed, bedroom 2 kept
Actual: ✅ Removes master bedroom items only
```

#### Test 3: Conversational Removal
```
Input: "2 BHK, removing the master bedroom"
Expected: Creates 2 bedrooms, then removes master
Actual: ✅ Bedroom 2 shown in quotation
```

#### Test 4: Style Change
```
Input 1: "2 BHK modern style"
Input 2: "change to minimalist"
Expected: Re-selects items with minimalist style
Actual: ✅ Items updated with new style
```

### Debugging

**Check console logs:**
```javascript
[Intent Detection] {
  text: "now removing master bedroom",
  hasPriorQuotation: true,
  intent: "ROOM_MODIFICATION",
  isModification: true,
  explanation: "Removing master bedroom from quotation"
}
```

**Check progress events:**
```javascript
{ 
  stage: 'intent',
  intent: 'ROOM_MODIFICATION',
  explanation: 'Removing master bedroom from quotation',
  isModification: true
}
```

## Future Enhancements

### 1. Multi-turn Conversations
```
User: "2 BHK apartment"
Bot: "Created quotation with 2 bedrooms"
User: "remove the master bedroom"
Bot: "Removed master bedroom. Quotation now shows bedroom 2 only"
User: "add it back"
Bot: "Added master bedroom back"
```

### 2. Clarification Questions
```
User: "remove bedroom"
Bot: "Which bedroom? Master bedroom or bedroom 2?"
User: "master"
Bot: "Removed master bedroom"
```

### 3. Undo/Redo
```
User: "remove master bedroom"
Bot: "Removed master bedroom"
User: "undo"
Bot: "Restored master bedroom"
```

### 4. Intent Confidence
```javascript
{
  intent: 'ROOM_MODIFICATION',
  confidence: 0.95,
  alternatives: [
    { intent: 'INITIAL_REQUEST', confidence: 0.05 }
  ]
}
```

## Troubleshooting

### Issue: System treats modification as planning

**Symptom:** "now remove master bedroom" excludes all bedrooms

**Check:**
1. Console log shows `isModification: false`
2. `hasPriorQuotation` is false

**Fix:**
- Ensure prior quotation is being passed correctly
- Check if `prior?.selections` has data

### Issue: Planning exclusion treated as modification

**Symptom:** "2 BHK without master bedroom" creates 2 bedrooms

**Check:**
1. Console log shows `isModification: true`
2. Context words detected incorrectly

**Fix:**
- Review `isModificationCommand` logic
- Check for false positive context words

### Issue: Wrong intent detected

**Symptom:** Style change detected as room modification

**Check:**
1. Console log shows wrong intent type
2. Multiple intents detected

**Fix:**
- Review intent priority in `detectIntent`
- Adjust pattern matching regex
