# Debug Guide: Bedroom Removal Not Working

## Issue
User says "remove master bedroom" or "removing master bedroom" but all bedrooms still appear in quotation.

## Debug Steps

### Step 1: Check Console Logs

Open browser DevTools Console and look for these logs:

#### A. Intent Detection
```javascript
[Intent Detection] {
  text: "removing master bedroom",
  hasPriorQuotation: true,
  intent: "ROOM_MODIFICATION",
  isModification: true,
  explanation: "Removing master bedroom from quotation"
}
```

**What to check:**
- ✅ `isModification: true` - Correct, it's a modification
- ✅ `intent: "ROOM_MODIFICATION"` - Correct intent detected

#### B. Deterministic Commands Called
```javascript
[Deterministic Commands] Called with text: "removing master bedroom"
[Deterministic Commands] Input items: 12 items
```

**What to check:**
- ✅ Function is being called
- ✅ Has items to process

#### C. Bedroom Removal Triggered
```javascript
[Deterministic Command] Removing bedroom type: master from 12 items
[Deterministic Command] Removing item: bed from room: master bedroom
[Deterministic Command] Removing item: wardrobe from room: master bedroom
[Deterministic Command] Removing item: table from room: master bedroom
[Deterministic Command] Removing item: mirror from room: master bedroom
[Deterministic Command] Removed 4 items. Remaining: 8
```

**What to check:**
- ✅ Bedroom type extracted correctly: "master"
- ✅ Items being removed
- ✅ Item count decreases

### Step 2: Check Room Names

The removal logic uses `startsWith()` to match room names:

```javascript
if (roomLower.startsWith(`${bedroomType} bedroom`))
```

**Possible mismatches:**
- ❌ Room name: "Master Bedroom" (capital M)
- ❌ Room name: "master_bedroom" (underscore)
- ❌ Room name: "masterbedroom" (no space)
- ✅ Room name: "master bedroom" (lowercase, space)

**To check actual room names:**
```javascript
console.log('Room names:', requested.map(r => r.room))
```

### Step 3: Check When Commands Are Applied

Commands are applied at 3 points:

1. **Line 817** - After loading prior selections
2. **Line 961** - After essentials/baseline
3. **Line 1067** - After minimal fallback

**Check if items are being re-added after removal:**
- Commands remove items
- But then new items might be added by essentials/baseline
- Commands need to run AFTER all item generation

### Step 4: Common Issues

#### Issue 1: Room Name Case Mismatch

**Symptom:** Logs show "Removed 0 items"

**Cause:** Room names are "Master Bedroom" but code checks for "master bedroom"

**Fix:** Already handled - we use `.toLowerCase()` on both sides

#### Issue 2: Commands Run Too Early

**Symptom:** Items removed but reappear

**Cause:** Commands run, then essentials adds items back

**Solution:** Commands run 3 times - last one should stick

#### Issue 3: Regex Not Matching

**Symptom:** No logs about bedroom removal

**Cause:** User text doesn't match regex pattern

**Test patterns:**
```javascript
// These should match:
"remove master bedroom" ✅
"removing master bedroom" ✅
"remove the master bedroom" ✅
"delete master bedroom" ✅
"drop master bedroom" ✅

// These won't match:
"take out master bedroom" ❌
"get rid of master bedroom" ❌
```

#### Issue 4: Prior Quotation Not Detected

**Symptom:** `hasPriorQuotation: false` in logs

**Cause:** Prior selections not being passed

**Check:**
```javascript
console.log('Prior selections:', prior?.selections?.length)
```

## Testing Commands

### Test 1: Simple Removal
```
Message 1: "2 BHK apartment"
[Wait for quotation]

Message 2: "remove master bedroom"
```

**Expected Console Logs:**
```
[Intent Detection] { intent: "ROOM_MODIFICATION", isModification: true }
[Deterministic Commands] Called with text: "remove master bedroom"
[Deterministic Command] Removing bedroom type: master from X items
[Deterministic Command] Removed 4 items. Remaining: Y
```

**Expected Result:** Master bedroom items gone, bedroom 2 remains

### Test 2: Conversational Removal
```
Message 1: "2 BHK apartment"
[Wait for quotation]

Message 2: "now removing the master bedroom"
```

