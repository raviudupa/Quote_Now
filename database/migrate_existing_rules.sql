-- Migration script to transform existing rules into new structure
-- This preserves your existing data while adding support for room subtypes

-- First, let's check if you want to keep both structures or migrate
-- If migrating, backup your existing tables first:
-- CREATE TABLE rules_for_apartment_backup AS SELECT * FROM rules_for_apartment;
-- CREATE TABLE size_and_pricing_backup AS SELECT * FROM size_and_pricing;

-- Transform existing rules_for_apartment data to new structure
-- This script assumes your existing table has columns: space, item, 1bhk, 2bhk, 3bhk, 4bhk

-- Example transformation for Living (Main) rules
INSERT INTO rules_for_apartment (configuration, room_type, room_subtype, item_category, item_subcategory, 
  min_quantity, max_quantity, recommended_quantity, size_preference, priority, notes, active)
SELECT 
  CASE 
    WHEN "1bhk" IS NOT NULL AND "1bhk" != 'No' THEN '1 BHK'
    WHEN "2bhk/2.5bhk" IS NOT NULL AND "2bhk/2.5bhk" != 'No' THEN '2 BHK'
    WHEN "3bhk/3.5bhk" IS NOT NULL AND "3bhk/3.5bhk" != 'No' THEN '3 BHK'
    WHEN "4bhk/4.5bhk/5bhk" IS NOT NULL AND "4bhk/4.5bhk/5bhk" != 'No' THEN '4 BHK'
  END as configuration,
  LOWER(REPLACE(space, ' (Main)', '')) as room_type,
  NULL as room_subtype, -- Will need manual mapping for master/guest/attached/common
  item as item_category,
  NULL as item_subcategory,
  CASE 
    WHEN "1bhk" ~ '^\d+$' THEN "1bhk"::integer
    WHEN "2bhk/2.5bhk" ~ '^\d+$' THEN "2bhk/2.5bhk"::integer
    WHEN "3bhk/3.5bhk" ~ '^\d+$' THEN "3bhk/3.5bhk"::integer
    WHEN "4bhk/4.5bhk/5bhk" ~ '^\d+$' THEN "4bhk/4.5bhk/5bhk"::integer
    ELSE 1
  END as min_quantity,
  NULL as max_quantity,
  CASE 
    WHEN "1bhk" ~ '^\d+$' THEN "1bhk"::integer
    WHEN "2bhk/2.5bhk" ~ '^\d+$' THEN "2bhk/2.5bhk"::integer
    WHEN "3bhk/3.5bhk" ~ '^\d+$' THEN "3bhk/3.5bhk"::integer
    WHEN "4bhk/4.5bhk/5bhk" ~ '^\d+$' THEN "4bhk/4.5bhk/5bhk"::integer
    ELSE 1
  END as recommended_quantity,
  CASE
    WHEN item LIKE '%Sofa%' AND ("1bhk" LIKE '%seater%' OR "2bhk/2.5bhk" LIKE '%seater%') THEN 
      REGEXP_REPLACE(COALESCE("1bhk", "2bhk/2.5bhk", "3bhk/3.5bhk", "4bhk/4.5bhk/5bhk"), '[^0-9-]', '', 'g')
    WHEN item LIKE '%TV unit%' AND ("1bhk" LIKE '%ft%' OR "2bhk/2.5bhk" LIKE '%ft%') THEN
      REGEXP_REPLACE(COALESCE("1bhk", "2bhk/2.5bhk", "3bhk/3.5bhk", "4bhk/4.5bhk/5bhk"), '[^0-9-]', '', 'g')
    ELSE NULL
  END as size_preference,
  'recommended' as priority,
  'Migrated from existing rules' as notes,
  true as active
FROM rules_for_apartment_old -- Your existing table
WHERE space IS NOT NULL AND item IS NOT NULL;

-- Manual mapping for room subtypes (you'll need to customize this)
-- Example: Differentiate bedrooms
UPDATE rules_for_apartment 
SET room_subtype = 'master'
WHERE room_type = 'bedroom' 
  AND item_category IN ('Bed', 'Wardrobe')
  AND configuration IN ('2 BHK', '3 BHK', '4 BHK');

-- Add guest bedroom rules by duplicating master with adjusted values
INSERT INTO rules_for_apartment (configuration, room_type, room_subtype, item_category, 
  min_quantity, recommended_quantity, size_preference, priority, notes, active)
SELECT 
  configuration,
  room_type,
  'guest' as room_subtype,
  item_category,
  min_quantity,
  CASE 
    WHEN configuration = '2 BHK' THEN recommended_quantity - 1
    WHEN configuration = '3 BHK' THEN recommended_quantity - 1
    ELSE recommended_quantity
  END as recommended_quantity,
  CASE 
    WHEN size_preference = 'queen' THEN 'medium'
    WHEN size_preference = 'king' THEN 'queen'
    ELSE size_preference
  END as size_preference,
  priority,
  'Derived from master bedroom rules' as notes,
  active
FROM rules_for_apartment
WHERE room_type = 'bedroom' AND room_subtype = 'master';

-- Add bathroom subtype differentiation
UPDATE rules_for_apartment 
SET room_subtype = 'attached'
WHERE room_type = 'bathroom' 
  AND item_category = 'Wash-stand'
  AND configuration IN ('2 BHK', '3 BHK', '4 BHK');

INSERT INTO rules_for_apartment (configuration, room_type, room_subtype, item_category,
  min_quantity, recommended_quantity, price_range_min_inr, price_range_max_inr, priority, notes, active)
SELECT 
  configuration,
  room_type,
  'common' as room_subtype,
  item_category,
  min_quantity,
  recommended_quantity,
  ROUND(price_range_min_inr * 0.8) as price_range_min_inr, -- 20% lower for common
  ROUND(price_range_max_inr * 0.8) as price_range_max_inr,
  priority,
  'Derived from attached bathroom rules with reduced pricing' as notes,
  active
FROM rules_for_apartment
WHERE room_type = 'bathroom' AND room_subtype = 'attached';

-- Verify migration
SELECT configuration, room_type, room_subtype, item_category, 
       min_quantity, recommended_quantity, size_preference, priority
FROM rules_for_apartment
ORDER BY configuration, room_type, room_subtype, item_category;
