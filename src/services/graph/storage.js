// Supabase persistence adapter for LangGraph state
// Loads prior state and saves graph outputs per sessionId

import { supabase } from "../../config/supabase.js"

const TBL_SUMMARIES = "iq_summaries"
const TBL_FILTERS = "iq_filters"
const TBL_SELECTIONS = "iq_selections"
const TBL_QUOTATIONS = "iq_quotations"

export async function loadPrior(sessionId) {
  try {
    const sid = String(sessionId || "default")
    const [{ data: sum }, { data: fil }, { data: sel }, { data: quo }] = await Promise.all([
      supabase.from(TBL_SUMMARIES).select("summary").eq("session_id", sid).maybeSingle(),
      supabase.from(TBL_FILTERS).select("data").eq("session_id", sid).maybeSingle(),
      supabase.from(TBL_SELECTIONS).select("index,line,item").eq("session_id", sid).order("index", { ascending: true }),
      supabase.from(TBL_QUOTATIONS).select("items,total_estimate").eq("session_id", sid).maybeSingle()
    ])
    const prior = {}
    if (sum?.summary) prior.llmSummary = sum.summary
    if (fil?.data) prior.filters = fil.data
    if (Array.isArray(sel)) prior.selections = sel.map(r => ({ line: r.line, item: r.item }))
    if (quo?.items) prior.selectedIds = quo.items.map(x => x?.id).filter(Boolean)
    return prior
  } catch (_) {
    return {}
  }
}

export async function saveGraphState(sessionId, { llmSummary, filters, selections, items, totalEstimate, reqItems, reqBudget }) {
  const sid = String(sessionId || "default")
  try {
    const tasks = []
    // summaries
    tasks.push(supabase.from(TBL_SUMMARIES).upsert({ session_id: sid, summary: llmSummary || null, updated_at: new Date().toISOString() }, { onConflict: "session_id" }))
    // filters
    tasks.push(supabase.from(TBL_FILTERS).upsert({ session_id: sid, data: filters || {}, updated_at: new Date().toISOString() }, { onConflict: "session_id" }))
    // selections (replace all rows for session)
    tasks.push((async () => {
      await supabase.from(TBL_SELECTIONS).delete().eq("session_id", sid)
      const rows = (Array.isArray(selections) ? selections : []).map((s, i) => ({ session_id: sid, index: i, line: s.line || null, item: s.item || null, updated_at: new Date().toISOString() }))
      if (rows.length) await supabase.from(TBL_SELECTIONS).insert(rows)
    })())
    // quotations
    tasks.push(supabase.from(TBL_QUOTATIONS).upsert({ session_id: sid, items: items || [], total_estimate: Number(totalEstimate || 0), updated_at: new Date().toISOString() }, { onConflict: "session_id" }))
    await Promise.all(tasks)
  } catch (e) {
    // Non-fatal for UX; log if needed
    console.warn("[persistence] saveGraphState failed", e?.message || e)
  }
}
