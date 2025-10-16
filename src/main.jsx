import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Debug: Check environment variables
console.log('🔍 Environment Variables Check:', {
  SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL ? '✅ Loaded' : '❌ Missing',
  SUPABASE_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY ? '✅ Loaded' : '❌ Missing',
  OPENAI_KEY: import.meta.env.VITE_OPENAI_API_KEY ? '✅ Loaded' : '❌ Missing',
  PLANS_BUCKET: import.meta.env.VITE_PLANS_BUCKET || 'plans',
  USE_VISION: import.meta.env.VITE_USE_VISION_FLOORPLAN || 'not set'
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
