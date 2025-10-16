import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// You'll need to set these environment variables
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY // Use service key for admin operations

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Please set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

// Function to parse CSV
function parseCSV(csvContent) {
  const lines = csvContent.split('\n')
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''))
  const data = []

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    
    const values = []
    let currentValue = ''
    let insideQuotes = false
    
    for (let j = 0; j < lines[i].length; j++) {
      const char = lines[i][j]
      
      if (char === '"') {
        insideQuotes = !insideQuotes
      } else if (char === ',' && !insideQuotes) {
        values.push(currentValue.trim())
        currentValue = ''
      } else {
        currentValue += char
      }
    }
    values.push(currentValue.trim()) // Add the last value
    
    if (values.length >= headers.length) {
      const row = {}
      headers.forEach((header, index) => {
        row[header] = values[index] || ''
      })
      data.push(row)
    }
  }
  
  return data
}

// Function to clean and transform data
function transformData(rawData) {
  return rawData.map(row => {
    // Clean price data
    let priceInr = 0
    if (row['Price(INR)']) {
      const priceStr = row['Price(INR)'].replace(/[^\d,]/g, '')
      priceInr = parseInt(priceStr.replace(/,/g, '')) || 0
    }

    // Clean dimensions
    const lengthFt = parseFloat(row['Length l(ft)']) || null
    const widthFt = parseFloat(row['Width w(ft)']) || null
    const heightFt = parseFloat(row['Height h(ft)']) || null

    return {
      sl_no: parseInt(row['Sl no.']) || null,
      item_name: row['Item Name'] || '',
      item_image: row['Item Image'] || '',
      item_details: row['Item Details'] || '',
      variation_name: row['Variation Name'] || '',
      base_material: row['Base material'] || '',
      finish_material: row['Finish material'] || '',
      suggestive_areas: row['Suggestive Areas'] || '',
      packages: row['Packages'] || '',
      length_ft: lengthFt,
      width_ft: widthFt,
      height_ft: heightFt,
      price_rule: row['Price rule'] || '',
      rate_inr: row['Rate(INR)'] || '',
      price_inr: priceInr,
      preferred_theme: row['Prefered Theme'] || '',
      item_description: row['Item Description'] || '',
      item_link: row['Item link'] || ''
    }
  })
}

async function importData() {
  try {
    console.log('Starting CSV import...')
    
    // Read CSV file
    const csvPath = path.join(__dirname, '../../quotes_ai/Ikea- Item list - 10_10_25 (1).csv')
    const csvContent = fs.readFileSync(csvPath, 'utf-8')
    
    console.log('Parsing CSV data...')
    const rawData = parseCSV(csvContent)
    console.log(`Parsed ${rawData.length} rows`)
    
    console.log('Transforming data...')
    const transformedData = transformData(rawData)
    
    console.log('Inserting data into Supabase...')
    
    // Insert data in batches to avoid timeout
    const batchSize = 50
    let totalInserted = 0
    
    for (let i = 0; i < transformedData.length; i += batchSize) {
      const batch = transformedData.slice(i, i + batchSize)
      
      const { data, error } = await supabase
        .from('interior_items')
        .insert(batch)
      
      if (error) {
        console.error(`Error inserting batch ${Math.floor(i/batchSize) + 1}:`, error)
        continue
      }
      
      totalInserted += batch.length
      console.log(`Inserted batch ${Math.floor(i/batchSize) + 1} - Total: ${totalInserted}`)
    }
    
    console.log(`✅ Successfully imported ${totalInserted} items!`)
    
  } catch (error) {
    console.error('❌ Error importing data:', error)
  }
}

// Run the import
importData()
