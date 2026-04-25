import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  SUPABASE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function GET(req: NextRequest) {
  const now = new Date()
  const result: any = {
    briefing: null,
    upcomingEvent: null,
    pendingTask: null,
    noidaTalk: null,
    persona: null,
    debug: {},
  }

  try {
    const { data, error } = await supabase.from('owner_master').select('preset_id, mbti').limit(1).maybeSingle()
    result.debug.owner = { data, error }
    if (data) result.persona = { preset_id: data.preset_id, mbti: data.mbti }
  } catch (e: any) { result.debug.owner_error = e.message }

  try {
    const { data, error } = await supabase.from('daily_briefing').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle()
    result.debug.briefing = { data, error }
    if (data?.top_action) result.briefing = { summary: data.top_action }
  } catch (e: any) { result.debug.briefing_error = e.message }

  try {
    const { data, error } = await supabase.from('task').select('content, done, state, deleted_at').eq('done', false).order('created_at', { ascending: true }).limit(3)
    result.debug.tasks = { data, error, count: data?.length }
    if (data?.length) result.pendingTask = { content: data[0].content }
  } catch (e: any) { result.debug.task_error = e.message }

  try {
    const tenMinAgo = new Date(now.getTime() - 60 * 60 * 1000)
    const { data, error } = await supabase.from('talk_master').select('content, intent, created_at').eq('role', 'noida').gte('created_at', tenMinAgo.toISOString()).order('created_at', { ascending: false }).limit(3)
    result.debug.talks = { data: data?.map(t => ({ content: t.content?.substring(0, 30), intent: t.intent })), error, count: data?.length }
    if (data?.length) result.noidaTalk = { content: data[0].content?.substring(0, 60), mode: data[0].intent || 'generic' }
  } catch (e: any) { result.debug.talk_error = e.message }

  return NextResponse.json(result)
}
