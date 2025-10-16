# Property Rules Implementation Guide

## Overview
This implementation adds support for:
1. **Differentiated bedroom/bathroom detection** from floor plans (master/guest/attached/common)
2. **Property-specific rules** from 3 DB tables: `size_and_pricing`, `rules_for_apartment`, `rules_for_villa`
3. **Rule-based item selection** that respects property type, configuration, room subtypes, and pricing constraints

## Database Schema

### Tables Created
Located in: `database/2025-10-11_property_rules.sql`

#### 1. `size_and_pricing`
Defines size ranges and budget tiers for different property configurations.

**Key Fields:**
- `property_type`: 'apartment' or 'villa'
- `configuration`: '1 BHK', '2 BHK', '3 BHK', etc.
- `carpet_area_min/max_sqft`: Carpet area range
- `built_up_area_min/max_sqft`: Built-up area range
- `budget_economy/premium/luxury_min/max_inr`: Budget ranges per tier

**Sample Data:**
- 2 BHK Apartment: 600-900 sqft carpet, ₹400K-600K economy, ₹700K-900K premium, ₹1M-1.2M luxury
- 3 BHK Villa: 1400-2000 sqft carpet, ₹900K-1.2M economy, ₹1.5M-2M premium, ₹2.2M-3M luxury

#### 2. `rules_for_apartment`
Item requirements and constraints for apartment configurations.

**Key Fields:**
- `configuration`: '1 BHK', '2 BHK', etc.
- `room_type`: 'living', 'bedroom', 'bathroom', etc.
- `room_subtype`: 'master', 'guest', 'attached', 'common', etc.
- `item_category`: 'Sofa', 'Bed', 'Wardrobe', etc.
- `item_subcategory`: 'coffee', 'dining', 'bedside', etc.
- `min/max/recommended_quantity`: Quantity constraints
- `size_preference`: 'small', 'medium', 'large', 'queen', 'king'
- `price_range_min/max_inr`: Price constraints
- `priority`: 'essential', 'recommended', 'optional'

**Sample Rules:**
- 2 BHK master bedroom: Queen bed (₹25K-45K), Large wardrobe (₹25K-50K)
- 2 BHK guest bedroom: Medium bed (₹20K-35K), Medium wardrobe (₹20K-40K)
- 2 BHK attached bathroom: Medium washstand (₹10K-18K)
- 2 BHK common bathroom: Medium washstand (₹8K-15K)

#### 3. `rules_for_villa`
Item requirements and constraints for villa configurations (similar structure to apartments but with villa-specific values).

**Sample Rules:**
- 3 BHK Villa living: Large sofa 5+ seater (₹45K-80K)
- 3 BHK Villa master bedroom: King bed (₹40K-70K), 2 Large wardrobes (₹40K-80K each)

### Running the Migration
```bash
psql -U postgres -d interior_quotation -f database/2025-10-11_property_rules.sql
```

## Code Changes

### 1. Floor Plan Detection (`src/services/graph/floorplanLLM.js`)

**Enhanced to detect:**
- Property type: 'apartment' or 'villa'
- Differentiated bedrooms: "master bedroom", "guest bedroom 1", "guest bedroom 2"
- Differentiated bathrooms: "attached bathroom", "common bathroom", "powder room"

**Output Structure:**
```javascript
{
  bhk: 2,
  sqft: 850,
  propertyType: 'apartment',
  rooms: ['living', 'master bedroom', 'guest bedroom', 'attached bathroom', 'common bathroom', 'kitchen'],
  roomDimensions: [
    { room: 'master bedroom', width: 12, height: 10, unit: 'ft' },
    { room: 'attached bathroom', width: 6, height: 8, unit: 'ft' },
    // ...
  ]
}
```

### 2. Property Rules Service (`src/services/propertyRules.js`)

**New Functions:**

#### `parseRoomName(roomName)`
Extracts room type and subtype from room names.
```javascript
parseRoomName('master bedroom') 
// → { type: 'bedroom', subtype: 'master' }

parseRoomName('attached bathroom')
// → { type: 'bathroom', subtype: 'attached' }
```

#### `deriveItemConstraints({ propertyType, bhk, roomName, itemType, itemSubtype })`
Fetches applicable rules for an item in a specific room.
```javascript
await deriveItemConstraints({
  propertyType: 'apartment',
  bhk: 2,
  roomName: 'master bedroom',
  itemType: 'bed',
  itemSubtype: null
})
// Returns:
{
  minQuantity: 1,
  maxQuantity: 1,
  recommendedQuantity: 1,
  sizePreference: 'queen',
  priceMin: 25000,
  priceMax: 45000,
  priority: 'essential',
  notes: 'Queen size bed for master bedroom'
}
```

