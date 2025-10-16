# Individual Bedroom Commands Guide

## Overview

Bedrooms are now **always created as separate entries** instead of using quantities. This allows granular control over specific bedrooms.

## How Bedrooms Are Created

### From Floor Plan
If floor plan detects specific bedrooms:
```
Floor plan → "master bedroom", "guest bedroom 1", "guest bedroom 2"
Result: 3 separate bedroom groups with individual items
```

### From BHK Count (No Floor Plan)
If you specify "4 BHK" without a floor plan:
```
4 BHK → "master bedroom", "bedroom 2", "bedroom 3", "bedroom 4"
Result: 4 separate bedroom groups
```

**Naming Convention:**
- First bedroom = "master bedroom"
- Others = "bedroom 2", "bedroom 3", "bedroom 4", etc.

## Supported Commands

### 1. Remove Specific Bedroom

**Remove by number:**
```
"remove bedroom 2"
"remove bedroom 3"
```
→ Removes ALL items from that specific bedroom

**Remove by type:**
```
"remove master bedroom"
"remove guest bedroom"
```
→ Removes ALL items from master/guest bedroom

### 2. Remove Item from Specific Bedroom

```
"remove bed from bedroom 2"
"remove wardrobe from master bedroom"
"remove bedside table from bedroom 3"
```
→ Removes only that item type from the specified bedroom

### 3. Only Specific Bedrooms

**Select specific bedrooms:**
```
"only bedroom 1 and bedroom 2"
"only master bedroom and bedroom 2"
"just bedroom 1"
```
→ Creates quotation for ONLY those bedrooms

### 4. Replace Item in Specific Bedroom

```
"replace bed in bedroom 2 with id 12345"
"replace wardrobe in master bedroom with id 67890"
```
→ Replaces item in that specific bedroom

### 5. Exclude Bedrooms

```
"exclude bedroom 3 and bedroom 4"
"without bedroom 2"
"4 BHK exclude 2 bedrooms"  // Results in 2 bedrooms
```
→ Removes those bedrooms from quotation

## Examples

### Example 1: 4 BHK - Only 2 Bedrooms

**Input:**
```
"4 BHK apartment, only bedroom 1 and bedroom 2"
```

**Result:**
- ✅ Master bedroom (bedroom 1) with bed, wardrobe, bedside table, mirror
- ✅ Bedroom 2 with bed, wardrobe, bedside table, mirror
- ❌ Bedroom 3 - not included
- ❌ Bedroom 4 - not included
- ✅ Living, kitchen, bathroom (other rooms still included)

### Example 2: Remove Specific Bedroom

**Initial:** 3 BHK with master bedroom, bedroom 2, bedroom 3

**Command:**
```
"remove bedroom 3"
```

**Result:**
- ✅ Master bedroom - kept
- ✅ Bedroom 2 - kept
- ❌ Bedroom 3 - removed (all items: bed, wardrobe, tables, mirror)

### Example 3: Remove Item from One Bedroom

**Initial:** 2 BHK with master bedroom and bedroom 2

**Command:**
```
"remove wardrobe from bedroom 2"
```

**Result:**
- Master bedroom: bed, wardrobe, bedside table, mirror (unchanged)
- Bedroom 2: bed, ~~wardrobe~~, bedside table, mirror (wardrobe removed)

### Example 4: Mix of Specific and Generic Rooms

**Input:**
```
"only master bedroom, bedroom 2, and living room"
```

**Result:**
- ✅ Master bedroom with items
- ✅ Bedroom 2 with items
- ✅ Living room with items
- ❌ All other bedrooms excluded
- ❌ Kitchen, bathroom, etc. excluded

### Example 5: Floor Plan with Differentiated Bedrooms

**Floor Plan Detects:**
- "master bedroom"
- "guest bedroom"
- "kids bedroom"

**Command:**
```
"remove guest bedroom"
```

**Result:**
- ✅ Master bedroom - kept
- ❌ Guest bedroom - removed
- ✅ Kids bedroom - kept

## UI Display

### Quotation Summary Groups

Bedrooms appear as separate collapsible sections:

```
📦 Master Bedroom
  - Queen Bed (₹38,000)
  - Large Wardrobe (₹45,000)
  - Bedside Table x2 (₹8,000 each)
  - Mirror (₹5,000)

📦 Bedroom 2
  - Medium Bed (₹28,000)
  - Wardrobe (₹35,000)
  - Bedside Table x2 (₹6,000 each)
  - Mirror (₹4,000)

📦 Bedroom 3
  - Medium Bed (₹28,000)
  - Wardrobe (₹35,000)
  - Bedside Table x2 (₹6,000 each)
  - Mirror (₹4,000)
```

