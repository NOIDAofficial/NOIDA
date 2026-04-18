import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * NOIDA route.ts v1.2 (記憶アーキテクチャ v1.1 対応)
 *
 * 変更履歴:
 * v1.1: Phase 0 (saveDecision緩和 + Objection + Non-Intervention)
 * v1.2: session_date対応 + トピック切り替え検出
 *
 * 今後やること:
 * 1. tenantIdを全操作の軸に追加(認証整備後)
 * 2. Supabase client責務分離(anon key → service role)
 * 3. Monitorモード実装(decision_log安定後)
 * 4. people同姓同名・転職の完全照合対応
 * 5. マルチAIルーティング(Claude監査・Gemini検索)
 * 6. Forget Queue連携
 * 7. daily_log_entries からの RAG 参照
 */
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const now = new Date()
const todayStr = now.toLocaleDateString('ja-JP', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})

// 今日のセッション日付 (YYYY-MM-DD)
function getSessionDate(): string {
  return new Date().toISOString().split('T')[0]
}

type Intent =
  | 'execute'
  | 'decide'
  | 'answer'
  | 'research'
  | 'explore'
  | 'empathy'
  | 'objection'
  | 'non_intervention'
  | 'generic'

const HIGH_RISK_KEYWORDS =
  /(法律|法的|訴訟|契約|税務|確定申告|医療|診断|病気|薬|症状|投資|株|為替|FX|仮想通貨)/

const EMPATHY_KEYWORDS =
  /(疲れた|しんどい|つらい|無理|だるい|眠い|やる気ない|面倒|詰んだ|ミスった|炎上|おはよう|おやすみ|ありがとう|嬉しい|うれしい|悲しい|やばい|最高|最悪)/

// トピック切り替え検出
const TOPIC_SWITCH = /(話変わるけど|別件|別の話|ところで|そういえば|話変わる)/

// Objection - 破滅的・危険な判断への安全弁
const CRISIS_PATTERNS = {
  lethal: /(死にたい|消えたい|終わりにしたい|もう限界|全部捨てる|生きてる意味)/,
  destructive: /(全財産|全部売る|絶縁|廃業|離婚する|辞める|店じまい).*(今日|今すぐ|明日|これから)/,
  illegal: /(脱税|脅迫|暴力|報復|殴る|潰してやる)/,
}

// Non-Intervention - NOIDAが決めるべきではない領域
const NON_INTERVENTION_PATTERNS = {
  life: /(結婚しようか|離婚しようか|出産|中絶|養子|別れるべき|復縁)/,
  health: /(手術|抗がん|精神科|薬の量|治療方針|どの病院)/,
  major_finance: /(投資.*\d{7,}|不動産購入|M&A|全資産|借金\d{7,})/,
  legal: /(訴訟|告訴|契約破棄|損害賠償)/,
}

function normalizeName(name: string) {
  return name.replace(/[さん様社長会長部長課長先生]/g, '').trim()
}

function extractKeywords(text: string) {
  const people =
    text.match(/([一-龯ぁ-んァ-ンA-Za-z]{1,12})(さん|会長|社長|部長|課長|先生|様)/g) || []
  const businesses =
    text.match(/[A-Z][A-Za-z0-9_-]+|[一-龯]{2,10}(事業|プロジェクト|案件|サービス|アプリ)/g) || []
  return {
    people: people.map((p) => normalizeName(p)),
    businesses,
  }
}

