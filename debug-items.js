import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://rionstehjszgfhijnmsi.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpb25zdGVoanN6Z2ZoaWpubXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc0OTM3NDMsImV4cCI6MjA3MzA2OTc0M30.xu6w_DtrGSiMAXTBDLIRS6NaS5td3B8n8J1jJ3ON9ao'

const supabase = createClient(supabaseUrl, supabaseAnonKey)

async function checkItemDetails() {
  console.log('Checking item details...')
  
  try {
    // Get items with detailed info
    const { data: items, error } = await supabase
      .from('interior_items')
      .select('item_name, item_description, item_details, preferred_theme, suggestive_areas, price_inr')
      .limit(10)
    
    if (error) {
      console.error('Error:', error)
      return
    }
    
    console.log('\n📋 Sample items with full details:')
    items.forEach((item, index) => {
      console.log(`\n${index + 1}. ${item.item_name}`)
      console.log(`   Description: ${item.item_description}`)
      console.log(`   Details: ${item.item_details}`)
      console.log(`   Areas: ${item.suggestive_areas}`)
      console.log(`   Themes: ${item.preferred_theme}`)
      console.log(`   Price: ₹${item.price_inr}`)
    })
    
    // Search for items containing "sofa" in description
    const { data: sofaItems, error: sofaError } = await supabase
      .from('interior_items')
      .select('item_name, item_description, price_inr')
      .or('item_description.ilike.%sofa%,item_details.ilike.%sofa%')
      .limit(5)
    
    if (sofaError) {
      console.error('Sofa search error:', sofaError)
      return
    }
    
    console.log(`\n🛋️ Found ${sofaItems.length} items with "sofa" in description:`)
    sofaItems.forEach(item => {
      console.log(`- ${item.item_name}: ${item.item_description} (₹${item.price_inr})`)
    })
    
  } catch (error) {
    console.error('❌ Failed:', error)
  }
}

checkItemDetails()
