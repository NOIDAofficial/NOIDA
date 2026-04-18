import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import crypto from 'crypto'

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

const DECAY_RATE = 0.99

// ハッシュ連鎖用の計算関数
function calculateHash(content: string, prevHash: string | null): string {
  const hash = crypto.createHash('sha256')
  hash.update((prevHash || '') + content)
  return hash.digest('hex')
}

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
    .map(f => `提案: ${(f.decision_log as any)?.decision_text || ''}\n本当はどうしたかった: ${f.preferred_action}`)
    .join('\n\n')

  if (!feedbackText) return

  const response = await openai.chat.completions.create({
    model: NOIDA_MODELS.ANALYTICS,
    max_tokens: 1000,
    messages: [
      {
        role: 'system',
        content: `あなたはNOIDAの学習エンジンです。
ユーザーの「本当はこうしたかった」という回答から、判断パターンを分析してください。
これはNOIDAの人格の根幹を形成する重要な処理です。
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

  if (parsed.failure_patterns?.length > 0) {
    await supabase.from('owner_master_drafts').insert({
      field_name: 'failure_patterns',
      before_value: { value: owner?.failure_patterns },
      proposed_value: { value: parsed.failure_patterns.join('\n') },
      confidence: Math.min(parsed.confidence_delta || 0.05, 0.1),
      evidence_count: feedbacks.length,
      reason: '逆学習: してない回答の分析',
      status: 'pending'
    })
  }

  if (parsed.rejection_patterns?.length > 0) {
    await supabase.from('owner_master_drafts').insert({
      field_name: 'rejection_patterns',
      before_value: { value: owner?.rejection_patterns },
      proposed_value: { value: parsed.rejection_patterns.join('\n') },
      confidence: Math.min(parsed.confidence_delta || 0.05, 0.1),
      evidence_count: feedbacks.length,
      reason: '逆学習: 拒否パターン抽出',
      status: 'pending'
    })
  }

  const ids = feedbacks.map(f => f.id)
  await supabase.from('reverse_feedback').update({ processed: true }).in('id', ids)
  console.log(`✅ ${ids.length}件の逆学習処理完了`)
}

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

  if (!recentDecisions || recentDecisions.length === 0) {
    console.log('📭 分析対象の decision_log なし')
    return
  }

  const doneCount = recentDecisions.filter(d => d.action_taken === 'done').length
  const skippedCount = recentDecisions.filter(d => d.action_taken === 'skipped').length
  const winRate = doneCount / recentDecisions.length

  const response = await openai.chat.completions.create({
    model: NOIDA_MODELS.ANALYTICS,
    max_tokens: 1000,
    messages: [
      {
        role: 'system',
        content: `あなたはNOIDAの人格分析エンジンです。
判断ログからowner_masterの更新候補を生成してください。
あなたは人格を直接書き換えるのではなく、「下書き(draft)」を生成する役割です。
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

  if (parsed.drafts?.length > 0) {
    for (const draft of parsed.drafts) {
      const currentConfidence = (owner?.confidence_by_field as any)?.[draft.field] || 0.5
      const rawDelta = draft.confidence_delta || 0.05
      const safeDelta = Math.min(rawDelta, 0.1)
      const newConfidence = Math.min(1, currentConfidence + safeDelta)

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

  const today = new Date().toISOString().split('T')[0]
  await supabase.from('briefing_queue').upsert({
    briefing_date: today,
    top_action: parsed.growth_message || '',
    draft_count: parsed.drafts?.length || 0,
    status: 'ready'
  }, { onConflict: 'briefing_date' })

  console.log('✅ 成長分析完了')
}

/**
 * ★新規: archiveDailyLog
 * 昨日のtalk_masterを daily_log + daily_log_entries にアーカイブ
 * ハッシュ連鎖で改ざん検知可能にする
 */
async function archiveDailyLog() {
  console.log('📚 1日分のログをアーカイブ開始')

  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toISOString().split('T')[0]

  const { data: talks } = await supabase
    .from('talk_master')
    .select('*')
    .eq('session_date', yesterdayStr)
    .order('created_at', { ascending: true })

  if (!talks || talks.length === 0) {
    console.log('📭 アーカイブ対象の会話なし')
    return
  }

  console.log(`📝 ${talks.length}件の会話をアーカイブ`)

  const { data: existing } = await supabase
    .from('daily_log')
    .select('id')
    .eq('session_date', yesterdayStr)
    .maybeSingle()

  if (existing) {
    console.log('⚠️ 既にアーカイブ済み、スキップ')
    return
  }

  const conversationText = talks
    .map((t, i) => `[${i + 1}][${t.role}] ${t.content}`)
    .join('\n')

  const response = await openai.chat.completions.create({
    model: NOIDA_MODELS.ANALYTICS,
    max_tokens: 1500,
    messages: [
      {
        role: 'system',
        content: `あなたはNOIDAの記憶アーキテクトです。
1日分の会話ログを分析し、以下を抽出してください。
必ずJSON形式のみで返答してください。

{
  "summary": "その日1日を3〜5行で要約",
  "topics": ["話したトピック1", "トピック2"],
  "key_decisions": ["この日の主要判断1", "判断2"],
  "emotional_tone": "positive / neutral / stressed / reflective のいずれか"
}`
      },
      {
        role: 'user',
        content: `以下は${yesterdayStr}の会話ログです:\n\n${conversationText}`
      }
    ]
  })

  const text = response.choices[0]?.message?.content || ''
  let summary: any = {
    summary: '',
    topics: [],
    key_decisions: [],
    emotional_tone: 'neutral'
  }

  try {
    const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1)
    summary = JSON.parse(jsonStr)
  } catch {
    console.log('❌ 要約JSON解析失敗、スキップ')
    return
  }

  const { data: owner } = await supabase
    .from('owner_master')
    .select('id, last_hash, daily_log_hashes')
    .limit(1)
    .single()

  const prevHash = owner?.last_hash || null

  const hashContent = JSON.stringify({
    session_date: yesterdayStr,
    summary: summary.summary,
    topics: summary.topics,
    key_decisions: summary.key_decisions,
    talks: talks.map(t => ({
      role: t.role,
      content: t.content,
      created_at: t.created_at
    }))
  })

  const contentHash = calculateHash(hashContent, prevHash)

  const { data: dailyLog, error: dailyLogError } = await supabase
    .from('daily_log')
    .insert({
      session_date: yesterdayStr,
      summary: summary.summary,
      topics: summary.topics || [],
      key_decisions: summary.key_decisions || [],
      emotional_tone: summary.emotional_tone || 'neutral',
      entry_count: talks.length,
      content_hash: contentHash,
      prev_hash: prevHash,
      archived: true,
    })
    .select('id')
    .single()

  if (dailyLogError || !dailyLog) {
    console.log('❌ daily_log INSERT失敗:', dailyLogError)
    return
  }

  const entries = talks.map((t, i) => ({
    daily_log_id: dailyLog.id,
    session_date: yesterdayStr,
    sequence: i + 1,
    role: t.role,
    content: t.content,
    intent: t.intent,
    importance: t.importance,
    original_talk_id: t.id,
    created_at: t.created_at,
  }))

  const { error: entriesError } = await supabase
    .from('daily_log_entries')
    .insert(entries)

  if (entriesError) {
    console.log('❌ daily_log_entries INSERT失敗:', entriesError)
    return
  }

  const prevHashes = Array.isArray(owner?.daily_log_hashes) 
    ? owner.daily_log_hashes 
    : []
  const newHashes = [
    ...prevHashes,
    { date: yesterdayStr, hash: contentHash, prev_hash: prevHash }
  ].slice(-365)

  if (owner?.id) {
    await supabase
      .from('owner_master')
      .update({
        last_hash: contentHash,
        daily_log_hashes: newHashes,
      })
      .eq('id', owner.id)
  }

  await supabase
    .from('talk_master')
    .delete()
    .eq('session_date', yesterdayStr)

  console.log(`✅ ${yesterdayStr} のログをアーカイブ完了 (hash: ${contentHash.substring(0, 8)}...)`)
}

async function analyzeTalkMaster() {
  console.log('🔍 talk_master分析開始')

  const { data: talks } = await supabase
    .from('talk_master')
    .select('*')
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: true })

  if (!talks || talks.length === 0) {
    console.log('📭 分析対象の会話なし')
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
  "memo": [{"content": ""}]
}`
      },
      {
        role: 'user',
        content: `以下の会話ログを分析してください:\n\n${conversationText}`
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
    }
  }

  if (parsed.tasks?.length > 0) {
    for (const task of parsed.tasks) {
      if (!task.content) continue
      const { data: existing } = await supabase.from('task').select('id').eq('content', task.content).single()
      if (!existing) {
        await supabase.from('task').insert({ content: task.content, done: false })
      }
    }
  }

  if (parsed.calendar?.length > 0) {
    for (const event of parsed.calendar) {
      if (!event.title) continue
      await supabase.from('calendar').insert({ title: event.title, datetime: event.datetime ? new Date(event.datetime) : null })
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
    }
  }

  if (parsed.memo?.length > 0) {
    for (const m of parsed.memo) {
      if (!m.content) continue
      await supabase.from('memo').insert({ content: m.content, color: 'yellow' })
    }
  }

  console.log('✅ talk_master分析完了')
}

async function keepAlive() {
  console.log('💓 非アクティブ防止クエリ実行')
  const tables = ['people', 'task', 'memo', 'calendar', 'business_master', 'talk_master', 'owner_master', 'daily_log', 'daily_log_entries']
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
    model: NOIDA_MODELS.ANALYTICS,
    max_tokens: 500,
    messages: [
      {
        role: 'system',
        content: `あなたは社長専属の意思決定AI「NOIDA」です。
全情報を統合し、社長の背中を押す「今日やるべき1つ」を生成してください。
必ずJSON形式のみで返答してください。

{
  "top_action": "【結論】○○してください\n【理由】○○だから",
  "summary": "今日の整理まとめ(1〜2行)",
  "growth_note": "昨日より成長した点(省略可)"
}`
      },
      {
        role: 'user',
        content: `オーナー: ${owner?.name || ''}
未完了タスク: ${tasks?.map(t => t.content).join('、') || 'なし'}
直近の予定: ${calendar?.map(c => c.title).join('、') || 'なし'}${draftSummary}

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
  await archiveDailyLog()
  await generateBriefing()
  console.log('✅ 朝バッチ完了:', new Date().toLocaleString('ja-JP'))
}

main().catch(console.error)
