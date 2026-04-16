import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
})

const NOIDA_MODELS = {
  REALTIME: 'gpt-4o-mini',
  ANALYTICS: 'gpt-4o',
  AUDIT: 'claude-sonnet-4-5',
  EXTRACTOR: 'gpt-4o-mini',
}

async function keepAlive() {
  console.log('💓 非アクティブ防止クエリ実行')
  const tables = ['people', 'task', 'memo', 'calendar', 'business_master', 'talk_master', 'owner_master']
  for (const table of tables) {
    await supabase.from(table).select('id').limit(1)
  }
  console.log('✅ 全テーブル疎通確認完了')
}

async function analyzeTalkMaster() {
  console.log('🔍 talk_master分析開始（昼バッチ）')

  const { data: talks } = await supabase
    .from('talk_master')
    .select('*')
    .eq('promoted', false)
    .gte('created_at', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: true })

  if (!talks || talks.length === 0) {
    console.log('📭 未昇格の会話なし')
    return
  }

  console.log(`📝 ${talks.length}件の会話を分析`)

  const userTalks = talks.filter(t => t.role === 'user')
  if (userTalks.length === 0) return

  const conversationText = userTalks
    .map(t => `[${new Date(t.created_at).toLocaleDateString('ja-JP')}] ${t.content}`)
    .join('\n')

  const response = await openai.chat.completions.create({
    model: NOIDA_MODELS.EXTRACTOR,
    max_tokens: 1000,
    messages: [
      {
        role: 'system',
        content: `会話ログから重要情報を抽出してJSON形式のみで返答してください。
{
  "people": [{"name": "", "company": "", "position": "", "importance": "B", "note": ""}],
  "tasks": [{"content": ""}],
  "calendar": [{"title": "", "datetime": ""}],
  "business": [{"name": "", "note": ""}],
  "memo": [{"content": ""}]
}`
      },
      {
        role: 'user',
        content: `以下の会話ログを分析してください：\n\n${conversationText}`
      }
    ]
  })

  const text = response.choices[0]?.message?.content || ''
  let parsed: any = {}

  try {
    const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1)
    parsed = JSON.parse(jsonStr)
  } catch {
    console.log('❌ JSON解析失敗')
    return
  }

  if (parsed.people?.length > 0) {
    for (const person of parsed.people) {
      if (!person.name) continue
      const { data: existing } = await supabase.from('people').select('id, note').ilike('name', `%${person.name}%`).single()
      if (existing) {
        const newNote = existing.note ? existing.note + '\n' + (person.note || '') : (person.note || '')
        await supabase.from('people').update({ company: person.company, position: person.position, importance: person.importance || 'B', note: newNote, updated_at: new Date().toISOString() }).eq('id', existing.id)
      } else {
        await supabase.from('people').insert({ name: person.name, company: person.company, position: person.position, importance: person.importance || 'B', note: person.note })
      }
      console.log(`👤 人物昇格: ${person.name}`)
    }
  }

  if (parsed.tasks?.length > 0) {
    for (const task of parsed.tasks) {
      if (!task.content) continue
      const { data: existing } = await supabase.from('task').select('id').eq('content', task.content).single()
      if (!existing) {
        await supabase.from('task').insert({ content: task.content, done: false })
        console.log(`✅ タスク昇格: ${task.content}`)
      }
    }
  }

  if (parsed.calendar?.length > 0) {
    for (const event of parsed.calendar) {
      if (!event.title) continue
      await supabase.from('calendar').insert({ title: event.title, datetime: event.datetime ? new Date(event.datetime) : null })
      console.log(`📅 予定昇格: ${event.title}`)
    }
  }

  if (parsed.business?.length > 0) {
    for (const biz of parsed.business) {
      if (!biz.name) continue
      const { data: existing } = await supabase.from('business_master').select('id, note').ilike('name', `%${biz.name.substring(0, 10)}%`).single()
      if (existing) {
        await supabase.from('business_master').update({ note: (existing.note || '') + '\n' + (biz.note || ''), updated_at: new Date().toISOString() }).eq('id', existing.id)
      } else {
        await supabase.from('business_master').insert({ name: biz.name, note: biz.note, status: '進行中' })
      }
      console.log(`💼 事業昇格: ${biz.name}`)
    }
  }

  if (parsed.memo?.length > 0) {
    for (const m of parsed.memo) {
      if (!m.content) continue
      await supabase.from('memo').insert({ content: m.content, color: 'yellow' })
      console.log(`📝 メモ昇格: ${m.content.substring(0, 30)}`)
    }
  }

  const talkIds = talks.map(t => t.id)
  const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  await supabase.from('talk_master').update({ promoted: true, delete_at: deleteAt }).in('id', talkIds)
  console.log(`✅ ${talkIds.length}件を昇格済みにマーク`)
}

async function main() {
  console.log('☀️ 昼バッチ開始:', new Date().toLocaleString('ja-JP'))
  await keepAlive()
  await analyzeTalkMaster()
  console.log('✅ 昼バッチ完了:', new Date().toLocaleString('ja-JP'))
}

main().catch(console.error)
