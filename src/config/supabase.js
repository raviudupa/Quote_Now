import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Debug: Log if environment variables are missing
if (!supabaseUrl || !supabaseAnonKey) {
  console.error('❌ CRITICAL: Supabase environment variables are missing!', {
    url: supabaseUrl ? '✅ Set' : '❌ Missing',
    key: supabaseAnonKey ? '✅ Set' : '❌ Missing'
  })
  console.error('Please add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to Vercel environment variables')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
