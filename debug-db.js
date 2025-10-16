import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://rionstehjszgfhijnmsi.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpb25zdGVoanN6Z2ZoaWpubXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc0OTM3NDMsImV4cCI6MjA3MzA2OTc0M30.xu6w_DtrGSiMAXTBDLIRS6NaS5td3B8n8J1jJ3ON9ao'

const supabase = createClient(supabaseUrl, supabaseAnonKey)

async function testDatabase() {
  console.log('Testing database connection...')
  
  try {
    // Test 1: Count total items
    const { count, error: countError } = await supabase
      .from('interior_items')
      .select('*', { count: 'exact', head: true })
    
    if (countError) {
      console.error('Count error:', countError)
      return
    }
    
    console.log(`✅ Total items in database: ${count}`)
    
    // Test 2: Get first 5 items
    const { data: items, error: itemsError } = await supabase
      .from('interior_items')
      .select('id, item_name, price_inr, suggestive_areas, preferred_theme')
      .limit(5)
    
    if (itemsError) {
      console.error('Items error:', itemsError)
      return
    }
    
    console.log('\n✅ Sample items:')
    items.forEach(item => {
      console.log(`- ${item.item_name} (₹${item.price_inr}) - ${item.suggestive_areas}`)
    })
    
    // Test 3: Search for "sofa"
    const { data: sofas, error: sofaError } = await supabase
      .from('interior_items')
      .select('id, item_name, price_inr')
      .ilike('item_name', '%sofa%')
      .limit(3)
    
    if (sofaError) {
      console.error('Sofa search error:', sofaError)
      return
    }
    
    console.log(`\n✅ Found ${sofas.length} sofas:`)
    sofas.forEach(sofa => {
      console.log(`- ${sofa.item_name} (₹${sofa.price_inr})`)
    })
    
    // Test 4: Search for living room items
    const { data: livingItems, error: livingError } = await supabase
      .from('interior_items')
      .select('id, item_name, price_inr, suggestive_areas')
      .ilike('suggestive_areas', '%Living%')
      .limit(3)
    
    if (livingError) {
      console.error('Living room search error:', livingError)
      return
    }
    
    console.log(`\n✅ Found ${livingItems.length} living room items:`)
    livingItems.forEach(item => {
      console.log(`- ${item.item_name} (₹${item.price_inr}) - ${item.suggestive_areas}`)
    })
    
  } catch (error) {
    console.error('❌ Database test failed:', error)
  }
}

testDatabase()
