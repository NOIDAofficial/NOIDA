import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
})

async function analyzeTalkMaster() {
  console.log('🔍 talk_master分析開始')

  // 未昇格の会話を取得（直近7日間）
  const { data: talks, error } = await supabase
    .from('talk_master')
    .select('*')
    .eq('promoted', false)
    .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: true })

  if (error || !talks || talks.length === 0) {
    console.log('📭 未昇格の会話なし')
    return
  }

  console.log(`📝 ${talks.length}件の会話を分析`)

  // ユーザーの発言のみ抽出
  const userTalks = talks.filter(t => t.role === 'user')
  if (userTalks.length === 0) return

  const conversationText = userTalks
    .map(t => `[${new Date(t.created_at).toLocaleDateString('ja-JP')}] ${t.content}`)
    .join('\n')

  // GPTで分析
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 2000,
    messages: [
      {
        role: 'system',
        content: `あなたはビジネス秘書AIです。
会話ログを分析して重要情報を抽出してください。
必ずJSON形式のみで返答してください。

抽出する情報：
- people: 人物情報（名前・会社・役職・重要度・メモ）
- tasks: タスク（内容）
- calendar: 予定（タイトル・日時）
- business: 事業・プロジェクト情報
- memo: 重要メモ
- delete_ids: 削除してよい会話ID（挨拶・雑談など）

重要度（importance）:
S: 売上直結
A: 重要
B: 通常
C: 無視OK

JSON形式:
{
  "people": [{"name": "", "company": "", "position": "", "importance": "B", "note": ""}],
  "tasks": [{"content": ""}],
  "calendar": [{"title": "", "datetime": ""}],
  "business": [{"name": "", "note": ""}],
  "memo": [{"content": ""}],
  "delete_ids": []
}`
      },
      {
        role: 'user',
        content: `以下の会話ログを分析してください：\n\n${conversationText}\n\n会話ID一覧：\n${userTalks.map(t => `${t.id}: ${t.content.substring(0, 50)}`).join('\n')}`
      }
    ]
  })

  const text = response.choices[0]?.message?.content || ''

  let parsed: {
    people?: any[]
    tasks?: any[]
    calendar?: any[]
    business?: any[]
    memo?: any[]
    delete_ids?: string[]
  } = {}

  try {
    const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1)
    parsed = JSON.parse(jsonStr)
  } catch {
    console.log('❌ JSON解析失敗')
    return
  }

  // 人物情報を昇格
  if (parsed.people && parsed.people.length > 0) {
    for (const person of parsed.people) {
      if (!person.name) continue
      const { data: existing } = await supabase
        .from('people')
        .select('id, note')
        .ilike('name', `%${person.name}%`)
        .single()

      if (existing) {
        const newNote = existing.note
          ? existing.note + '\n' + (person.note || '')
          : (person.note || '')
        await supabase.from('people').update({
          company: person.company,
          position: person.position,
          importance: person.importance || 'B',
          note: newNote,
          updated_at: new Date().toISOString()
        }).eq('id', existing.id)
        console.log(`👤 人物更新: ${person.name}`)
      } else {
        await supabase.from('people').insert({
          name: person.name,
          company: person.company,
          position: person.position,
          importance: person.importance || 'B',
          note: person.note,
        })
        console.log(`👤 人物追加: ${person.name}`)
      }
    }
  }

  // タスクを昇格
  if (parsed.tasks && parsed.tasks.length > 0) {
    for (const task of parsed.tasks) {
      if (!task.content) continue
      const { data: existing } = await supabase
        .from('task')
        .select('id')
        .eq('content', task.content)
        .single()
      if (!existing) {
        await supabase.from('task').insert({ content: task.content, done: false })
        console.log(`✅ タスク追加: ${task.content}`)
      }
    }
  }

  // 予定を昇格
  if (parsed.calendar && parsed.calendar.length > 0) {
    for (const event of parsed.calendar) {
      if (!event.title) continue
      await supabase.from('calendar').insert({
        title: event.title,
        datetime: event.datetime ? new Date(event.datetime) : null
      })
      console.log(`📅 予定追加: ${event.title}`)
    }
  }

  // 事業情報を昇格
  if (parsed.business && parsed.business.length > 0) {
    for (const biz of parsed.business) {
      if (!biz.name) continue
      const { data: existing } = await supabase
        .from('business_master')
        .select('id, note')
        .ilike('name', `%${biz.name.substring(0, 10)}%`)
        .single()
      if (existing) {
        await supabase.from('business_master').update({
          note: (existing.note || '') + '\n' + (biz.note || ''),
          updated_at: new Date().toISOString()
        }).eq('id', existing.id)
      } else {
        await supabase.from('business_master').insert({
          name: biz.name,
          note: biz.note,
          status: '進行中'
        })
      }
      console.log(`💼 事業更新: ${biz.name}`)
    }
  }

  // メモを昇格
  if (parsed.memo && parsed.memo.length > 0) {
    for (const m of parsed.memo) {
      if (!m.content) continue
      await supabase.from('memo').insert({ content: m.content, color: 'yellow' })
      console.log(`📝 メモ追加: ${m.content.substring(0, 30)}`)
    }
  }

  // 昇格済みにマーク
  const talkIds = talks.map(t => t.id)
  const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  await supabase
    .from('talk_master')
    .update({ promoted: true, delete_at: deleteAt })
    .in('id', talkIds)

  console.log(`✅ ${talkIds.length}件を昇格済みにマーク`)
}