#### `getSizePricingFor({ propertyType, bhk })`
Gets size and budget info for a configuration.

#### `determineBudgetTier({ propertyType, bhk, totalBudget })`
Determines tier (economy/premium/luxury) based on budget.

### 3. State Flow Updates (`src/services/graph/stateFlow.v2.js`)

**Key Changes:**

1. **Preserve Room Subtypes:**
   - Floor plan rooms are no longer deduplicated
   - "master bedroom" and "guest bedroom" remain separate
   - "attached bathroom" and "common bathroom" remain separate

2. **Conditional Bedroom Expansion:**
   - Generic "bedroom" with qty > 1 expands to "bedroom 1", "bedroom 2" ONLY if floor plan didn't provide differentiated bedrooms
   - If floor plan has "master bedroom" and "guest bedroom", no expansion occurs

3. **Property Context Passed to Selection:**
   ```javascript
   const propertyContext = {
     propertyType: fpPropertyType || 'apartment',
     bhk: fpBhk || bhkFromText || null,
     sqft: areaSqft || null,
     budget: budget || null
   }
   ```

### 4. Item Selection (`src/services/aiService.v2.js`)

**Enhanced `findBestItem()` to:**

1. **Derive Rule Constraints:**
   ```javascript
   const ruleConstraints = await deriveItemConstraints({
     propertyType: propCtx.propertyType,
     bhk: propCtx.bhk,
     roomName,
     itemType: type,
     itemSubtype
   })
   ```

2. **Apply Price Constraints:**
   - Uses `ruleConstraints.priceMax` if available
   - Falls back to pipeline caps or global filters

3. **Apply Size Preferences:**
   - For beds: Filters by 'queen', 'king', 'super_king'
   - For other items: Filters by 'small', 'medium', 'large'
   - Example: Master bedroom bed rule with `sizePreference: 'queen'` will prefer items with "queen" in description

## Usage Examples

### Example 1: 2 BHK Apartment with Floor Plan

**Input:**
- Floor plan image showing: living, master bedroom, guest bedroom, attached bathroom, common bathroom, kitchen
- User text: "2 BHK apartment, modern style"

**Processing:**
1. Floor plan detection identifies:
   - `propertyType: 'apartment'`
   - `bhk: 2`
   - Rooms: `['living', 'master bedroom', 'guest bedroom', 'attached bathroom', 'common bathroom', 'kitchen']`

2. For "master bedroom" bed:
   - Rule fetched: 2 BHK apartment, bedroom (master), Bed
   - Constraints: `{ sizePreference: 'queen', priceMin: 25000, priceMax: 45000 }`
   - Selection filters for queen beds within ₹25K-45K

3. For "guest bedroom" bed:
   - Rule fetched: 2 BHK apartment, bedroom (guest), Bed
   - Constraints: `{ sizePreference: 'medium', priceMin: 20000, priceMax: 35000 }`
   - Selection filters for medium beds within ₹20K-35K

4. For "attached bathroom" washstand:
   - Rule fetched: 2 BHK apartment, bathroom (attached), Wash-stand
   - Constraints: `{ sizePreference: 'medium', priceMin: 10000, priceMax: 18000 }`

5. For "common bathroom" washstand:
   - Rule fetched: 2 BHK apartment, bathroom (common), Wash-stand
   - Constraints: `{ sizePreference: 'medium', priceMin: 8000, priceMax: 15000 }`

**Result:**
- Master bedroom gets higher-quality queen bed
- Guest bedroom gets appropriate medium bed
- Attached bathroom gets premium washstand
- Common bathroom gets standard washstand
- All selections respect property-specific rules

### Example 2: 3 BHK Villa

**Input:**
- Floor plan showing villa layout with garden
- User text: "3 BHK villa, luxury budget"

**Processing:**
1. Floor plan detection:
   - `propertyType: 'villa'`
   - `bhk: 3`

2. Living room sofa:
   - Rule: 3 BHK Villa, living, Sofa
   - Constraints: `{ sizePreference: 'large', priceMin: 45000, priceMax: 80000 }`
   - Selection prefers 5+ seater or sectional sofas

3. Master bedroom:
   - Bed rule: `{ sizePreference: 'king', priceMin: 40000, priceMax: 70000 }`
   - Wardrobe rule: `{ recommendedQuantity: 2, sizePreference: 'large', priceMin: 40000, priceMax: 80000 }`

