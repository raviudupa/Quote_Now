import React, { useState, useRef, useEffect } from 'react'
import {
  Box,
  Button,
  Card,
  CardContent,
  CardActions,
  Container,
  Divider,
  IconButton,
  InputBase,
  List,
  ListItem,
  ListItemText,
  Avatar,
  Paper,
  Stack,
  TextField,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  Chip,
  Tooltip,
  Backdrop,
  Grid,
  CardMedia
} from '@mui/material'
import {
  Send as SendIcon,
  SupportAgent as BotIcon,
  Person as PersonIcon,
  Home as HomeIcon,
  Image as ImageIcon,
  Weekend as LivingIcon,
  Hotel as BedroomIcon,
  Kitchen as KitchenIcon,
  Shower as BathroomIcon,
  Restaurant as DiningIcon,
  MeetingRoom as StudyIcon,
  DoorFront as FoyerIcon,
  Balcony as BalconyIcon
} from '@mui/icons-material'
import aiService from '../services/aiService.v2.js'
import { uploadToBucket } from '../services/storage'
import { loadStyles } from '../services/styles.js'

// Lightweight client-side parser to preview which rooms will be used from the user's text
const parseRoomIntentClient = (text) => {
  const t = String(text || '').toLowerCase()
  const positives = []
  const negatives = []
  const add = (arr, r) => { if (r && !arr.includes(r)) arr.push(r) }
  const pos = [
    { re: /\bliving\s*room\b|\bliving\b|\blounge\b|\bhall\b/, key: 'living' },
    { re: /\bbed\s*room\b|\bbedrooms?\b|\bmaster\s*bed(room)?\b|\bguest\s*room\b/, key: 'bedroom' },
    { re: /\bkitchen\b/, key: 'kitchen' },
    { re: /\bbath(room)?\b|\bwashroom\b|\btoilet\b|\bwc\b|\brestroom\b|\blavatory\b/, key: 'bathroom' },
    { re: /\bdining\b|\bdining\s*room\b/, key: 'dining' },
    { re: /\bfoyer\b|\bentry\b|\bentrance\b|\blobby\b/, key: 'foyer' },
    { re: /\bstudy\b|\boffice\b|\bwork\s*station\b/, key: 'study' },
    { re: /\bbalcony\b|\bveranda\b|\bpatio\b|\bterrace\b/, key: 'balcony' },
    { re: /\butility\b|\blaundry\b/, key: 'utility' }
  ]
  // Detect negatives first by capturing the clause after the negative trigger
  const trig = /(without|except|exclude|excluding|not\s+including|no)\s+([^\.\;\n]+)/gi
  const negCandidates = [
    { re: /\bliving(?:\s*room)?\b/, key: 'living' },
    { re: /\bbed\s*room\b|\bbedrooms?\b|\bmaster\s*bed(?:room)?\b|\bguest\s*room\b/, key: 'bedroom' },
    { re: /\bkitchen\b/, key: 'kitchen' },
    { re: /\bbath(?:room)?\b|\bwashroom\b|\btoilet\b|\bwc\b|\brestroom\b|\blavatory\b/, key: 'bathroom' },
    { re: /\bdining(?:\s*room)?\b/, key: 'dining' },
    { re: /\bfoyer\b|\bentry\b|\bentrance\b|\blobby\b/, key: 'foyer' },
    { re: /\bstudy\b|\boffice\b|\bwork\s*station\b/, key: 'study' },
    { re: /\bbalcony\b|\bveranda\b|\bpatio\b|\bterrace\b/, key: 'balcony' },
    { re: /\butility\b|\blaundry\b/, key: 'utility' }
  ]
  let m
  while ((m = trig.exec(t)) !== null) {
    const clause = m[2] || ''
    for (const c of negCandidates) if (c.re.test(clause)) add(negatives, c.key)
  }

  // Explore-more handler: open Alternatives modal for a synthetic selection derived from label and room
  const handleExploreCategory = async ({ room, label, filters }) => {
    try {
      const t = labelToType(label)
      if (!t) return
      // Basic subtype heuristics from label
      const lower = String(label||'').toLowerCase()
      const specifications = {}
      if (t === 'table') {
        if (/coffee/.test(lower)) specifications.subtype = 'coffee'
        else if (/bedside/.test(lower)) specifications.subtype = 'bedside'
        else if (/side/.test(lower)) specifications.subtype = 'side'
        else if (/dining/.test(lower)) specifications.subtype = 'dining'
      }
      const syntheticSel = { line: { type: t, specifications, room }, item: null }
      setAltLoading(true)
      setAltOpen(true)
      setAltLine({ idx: -1, label })
      setAltItems([])
      setAltOffset(0)
      setAltHasMore(false)
      const pageSize = 100
      const alts = await aiService.getAlternatives(syntheticSel, filters || {}, { limit: pageSize, offset: 0, sessionId, showAll: true })
      setAltItems((alts || []).map(r => ({ id: r.id, item_name: r.item_name, item_description: r.item_description || '', price_inr: r.price_inr })))
      setAltOffset(pageSize)
      setAltHasMore((alts || []).length === pageSize)
    } catch (e) {
      console.error('Explore category error:', e)
      setAltItems([])
    } finally {
      setAltLoading(false)
    }
  }

  // Then positives only if not excluded
  for (const p of pos) if (p.re.test(t) && !negatives.includes(p.key)) add(positives, p.key)
  const only = /(\bonly\b|\bjust\b)/.test(t)
  // If we have positives, apply negatives by subtraction; else just report negatives
  const rooms = positives.length ? positives.filter(r => !negatives.includes(r)) : positives
  return { rooms, only, exclude: negatives }
}