async function deleteStaleTalks() {
  console.log('🗑️ 期限切れ会話を削除')
  const { error } = await supabase
    .from('talk_master')
    .delete()
    .eq('promoted', true)
    .lt('delete_at', new Date().toISOString())

  if (!error) console.log('✅ 削除完了')
}

async function keepAlive() {
  console.log('💓 非アクティブ防止クエリ実行')
  const tables = ['people', 'task', 'memo', 'calendar', 'business_master', 'talk_master', 'owner_master']
  for (const table of tables) {
    await supabase.from(table).select('id').limit(1)
  }
  console.log('✅ 全テーブル疎通確認完了')
}

async function generateBriefing() {
  console.log('📋 翌日ブリーフィング生成')

  const { data: tasks } = await supabase
    .from('task')
    .select('*')
    .eq('done', false)
    .order('created_at', { ascending: false })
    .limit(5)

  const { data: calendar } = await supabase
    .from('calendar')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(3)

  const { data: owner } = await supabase
    .from('owner_master')
    .select('*')
    .limit(1)
    .single()

  if (!tasks && !calendar) return

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 500,
    messages: [
      {
        role: 'system',
        content: `あなたは社長専属の意思決定AI「NOIDA」です。
明日の最優先行動を1つだけ提示してください。
必ずJSON形式のみで返答してください。

形式：
{
  "briefing": "【結論】○○してください\n【理由】○○だから",
  "priority_task": "最重要タスク1件"
}`
      },
      {
        role: 'user',
        content: `オーナー：${owner?.name || ''}
未完了タスク：${tasks?.map(t => t.content).join('、') || 'なし'}
直近の予定：${calendar?.map(c => c.title).join('、') || 'なし'}

明日の最優先行動を1つ教えてください。`
      }
    ]
  })

  const text = response.choices[0]?.message?.content || ''
  try {
    const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1)
    const briefing = JSON.parse(jsonStr)

    // ブリーフィングをメモとして保存
    await supabase.from('memo').insert({
      title: `【明日のブリーフィング】${new Date().toLocaleDateString('ja-JP')}`,
      content: briefing.briefing,
      color: 'blue',
      pinned: true
    })
    console.log('✅ ブリーフィング保存完了')
  } catch {
    console.log('❌ ブリーフィング生成失敗')
  }
}

async function main() {
  console.log('🌙 夜間バッチ開始:', new Date().toLocaleString('ja-JP'))

  await keepAlive()
  await analyzeTalkMaster()
  await deleteStaleTalks()
  await generateBriefing()

  console.log('✅ 夜間バッチ完了:', new Date().toLocaleString('ja-JP'))
}

main().catch(console.error)
