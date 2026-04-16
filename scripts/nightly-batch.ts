import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
})

const DECAY_RATE = 0.99

// ① confidence time decay
async function applyTimeDecay() {
  console.log('📉 confidence time decay適用')
  const { data: master } = await supabase
    .from('owner_master')
    .select('id, confidence_by_field')
    .limit(1)
    .single()

  if (!master?.confidence_by_field) return

  const updated = Object.fromEntries(
    Object.entries(master.confidence_by_field).map(([field, score]) => [
      field,
      Math.max(0, Math.min(1, (score as number) * DECAY_RATE))
    ])
  )

  await supabase
    .from('owner_master')
    .update({ confidence_by_field: updated })
    .eq('id', master.id)

  console.log('✅ time decay完了')
}

// ② 逆学習：reverse_feedbackを処理
async function processReverseFeedback() {
  console.log('🔄 逆学習処理開始')

  const { data: feedbacks } = await supabase
    .from('reverse_feedback')
    .select('*, decision_log:decision_log_id(decision_text, intent)')
    .eq('processed', false)
    .limit(20)

  if (!feedbacks || feedbacks.length === 0) {
    console.log('📭 未処理の逆学習データなし')
    return
  }

  const { data: owner } = await supabase
    .from('owner_master')
    .select('*')
    .limit(1)
    .single()

  const feedbackText = feedbacks
    .filter(f => f.preferred_action)
    .map(f => `提案：${(f.decision_log as any)?.decision_text || ''}\n本当はどうしたかった：${f.preferred_action}`)
    .join('\n\n')

  if (!feedbackText) return

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1000,
    messages: [
      {
        role: 'system',
        content: `あなたはNOIDAの学習エンジンです。
ユーザーの「本当はこうしたかった」という回答から、判断パターンを分析してください。
必ずJSON形式のみで返答してください。

{
  "failure_patterns": ["避けるべき判断パターン"],
  "rejection_patterns": ["拒否条件"],
  "success_patterns": ["成功パターン"],
  "priority_insight": "優先順位についての洞察",
  "confidence_delta": 0.05
}`
      },
      {
        role: 'user',
        content: `現在のowner_master:\n${JSON.stringify(owner, null, 2)}\n\n逆学習データ:\n${feedbackText}`
      }
    ]
  })

  const text = response.choices[0]?.message?.content || ''
  let parsed: any = {}
  try {
    const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1)
    parsed = JSON.parse(jsonStr)
  } catch {
    console.log('❌ 逆学習JSON解析失敗')
    return
  }

  // owner_master_draftsに保存（直接更新しない）
  if (parsed.failure_patterns?.length > 0) {
    await supabase.from('owner_master_drafts').insert({
      field_name: 'failure_patterns',
      before_value: { value: owner?.failure_patterns },
      proposed_value: { value: parsed.failure_patterns.join('\n') },
      confidence: parsed.confidence_delta || 0.05,
      evidence_count: feedbacks.length,
      reason: '逆学習：してない回答の分析',
      status: 'pending'
    })
  }

  if (parsed.rejection_patterns?.length > 0) {
    await supabase.from('owner_master_drafts').insert({
      field_name: 'rejection_patterns',
      before_value: { value: owner?.rejection_patterns },
      proposed_value: { value: parsed.rejection_patterns.join('\n') },
      confidence: parsed.confidence_delta || 0.05,
      evidence_count: feedbacks.length,
      reason: '逆学習：拒否パターン抽出',
      status: 'pending'
    })
  }

  // 処理済みにマーク
  const ids = feedbacks.map(f => f.id)
  await supabase.from('reverse_feedback').update({ processed: true }).in('id', ids)
  console.log(`✅ ${ids.length}件の逆学習処理完了`)
}

// ③ owner_master自動成長分析
async function analyzeOwnerGrowth() {
  console.log('🧠 owner_master成長分析開始')

  const { data: owner } = await supabase
    .from('owner_master')
    .select('*')
    .limit(1)
    .single()

  const { data: recentDecisions } = await supabase
    .from('decision_log')
    .select('*')
    .in('intent', ['execute', 'decide'])
    .order('created_at', { ascending: false })
    .limit(30)

  if (!recentDecisions || recentDecisions.length === 0) return

  const doneCount = recentDecisions.filter(d => d.action_taken === 'done').length
  const skippedCount = recentDecisions.filter(d => d.action_taken === 'skipped').length
  const winRate = doneCount / recentDecisions.length

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1000,
    messages: [
      {
        role: 'system',
        content: `あなたはNOIDAの人格分析エンジンです。
判断ログからowner_masterの更新候補を生成してください。
必ずJSON形式のみで返答してください。

{
  "drafts": [
    {
      "field": "priority_style",
      "proposed_value": "更新後の値",
      "reason": "理由",
      "confidence_delta": 0.05
    }
  ],
  "identity_score": 0.75,
  "growth_message": "昨日の自分より○○が改善されました"
}`
      },
      {
        role: 'user',
        content: `現在のowner_master:\n${JSON.stringify(owner, null, 2)}\n\n直近の判断ログ:\n${recentDecisions.map(d => `${d.intent}: ${d.decision_text} → ${d.action_taken}`).join('\n')}\n\n採用率: ${Math.round(winRate * 100)}%\n採用: ${doneCount}件 / 却下: ${skippedCount}件`
      }
    ]
  })

  const text = response.choices[0]?.message?.content || ''
  let parsed: any = {}
  try {
    const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1)
    parsed = JSON.parse(jsonStr)
  } catch {
    console.log('❌ 成長分析JSON解析失敗')
    return
  }

  // draftsをowner_master_draftsに保存
  if (parsed.drafts?.length > 0) {
    for (const draft of parsed.drafts) {
      const currentConfidence = (owner?.confidence_by_field as any)?.[draft.field] || 0.5
      const newConfidence = Math.min(1, currentConfidence + (draft.confidence_delta || 0.05))

      await supabase.from('owner_master_drafts').insert({
        field_name: draft.field,
        before_value: { value: (owner as any)?.[draft.field] },
        proposed_value: { value: draft.proposed_value },
        confidence: newConfidence,
        evidence_count: recentDecisions.length,
        reason: draft.reason,
        status: 'pending'
      })
    }
    console.log(`✅ ${parsed.drafts.length}件の更新候補を生成`)
  }

  // briefing_queueに追加
  const today = new Date().toISOString().split('T')[0]
  await supabase.from('briefing_queue').upsert({
    briefing_date: today,
    top_action: parsed.growth_message || '',
    draft_count: parsed.drafts?.length || 0,
    status: 'ready'
  }, { onConflict: 'briefing_date' })

  console.log('✅ 成長分析完了')
}

