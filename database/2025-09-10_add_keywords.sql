-- Migration: add searchable keywords to interior_items
ALTER TABLE interior_items
  ADD COLUMN IF NOT EXISTS keywords TEXT,
  ADD COLUMN IF NOT EXISTS price_tier TEXT; -- e.g., Economy / Premium / Luxury (normalized)

-- Backfill price_tier from existing packages (first match wins)
UPDATE interior_items
SET price_tier = CASE
  WHEN packages ILIKE '%Luxury%' THEN 'Luxury'
  WHEN packages ILIKE '%Premium%' THEN 'Premium'
  WHEN packages ILIKE '%Economy%' THEN 'Economy'
  ELSE NULL
END
WHERE price_tier IS NULL;

-- Optional: backfill keywords from existing columns (simple concatenation)
UPDATE interior_items
SET keywords = trim(both ' ' from (
  coalesce(item_name,'') || ' ' ||
  coalesce(item_details,'') || ' ' ||
  coalesce(variation_name,'') || ' ' ||
  coalesce(base_material,'') || ' ' ||
  coalesce(finish_material,'') || ' ' ||
  coalesce(preferred_theme,'') || ' ' ||
  coalesce(suggestive_areas,'') || ' ' ||
  coalesce(packages,'')
))
WHERE keywords IS NULL;

-- Add full text index for fast search over keywords and descriptions
CREATE INDEX IF NOT EXISTS idx_interior_items_keywords ON interior_items USING GIN (to_tsvector('english', keywords));

-- Lightweight check
-- SELECT id, left(keywords, 200) FROM interior_items LIMIT 5;
