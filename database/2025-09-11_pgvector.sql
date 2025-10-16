-- Enable pgvector and prepare embeddings for interior_items
BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- 1536 dims for OpenAI text-embedding-3-small. Adjust if you choose a different model.
ALTER TABLE public.interior_items
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Vector index for fast ANN search
CREATE INDEX IF NOT EXISTS idx_interior_items_embedding
  ON public.interior_items
  USING ivfflat (embedding vector_cosine) WITH (lists = 100);

-- Helpful function: normalized text used for embeddings
-- (Safe to re-run: CREATE OR REPLACE)
CREATE OR REPLACE VIEW public.interior_items_embedding_text AS
SELECT
  id,
  trim(
    coalesce(item_name,'') || ' ' ||
    coalesce(item_description,'') || ' ' ||
    coalesce(item_details,'') || ' ' ||
    coalesce(variation_name,'') || ' ' ||
    coalesce(base_material,'') || ' ' ||
    coalesce(finish_material,'') || ' ' ||
    coalesce(keywords,'')
  ) AS embed_text
FROM public.interior_items;

COMMIT;

-- RPC: vector similarity search over interior_items
-- Usage from Supabase JS: supabase.rpc('match_interior_items', { query_embedding: <vector>, match_count: 50 })
CREATE OR REPLACE FUNCTION public.match_interior_items(
  query_embedding vector,
  match_count integer DEFAULT 50
)
RETURNS SETOF public.interior_items
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT *
  FROM public.interior_items
  WHERE embedding IS NOT NULL
  ORDER BY embedding <-> query_embedding
  LIMIT match_count;
$$;
