/*
 Backfill embeddings for interior_items using OpenAI embeddings.
 Usage:
   node scripts/backfill-embeddings.js
 Requires env:
   - VITE_SUPABASE_URL
   - VITE_SUPABASE_SERVICE_ROLE (recommended) or VITE_SUPABASE_ANON_KEY (will be blocked by RLS if enabled)
   - VITE_OPENAI_API_KEY
*/

import 'dotenv/config'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_SERVICE_ROLE || process.env.VITE_SUPABASE_ANON_KEY
const OPENAI_API_KEY = process.env.VITE_OPENAI_API_KEY

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
  console.error('Missing env: VITE_SUPABASE_URL, VITE_SUPABASE_SERVICE_ROLE/ANON_KEY, VITE_OPENAI_API_KEY')
  process.exit(1)
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const MODEL = 'text-embedding-3-small' // 1536 dims

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchBatch(offset = 0, limit = 100) {
  const { data, error } = await supabase
    .from('interior_items')
    .select('id, item_name, item_description, item_details, variation_name, base_material, finish_material, keywords, embedding')
    .is('embedding', null)
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) throw error
  return data
}

function buildText(row) {
  return [
    row.item_name,
    row.item_description,
    row.item_details,
    row.variation_name,
    row.base_material,
    row.finish_material,
    row.keywords,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

async function embed(texts) {
  const res = await openai.embeddings.create({
    model: MODEL,
    input: texts
  })
  return res.data.map(d => d.embedding)
}

async function saveEmbedding(id, vector) {
  const { error } = await supabase
    .from('interior_items')
    .update({ embedding: vector })
    .eq('id', id)
  if (error) throw error
}

async function main() {
  console.log('Starting embeddings backfill...')
  let offset = 0
  const batchSize = 64
  while (true) {
    const rows = await fetchBatch(offset, batchSize)
    if (!rows || rows.length === 0) break

    const texts = rows.map(buildText)
    const vectors = await embed(texts)

    for (let i = 0; i < rows.length; i++) {
      await saveEmbedding(rows[i].id, vectors[i])
    }

    offset += batchSize
    console.log(`Embedded ${offset} items...`)
    await sleep(200)
  }
  console.log('Done.')
}

main().catch(err => { console.error(err); process.exit(1) })