function extractDatetime(text: string): { title: string; datetime: string | null } | null {
  const now = new Date()
  const patterns: { regex: RegExp; resolver: (m: RegExpMatchArray) => Date | null }[] = [
    {
      regex: /明日[のは]?\s*(\d{1,2})時(\d{1,2})?分?/,
      resolver: (m) => {
        const d = new Date(now)
        d.setDate(d.getDate() + 1)
        d.setHours(parseInt(m[1]), m[2] ? parseInt(m[2]) : 0, 0, 0)
        return d
      },
    },
    {
      regex: /今日[のは]?\s*(\d{1,2})時(\d{1,2})?分?/,
      resolver: (m) => {
        const d = new Date(now)
        d.setHours(parseInt(m[1]), m[2] ? parseInt(m[2]) : 0, 0, 0)
        return d
      },
    },
    {
      regex: /来週[のは]?\s*(月|火|水|木|金|土|日)曜/,
      resolver: (m) => {
        const dayMap: Record<string, number> = { 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6, 日: 0 }
        const target = dayMap[m[1]]
        const d = new Date(now)
        const diff = ((target - d.getDay() + 7) % 7) + 7
        d.setDate(d.getDate() + diff)
        d.setHours(10, 0, 0, 0)
        return d
      },
    },
    {
      regex: /今週[のは]?\s*(月|火|水|木|金|土|日)曜/,
      resolver: (m) => {
        const dayMap: Record<string, number> = { 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6, 日: 0 }
        const target = dayMap[m[1]]
        const d = new Date(now)
        const diff = (target - d.getDay() + 7) % 7
        d.setDate(d.getDate() + diff)
        d.setHours(10, 0, 0, 0)
        return d
      },
    },
    {
      regex: /今週中/,
      resolver: () => {
        const d = new Date(now)
        const daysUntilFriday = (5 - d.getDay() + 7) % 7 || 7
        d.setDate(d.getDate() + daysUntilFriday)
        d.setHours(18, 0, 0, 0)
        return d
      },
    },
    {
      regex: /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/,
      resolver: (m) => new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`),
    },
    {
      regex: /(\d{1,2})月(\d{1,2})日[のは]?\s*(\d{1,2})時/,
      resolver: (m) => {
        const d = new Date(now)
        d.setMonth(parseInt(m[1]) - 1, parseInt(m[2]))
        d.setHours(parseInt(m[3]), 0, 0, 0)
        return d
      },
    },
  ]

  for (const { regex, resolver } of patterns) {
    const match = text.match(regex)
    if (match) {
      const dt = resolver(match)
      if (dt) return { title: text.substring(0, 30), datetime: dt.toISOString() }
    }
  }
  return null
}

function detectCrisis(text: string): 'lethal' | 'destructive' | 'illegal' | null {
  if (CRISIS_PATTERNS.lethal.test(text)) return 'lethal'
  if (CRISIS_PATTERNS.destructive.test(text)) return 'destructive'
  if (CRISIS_PATTERNS.illegal.test(text)) return 'illegal'
  return null
}

function detectNonIntervention(text: string): string | null {
  if (NON_INTERVENTION_PATTERNS.life.test(text)) return 'life'
  if (NON_INTERVENTION_PATTERNS.health.test(text)) return 'health'
  if (NON_INTERVENTION_PATTERNS.major_finance.test(text)) return 'major_finance'
  if (NON_INTERVENTION_PATTERNS.legal.test(text)) return 'legal'
  return null
}

function detectTopicSwitch(text: string): boolean {
  return TOPIC_SWITCH.test(text)
}

function classifyIntent(
  text: string,
  keywords: { people: string[]; businesses: string[] }
): Intent {
  if (detectCrisis(text)) return 'objection'
  if (detectNonIntervention(text)) return 'non_intervention'
  if (/(情報|検索|一覧|調べて|探して)/.test(text)) return 'research'
  if (/(どうする|どっち|決めて|どれがいい|どれにする)/.test(text)) return 'decide'
  if (/(どう思う|考えて|アイデア|壁打ち|案|提案)/.test(text)) return 'explore'
  if (/(何|なに|なぜ|意味|とは|教えて|って何|どういう)/.test(text)) return 'answer'
  if (/(して|やって|送って|返して|作って)/.test(text)) return 'execute'
  if (keywords.people.length || keywords.businesses.length) return 'decide'
  if (EMPATHY_KEYWORDS.test(text)) return 'empathy'
  return 'generic'
}

function detectPreviousEmpathy(messages: any[]): boolean {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!lastAssistant) return false
  if (lastAssistant.meta?.mode === 'empathy') return true
  try {
    const content = lastAssistant.content
    const jsonStr = content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1)
    const parsed = JSON.parse(jsonStr)
    return parsed.mode === 'empathy'
  } catch {
    return false
  }
}

async function fetchOwnerMaster() {
  const { data } = await supabase.from('owner_master').select('*').limit(1).single()
  return data ?? null
}

async function fetchMemory(
  intent: Intent,
  keywords: { people: string[]; businesses: string[] }
) {
  const memory: string[] = []

  if (keywords.people.length > 0) {
    const name = keywords.people[0]
    const { data } = await supabase.from('people').select('*').ilike('name', `%${name}%`).limit(1)
    if (data?.length) {
      const p = data[0]
      memory.push(
        `【人物】${p.name}(${p.company || ''}・${p.position || ''}・重要度${p.importance})${p.note ? '特記:' + p.note : ''}`
      )
    }
  }

  if (keywords.businesses.length > 0 && memory.length < 3) {
    const name = keywords.businesses[0]
    const { data } = await supabase
      .from('business_master')
      .select('*')
      .ilike('name', `%${name}%`)
      .limit(1)
    if (data?.length) {
      const b = data[0]
      memory.push(`【事業】${b.name}(${b.status || '進行中'})${b.note ? '詳細:' + b.note : ''}`)
    }
  }

  if (memory.length < 3 && (intent === 'decide' || intent === 'generic' || intent === 'execute')) {
    const { data } = await supabase
      .from('task')
      .select('*')
      .eq('done', false)
      .order('created_at', { ascending: true })
      .limit(2)
    if (data?.length) {
      memory.push(`【未完了タスク】${data.map((t: any) => t.content).join(' / ')}`)
    }
  }

  if (memory.length < 3 && (intent === 'decide' || intent === 'generic')) {
    const { data } = await supabase
      .from('calendar')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
    if (data?.length) {
      memory.push(`【予定】${data[0].title}`)
    }
  }

  return memory.slice(0, 3)
}

async function fetchPendingFeedback() {
  const { data } = await supabase
    .from('feedback_queue')
    .select('id, decision_log_id, decision_log:decision_log_id(decision_text)')
    .eq('asked', false)
    .lte('ask_after', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return data ?? null
}

async function recordFeedback(queueId: string, decisionLogId: string, done: boolean) {
  await supabase
    .from('decision_log')
    .update({ action_taken: done ? 'done' : 'skipped', updated_at: new Date().toISOString() })
    .eq('id', decisionLogId)
  await supabase
    .from('feedback_queue')
    .update({ asked: true, answered: true })
    .eq('id', queueId)
}

async function saveDecision(sourceMessage: string, intent: Intent, parsed: any, owner: any) {
  const LOGGABLE_INTENTS = ['execute', 'decide', 'objection', 'non_intervention']
  if (!LOGGABLE_INTENTS.includes(intent)) return

  const decisionText =
    parsed?.decision_log?.decision_text ||
    parsed?.reply?.substring(0, 100) ||
    sourceMessage.substring(0, 100)

  const { data, error } = await supabase
    .from('decision_log')
    .insert({
      source_message: sourceMessage,
      intent,
      decision_text: decisionText,
      reason_text: parsed?.reason || parsed?.decision_log?.reason || null,
      context_summary: parsed?.decision_log?.context_summary || null,
      owner_snapshot: owner || {},
      action_taken: 'pending',
    })
    .select('id')
    .single()

  if (error || !data) {
    console.log('❌ decision_log 記録失敗:', error)
    return
  }

  if (intent === 'objection' || intent === 'non_intervention') return

  const askAfter = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  await supabase.from('feedback_queue').insert({
    decision_log_id: data.id,
    ask_after: askAfter,
  })
}

async function saveStructuredMemory(save: any, rawText: string) {
  if (!save) return

  if (save.task) {
    const { data: existing } = await supabase
      .from('task')
      .select('id')
      .eq('content', save.task)
      .limit(1)
    if (!existing?.length) {
      await supabase.from('task').insert({ content: save.task, done: false })
    }
  }

  if (save.memo) await supabase.from('memo').insert({ content: save.memo })

  if (save.calendar) {
    const extracted = extractDatetime(rawText)
    await supabase.from('calendar').insert({
      title: save.calendar,
      datetime: extracted?.datetime || null,
    })
  }

  if (save.people?.name) {
    const p = save.people
    const normalizedName = normalizeName(p.name)
    const { data: candidates } = await supabase
      .from('people')
      .select('*')
      .ilike('name', `%${normalizedName}%`)
      .limit(3)

    const existing =
      candidates?.find(
        (c) =>
          (p.company && c.company === p.company) ||
          (p.position && c.position === p.position) ||
          c.name === normalizedName
      ) || candidates?.[0]

    if (existing) {
      const nextNote = [existing.note, p.note].filter(Boolean).join('\n')
      await supabase
        .from('people')
        .update({
          company: p.company || existing.company,
          position: p.position || existing.position,
          note: nextNote,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
    } else {
      await supabase.from('people').insert({
        name: normalizedName,
        company: p.company || null,
        position: p.position || null,
        note: p.note || null,
        importance: 'B',
      })
    }
  }

  if (save.business?.name) {
    const b = save.business
    const { data: existing } = await supabase
      .from('business_master')
      .select('*')
      .ilike('name', `%${b.name}%`)
      .limit(1)
    if (existing?.length) {
      await supabase
        .from('business_master')
        .update({
          note: [existing[0].note, b.note].filter(Boolean).join('\n'),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing[0].id)
    } else {
      await supabase.from('business_master').insert({ name: b.name, note: b.note || null })
    }
  }

  if (save.ideas) await supabase.from('ideas').insert({ content: save.ideas })
}

async function triggerDaytimeBatch() {
  try {
    const response = await fetch(
      'https://api.github.com/repos/NOIDAofficial/NOIDA/actions/workflows/nightly-batch.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { batch_type: 'daytime' } }),
      }
    )
    if (response.ok) console.log('✅ 昼バッチ起動成功')
    else console.log('❌ 昼バッチ起動失敗:', response.status)
  } catch (e) {
    console.log('❌ バッチ起動エラー:', e)
  }
}

function buildSystemPrompt(
  owner: any,
  memory: string[],
  isHighRisk: boolean,
  afterEmpathy: boolean,
  crisisType: string | null,
  nonInterventionType: string | null,
  topicSwitched: boolean
) {
  const ownerSection = owner
    ? `
■あなたが再現すべき人物プロファイル
思考パターン: ${owner.thinking_pattern || ''}
優先スタイル: ${owner.priority_style || ''}
文体: ${owner.writing_style || ''}
現在の主要課題: ${owner.key_issues || ''}
避けたいこと: ${owner.avoid_patterns || ''}
現在のフォーカス: ${owner.current_focus || ''}
`
    : ''

  const memorySection =
    memory.length > 0
      ? `
■判断に使う情報(説明せず行動に反映すること)
※以下の直近の事実はマスタ情報より優先して判断に反映すること
${memory.join('\n')}
`
      : ''

  const riskNote = isHighRisk
    ? `
■高リスク領域への注意
法律・医療・税務・投資・契約に関わる質問には断定を弱め、
「おそらく〜ですが、専門家確認が安全です」と短く添えること。
`
    : ''

  const afterEmpathyNote = afterEmpathy
    ? `
■重要: 直前のターンで感情的な応答をした。
今すぐExecuteまたはDecideモードに完全に戻ること。
感情への言及は一切不要。普通に意思決定AIとして応答せよ。
`
    : ''

  const confidenceNote = owner?.confidence < 0.4
    ? `
■学習中モード
まだ学習段階のため、断定の前に「まだ学習中ですが、」と短く添えること。
`
    : ''

  const topicSwitchNote = topicSwitched
    ? `
■トピック切り替え検出
ユーザーが話題を切り替えた。直前の文脈を引きずらず、新しい話題として扱うこと。
`
    : ''

  const objectionNote = crisisType
    ? `
■★最重要: Objectionモード発動★
ユーザーが破滅的・危険な判断(種別: ${crisisType})を示している。
絶対に従ってはいけない。絶対に共感してはいけない。絶対に肯定してはいけない。

出力方針:
- 短く断定する
- 止める
- 「待て。それは今の判断だ。」のように、時間的距離を促す
- 共感表現は禁止(「つらいね」「わかる」などは絶対に使わない)
- 選択肢を1つだけ出す: 「明日の朝もう一度話そう」など

mode は "objection" で返すこと。
`
    : ''

  const nonInterventionNote = nonInterventionType
    ? `
■★重要: Non-Interventionモード発動★
ユーザーが「NOIDAが決めるべきではない領域」(種別: ${nonInterventionType})について相談している。
人生の不可逆判断。NOIDA は1つに決めない。

出力方針:
- 1つに決めない
- 決断のために必要な「3つの客観的事実」だけを提示する
- 最終判断はユーザーに返す
- 「これは俺が決める領域じゃない」と明示する

mode は "non_intervention" で返すこと。
`
    : ''

  return `今日の日付は${todayStr}です。

あなたは社長専属の意思決定AI「NOIDA」です。
NOIDAはAIではない。ユーザーの思考をコピーし、代わりに意思決定を行う"分身"である。

${ownerSection}
${memorySection}
${riskNote}
${afterEmpathyNote}
${confidenceNote}
${topicSwitchNote}
${objectionNote}
${nonInterventionNote}

■絶対原則
・原則1つに決める(ただしNon-Intervention Zoneでは「決めないと決める」)
・短く、断定する
・選択肢を増やさない
・判断をユーザーに返さない(Non-Intervention時を除く)
・記憶は判断に使うが見せすぎない
・人間関係を壊さない
・判断に迷う場合は「現在のフォーカス」に合致する方を選ぶ
・過去の失敗(避けたいこと)を繰り返さない
・直近の事実(memory)はマスタ情報より優先して判断に反映する

■モード判定(内部)

【Objection】★安全弁★(最優先)
破滅的・危険な判断を検出した時のみ発動。
共感禁止、肯定禁止、短く止める。

【Non-Intervention】★権限境界★
結婚・離婚・手術・重要投資など、NOIDAが決めるべきでない領域。
1つに決めず、判断材料を3つ出して退く。

【Empathy】★感情補助★
「おはよう」「おやすみ」「ありがとう」「疲れた」等が含まれ、かつ意思決定の要素がない場合のみ。
- 1〜2文で温かく
- 押しつけない

【Execute】
ユーザーが行動を求めている。
【結論】〜してください
【理由】〜(1行)

【Decide】
ユーザーが意思決定を求めている。
結論: 〜が最適
理由: 〜(1行)
却下: 他の選択肢が劣る理由(1行)

【Answer】
知識・説明・定義。端的に答える。

【Research】
調査・情報収集。知ってる範囲で答える。不足は「おそらく〜」で補う。

【Explore】
思考・アイデア。2〜3案まで出して最後は1つに収束。

■保存ルール
・calendar: ユーザーが日時・予定を言った時のみ
・task: ユーザーが明確にタスクを述べた時のみ
・memo: 「覚えて」「メモして」と言った時のみ
・people: 人物について言及した時
・business: 明確なビジネス案がある時のみ
・ideas: 明確なアイデアがある時のみ

■優先順位
売上 > 時間 > 人間関係

■★decision_log の should_log 判定ルール★
modeが "execute" "decide" "objection" "non_intervention" のいずれかなら
decision_log.should_log は必ず true。
その他のmodeでは false。
decision_text には「何をすべきか」を動詞で終わる1文で。

■必ずJSON形式のみで返答
{
  "reply": "応答テキスト",
  "reason": "1行理由(省略可)",
  "hint": "一言進言(省略可)",
  "options": ["行動に直結する選択肢1〜2個"],
  "mode": "execute|decide|answer|research|explore|empathy|objection|non_intervention",
  "save": {
    "memo": null,
    "calendar": null,
    "task": null,
    "people": null,
    "business": null,
    "ideas": null
  },
  "decision_log": {
    "should_log": true,
    "decision_text": "結論だけ(1文・動詞で終わる)",
    "context_summary": "短い文脈要約"
  }
}`
}

export async function POST(req: NextRequest) {
  const { messages } = await req.json()
  const lastUserMessage = messages[messages.length - 1]?.content || ''
  const sessionDate = getSessionDate()

  if (/更新して|整理して|学習して|マスタ更新/.test(lastUserMessage)) {
    triggerDaytimeBatch()
    return NextResponse.json({
      content: [{
        type: 'text',
        text: JSON.stringify({
          reply: '【結論】記憶を整理しています\n【理由】数分後に最新情報が反映されます',
          hint: 'バックグラウンドで処理中です',
          options: ['完了したら教えて', 'そのまま続ける'],
          mode: 'execute',
          save: {},
          decision_log: { should_log: false },
        }),
      }],
    })
  }

  const pendingFeedback = await fetchPendingFeedback()

  if (
    pendingFeedback &&
    /^(した|やった|できた|してない|やってない|できてない)$/.test(lastUserMessage.trim())
  ) {
    const done = /^(した|やった|できた)$/.test(lastUserMessage.trim())
    await recordFeedback(pendingFeedback.id, pendingFeedback.decision_log_id, done)
    return NextResponse.json({
      content: [{
        type: 'text',
        text: JSON.stringify({
          reply: done ? '了解。記録しました。' : '了解です。次の判断に反映します。',
          options: [],
          mode: 'empathy',
          save: {},
          decision_log: { should_log: false },
        }),
      }],
    })
  }

  if (
    pendingFeedback &&
    lastUserMessage.length < 15 &&
    !HIGH_RISK_KEYWORDS.test(lastUserMessage)
  ) {
    const decisionText = (pendingFeedback as any).decision_log?.decision_text || '昨日の提案'
    return NextResponse.json({
      content: [{
        type: 'text',
        text: JSON.stringify({
          reply: `昨日の提案「${decisionText}」は実行しましたか?`,
          options: ['した', 'してない'],
          mode: 'decide',
          save: {},
          decision_log: { should_log: false },
        }),
      }],
    })
  }

  const crisisType = detectCrisis(lastUserMessage)
  const nonInterventionType = detectNonIntervention(lastUserMessage)
  const topicSwitched = detectTopicSwitch(lastUserMessage)

  const afterEmpathy = detectPreviousEmpathy(messages)
  const owner = await fetchOwnerMaster()
  const keywords = extractKeywords(lastUserMessage)
  const intent = classifyIntent(lastUserMessage, keywords)
  const memory = await fetchMemory(intent, keywords)
  const isHighRisk = HIGH_RISK_KEYWORDS.test(lastUserMessage)
  const systemPrompt = buildSystemPrompt(
    owner,
    memory,
    isHighRisk,
    afterEmpathy,
    crisisType,
    nonInterventionType,
    topicSwitched
  )

  const cleanMessages = messages
    .map((m: any) => ({
      role: m.role === 'noida' ? 'assistant' : m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }))
    .slice(-10)

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 1000,
      messages: [{ role: 'system', content: systemPrompt }, ...cleanMessages],
    }),
  })

  const data = await res.json()
  const text = data.choices?.[0]?.message?.content ?? ''

  let parsed: any = {
    reply: text,
    reason: '',
    hint: '',
    options: [],
    mode: intent,
    save: {},
    decision_log: { should_log: false },
  }

  try {
    const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1)
    parsed = JSON.parse(jsonStr)
  } catch {}

  if (owner?.confidence < 0.4 && parsed.reply && !parsed.reply.startsWith('まだ学習中')) {
    parsed.reply = 'まだ学習中ですが、' + parsed.reply
  }

  let finalIntent = (parsed.mode || intent) as Intent
  if (crisisType) finalIntent = 'objection'
  if (nonInterventionType && !crisisType) finalIntent = 'non_intervention'

  // ★セッション日付付きで talk_master に保存
  await supabase.from('talk_master').insert({
    role: 'user',
    content: lastUserMessage,
    intent: finalIntent,
    importance: finalIntent === 'objection' ? 'A' : 'B',
    session_date: sessionDate,
  })

  await saveStructuredMemory(parsed.save, lastUserMessage)
  await saveDecision(lastUserMessage, finalIntent, parsed, owner)

  await supabase.from('talk_master').insert({
    role: 'noida',
    content: parsed.reply || '',
    intent: finalIntent,
    importance:
      finalIntent === 'empathy' || finalIntent === 'objection' ? 'A' : 'B',
    session_date: sessionDate,
  })

  return NextResponse.json({
    content: [{
      type: 'text',
      text: JSON.stringify({
        reply: parsed.reply,
        reason: parsed.reason,
        hint: parsed.hint,
        options: parsed.options || [],
        mode: finalIntent,
        confidence_low: owner?.confidence < 0.4,
        saved: parsed.save || {},
      }),
    }],
  })
}
