# Testing Legacy Rules Integration

## Setup Complete ✅

The system is now configured to use your existing database tables:
- `rules_for_apartment` (with columns: space, item, 1bhk, 2bhk, 3bhk, 4bhk/4.5bhk/5bhk)
- `size_and_pricing` (with your existing structure)

## How to Test

### 1. Check Console Logs

When you upload a floor plan or create a quotation, check the browser console for:

```javascript
// Should see property context being passed:
[v2] propertyContext= {
  propertyType: 'apartment',
  bhk: 2,
  sqft: 850,
  budget: 500000
}

// Should see rule constraints being derived:
[aiService.v2] deriveItemConstraints called for: master bedroom, bed
[propertyRulesLegacy] Found rule: Living (Main) - Sofa-Large/ Sectional sofa
[propertyRulesLegacy] Constraints: { 
  recommendedQuantity: 1, 
  sizePreference: '3-seater',
  priceMin: 25000,
  priceMax: 45000
}
```

### 2. Test Different Room Types

Upload a 2 BHK floor plan and verify:

**Master Bedroom:**
- Should get queen bed (₹25K-45K range)
- Should get larger wardrobe

**Guest Bedroom:**
- Should get medium bed (₹20K-35K range)
- Should get standard wardrobe

**Living Room:**
- Should get 3-seater sofa for 2 BHK
- Should get 3-seater sofa for 3 BHK
- Should get TV unit (4ft-6ft based on BHK)

### 3. Test BHK Scaling

Try different configurations:

**1 BHK:**
- Living: 2-seater sofa
- Bedroom: 1 bed, 1 wardrobe

**2 BHK:**
- Living: 3-seater sofa
- Master bedroom: Queen bed
- Guest bedroom: Medium bed

**3 BHK:**
- Living: 3-seater sofa
- TV unit: 6ft-8ft
- 3 bedrooms with appropriate items

**4 BHK:**
- Living: 3-seater sofa (or sectional if available)
- TV unit: 8ft-10ft
- 4 bedrooms with premium items

### 4. Verify Database Queries

Open browser DevTools > Network tab and check Supabase queries:

```sql
-- Should see queries like:
SELECT * FROM rules_for_apartment WHERE space ILIKE '%living%' AND item ILIKE '%sofa%'

SELECT * FROM size_and_pricing WHERE property_type = 'apartment' AND configuration LIKE '%2 BHK%'
```

### 5. Test Room Differentiation

**With Floor Plan Detection:**
1. Upload floor plan showing "master bedroom" and "guest bedroom"
2. Check that items selected are different for each
3. Master should get higher-quality items

**Without Floor Plan:**
1. Type "2 BHK apartment"
2. Should create generic "bedroom 1" and "bedroom 2"
3. Both get similar items (no differentiation)

## Expected Behavior

### Scenario 1: 2 BHK with Floor Plan
```
Input: Floor plan image + "modern style"
Detected: master bedroom, guest bedroom, attached bathroom, common bathroom

Master Bedroom Bed:
- Rule from: rules_for_apartment WHERE space='bedroom' AND item='Bed' AND 2bhk column
- Constraints: Queen size, ₹25K-45K
- Selected: Queen bed at ₹38,000

Guest Bedroom Bed:
- Same rule but adjusted for guest subtype
- Constraints: Medium size, ₹20K-35K
- Selected: Medium bed at ₹28,000

Attached Bathroom Washstand:
- Constraints: ₹10K-18K
- Selected: Premium washstand at ₹15,000

Common Bathroom Washstand:
- Constraints: ₹8K-15K
- Selected: Standard washstand at ₹12,000
```

### Scenario 2: 3 BHK Apartment (Text Only)
```
Input: "3 BHK apartment, budget 800000"
No floor plan, so generic bedrooms created

Living Room Sofa:
- Rule: 3bhk column shows "3-seater"
- Constraints: ₹40K-70K
- Selected: 3-seater sofa at ₹55,000

Bedroom 1, 2, 3 (all similar):
- Each gets bed, wardrobe, bedside table
- No differentiation without floor plan
```

## Troubleshooting

### Issue: Rules not being applied

**Check:**
1. Table names are correct: `rules_for_apartment`, `size_and_pricing`
2. Column names match: `space`, `item`, `1bhk`, `2bhk`, `3bhk`, `4bhk/4.5bhk/5bhk`
3. Console shows no errors from `propertyRulesLegacy.js`

**Fix:**
```javascript
// Check in browser console:
const { rules } = await loadPropertyRules()
console.log('Rules loaded:', rules.length)
console.log('Sample rule:', rules[0])
```

### Issue: Wrong items selected

**Check:**
1. `space` column values match room types (e.g., "Living (Main)", "Foyer", "Bedroom")
2. `item` column values match item categories
3. BHK column has valid values (not "No" for essential items)

**Fix:**
Update `ITEM_MAP` in `propertyRulesLegacy.js` to match your exact item names.

### Issue: Price ranges too low/high

**Check:**
1. `deriveItemConstraints()` price calculation logic
2. BHK multipliers for different room subtypes

**Fix:**
Adjust the price ranges in `propertyRulesLegacy.js` lines 160-185:
```javascript
if (roomType === 'bedroom' && itemType === 'bed') {
  if (roomSubtype === 'master') {
    priceMin = bhk >= 3 ? 35000 : 25000  // Adjust these values
    priceMax = bhk >= 3 ? 60000 : 45000
  }
}
```

### Issue: Floor plan not detecting subtypes

**Check:**
1. `VITE_USE_VISION_FLOORPLAN=true` in `.env`
2. OpenAI API key is valid
3. Floor plan image is clear

**Fix:**
Test with a clear, labeled floor plan that explicitly shows "Master Bedroom", "Guest Bedroom", etc.

## Next Steps

1. **Test with Real Data:**
   - Upload various floor plans
   - Try different BHK configurations
   - Compare quotations

2. **Fine-tune Prices:**
   - Adjust price ranges in `propertyRulesLegacy.js`
   - Update based on actual market rates

3. **Add More Rules:**
   - Add rows to `rules_for_apartment` for missing items
   - Add villa rules to `rules_for_villa` table

4. **Monitor Performance:**
   - Check query times in Network tab
   - Verify caching is working (10-minute cache)

## Success Criteria

✅ Master bedroom gets better items than guest bedroom
✅ Attached bathroom gets better fixtures than common bathroom
✅ 3 BHK gets larger furniture than 2 BHK
✅ Price ranges respect your existing rules table
✅ No errors in console
✅ Quotations look realistic and appropriate for property type

## Support

If you encounter issues:
1. Check browser console for errors
2. Verify database table structure matches expectations
3. Test with simple cases first (2 BHK apartment)
4. Gradually add complexity (floor plans, multiple rooms)
