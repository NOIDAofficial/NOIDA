import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * GET /api/noida/whisper
 *
 * NoidaScreen 用のデータ取得 API
 * Service Role Key で RLS をバイパスして
 * daily_briefing, calendar, task, talk_master, owner_master を取得
 *
 * コスト: 0(Supabase SELECT のみ)
 */

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  SUPABASE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
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

  // Persona
  try {
    const { data: owner } = await supabase
      .from('owner_master')
      .select('preset_id, mbti')
      .limit(1)
      .maybeSingle()
    if (owner) {
      result.persona = { preset_id: owner.preset_id, mbti: owner.mbti }
    }
  } catch (e) {
    console.error('❌ whisper: owner_master エラー:', e)
  }

  // Briefing(最新)
  try {
    const { data: briefing } = await supabase
      .from('daily_briefing')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (briefing?.top_action) {
      result.briefing = { summary: briefing.top_action }
    }
  } catch (e) {
    console.error('❌ whisper: daily_briefing エラー:', e)
  }

  // 60分以内の予定
  try {
    const sixtyMinLater = new Date(now.getTime() + 60 * 60 * 1000)
    const { data: events } = await supabase
      .from('calendar')
      .select('title, datetime')
      .is('deleted_at', null)
      .neq('state', 'cancelled')
      .gte('datetime', now.toISOString())
      .lte('datetime', sixtyMinLater.toISOString())
      .order('datetime', { ascending: true })
      .limit(1)
    if (events?.length) {
      const ev = events[0]
      const minutesUntil = Math.round(
        (new Date(ev.datetime).getTime() - now.getTime()) / 60000
      )
      if (minutesUntil > 0) {
        result.upcomingEvent = { title: ev.title, minutesUntil }
      }
    }
  } catch (e) {
    console.error('❌ whisper: calendar エラー:', e)
  }

  // 未完了タスク
  try {
    const { data: tasks } = await supabase
      .from('task')
      .select('content')
      .eq('done', false)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
    if (tasks?.length) {
      result.pendingTask = { content: tasks[0].content }
    }
  } catch (e) {
    console.error('❌ whisper: task エラー:', e)
  }

  // 最新のNOIDA重要発言(10分以内、empathy/modify除外)
  try {
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000)
    const { data: talks } = await supabase
      .from('talk_master')
      .select('content, intent, created_at')
      .eq('role', 'noida')
      .gte('created_at', tenMinAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(5)

    if (talks?.length) {
      const SKIP_MODES = ['empathy', 'modify']
      const SKIP_PATTERNS = [
        /記録した|保存した|了解|わかった|承知|削除した|完了した|キャンセルした|戻した|やめとく|更新した/,
      ]

      const worthy = talks.find(t => {
        if (SKIP_MODES.includes(t.intent || '')) return false
        if (SKIP_PATTERNS.some(p => p.test(t.content || ''))) return false
        return true
      })

      if (worthy) {
        result.noidaTalk = {
          content: worthy.content.substring(0, 60),
          mode: worthy.intent || 'generic',
        }
      }
    }
  } catch (e) {
    console.error('❌ whisper: talk_master エラー:', e)
  }

  return NextResponse.json(result)
}