## Testing

### 1. Database Setup
```bash
# Run migration
psql -U postgres -d interior_quotation -f database/2025-10-11_property_rules.sql

# Verify tables
psql -U postgres -d interior_quotation -c "\dt"
# Should show: size_and_pricing, rules_for_apartment, rules_for_villa

# Check sample data
psql -U postgres -d interior_quotation -c "SELECT * FROM size_and_pricing;"
psql -U postgres -d interior_quotation -c "SELECT * FROM rules_for_apartment WHERE configuration = '2 BHK';"
```

### 2. Test Floor Plan Detection
Upload a 2 BHK floor plan and check console logs:
```javascript
// Should see in console:
[v2] fpPropertyType= apartment
[v2] fpRooms= ['living', 'master bedroom', 'guest bedroom', 'attached bathroom', 'common bathroom', 'kitchen']
```

### 3. Test Rule Application
Check browser console during item selection:
```javascript
// Should see constraints being applied:
[aiService.v2] ruleConstraints= {
  sizePreference: 'queen',
  priceMin: 25000,
  priceMax: 45000,
  priority: 'essential'
}
```

### 4. Verify Different Selections
Compare items selected for:
- Master bedroom vs Guest bedroom (should differ in quality/size)
- Attached bathroom vs Common bathroom (should differ in pricing)
- 2 BHK apartment vs 3 BHK villa (should differ significantly)

## Benefits

1. **Accurate Room Differentiation:**
   - Master bedrooms get premium items (queen/king beds, larger wardrobes)
   - Guest bedrooms get appropriate standard items
   - Attached bathrooms get better fixtures than common bathrooms

2. **Property-Aware Pricing:**
   - Villas automatically get higher budget allocations
   - Larger BHK configurations get premium items
   - Budget tiers (economy/premium/luxury) applied correctly

3. **Scalable Rule Management:**
   - Rules stored in database, easy to update
   - No code changes needed to adjust pricing or preferences
   - Can add new property types or configurations easily

4. **Better User Experience:**
   - More realistic quotations matching property type
   - Appropriate item quality per room importance
   - Respects industry standards for different property segments

## Future Enhancements

1. **Admin UI for Rules:**
   - Create interface to manage rules without SQL
   - Bulk import/export of rules
   - Version control for rule changes

2. **Regional Variations:**
   - Add `region` field to rules (metro/tier1/tier2 cities)
   - Adjust pricing based on location

3. **Custom Property Types:**
   - Support for penthouse, duplex, farmhouse
   - Commercial properties (office, retail)

4. **Machine Learning Integration:**
   - Learn from user selections to refine rules
   - Predict optimal item combinations
   - Personalized recommendations based on history

## Troubleshooting

### Issue: Rules not being applied
**Check:**
1. Database tables exist and have data
2. `propertyContext` is being passed in filters
3. Console logs show `ruleConstraints` being derived
4. Room names match between floor plan and rules table

### Issue: Wrong items selected
**Check:**
1. `room_subtype` in rules matches floor plan output
2. Price ranges in rules are reasonable
3. Size preferences match item descriptions in catalog
4. Category mapping in `aiService.v2.resolveCategory()` is correct

### Issue: Floor plan not detecting subtypes
**Check:**
1. `VITE_USE_VISION_FLOORPLAN=true` in `.env`
2. OpenAI API key is valid
3. Floor plan image is clear and labeled
4. Console shows vision stage output with `propertyType` and differentiated rooms

## API Reference

### propertyRules.js

```javascript
// Parse room name
parseRoomName(roomName: string): { type: string, subtype: string|null }

// Get constraints for item
deriveItemConstraints({
  propertyType: 'apartment'|'villa',
  bhk: number,
  roomName: string,
  itemType: string,
  itemSubtype?: string
}): Promise<Constraints|null>

// Get size/pricing info
getSizePricingFor({
  propertyType: 'apartment'|'villa',
  bhk: number
}): Promise<SizePricing|null>

// Determine budget tier
determineBudgetTier({
  propertyType: 'apartment'|'villa',
  bhk: number,
  totalBudget: number
}): Promise<'economy'|'premium'|'luxury'>
```

### Database Schema

```sql
-- Query rules for specific room
SELECT * FROM rules_for_apartment 
WHERE configuration = '2 BHK' 
  AND room_type = 'bedroom' 
  AND room_subtype = 'master'
  AND item_category = 'Bed';

-- Query size/pricing
SELECT * FROM size_and_pricing 
WHERE property_type = 'apartment' 
  AND configuration = '2 BHK';
```
