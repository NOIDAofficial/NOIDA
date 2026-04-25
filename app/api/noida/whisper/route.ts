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
  const result: {
    briefing: { summary: string } | null
    upcomingEvent: { title: string; minutesUntil: number } | null
    pendingTask: { content: string } | null
    noidaTalk: { content: string; mode: string } | null
    persona: { preset_id: string | null; mbti: string | null } | null
  } = {
    briefing: null,
    upcomingEvent: null,
    pendingTask: null,
    noidaTalk: null,
    persona: null,
  }

  try {
    const { data } = await supabase.from('owner_master').select('preset_id, mbti').limit(1).maybeSingle()
    if (data) result.persona = { preset_id: data.preset_id, mbti: data.mbti }
  } catch {}

  try {
    const { data } = await supabase.from('daily_briefing').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (data?.top_action) result.briefing = { summary: data.top_action }
  } catch {}

  try {
    const sixtyMinLater = new Date(now.getTime() + 60 * 60 * 1000)
    const { data } = await supabase
      .from('calendar')
      .select('title, datetime')
      .is('deleted_at', null)
      .neq('state', 'cancelled')
      .gte('datetime', now.toISOString())
      .lte('datetime', sixtyMinLater.toISOString())
      .order('datetime', { ascending: true })
      .limit(1)
    if (data?.length) {
      const minutesUntil = Math.round((new Date(data[0].datetime).getTime() - now.getTime()) / 60000)
      if (minutesUntil > 0) result.upcomingEvent = { title: data[0].title, minutesUntil }
    }
  } catch {}

  try {
    const { data } = await supabase
      .from('task')
      .select('content')
      .eq('done', false)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
    if (data?.length) result.pendingTask = { content: data[0].content }
  } catch {}

  try {
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)
    const { data } = await supabase
      .from('talk_master')
      .select('content, intent, created_at')
      .eq('role', 'noida')
      .gte('created_at', oneHourAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(5)
    if (data?.length) {
      const SKIP = ['empathy', 'modify']
      const SKIP_PAT = /記録した|保存した|了解|わかった|承知|削除した|完了した|キャンセルした|戻した|やめとく|更新した/
      const worthy = data.find(t => !SKIP.includes(t.intent || '') && !SKIP_PAT.test(t.content || ''))
      if (worthy) result.noidaTalk = { content: worthy.content.substring(0, 60), mode: worthy.intent || 'generic' }
    }
  } catch {}

  return NextResponse.json(result)
}