const ChatBot = () => {
  const [messages, setMessages] = useState([
    {
      id: 1,
      type: 'bot',
      text: "Hello! I'm your Interior Design AI assistant. I can help you find the perfect furniture and generate quotations for your space. Tell me about your requirements - which room are you designing, your style preferences, and budget range?",
      timestamp: new Date()
    }
  ])

  // Render message content: show image preview for plan uploads instead of raw base64 text
  const renderMessageContent = (m) => {
    const text = String(m?.text || '')
    const dataUrlMatch = text.match(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+/)
    const isPlanCmd = /^analy\w*\s*plan/i.test(text)
    if (isPlanCmd && dataUrlMatch) {
      const dataUrl = dataUrlMatch[0]
      return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography variant="body2">analyze plan (image)</Typography>
          <Box component="img" src={dataUrl} alt="Floor plan" sx={{ maxWidth: 320, maxHeight: 320, borderRadius: 1, border: '1px solid #eee' }} />
        </Box>
      )
    }
    return <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>{text}</Typography>
  }

  const [inputMessage, setInputMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // sessionId for in-process graph memory — new on every mount (no persistence)
  const [sessionId, setSessionId] = useState(() => (
    (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now())
  ))
  const [currentQuotation, setCurrentQuotation] = useState(null)
  // Alternatives dialog state
  const [altOpen, setAltOpen] = React.useState(false)
  const [altItems, setAltItems] = React.useState([])
  const [altLoading, setAltLoading] = React.useState(false)
  const [altLine, setAltLine] = React.useState({ idx: null, label: '' })
  // Snapshot dialog for previous quotations
  const [snapOpen, setSnapOpen] = useState(false)
  const [snapMsg, setSnapMsg] = useState(null)
  const [altOffset, setAltOffset] = React.useState(0)
  const [altHasMore, setAltHasMore] = React.useState(false)
  const messagesEndRef = useRef(null)
  const floorInputRef = useRef(null)
  const [isUploadingPlan, setIsUploadingPlan] = useState(false)
  const [lastPlanName, setLastPlanName] = useState('')
  const [pendingPlan, setPendingPlan] = useState(null) // { dataUrl, httpUrl, fname }

  // Quick-reply helpers for clarifier
  const budgetOptions = [
    'under ₹10,000', '₹10,000–₹20,000', '₹20,000–₹40,000', 'above ₹40,000'
  ]
  const packageOptions = ['Economy', 'Premium', 'Luxury']
  const materialOptions = ['fabric', 'leather', 'wood', 'glass', 'metal']

  const sendQuickReply = async (text) => {
    if (isLoading) return
    await handleSendMessage(text)
  }

  // Decide which chips to show for a given clarifier text
  const getClarifierChips = (text) => {
    const lower = String(text || '').toLowerCase()
    const askMaterial = /material|style/.test(lower)
    const askBudgetOrPackage = /budget|under|above|₹|rs/.test(lower)
    const chips = []
    if (askMaterial) {
      chips.push(...materialOptions.map((m, idx) => ({ key: `m-${idx}`, label: m })))
    }
    if (askBudgetOrPackage) {
      chips.push(...budgetOptions.map((b, idx) => ({ key: `b-${idx}`, label: b })))
    }
    // If neither keyword detected (fallback), show nothing to avoid noise
    return chips
  }

  // Floor plan upload & analyze handlers
  const handleClickAnalyzePlan = () => {
    if (isLoading || isUploadingPlan) return
    floorInputRef.current?.click()
  }

  const handleSelectPlanFile = async (e) => {
    try {
      const file = e?.target?.files?.[0]
      if (!file) return
      setIsUploadingPlan(true)
      setLastPlanName(file.name)
      // 1) Upload to Supabase Storage (bucket: plans)
      const uploaded = await uploadToBucket(file, { bucket: 'plans', pathPrefix: '' })
      // 2) Also send a base64 data URL so the LLM can view the image without remote fetch
      const toResizedDataUrl = (file, maxDim=1024, quality=0.8) => new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement('canvas')
          let { width, height } = img
          if (width > height) {
            if (width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim }
          } else {
            if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim }
          }
          canvas.width = width; canvas.height = height
          const ctx = canvas.getContext('2d')
          ctx.drawImage(img, 0, 0, width, height)
          // Prefer webp to reduce size
          const out = canvas.toDataURL('image/webp', quality)
          resolve(out)
        }
        img.onerror = reject
        const reader = new FileReader()
        reader.onload = () => { img.src = reader.result }
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const dataUrl = await toResizedDataUrl(file)
      // 3) Stage as pending attachment; user can now type instructions (e.g., "just for the living room")
      const httpUrl = uploaded?.url || ''
      const fname = file?.name ? `file:${file.name}` : ''
      setPendingPlan({ dataUrl, httpUrl, fname })
      // Do not auto-send; we will compose with the user's message on Send
    } catch (err) {
      console.error('Analyze floor plan failed:', err)
      setMessages(prev => [...prev, { id: Date.now() + 1, type: 'bot', text: 'Sorry, I could not analyze that floor plan. Please try another image or try again.', timestamp: new Date() }])
    } finally {
      setIsUploadingPlan(false)
      // reset input so selecting the same file triggers change again
      if (floorInputRef.current) floorInputRef.current.value = ''
    }
  }

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSendMessage = async (messageOverride = null) => {
    // Always coerce to string to avoid rendering [object Object]
    const raw = (messageOverride != null) ? messageOverride : inputMessage
    const outgoing = String(raw || '')
    // Allow sending if there's either text or a staged plan
    if ((!outgoing.trim() && !pendingPlan) || isLoading) return

    // If a plan is staged, compose a single message combining plan tokens + user text
    const composed = pendingPlan
      ? `analyze plan ${pendingPlan.dataUrl} ${pendingPlan.httpUrl} ${pendingPlan.fname} ${outgoing}`.trim()
      : outgoing

    const userMessage = {
      id: Date.now(),
      type: 'user',
      text: composed,
      timestamp: new Date()
    }

    setMessages(prev => [...prev, userMessage])
    setInputMessage('')
    if (pendingPlan) setPendingPlan(null)
    setIsLoading(true)

    try {
      const prevBot = [...messages].reverse().find(m => m.type === 'bot' && typeof m.totalEstimate === 'number')

      // Create a streaming placeholder bot message we will update via onProgress
      const streamId = Date.now() + 1
      setMessages(prev => [...prev, { id: streamId, type: 'bot', text: 'Thinking…', timestamp: new Date(), llmSummary: null }])
      const prevTotal = prevBot ? Number(prevBot.totalEstimate || 0) : null
      // Build recent history (last 12 turns) including this outgoing user message
      const recent = [...messages.slice(-11), { id: userMessage.id, type: 'user', text: composed }]
      const response = await aiService.processChat(composed, {
        sessionId,
        // Provide last known state so the agent can apply add/replace/remove/qty updates
        context: prevBot ? { selections: prevBot.selections || null, filters: prevBot.filters || null } : null,
        // Option B: UI-only streaming shim using onProgress
        onProgress: (evt) => {
          try {
            setMessages(prev => prev.map(m => {
              if (m.id !== streamId) return m
              // Build a short, user-friendly status text for early stages
              let nextText = m.text || ''
              if (evt?.stage === 'vision') {
                const rooms = Array.isArray(evt.rooms) ? evt.rooms.join(', ') : ''
                const bhk = evt.bhk ? ` • BHK: ${evt.bhk}` : ''
                const sqft = evt.sqft ? ` • Area: ${evt.sqft} sqft` : ''
                nextText = `Analyzing plan…${rooms ? ` Rooms: ${rooms}.` : ''}${bhk}${sqft}`.trim()
              } else if (evt?.stage === 'parsed') {
                const rooms = Array.isArray(evt.parsedRooms) ? evt.parsedRooms.join(', ') : ''
                const theme = evt.parseTheme ? ` • Theme: ${evt.parseTheme}` : ''
                const budget = evt.parseBudget ? ` • Budget: ₹${Number(evt.parseBudget).toLocaleString('en-IN')}` : ''
                nextText = `Understanding your request…${rooms ? ` Rooms: ${rooms}.` : ''}${theme}${budget}`.trim()
              } else if (evt?.stage === 'summary') {
                const overview = evt?.summary?.overview || ''
                nextText = overview || 'Summarizing…'
              } else if (evt?.stage === 'rooms') {
                const rms = Array.isArray(evt.rooms) ? evt.rooms.join(', ') : ''
                nextText = rms ? `Rooms selected: ${rms}` : 'Selecting rooms…'
              }

              const patch = { ...m, text: nextText }
              if (evt?.stage === 'llmSummary' && evt.llmSummary) {
                patch.llmSummary = evt.llmSummary
              }
              return patch
            }))
          } catch (_) {}
        }
      })
      
      // Compute delta vs previous total if present
      const newTotal = Number(response.totalEstimate || 0)
      const delta = (prevTotal != null) ? (newTotal - prevTotal) : 0
      const deltaText = (prevTotal != null && delta !== 0)
        ? `Total changed by ${delta > 0 ? '+' : ''}₹${Math.abs(delta).toLocaleString('en-IN')}.`
        : ''
      const safeText = (() => {
        if (typeof response?.message === 'string') return response.message
        if (response?.message && typeof response.message.text === 'string') return response.message.text
        if (deltaText) return deltaText
        if (response?.clarification && typeof response.clarification === 'string') return response.clarification
        try { return response?.message ? JSON.stringify(response.message) : '' } catch { return '' }
      })()
      const botMessage = {
        id: Date.now() + 1,
        type: 'bot',
        text: safeText,
        timestamp: new Date(),
        items: response.items,
        totalEstimate: response.totalEstimate,
        alternatives: response.alternatives || null,
        filters: response.filters || null,
        selections: response.selections || null,
        llmSummary: response.llmSummary || null,
        styleProfile: response.styleProfile || null
      }

      // Compute per-line deltas vs previous selections (if available)
      const computeLineDeltas = (prevMsg, nextRes) => {
        const prevSel = Array.isArray(prevMsg?.selections) ? prevMsg.selections : []
        const nextSel = Array.isArray(nextRes?.selections) ? nextRes.selections : []
        const keyOf = (s) => {
          const t = String(s?.line?.type || '').toLowerCase()
          const sub = String(s?.line?.specifications?.subtype || '').toLowerCase()
          return `${t}|${sub}`
        }
        const prevMap = new Map()
        for (const s of prevSel) {
          const k = keyOf(s)
          if (!prevMap.has(k)) prevMap.set(k, [])
          prevMap.get(k).push(s)
        }
        const deltas = {}
        for (let i = 0; i < nextSel.length; i++) {
          const ns = nextSel[i]
          const k = keyOf(ns)
          const arr = prevMap.get(k) || []
          const ps = arr.length ? arr.shift() : null
          const qty = Math.max(1, Number(ns?.line?.quantity || 1))
          const price = Number(ns?.item?.price_inr || 0)
          const nowTotal = qty * price
          if (!ps) {
            deltas[i] = { delta: nowTotal, prev: 0, reason: 'added' }
            continue
          }
          const pqty = Math.max(1, Number(ps?.line?.quantity || 1))
          const pprice = Number(ps?.item?.price_inr || 0)
          const prevTotal = pqty * pprice
          let reason = 'qty'
          if ((ps?.item?.id || null) !== (ns?.item?.id || null)) reason = 'replaced'
          else if (pqty !== qty) reason = 'qty'
          else if (pprice !== price) reason = 'price'
          else reason = 'unchanged'
          const delta = nowTotal - prevTotal
          if (delta !== 0) deltas[i] = { delta, prev: prevTotal, reason }
        }
        return deltas
      }
      const prevBotMsg = [...messages].reverse().find(m => m.type === 'bot' && Array.isArray(m.selections)) || null
      const lineDeltas = prevBotMsg ? computeLineDeltas(prevBotMsg, response) : {}

      // Replace the streaming placeholder with the final bot message
      setMessages(prev => prev.map(m => (m.id === streamId ? { ...botMessage, lineDeltas } : m)))
      // no client-side prior; graph memory persists in-process by sessionId
      
      if (response.items && response.items.length > 0) {
        setCurrentQuotation({
          items: response.items,
          total: response.totalEstimate,
          selections: response.selections || null,
          explanations: response.explanations || null,
          groupedByRoom: response.groupedByRoom || null,
          filters: response.filters || null,
          bhk: response.bhk || null,
          tier: response.tier || null,
          roomPlan: response.roomPlan || null,
          lastUser: outgoing,
          overBudget: response.overBudget || false,
          budgetOverBy: response.budgetOverBy || 0,
          timestamp: new Date(),
          lineDeltas,
          styleProfile: response.styleProfile || null
        })
      }
    } catch (error) {
      const errorMessage = {
        id: Date.now() + 1,
        type: 'bot',
        text: "I apologize, but I'm having trouble processing your request. Please try again.",
        timestamp: new Date()
      }
      setMessages(prev => [...prev, errorMessage])
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  const formatPrice = (price) => {
    return `₹${price.toLocaleString('en-IN')}`
}


// Map catalog labels to internal line types used by the selector
const labelToType = (label) => {
  const t = String(label||'').toLowerCase()
  if (!t) return ''
  if (t.includes('tv-bench') || t.includes('tv bench') || t.includes('tv unit')) return 'tv_bench'
  if (t.includes('sofa-bed') || t.includes('sofa bed')) return 'sofa_bed'
  if (t.includes('wash-stand') || t.includes('wash stand') || t.includes('vanity')) return 'washstand'
  if (t.includes('mirror cabinet')) return 'mirror_cabinet'
  if (t.includes('shoe rack')) return 'shoe_rack'
  // Generic fallbacks
  if (t.includes('sofa')) return 'sofa'
  if (t.includes('table')) return 'table'
  if (t.includes('chair')) return 'chair'
  if (t.includes('bed')) return 'bed'
  if (t.includes('wardrobe')) return 'wardrobe'
  if (t.includes('mirror')) return 'mirror'
  if (t.includes('cabinet')) return 'cabinet'
  if (t.includes('bookcase')) return 'bookcase'
  if (t.includes('shelf')) return 'shelf'
  if (t.includes('stool')) return 'stool'
  if (t.includes('lamp') || t.includes('light')) return 'lamp'
  if (t.includes('desk')) return 'desk'
  if (t.includes('drawer')) return 'drawer'
  return t.split(/\s|-/)[0]
}

  const QuotationSummary = ({ items, total, alternatives, selections, explanations, groupedByRoom, bhk, tier, roomPlan, lastUser, filters, sqft, llmSummary, styleProfile, onReplace, onOpenAllAlternatives, onQtyAdjust, onRemove, overBudget, budgetOverBy, lineDeltas, onSwitchStyle, onExploreCategory, onSetStyles }) => {

    const [styleOptions, setStyleOptions] = useState([])
    const [activeStyles, setActiveStyles] = useState([]) // names (strings)
    const [showTotal, setShowTotal] = useState(false)
    useEffect(() => {
      let mounted = true
      ;(async () => {
        try {
          const styles = await loadStyles()
          if (mounted && Array.isArray(styles)) {
            // Keep top 8 styles for UI brevity
            setStyleOptions(styles.slice(0, 8))
          }
        } catch (_) {}
      })()
      return () => { mounted = false }
    }, [])

    // Initialize activeStyles from current styleProfile if none selected yet
    useEffect(() => {
      if (activeStyles.length === 0 && styleProfile?.name) {
        setActiveStyles([String(styleProfile.name)])
      }
    }, [items, styleProfile?.name])

    const toggleStyle = (name) => {
      const n = String(name || '').trim()
      if (!n) return
      // Single-select: if already active, deselect; otherwise select only this one
      const next = activeStyles.includes(n) ? [] : [n]
      setActiveStyles(next)
    }

    const applyStyles = () => {
      if (!activeStyles.length) return
      if (activeStyles.length === 1 && onSwitchStyle) {
        onSwitchStyle(activeStyles[0])
      }
    }

    // Reset total visibility when a new set of items arrives
    useEffect(() => {
      setShowTotal(false)
    }, [items])

    // Infer room from item attributes when missing
    const inferRoom = (it) => {
      const text = `${String(it.item_name||'')} ${String(it.item_details||'')} ${String(it.item_description||'')} ${String(it.line_type||'')}`.toLowerCase()
      const word = (w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`, 'i').test(text)
      const areas = String(it.suggestive_areas || '').toLowerCase()
      const category = String(it.category || '').toLowerCase()
      const subcategory = String(it.subcategory || '').toLowerCase()

      // 1) Prefer suggestive_areas from catalog
      if (/bath/.test(areas)) return 'bathroom'
      if (/bed/.test(areas)) return 'bedroom'
      if (/living/.test(areas)) return 'living'
      if (/kitchen/.test(areas)) return 'kitchen'
      if (/dining/.test(areas)) return 'kitchen'
      if (/foyer|entry/.test(areas)) return 'foyer'

      // 2) Category-based routing
      if (category === 'wash-stand') return 'bathroom'
      if (category === 'bed') return 'bedroom'
      if (category === 'wardrobe') return 'bedroom'
      if (category === 'tv-bench') return 'living'
      if (category === 'bookcase') return (word('study') ? 'study' : 'living')
      if (category === 'table') {
        if (subcategory === 'dining' || word('dining')) return 'kitchen'
        if (subcategory === 'bedside') return 'bedroom'
        if (subcategory === 'coffee') return 'living'
      }
      if (category === 'cabinet') {
        if (word('shoe')) return 'foyer'
        if (word('glass') && word('door')) return 'kitchen'
      }
      if (category === 'mirror') {
        if (word('bath') || word('bathroom') || word('vanity')) return 'bathroom'
        return 'bedroom'
      }

      // 3) Keyword heuristics fallback
      if (word('washstand') || (word('wash') && word('basin')) || word('toilet') || word('bathroom')) return 'bathroom'
      if (word('sofa') || word('tv bench') || word('tv unit') || word('center table') || word('coffee table') || word('media')) return 'living'
      if (word('bookcase') || word('bookshelf') || (word('book') && word('shelf'))) return word('study') ? 'study' : 'living'
      if (word('wardrobe') || word('bed') || word('dresser') || word('nightstand') || word('bedside')) return 'bedroom'
      if (word('dining') || word('dining table') || (word('chair') && word('dining')) || word('sideboard')) return 'kitchen'
      if (word('kitchen') || word('cabinet') || word('cooktop') || word('hob') || word('chimney')) return 'kitchen'
      if (word('sink')) return word('kitchen') ? 'kitchen' : 'bathroom'
      if (word('mirror')) return 'bedroom'
      if (word('study') || word('desk') || word('office')) return 'study'
      if ((word('shoe') && word('rack')) || word('entryway') || word('foyer')) return 'foyer'
      return 'living'
    }
    // Build groups; use inferred room when missing; remap literal 'unspecified'
    const buildGroups = (list) => {
      const g = {}; const ord = []
      for (let i = 0; i < (list || []).length; i++) {
        const it = list[i]
        const rk = String(it.room || '').trim().toLowerCase()
        const key = rk ? (rk === 'unspecified' ? inferRoom(it) : rk) : inferRoom(it)
        if (!g[key]) { g[key] = []; ord.push(key) }
        g[key].push({ it, idx: items.indexOf(it) })
      }
      return { g, ord }
    }
    const { g: groups, ord: order } = buildGroups(items || [])
    // Preferred room order
    const roomPriority = {
      'living': 1,
      'bedroom': 2,
      'kitchen': 3,
      'bathroom': 4,
      'dining': 5,
      'study': 6,
      'foyer': 7
    }
    const orderedRooms = [...order].sort((a,b) => (roomPriority[a]||99) - (roomPriority[b]||99) || a.localeCompare(b))

    return (
      <Card sx={{ mb: 2, border: overBudget ? '2px solid #d32f2f' : '1px solid #e0e0e0', boxShadow: overBudget ? '0 0 0 1px #d32f2f inset' : undefined }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Quotation Summary
          </Typography>
          {/* Highlights */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 1 }}>
            {/* Style Switcher (single-select only) */}
            {styleOptions && styleOptions.length > 0 ? (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ alignSelf: 'center', mr: 1 }}><strong>Style:</strong></Typography>
                {styleOptions.map((s) => {
                  const isActive = activeStyles.map(x => x.toLowerCase()).includes(String(s?.name||'').toLowerCase())
                  return (
                    <Chip
                      key={`style-${s.id}`}
                      size="small"
                      color={isActive ? 'primary' : 'default'}
                      variant={isActive ? 'filled' : 'outlined'}
                      label={s.name}
                      onClick={() => toggleStyle(s.name)}
                    />
                  )
                })}
                <Button size="small" variant="contained" onClick={applyStyles} disabled={activeStyles.length === 0}>
                  Apply styles
                </Button>
                {filters?.styleApplied ? (
                  <Chip
                    size="small"
                    color="success"
                    variant="outlined"
                    label={`Style applied${Array.isArray(filters?.appliedStyles)&&filters.appliedStyles.length?`: ${filters.appliedStyles.join(', ')}`:''}`}
                  />
                ) : null}
              </Box>
            ) : null}
            {lastUser ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                <strong>Request:</strong> {lastUser}
              </Typography>
            ) : null}
            {(Array.isArray(roomPlan) && roomPlan.length > 0) ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                <strong>Plan insights:</strong> {bhk ? `${bhk} BHK` : ''}{bhk && tier ? ' • ' : ''}{tier ? tier : ''}{(bhk || tier) && roomPlan?.length ? ' • ' : ''}
                {roomPlan?.length ? `Rooms detected: ${roomPlan.map(r => r.room).join(', ')}` : ''}
              </Typography>
            ) : null}
            {/* LLM Summary inside the Quotation panel (descriptive style) */}
            {llmSummary ? (
              <Box sx={{ mt: 0.5, p: 1, border: '1px dashed #bbb', borderRadius: 1, bgcolor: 'background.paper' }}>
                {typeof llmSummary.summary === 'string' && llmSummary.summary.trim() ? (
                  <Typography variant="body2" sx={{ mb: 0.75 }}>
                    {llmSummary.summary}
                  </Typography>
                ) : null}
                {(llmSummary?.bhk || llmSummary?.sqft || llmSummary?.theme) ? (
                  <Typography variant="body2" sx={{ mb: 0.5 }}>
                    {llmSummary?.bhk ? (<><strong>BHK:</strong> {llmSummary.bhk}{llmSummary?.sqft || llmSummary?.theme ? ' • ' : ''}</>) : null}
                    {llmSummary?.sqft ? (<><strong>Area:</strong> {llmSummary.sqft} sqft{llmSummary?.theme ? ' • ' : ''}</>) : null}
                    {llmSummary?.theme ? (<><strong>Theme:</strong> {llmSummary.theme}</>) : null}
                  </Typography>
                ) : null}
                {Array.isArray(llmSummary?.roomDimensions) && llmSummary.roomDimensions.length > 0 && (
                  <Typography variant="body2" sx={{ mb: 0.5 }}>
                    <strong>Dimensions:</strong> {llmSummary.roomDimensions.map((d) => {
                      const name = String(d.room || '').charAt(0).toUpperCase() + String(d.room || '').slice(1)
                      const unit = String(d.unit || 'ft')
                      const w = d.width == null ? '—' : Number(d.width || 0)
                      const h = d.height == null ? '—' : Number(d.height || 0)
                      return `${name} ${w}×${h} ${unit}`
                    }).join(', ')}
                  </Typography>
                )}
                {Array.isArray(llmSummary.rooms) && llmSummary.rooms.length > 0 && (
                  <Typography variant="body2" sx={{ mb: 0.5 }}>
                    <strong>Rooms detected:</strong> {llmSummary.rooms.join(', ')}.
                  </Typography>
                )}
                {llmSummary?.budget?.amount ? (
                  <Typography variant="body2" sx={{ mb: 0.5 }}>
                    <strong>Budget:</strong> {llmSummary?.budget?.scope === 'total' ? 'Total' : 'Per-item'} up to ₹{Number(llmSummary.budget.amount).toLocaleString('en-IN')}.
                  </Typography>
                ) : null}
                {Array.isArray(llmSummary.constraints) && llmSummary.constraints.length > 0 && (
                  <Typography variant="body2" sx={{ mb: 0.5 }}>
                    <strong>Constraints:</strong> {llmSummary.constraints.join(', ')}.
                  </Typography>
                )}
                {Array.isArray(llmSummary.priorities) && llmSummary.priorities.length > 0 && (
                  <Typography variant="body2" sx={{ mb: 0.5 }}>
                    <strong>Priorities:</strong> {llmSummary.priorities.join(', ')}.
                  </Typography>
                )}
                {Array.isArray(llmSummary.mustHaveItems) && llmSummary.mustHaveItems.length > 0 && (
                  <Typography variant="body2" sx={{ mb: 0.5 }}>
                    <strong>Must-haves:</strong> {llmSummary.mustHaveItems.slice(0, 6).map((it) => {
                      const base = String(it?.type || '').replace('_',' ')
                      const extra = [it?.subtype ? `(${it.subtype})` : null, it?.room ? `in ${it.room}` : null].filter(Boolean).join(' ')
                      return [base, extra].filter(Boolean).join(' ')
                    }).join(', ')}{llmSummary.mustHaveItems.length > 6 ? '…' : ''}
                  </Typography>
                )}
                {Array.isArray(llmSummary.niceToHaveItems) && llmSummary.niceToHaveItems.length > 0 && (
                  <Typography variant="body2" sx={{ mb: 0.5 }}>
                    <strong>Nice-to-haves:</strong> {llmSummary.niceToHaveItems.slice(0, 6).map((it) => {
                      const base = String(it?.type || '').replace('_',' ')
                      const extra = [it?.subtype ? `(${it.subtype})` : null, it?.room ? `in ${it.room}` : null].filter(Boolean).join(' ')
                      return [base, extra].filter(Boolean).join(' ')
                    }).join(', ')}{llmSummary.niceToHaveItems.length > 6 ? '…' : ''}
                  </Typography>
                )}
                {Array.isArray(llmSummary.itemsSuggested) && llmSummary.itemsSuggested.length > 0 && (
                  <Typography variant="body2" sx={{ mb: 0 }}>
                    <strong>Initial suggestions:</strong> {llmSummary.itemsSuggested.slice(0, 5).map((it) => {
                      const base = String(it?.type || '').replace('_',' ')
                      const extra = [it?.subtype ? `(${it.subtype})` : null, it?.room ? `in ${it.room}` : null].filter(Boolean).join(' ')
                      return [base, extra].filter(Boolean).join(' ')
                    }).join(', ')}{llmSummary.itemsSuggested.length > 5 ? '…' : ''}
                  </Typography>
                )}
              </Box>
            ) : null}
          </Box>

          {/* No filter chip; we show all items grouped by room */}

          {/* Render items grouped by room with preferred order */}
          {orderedRooms.map((roomKey) => (
            roomKey === 'unspecified' ? null : (
            <Box key={`grp-${roomKey}`} sx={{ mb: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  {(
                    {
                      living: <LivingIcon fontSize="small" />,
                      bedroom: <BedroomIcon fontSize="small" />,
                      kitchen: <KitchenIcon fontSize="small" />,
                      bathroom: <BathroomIcon fontSize="small" />,
                      dining: <DiningIcon fontSize="small" />,
                      study: <StudyIcon fontSize="small" />,
                      foyer: <FoyerIcon fontSize="small" />,
                      balcony: <BalconyIcon fontSize="small" />
                    }[roomKey] || <HomeIcon fontSize="small" />
                  )}
                  <Typography variant="subtitle1" sx={{ fontWeight: 700, textTransform: 'capitalize' }}>{roomKey}</Typography>
                </Box>
                <Box sx={{ flex: 1 }} />
              </Box>
              <Divider sx={{ mb: 1 }} />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {groups[roomKey].map(({ it, idx }) => (
                  <Box key={idx} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="subtitle2" noWrap title={it.item_name}>{it.item_name}</Typography>
                      {it.item_description && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {it.item_description}
                        </Typography>
                      )}
                      {it.item_details && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {it.item_details}
                        </Typography>
                      )}
                      {selections && selections[idx]?.line?._metaDefaultedMaterial === 'fabric' && (
                        <Chip size="small" label="Defaulted to fabric" sx={{ mt: 0.5 }} />
                      )}
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                        {it.line_type && (
                          <Chip size="small" color="default" variant="outlined" label={`type: ${String(it.line_type).replace('_',' ')}`} />
                        )}
                      </Box>
                      {Array.isArray(explanations) && explanations.length > 0 && (() => {
                        const ex = explanations.find(e => e && e.id === it.id)
                        if (!ex || !Array.isArray(ex.why) || ex.why.length === 0) return null
                        const cleaned = ex.why.filter(w => typeof w === 'string' && !/^\s*type\s*:/i.test(w))
                        if (cleaned.length === 0) return null
                        return (
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                            {cleaned.slice(0, 4).map((w, i) => (
                              <Chip key={`why-${idx}-${i}`} size="small" variant="outlined" label={w} />
                            ))}
                          </Box>
                        )
                      })()}
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                        <Typography variant="caption" color="text.secondary">Qty:</Typography>
                        <Button size="small" variant="outlined" onClick={() => onQtyAdjust && onQtyAdjust({ idx, delta: -1, currentQty: it.quantity })} disabled={Number(it.quantity || 1) <= 1}>-</Button>
                        <Typography variant="body2" sx={{ minWidth: 16, textAlign: 'center' }}>{it.quantity}</Typography>
                        <Button size="small" variant="outlined" onClick={() => onQtyAdjust && onQtyAdjust({ idx, delta: +1, currentQty: it.quantity })}>+</Button>
                      </Box>
                      {/* Per-line delta vs previous quotation */}
                      {(() => {
                        const ld = lineDeltas && lineDeltas[idx]
                        if (!ld || typeof ld.delta !== 'number' || !isFinite(ld.delta) || ld.delta === 0) return null
                        const inc = ld.delta > 0
                        const label = `${inc ? '+' : '-'}${formatPrice(Math.abs(ld.delta))}`
                        const from = typeof ld.prev === 'number' ? ld.prev : null
                        const to = typeof ld.delta === 'number' && typeof ld.prev === 'number' ? (ld.prev + ld.delta) : null
                        const tip = `${inc ? 'Increased' : 'Decreased'}${ld.reason ? ` (${ld.reason})` : ''}${(from!=null&&to!=null)?` • from ${formatPrice(from)} to ${formatPrice(to)}`:''}`
                        return (
                          <Tooltip title={tip}>
                            <Chip size="small" label={label} color={inc ? 'warning' : 'success'} sx={{ mt: 0.5 }} />
                          </Tooltip>
                        )
                      })()}
                      <Box sx={{ mt: 1, display: 'flex', gap: 2 }}>
                        <Button size="small" onClick={() => onOpenAllAlternatives && onOpenAllAlternatives({ idx })}>Alternatives</Button>
                        <Button size="small" color="error" onClick={() => onRemove && onRemove({ idx })}>Remove</Button>
                      </Box>
                    </Box>
                    <Box sx={{ textAlign: 'right', minWidth: 120 }}>
                      {(() => {
                        const img = it.image_url || it.image || it.image_url_small || null
                        if (img) {
                          return (
                            <Box
                              component="img"
                              src={img}
                              alt={it.item_name || 'item'}
                              referrerPolicy="no-referrer"
                              crossOrigin="anonymous"
                              loading="lazy"
                              onError={(e) => { e.currentTarget.src = `https://source.unsplash.com/256x256/?${encodeURIComponent(`${String(it.line_type||'furniture')},${String(it?.subcategory||'')},${String(it?.room||'')},product,catalog`)}` }}
                              sx={{ width: 110, height: 110, objectFit: 'cover', borderRadius: 1, border: '1px solid #eee' }}
                            />
                          )
                        }
                        return (
                          <Box sx={{ width: 110, height: 110, borderRadius: 1, bgcolor: 'grey.200', border: '1px dashed #ddd' }} />
                        )
                      })()}
                    </Box>
                  </Box>
                ))}
                {/* Explore-more chips removed as requested */}
              </Box>
            </Box>
            )
          ))}

          <Divider sx={{ my: 1.5 }} />
          {!showTotal ? (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="contained" color="primary" onClick={() => setShowTotal(true)}>
                Generate Quotation
              </Button>
            </Box>
          ) : (
            <>
              <Typography variant="h6" sx={{ textAlign: 'right', color: overBudget ? 'error.main' : 'inherit', fontWeight: overBudget ? 700 : 500 }}>
                Total: {formatPrice(total || 0)}
              </Typography>
              {overBudget && (
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 1 }}>
                  <Typography variant="body2" color="error.main">
                    Over budget by {formatPrice(Math.max(0, Number(budgetOverBy||0)))}
                  </Typography>
                  <Button variant="contained" color="error" size="small" onClick={() => {
                    (async () => { await sendQuickReply('reduce to budget') })()
                  }}>Reduce to budget</Button>
                </Box>
              )}
            </>
          )}
        </CardContent>
      </Card>
    )
  }

  const handleOpenAlternatives = async ({ idx, msg }) => {
    try {
      const targetMsg = msg || messages[messages.length - 1] || {}
      const line = targetMsg.items?.[idx]
      const typeText = line ? String(line.line_type || '').replace('_',' ') : 'item'
      setAltLoading(true)
      setAltOpen(true)
      setAltLine({ idx, label: typeText || 'item' })
      setAltItems([])
      setAltOffset(0)
      setAltHasMore(false)
      const sel = targetMsg.selections?.[idx]
      if (!sel) { 
        console.log('No selection found for idx:', idx, 'in msg:', targetMsg)
        setAltItems([])
        return 
      }
      console.log('Fetching alternatives for:', sel, 'with filters:', targetMsg.filters)
      const pageSize = 100
      const alts = await aiService.getAlternatives(sel, targetMsg.filters || {}, { limit: pageSize, offset: 0, sessionId, showAll: true })
      console.log('Got alternatives:', alts)
      setAltItems((alts || []).map(r => ({ id: r.id, item_name: r.item_name, item_description: r.item_description || '', price_inr: r.price_inr })))
      setAltOffset(pageSize)
      setAltHasMore((alts || []).length === pageSize)
    } catch (e) {
      console.error('Open alternatives error:', e)
      setAltItems([])
    } finally {
      setAltLoading(false)
    }
  }

  const handleCloseAlternatives = () => {
    setAltOpen(false)
  }

  const openSnapshotForMessage = (msg) => {
    if (!msg) return
    setSnapMsg(msg)
    setSnapOpen(true)
  }
  const closeSnapshot = () => setSnapOpen(false)

  const handleLoadMoreAlternatives = async () => {
    try {
      setAltLoading(true)
      const last = messages[messages.length - 1] || {}
      const sel = last.selections?.[altLine.idx]
      if (!sel) return
      const pageSize = 50
      const alts = await aiService.getAlternatives(sel, last.filters || {}, { limit: pageSize, offset: altOffset, sessionId, showAll: true })
      setAltItems(prev => [...prev, ...(alts || []).map(r => ({ id: r.id, item_name: r.item_name, item_description: r.item_description || '', price_inr: r.price_inr }))])
      setAltOffset(altOffset + pageSize)
      setAltHasMore((alts || []).length === pageSize)
    } catch (e) {
      console.error('Load more alternatives error:', e)
    } finally {
      setAltLoading(false)
    }
  }

  const handleReplaceAlternative = (alt) => {
    const last = messages[messages.length - 1] || {}
    const sel = last.selections?.[altLine.idx]
    const typeRaw = sel?.line?.type || ''
    const typeText = typeRaw ? String(typeRaw).replace('_', ' ') : ''
    const cmd = typeText ? `replace ${typeText} with id ${alt.id}` : `replace ${altLine.label || 'item'} with id ${alt.id}`
    sendQuickReply(cmd)
    handleCloseAlternatives()
  }

  return (
    <Container maxWidth="lg">
      <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', py: 2 }}>
        {/* Header */}
        <Paper elevation={3} sx={{
          p: 2,
          mb: 2,
          color: 'white',
          borderRadius: 2,
          background: theme => `linear-gradient(135deg, ${theme.palette.primary.dark} 0%, ${theme.palette.primary.main} 60%, ${theme.palette.secondary.main} 100%)`,
          backdropFilter: 'blur(6px)'
        }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <HomeIcon sx={{ fontSize: 40 }} />
            <Box>
              <Typography variant="h5" component="h1">
                Interior Design AI Quotation
              </Typography>
              <Typography variant="subtitle1">
                Get instant quotations for your interior design needs
              </Typography>
              <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Chip size="small" label="New Session" onClick={() => { const sid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()); setSessionId(sid); setMessages(prev => prev.slice(0,1)); setCurrentQuotation(null); }} sx={{ bgcolor: 'secondary.light', color: 'black' }} />
                {lastPlanName && (
                  <Chip size="small" label={`Last: ${lastPlanName}`} sx={{ bgcolor: 'secondary.light', color: 'black' }} />
                )}
              </Box>
            </Box>
          </Box>
        </Paper>

        {/* Chat Messages */}
        <Paper
          elevation={1}
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            p: 2,
            overflowY: 'auto',
            background: theme => theme.palette.mode === 'light' ? 'linear-gradient(180deg, #fafafa 0%, #ffffff 30%)' : undefined,
            borderRadius: 3
          }}
        >
          <List sx={{ flex: 1 }}>
            {messages.map((msg) => {
              const isBot = msg.type === 'bot'
              return (
                <ListItem key={msg.id} disableGutters sx={{
                  justifyContent: isBot ? 'flex-start' : 'flex-end'
                }}>
                  <Box sx={{
                    maxWidth: '75%',
                    display: 'flex',
                    gap: 1.25,
                    alignItems: 'flex-start',
                    flexDirection: isBot ? 'row' : 'row-reverse'
                  }}>
                    {isBot ? (
                      <Avatar sx={{ bgcolor: '#1e88e5' }}><BotIcon fontSize="small" /></Avatar>
                    ) : (
                      <Avatar sx={{ bgcolor: '#673ab7' }}>U</Avatar>
                    )}
                    <Box sx={{
                      p: 1.5,
                      borderRadius: 3,
                      boxShadow: isBot ? '0 8px 24px rgba(0,0,0,0.06)' : '0 8px 24px rgba(25,118,210,0.18)',
                      bgcolor: theme => isBot ? 'rgba(255,255,255,0.7)' : 'rgba(33, 150, 243, 0.12)',
                      border: theme => isBot ? `1px solid ${theme.palette.divider}` : `1px solid rgba(33,150,243,0.3)`,
                      backdropFilter: 'blur(6px)'
                    }}>
                      {renderMessageContent(msg)}
                      <Typography variant="caption" sx={{ opacity: 0.7, display: 'block', mt: 0.5 }}>
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </Typography>
                      {/* LLM Summary panel (if provided) */}
                      {isBot && msg.llmSummary ? (
                        <Box sx={{ mt: 1, p: 1, border: '1px dashed #bbb', borderRadius: 1, bgcolor: 'background.paper' }}>
                          {typeof msg.llmSummary.summary === 'string' && msg.llmSummary.summary.trim() ? (
                            <Typography variant="body2" sx={{ mb: 0.75 }}>
                              {msg.llmSummary.summary}
                            </Typography>
                          ) : null}
                          {/* Rich details (early, before generic suggestions) */}
                          {(msg.llmSummary?.bhk || msg.llmSummary?.sqft || msg.llmSummary?.theme) ? (
                            <Typography variant="body2" sx={{ mb: 0.5 }}>
                              {msg.llmSummary?.bhk ? (<><strong>BHK:</strong> {msg.llmSummary.bhk}{msg.llmSummary?.sqft || msg.llmSummary?.theme ? ' • ' : ''}</>) : null}
                              {msg.llmSummary?.sqft ? (<><strong>Area:</strong> {msg.llmSummary.sqft} sqft{msg.llmSummary?.theme ? ' • ' : ''}</>) : null}
                              {msg.llmSummary?.theme ? (<><strong>Theme:</strong> {msg.llmSummary.theme}</>) : null}
                            </Typography>
                          ) : null}
                          {Array.isArray(msg.llmSummary?.roomDimensions) && msg.llmSummary.roomDimensions.length > 0 && (
                            <Typography variant="body2" sx={{ mb: 0.5 }}>
                              <strong>Dimensions:</strong> {msg.llmSummary.roomDimensions.map((d) => {
                                const name = String(d.room || '').charAt(0).toUpperCase() + String(d.room || '').slice(1)
                                const unit = String(d.unit || 'ft')
                                const w = d.width == null ? '—' : Number(d.width || 0)
                                const h = d.height == null ? '—' : Number(d.height || 0)
                                return `${name} ${w}×${h} ${unit}`
                              }).join(', ')}
                            </Typography>
                          )}
                          {Array.isArray(msg.llmSummary.rooms) && msg.llmSummary.rooms.length > 0 && (
                            <Typography variant="body2" sx={{ mb: 0.5 }}>
                              <strong>Rooms detected:</strong> {msg.llmSummary.rooms.join(', ')}.
                            </Typography>
                          )}
                          {msg.llmSummary?.budget?.amount ? (
                            <Typography variant="body2" sx={{ mb: 0.5 }}>
                              <strong>Budget:</strong> {msg.llmSummary?.budget?.scope === 'total' ? 'Total' : 'Per-item'} up to ₹{Number(msg.llmSummary.budget.amount).toLocaleString('en-IN')}.
                            </Typography>
                          ) : null}
                          {Array.isArray(msg.llmSummary.constraints) && msg.llmSummary.constraints.length > 0 && (
                            <Typography variant="body2" sx={{ mb: 0.5 }}>
                              <strong>Constraints:</strong> {msg.llmSummary.constraints.join(', ')}.
                            </Typography>
                          )}
                          {Array.isArray(msg.llmSummary.priorities) && msg.llmSummary.priorities.length > 0 && (
                            <Typography variant="body2" sx={{ mb: 0.5 }}>
                              <strong>Priorities:</strong> {msg.llmSummary.priorities.join(', ')}.
                            </Typography>
                          )}
                          {Array.isArray(msg.llmSummary.mustHaveItems) && msg.llmSummary.mustHaveItems.length > 0 && (
                            <Typography variant="body2" sx={{ mb: 0.5 }}>
                              <strong>Must-haves:</strong> {msg.llmSummary.mustHaveItems.slice(0, 6).map((it) => {
                                const base = String(it?.type || '').replace('_',' ')
                                const extra = [it?.subtype ? `(${it.subtype})` : null, it?.room ? `in ${it.room}` : null].filter(Boolean).join(' ')
                                return [base, extra].filter(Boolean).join(' ')
                              }).join(', ')}{msg.llmSummary.mustHaveItems.length > 6 ? '…' : ''}
                            </Typography>
                          )}
                          {Array.isArray(msg.llmSummary.niceToHaveItems) && msg.llmSummary.niceToHaveItems.length > 0 && (
                            <Typography variant="body2" sx={{ mb: 0.5 }}>
                              <strong>Nice-to-haves:</strong> {msg.llmSummary.niceToHaveItems.slice(0, 6).map((it) => {
                                const base = String(it?.type || '').replace('_',' ')
                                const extra = [it?.subtype ? `(${it.subtype})` : null, it?.room ? `in ${it.room}` : null].filter(Boolean).join(' ')
                                return [base, extra].filter(Boolean).join(' ')
                              }).join(', ')}{msg.llmSummary.niceToHaveItems.length > 6 ? '…' : ''}
                            </Typography>
                          )}
                          {Array.isArray(msg.llmSummary.itemsSuggested) && msg.llmSummary.itemsSuggested.length > 0 && (
                            <Typography variant="body2" sx={{ mb: 0 }}>
                              <strong>Initial suggestions:</strong> {msg.llmSummary.itemsSuggested.slice(0, 5).map((it) => {
                                const base = String(it?.type || '').replace('_',' ')
                                const extra = [it?.subtype ? `(${it.subtype})` : null, it?.room ? `in ${it.room}` : null].filter(Boolean).join(' ')
                                return [base, extra].filter(Boolean).join(' ')
                              }).join(', ')}{msg.llmSummary.itemsSuggested.length > 5 ? '…' : ''}
                            </Typography>
                          )}
                        </Box>
                      ) : null}
                      {/* Historical quotation snapshot opener */}
                      {isBot && Array.isArray(msg.items) && msg.items.length > 0 ? (
                        <Box sx={{ mt: 1, display: 'flex', justifyContent: 'flex-end' }}>
                          <Button size="small" variant="outlined" onClick={() => openSnapshotForMessage(msg)}>
                            View quotation snapshot
                          </Button>
                        </Box>
                      ) : null}
                    </Box>
                  </Box>
                </ListItem>
              )
            })}
          </List>

          {/* Persistent Quotation Panel (always shows the latest quotation) */}
          {currentQuotation && Array.isArray(currentQuotation.items) && currentQuotation.items.length > 0 && (
            <Box sx={{ mt: 2 }}>
              <QuotationSummary
                items={currentQuotation.items}
                total={currentQuotation.total}
                alternatives={null}
                explanations={currentQuotation.explanations}
                groupedByRoom={currentQuotation.groupedByRoom}
                bhk={currentQuotation.bhk}
                tier={currentQuotation.tier}
                roomPlan={currentQuotation.roomPlan}
                lastUser={currentQuotation.lastUser}
                filters={currentQuotation.filters}
                overBudget={Boolean(currentQuotation.overBudget)}
                budgetOverBy={currentQuotation.budgetOverBy}
                lineDeltas={currentQuotation.lineDeltas}
                styleProfile={currentQuotation.styleProfile || null}
                onSwitchStyle={(styleName) => {
                  // Send a quick command to re-bias by style
                  sendQuickReply(`set style to ${styleName}`)
                }}
                onSetStyles={(list) => {
                  if (Array.isArray(list) && list.length > 1) {
                    sendQuickReply(`styles: ${list.join(', ')}`)
                  } else if (Array.isArray(list) && list.length === 1) {
                    sendQuickReply(`set style to ${list[0]}`)
                  }
                }}
                onReplace={({ idx, alt }) => {
                  const line = currentQuotation.items[idx]
                  const typeText = String(line.line_type || '').replace('_',' ')
                  const cmd = typeText ? `replace ${typeText} with id ${alt.id}` : `replace item with id ${alt.id}`
                  sendQuickReply(cmd)
                }}
                onExploreCategory={({ room, label, filters }) => {
                  handleExploreCategory({ room, label, filters })
                }}
                onQtyAdjust={({ idx, delta, currentQty }) => {
                  const sel = currentQuotation.selections?.[idx]
                  const typeRaw = sel?.line?.type || (currentQuotation.items[idx]?.line_type) || ''
                  const typeText = typeRaw ? String(typeRaw).replace('_',' ') : ''
                  const nextQty = Math.max(1, Number(currentQty || 1) + Number(delta || 0))
                  const cmd = typeText ? `set ${typeText} qty to ${nextQty}` : `set item qty to ${nextQty}`
                  sendQuickReply(cmd)
                }}
                onRemove={({ idx }) => {
                  const sel = currentQuotation.selections?.[idx]
                  const typeRaw = sel?.line?.type || (currentQuotation.items[idx]?.line_type) || ''
                  const sub = sel?.line?.specifications?.subtype || ''
                  let typeText = typeRaw ? String(typeRaw).replace('_',' ') : ''
                  if (typeRaw === 'table' && sub) typeText = `${sub} table`
                  const cmd = typeText ? `remove ${typeText}` : 'remove item'
                  sendQuickReply(cmd)
                }}
                onOpenAllAlternatives={({ idx }) => {
                  // Build a synthetic message from currentQuotation for the dialog
                  const synthetic = {
                    items: currentQuotation.items,
                    selections: currentQuotation.selections,
                    filters: currentQuotation.filters
                  }
                  handleOpenAlternatives({ idx, msg: synthetic })
                }}
              />
            </Box>
          )}
          {/* Snapshot Dialog for previous quotations */}
          <Dialog open={snapOpen} onClose={closeSnapshot} fullWidth maxWidth="md">
            <DialogTitle>Quotation snapshot</DialogTitle>
            <DialogContent dividers>
              {Array.isArray(snapMsg?.items) && snapMsg.items.length > 0 ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {snapMsg.items.map((it, i) => (
                    <Box key={`snap-${i}`} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: 0.5, borderBottom: '1px dashed #eee' }}>
                      <Box sx={{ pr: 2 }}>
                        <Typography variant="body2"><strong>{it.item_name || it.variation_name || it.category || 'Item'}</strong></Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                          Qty: {Math.max(1, Number(it.quantity || 1))} • Room: {String(it.room || '—')}
                        </Typography>
                      </Box>
                      <Typography variant="body2">₹{Number(it.line_total_inr || (Math.max(1, Number(it.quantity || 1)) * Number(it.price_inr || 0))).toLocaleString('en-IN')}</Typography>
                    </Box>
                  ))}
                  <Divider sx={{ my: 1 }} />
                  <Typography variant="h6" sx={{ textAlign: 'right' }}>
                    Total: ₹{Number(snapMsg.totalEstimate || 0).toLocaleString('en-IN')}
                  </Typography>
                </Box>
              ) : (
                <Typography variant="body2">No items in this snapshot.</Typography>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={closeSnapshot}>Close</Button>
            </DialogActions>
          </Dialog>

          {isLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'flex-start', mb: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Avatar sx={{ bgcolor: 'secondary.main', width: 32, height: 32 }}>
                  <BotIcon />
                </Avatar>
                <Paper elevation={1} sx={{ p: 2, bgcolor: 'grey.100' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CircularProgress size={20} />
                    <Typography variant="body1">Analyzing your requirements...</Typography>
                  </Box>
                </Paper>
              </Box>
            </Box>
          )}

          <div ref={messagesEndRef} />

          {/* Input Area */}
          <Divider />
          <Box sx={{ p: 2 }}>
            {/* Hidden file input for floor plan uploads */}
            <input type="file" accept="image/*" ref={floorInputRef} style={{ display: 'none' }} onChange={handleSelectPlanFile} />
            <Paper elevation={2} sx={{ p: 1, borderRadius: 999, pl: 2 }}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                {/* Staged floor plan preview */}
                {pendingPlan && (
                  <Box sx={{ position: 'relative', width: 44, height: 44, borderRadius: 1, overflow: 'hidden', border: '1px solid #e0e0e0' }}>
                    <Box component="img" src={pendingPlan.dataUrl} alt={lastPlanName || 'floor plan'} sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <IconButton size="small" aria-label="remove" onClick={() => setPendingPlan(null)} sx={{ position: 'absolute', top: -8, right: -8 }}>
                      ✕
                    </IconButton>
                  </Box>
                )}
                <TextField
                  fullWidth
                  multiline
                  maxRows={3}
                  placeholder="Describe your interior design requirements..."
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyPress={handleKeyPress}
                  disabled={isLoading}
                  variant="standard"
                  InputProps={{ disableUnderline: true, sx: { py: 0.5, px: 1 } }}
                  size="small"
                />
                <Tooltip title="Attach floor plan">
                  <span>
                    <IconButton
                      color="secondary"
                      onClick={handleClickAnalyzePlan}
                      disabled={isUploadingPlan || isLoading}
                      sx={{ mr: 0.5 }}
                    >
                      <ImageIcon />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="Send">
                  <span>
                    <IconButton
                      color="primary"
                      onClick={() => handleSendMessage()}
                      disabled={((!inputMessage.trim() && !pendingPlan) || isLoading)}
                      sx={{ mr: 0.5 }}
                    >
                      <SendIcon />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            </Paper>
            {/* Intent preview hint: shows which rooms will be used or excluded based on the typed text, even without a plan */}
            {(() => {
              const intent = parseRoomIntentClient(inputMessage)
              if (intent.rooms.length) {
                return (
                  <Typography variant="caption" sx={{ color: 'text.secondary', mt: 0.5, display: 'block' }}>
                    {intent.only ? 'Only ' : ''}rooms to design: {intent.rooms.join(', ')}
                  </Typography>
                )
              }
              if (intent.exclude && intent.exclude.length) {
                return (
                  <Typography variant="caption" sx={{ color: 'text.secondary', mt: 0.5, display: 'block' }}>
                    excluding: {intent.exclude.join(', ')}
                  </Typography>
                )
              }
              return null
            })()}
          </Box>
        </Paper>
      </Box>

      {/* Alternatives Dialog */}
      <Dialog open={altOpen} onClose={handleCloseAlternatives} fullWidth maxWidth="md">
        <DialogTitle>Alternatives for {altLine.label}</DialogTitle>
        <DialogContent dividers>
          {altLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
              <CircularProgress size={24} />
            </Box>
          ) : (
            <>
              <Grid container spacing={2} sx={{ py: 1 }}>
                {altItems.map((alt) => (
                  <Grid key={alt.id} item xs={12} sm={6} md={4}>
                    <Card variant="outlined" sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                      {alt.image_url ? (
                        <CardMedia component="img" height="140" image={alt.image_url} alt={alt.item_name} />
                      ) : null}
                      <CardContent sx={{ flex: 1 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{alt.item_name}</Typography>
                        <Typography
                          variant="caption"
                          sx={{ color: 'text.secondary', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                          title={alt.item_description}
                        >
                          {alt.item_description}
                        </Typography>
                      </CardContent>
                      <CardActions sx={{ justifyContent: 'flex-end', px: 2, pb: 2 }}>
                        <Box sx={{ display: 'flex', gap: 1 }}>
                          <Button size="small" variant="outlined" onClick={() => {
                            const last = messages[messages.length - 1] || {}
                            const sel = last.selections?.[altLine.idx]
                            const typeRaw = sel?.line?.type || ''
                            const typeText = typeRaw ? String(typeRaw).replace('_',' ') : (altLine.label || 'item')
                            const cmd = `add ${typeText} with id ${alt.id}`
                            sendQuickReply(cmd)
                            handleCloseAlternatives()
                          }}>Add item</Button>
                          <Button size="small" variant="contained" onClick={() => handleReplaceAlternative(alt)}>Replace</Button>
                        </Box>
                      </CardActions>
                    </Card>
                  </Grid>
                ))}
              </Grid>
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                <Button onClick={handleLoadMoreAlternatives} disabled={!altHasMore}>Load more</Button>
              </Box>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseAlternatives}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Global Loading Overlay */}
      <Backdrop
        sx={{ color: '#fff', zIndex: (theme) => theme.zIndex.modal + 1, flexDirection: 'column', gap: 2 }}
        open={Boolean(isLoading || isUploadingPlan)}
      >
        <CircularProgress color="inherit" />
        <Typography variant="body1" sx={{ opacity: 0.9 }}>
          {isUploadingPlan ? 'Analyzing floor plan…' : 'Thinking…'}
        </Typography>
      </Backdrop>
    </Container>
  )
}

export default ChatBot