Each bedroom is independently selectable and modifiable.

## Technical Details

### Data Structure

**Old Way (Quantity-based):**
```javascript
{
  type: 'bed',
  quantity: 3,  // 3 beds for 3 bedrooms
  room: 'bedroom'
}
```

**New Way (Individual Entries):**
```javascript
[
  { type: 'bed', quantity: 1, room: 'master bedroom' },
  { type: 'bed', quantity: 1, room: 'bedroom 2' },
  { type: 'bed', quantity: 1, room: 'bedroom 3' }
]
```

### Room Naming

- **Master bedroom:** Always named "master bedroom"
- **Additional bedrooms:** "bedroom 2", "bedroom 3", "bedroom 4", "bedroom 5"
- **From floor plan:** Preserves exact names like "guest bedroom", "kids bedroom"

### Command Parsing

The system recognizes:
- `bedroom 1`, `bedroom 2`, `bedroom 3`, etc.
- `master bedroom`, `guest bedroom`, `kids bedroom`
- Numeric references: "bedroom two" → "bedroom 2"

## Benefits

### 1. Granular Control
Remove or modify specific bedrooms without affecting others.

### 2. Realistic Quotations
Master bedroom gets premium items, other bedrooms get standard items.

### 3. Flexible Planning
"I only need furniture for 2 bedrooms in my 4 BHK" → Easy!

### 4. Better UX
Clear separation in UI, easy to understand and modify.

### 5. Property Rules Integration
Each bedroom type (master/guest) gets appropriate items based on rules.

## Command Patterns

### Pattern 1: Selective Inclusion
```
"only [room list]"
"just [room list]"
"[room list] only"
```

Examples:
- "only master bedroom and bedroom 2"
- "just bedroom 1"
- "master bedroom and living room only"

### Pattern 2: Exclusion
```
"exclude [room list]"
"without [room list]"
"remove [room list]"
"except [room list]"
```

Examples:
- "exclude bedroom 3 and bedroom 4"
- "without bedroom 2"
- "4 BHK except 2 bedrooms"

### Pattern 3: Item-Specific
```
"remove [item] from [bedroom]"
"replace [item] in [bedroom] with id [id]"
"add [item] to [bedroom]"
```

Examples:
- "remove wardrobe from bedroom 2"
- "replace bed in master bedroom with id 12345"
- "add bookcase to bedroom 3"

## Testing Checklist

- [ ] 2 BHK creates: master bedroom, bedroom 2
- [ ] 3 BHK creates: master bedroom, bedroom 2, bedroom 3
- [ ] 4 BHK creates: master bedroom, bedroom 2, bedroom 3, bedroom 4
- [ ] "remove bedroom 2" removes all items from bedroom 2
- [ ] "only bedroom 1 and bedroom 2" shows only those 2 bedrooms
- [ ] "remove bed from bedroom 3" removes only bed from bedroom 3
- [ ] Master bedroom gets better items than other bedrooms
- [ ] Floor plan bedrooms preserve their names
- [ ] UI shows separate sections for each bedroom
- [ ] Commands work case-insensitively

## Troubleshooting

### Issue: All bedrooms look the same

**Cause:** Property rules not differentiating master vs other bedrooms

**Fix:** Check `propertyRulesLegacy.js` - master bedroom should get:
- Higher price ranges
- Better size preferences (queen/king vs medium)

### Issue: "remove bedroom 2" doesn't work

**Cause:** Bedroom might be named differently

**Check:** Console log to see actual room names:
```javascript
console.log('Rooms:', selections.map(s => s.line.room))
```

**Fix:** Use exact name from console (e.g., "guest bedroom" instead of "bedroom 2")

### Issue: Can't select specific bedrooms

**Cause:** Command parsing not recognizing bedroom numbers

**Fix:** Use explicit patterns:
- ✅ "only bedroom 1 and bedroom 2"
- ❌ "only bedrooms 1 and 2" (might not parse correctly)

## Future Enhancements

1. **Bathroom Differentiation:**
   - "attached bathroom 1", "attached bathroom 2"
   - "common bathroom"

2. **Custom Bedroom Names:**
   - "master bedroom", "kids room", "guest room", "study room"

3. **Bulk Operations:**
   - "remove all wardrobes from bedrooms"
   - "upgrade all beds in bedrooms"

4. **Room Templates:**
   - "make bedroom 2 same as master bedroom"
   - "copy bedroom 1 to bedroom 3"