// 既存関数（変更なし）
async function analyzeTalkMaster() {
  console.log('🔍 talk_master分析開始')

  const { data: talks } = await supabase
    .from('talk_master')
    .select('*')
    .eq('promoted', false)
    .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
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
    model: 'gpt-4o-mini',
    max_tokens: 2000,
    messages: [
      {
        role: 'system',
        content: `あなたはビジネス秘書AIです。
会話ログを分析して重要情報を抽出してください。
必ずJSON形式のみで返答してください。

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
      console.log(`👤 人物更新: ${person.name}`)
    }
  }

  if (parsed.tasks?.length > 0) {
    for (const task of parsed.tasks) {
      if (!task.content) continue
      const { data: existing } = await supabase.from('task').select('id').eq('content', task.content).single()
      if (!existing) {
        await supabase.from('task').insert({ content: task.content, done: false })
        console.log(`✅ タスク追加: ${task.content}`)
      }
    }
  }

  if (parsed.calendar?.length > 0) {
    for (const event of parsed.calendar) {
      if (!event.title) continue
      await supabase.from('calendar').insert({ title: event.title, datetime: event.datetime ? new Date(event.datetime) : null })
      console.log(`📅 予定追加: ${event.title}`)
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
      console.log(`💼 事業更新: ${biz.name}`)
    }
  }

  if (parsed.memo?.length > 0) {
    for (const m of parsed.memo) {
      if (!m.content) continue
      await supabase.from('memo').insert({ content: m.content, color: 'yellow' })
      console.log(`📝 メモ追加: ${m.content.substring(0, 30)}`)
    }
  }

  const talkIds = talks.map(t => t.id)
  const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  await supabase.from('talk_master').update({ promoted: true, delete_at: deleteAt }).in('id', talkIds)
  console.log(`✅ ${talkIds.length}件を昇格済みにマーク`)
}

async function deleteStaleTalks() {
  console.log('🗑️ 期限切れ会話を削除')
  await supabase.from('talk_master').delete().eq('promoted', true).lt('delete_at', new Date().toISOString())
  console.log('✅ 削除完了')
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

  const { data: tasks } = await supabase.from('task').select('*').eq('done', false).order('created_at', { ascending: false }).limit(5)
  const { data: calendar } = await supabase.from('calendar').select('*').order('created_at', { ascending: false }).limit(3)
  const { data: owner } = await supabase.from('owner_master').select('*').limit(1).single()
  const { data: drafts } = await supabase.from('owner_master_drafts').select('*').eq('status', 'pending').limit(3)

  const draftSummary = drafts && drafts.length > 0
    ? `\n承認待ちの更新: ${drafts.map(d => d.field_name).join('、')}`
    : ''

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 500,
    messages: [
      {
        role: 'system',
        content: `あなたは社長専属の意思決定AI「NOIDA」です。
明日の最優先行動を1つだけ提示してください。
必ずJSON形式のみで返答してください。

{
  "top_action": "【結論】○○してください\n【理由】○○だから",
  "summary": "今日の整理まとめ（1〜2行）",
  "growth_note": "昨日より成長した点（省略可）"
}`
      },
      {
        role: 'user',
        content: `オーナー：${owner?.name || ''}
未完了タスク：${tasks?.map(t => t.content).join('、') || 'なし'}
直近の予定：${calendar?.map(c => c.title).join('、') || 'なし'}${draftSummary}

明日の最優先行動を1つ教えてください。`
      }
    ]
  })

  const text = response.choices[0]?.message?.content || ''
  try {
    const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1)
    const briefing = JSON.parse(jsonStr)

    const today = new Date().toISOString().split('T')[0]
    await supabase.from('daily_briefing').upsert({
      briefing_date: today,
      top_action: briefing.top_action,
      summary: briefing.summary,
    }, { onConflict: 'briefing_date' })

    console.log('✅ ブリーフィング保存完了')
    if (briefing.growth_note) {
      console.log(`🌱 成長メモ: ${briefing.growth_note}`)
    }
  } catch {
    console.log('❌ ブリーフィング生成失敗')
  }
}

async function main() {
  console.log('🌙 朝バッチ開始:', new Date().toLocaleString('ja-JP'))
  await keepAlive()
  await applyTimeDecay()
  await processReverseFeedback()
  await analyzeOwnerGrowth()
  await analyzeTalkMaster()
  await deleteStaleTalks()
  await generateBriefing()
  console.log('✅ 朝バッチ完了:', new Date().toLocaleString('ja-JP'))
}

main().catch(console.error)

