import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * NOTE:
 * 今は anon key のまま。
 * 将来は必ず以下に分離する：
 * - user scoped client（RLS用）
 * - admin client（service role）
 *
 * 今後やること：
 * 1. tenantIdを全操作の軸に追加（認証整備後）
 * 2. Supabase client責務分離（anon key → service role）
 * 3. Monitorモード実装（decision_log安定後）
 * 4. フロント側で「した/してない」UIを実装
 * 5. people同姓同名・転職の完全照合対応
 * 6. ログインボーナス制・研修期間モデルの実装
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

type Intent = 'execute' | 'decide' | 'answer' | 'research' | 'explore' | 'empathy' | 'generic'

const HIGH_RISK_KEYWORDS =
  /(法律|法的|訴訟|契約|税務|確定申告|医療|診断|病気|薬|症状|投資|株|為替|FX|仮想通貨)/

const EMPATHY_KEYWORDS =
  /(疲れた|しんどい|つらい|無理|だるい|眠い|やる気ない|面倒|詰んだ|終わった|ミスった|炎上|おはよう|おやすみ|ありがとう|嬉しい|うれしい|悲しい|やばい|最高|最悪)/

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

function classifyIntent(
  text: string,
  keywords: { people: string[]; businesses: string[] }
): Intent {
  if (EMPATHY_KEYWORDS.test(text)) return 'empathy'
  if (/(情報|検索|一覧|調べて|探して)/.test(text)) return 'research'
  if (/(どうする|どっち|決めて|どれがいい|どれにする)/.test(text)) return 'decide'
  if (/(どう思う|考えて|アイデア|壁打ち|案|提案)/.test(text)) return 'explore'
  if (/(何|なに|なぜ|意味|とは|教えて|って何|どういう)/.test(text)) return 'answer'
  if (/(して|やって|送って|返して|作って)/.test(text)) return 'execute'
  if (keywords.people.length || keywords.businesses.length) return 'decide'
  return 'generic'
}

