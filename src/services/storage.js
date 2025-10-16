import { supabase } from '../config/supabase.js'

export async function uploadToBucket(file, { bucket = null, pathPrefix = '' } = {}) {
  const bucketName = bucket || (import.meta.env.VITE_PLANS_BUCKET || 'plans')
  const name = `${Date.now()}-${Math.random().toString(36).slice(2)}-${file.name}`
  const fullPath = `${pathPrefix}${name}`
  const { data, error } = await supabase.storage.from(bucketName).upload(fullPath, file, { upsert: false, cacheControl: '3600' })
  if (error) {
    const msg = (error?.message || '').toLowerCase()
    if (msg.includes('bucket') && msg.includes('not found')) {
      throw new Error(`Supabase Storage bucket "${bucketName}" not found. Please create it in your Supabase project (public read) or set VITE_PLANS_BUCKET to an existing bucket name.`)
    }
    throw error
  }
  const { data: pub } = supabase.storage.from(bucketName).getPublicUrl(fullPath)
  return { path: fullPath, url: pub.publicUrl }
}