**Expected Console Logs:**
```
[Intent Detection] { intent: "ROOM_MODIFICATION", isModification: true }
[Deterministic Commands] Called with text: "now removing the master bedroom"
[Deterministic Command] Removing bedroom type: master from X items
```

### Test 3: Initial Planning Exclusion
```
Message 1: "2 BHK without master bedroom"
```

**Expected Console Logs:**
```
[Intent Detection] { intent: "INITIAL_REQUEST", isModification: false }
```

**Expected Result:** Only 1 bedroom created from start

## Debugging Checklist

- [ ] Console shows `[Intent Detection]` logs
- [ ] Intent is `ROOM_MODIFICATION` for removal commands
- [ ] `isModification: true` for "removing" commands
- [ ] Console shows `[Deterministic Commands] Called`
- [ ] Console shows `[Deterministic Command] Removing bedroom type: master`
- [ ] Console shows items being removed
- [ ] Removed count > 0
- [ ] Room names match (lowercase, with space)
- [ ] Prior quotation exists (`hasPriorQuotation: true`)
- [ ] Commands run after all item generation

## Quick Fixes

### Fix 1: Add More Removal Verbs

If user says "take out master bedroom":

```javascript
if (/\b(remove|removing|delete|deleting|drop|dropping|take\s+out|get\s+rid\s+of)\s+(the\s+)?(master|guest|kids?)\s+bedroom\b/.test(lower)) {
```

### Fix 2: Case-Insensitive Room Matching

Already implemented:
```javascript
const roomLower = String(out[i].room||'').toLowerCase()
if (roomLower.startsWith(`${bedroomType} bedroom`))
```

### Fix 3: Debug Actual Room Names

Add this log:
```javascript
console.log('[Debug] All room names:', out.map(item => ({
  type: item.type,
  room: item.room,
  roomLower: String(item.room||'').toLowerCase()
})))
```

## Expected Flow

### Successful Removal Flow

1. User: "2 BHK apartment"
2. System creates: master bedroom + bedroom 2
3. User: "remove master bedroom"
4. Intent detector: `ROOM_MODIFICATION`, `isModification: true`
5. Room exclusions: Returns `[]` (empty, because it's modification)
6. Bedrooms created: master bedroom + bedroom 2
7. Deterministic commands: Removes master bedroom items
8. Final result: Only bedroom 2 in quotation

### What You Should See

**In Console:**
```
[Intent Detection] { intent: "ROOM_MODIFICATION", isModification: true }
[Deterministic Commands] Called with text: "remove master bedroom"
[Deterministic Commands] Input items: 12 items
[Deterministic Command] Removing bedroom type: master from 12 items
[Deterministic Command] Removing item: bed from room: master bedroom
[Deterministic Command] Removing item: wardrobe from room: master bedroom
[Deterministic Command] Removing item: table from room: master bedroom
[Deterministic Command] Removing item: mirror from room: master bedroom
[Deterministic Command] Removed 4 items. Remaining: 8
```

**In Quotation:**
- ❌ Master Bedroom section - GONE
- ✅ Bedroom 2 section - PRESENT
- ✅ Living room - PRESENT
- ✅ Kitchen - PRESENT
- ✅ Bathroom - PRESENT

## Still Not Working?

If bedroom removal still doesn't work after checking all above:

1. **Share console logs** - Copy all `[Intent Detection]` and `[Deterministic Command]` logs
2. **Check room names** - Log actual room names from `requested` array
3. **Verify regex** - Test the removal regex pattern manually
4. **Check timing** - Ensure commands run AFTER item generation completes
5. **Inspect final output** - Log the final `requested` array before selection

## Manual Test in Console

```javascript
// Test the regex pattern
const text = "removing the master bedroom"
const lower = text.toLowerCase()
const pattern = /\b(remove|removing|delete|deleting|drop|dropping)\s+(the\s+)?(master|guest|kids?)\s+bedroom\b/
console.log('Pattern matches:', pattern.test(lower))
console.log('Match result:', lower.match(pattern))
```

Expected output:
```
Pattern matches: true
Match result: ["removing the master bedroom", "removing", "the ", "master"]
```