// 直前のNOIDAの返答がempathyだったか検出
function detectPreviousEmpathy(messages: { role: string; content: string }[]): boolean {
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      try {
        const parsed = JSON.parse(messages[i].content)
        return parsed.mode === 'empathy'
      } catch {
        return false
      }
    }
  }
  return false
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
        `【人物】${p.name}（${p.company || ''}・${p.position || ''}・重要度${p.importance}）${p.note ? '特記:' + p.note : ''}`
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
      memory.push(`【事業】${b.name}（${b.status || '進行中'}）${b.note ? '詳細:' + b.note : ''}`)
    }
  }

  if (
    memory.length < 3 &&
    (intent === 'decide' || intent === 'generic' || intent === 'execute')
  ) {
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

async function saveDecision(
  sourceMessage: string,
  intent: Intent,
  parsed: any,
  owner: any
) {
  const shouldLog = ['execute', 'decide'].includes(intent)
  if (!shouldLog || !parsed?.decision_log?.should_log) return

  const { data, error } = await supabase
    .from('decision_log')
    .insert({
      source_message: sourceMessage,
      intent,
      decision_text: parsed.decision_log.decision_text || parsed.reply,
      reason_text: parsed.reason || null,
      context_summary: parsed.decision_log.context_summary || null,
      owner_snapshot: owner || {},
      action_taken: 'pending',
    })
    .select('id')
    .single()

  if (error || !data) return

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
  afterEmpathy: boolean  // ← 追加
) {
  const ownerSection = owner
    ? `
■あなたが再現すべき人物プロファイル
思考パターン: ${owner.thinking_pattern || ''}
優先スタイル: ${owner.priority_style || ''}
文体: ${owner.writing_style || ''}
現在の主要課題: ${owner.key_issues || ''}
避けたいこと: ${owner.avoid_patterns || ''}
`
    : ''

  const memorySection =
    memory.length > 0
      ? `
■判断に使う情報（説明せず行動に反映すること）
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

  // Empathy後の強制復帰
  const afterEmpathyNote = afterEmpathy
    ? `
■重要：直前のターンで感情的な応答をした。
今すぐExecuteまたはDecideモードに完全に戻ること。
感情への言及は一切不要。普通に意思決定AIとして応答せよ。
`
    : ''

  return `今日の日付は${todayStr}です。

あなたは社長専属の意思決定AI「NOIDA」です。
NOIDAはAIではない。ユーザーの思考をコピーし、代わりに意思決定を行う"分身"である。

${ownerSection}
${memorySection}
${riskNote}
${afterEmpathyNote}

■絶対原則
・必ず最後は1つに決める
・短く、断定する
・選択肢を増やさない
・判断をユーザーに返さない
・記憶は判断に使うが見せすぎない
・人間関係は壊さない

■モード判定（内部）
【Empathy】
感情的な言葉（疲れた、しんどい、つらい、無理、だるい、眠い、やる気ない、面倒、詰んだ、終わった、ミスった、炎上、ありがとう、嬉しい、悲しい、最高、最悪、おはよう、おやすみ）
- 1〜2文で終える
- 長く共感しない
- 押しつけない
- 必要なら行動を1つだけ添える
- 必ず mode: "empathy" を返す

【Execute】
ユーザーが行動を求めている
出力：
【結論】〜してください
【理由】〜（1行）

【Decide】
ユーザーが意思決定を求めている
出力：
結論：〜が最適
理由：〜（1行）
却下：他の選択肢が劣る理由（1行）

【Answer】
知識・説明・定義
出力：
端的に答える。行動指示は不要。

【Research】
調査・情報収集
出力：
知っている範囲で答える。不足は「おそらく〜」で補う。

【Explore】
思考・アイデア・相談
出力：
2〜3案まで出してよい。
最後は必ず「結論：〜が最も現実的」で1つに収束。

■保存ルール
・calendar：ユーザーが日時・予定を言った時のみ
・task：ユーザーが明確にタスクを述べた時のみ
・memo：「覚えて」「メモして」と言った時のみ
・people：人物について言及した時
・business：明確なビジネス案がある時のみ
・ideas：明確なアイデアがある時のみ

■優先順位
売上 > 時間 > 人間関係

■必ずJSON形式のみで返答
{
  "reply": "応答テキスト",
  "reason": "1行理由（省略可）",
  "hint": "一言進言（省略可）",
  "options": ["行動に直結する選択肢1〜2個"],
  "mode": "execute|decide|answer|research|explore|empathy",
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
    "decision_text": "提案・結論の要約",
    "context_summary": "短い文脈要約"
  }
}`
}

export async function POST(req: NextRequest) {
  const { messages } = await req.json()
  const lastUserMessage = messages[messages.length - 1]?.content || ''

  // 手動整理コマンド
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

  // フィードバック回収
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

  if (pendingFeedback) {
    const decisionText = (pendingFeedback as any).decision_log?.decision_text || '昨日の提案'
    return NextResponse.json({
      content: [{
        type: 'text',
        text: JSON.stringify({
          reply: `昨日の提案「${decisionText}」は実行しましたか？`,
          options: ['した', 'してない'],
          mode: 'decide',
          save: {},
          decision_log: { should_log: false },
        }),
      }],
    })
  }

  // Empathy後の検出
  const afterEmpathy = detectPreviousEmpathy(messages)

  const owner = await fetchOwnerMaster()
  const keywords = extractKeywords(lastUserMessage)
  const intent = classifyIntent(lastUserMessage, keywords)
  const memory = await fetchMemory(intent, keywords)
  const isHighRisk = HIGH_RISK_KEYWORDS.test(lastUserMessage)
  const systemPrompt = buildSystemPrompt(owner, memory, isHighRisk, afterEmpathy)

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
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
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

  await supabase.from('talk_master').insert({
    role: 'user',
    content: lastUserMessage,
    intent,
    importance: 'B',
  })

  await saveStructuredMemory(parsed.save, lastUserMessage)
  await saveDecision(lastUserMessage, intent, parsed, owner)

  await supabase.from('talk_master').insert({
    role: 'noida',
    content: parsed.reply || '',
    intent,
    importance: intent === 'empathy' ? 'A' : 'B',
  })

  return NextResponse.json({
    content: [{
      type: 'text',
      text: JSON.stringify({
        reply: parsed.reply,
        reason: parsed.reason,
        hint: parsed.hint,
        options: parsed.options || [],
        mode: parsed.mode || intent,
        confidence_low: false,
        saved: parsed.save || {},
      }),
    }],
  })
}
