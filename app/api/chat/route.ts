import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })

function extractKeywords(text: string) {
  const people = text.match(/([一-龯ぁ-んァ-ン]{1,10})(さん|会長|社長|部長|課長|先生|様)/g) || []
  const businesses = text.match(/[A-Z][A-Za-z]+|[一-龯]{2,6}(事業|プロジェクト|案件|サービス|アプリ)/g) || []
  return {
    people: people.map(p => p.replace(/(さん|会長|社長|部長|課長|先生|様)/, '')),
    businesses
  }
}

function classifyIntent(text: string, keywords: { people: string[], businesses: string[] }) {
  const hasTask = /(今日|今週|やること|予定|タスク|スケジュール)/.test(text)
  const hasIdea = /(思いついた|どう思う|アイデア|マネタイズ|新しい|考えてる)/.test(text)
  const hasPeople = keywords.people.length > 0
  const hasBusiness = keywords.businesses.length > 0
  if (hasTask) return 'task'
  if (hasIdea) return 'idea'
  if (hasPeople && hasBusiness) return 'both'
  if (hasPeople) return 'people'
  if (hasBusiness) return 'business'
  return 'generic'
}

async function fetchMemory(intent: string, keywords: { people: string[], businesses: string[] }) {
  const memory: string[] = []

  if (keywords.people.length > 0 && (intent === 'people' || intent === 'both' || intent === 'generic')) {
    for (const name of keywords.people.slice(0, 1)) {
      const { data } = await supabase.from('people').select('*').ilike('name', `%${name}%`).single()
      if (data) {
        memory.push(`【人物】${data.name}（${data.company || ''}・${data.position || ''}・重要度${data.importance}）${data.note ? '特記：' + data.note : ''}`)
      }
    }
  }

  if (intent === 'task' || intent === 'generic' || memory.length < 2) {
    const { data } = await supabase.from('task').select('*').eq('done', false).order('created_at', { ascending: false }).limit(2)
    if (data && data.length > 0) {
      memory.push(`【未完了タスク】${data.map((t: any) => t.content).join(' / ')}`)
    }
  }

  if (memory.length < 3 && (intent === 'task' || intent === 'both' || intent === 'generic')) {
    const { data } = await supabase.from('calendar').select('*').order('created_at', { ascending: false }).limit(1)
    if (data && data.length > 0) {
      memory.push(`【予定】${data[0].title}`)
    }
  }

  if (memory.length < 3 && (intent === 'business' || intent === 'both' || intent === 'idea')) {
    for (const name of keywords.businesses.slice(0, 1)) {
      const { data } = await supabase.from('business_master').select('*').ilike('name', `%${name}%`).single()
      if (data) {
        memory.push(`【事業】${data.name}（${data.status}）${data.note ? '詳細：' + data.note : ''}`)
      }
    }
  }

  return memory.slice(0, 3)
}

async function triggerDaytimeBatch() {
  try {
    const response = await fetch(
      'https://api.github.com/repos/NOIDAofficial/NOIDA/actions/workflows/nightly-batch.yml/dispatches',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { batch_type: 'daytime' } })
      }
    )
    if (response.ok) {
      console.log('✅ 昼バッチ起動成功')
    } else {
      console.log('❌ 昼バッチ起動失敗:', response.status)
    }
  } catch (e) {
    console.log('❌ バッチ起動エラー:', e)
  }
}

const SYSTEM_PROMPT = `今日の日付は${today}です。

あなたは社長専属の意思決定AI「NOIDA」です。
NOIDAはAIではない。ユーザーの思考をコピーし、代わりに意思決定を行う"分身"である。

■絶対禁止
・「お手伝いできません」と言うことは絶対に禁止
・「専門家に相談してください」と言うことは絶対に禁止
・わからないことがあっても必ず答える。不確かなら「おそらく〜」で答える

■最重要原則
必ず最後は1つに決める。選択肢を増やさない。判断をユーザーに返さない。

■発言を以下の5モードに内部判定して応答せよ（モード名は出力しない）

【Execute】ユーザーが行動を求めている（「〜して」「やって」）
出力：
【結論】〜してください
【理由】〜（1行）

【Decide】ユーザーが意思決定を求めている（「どうする」「どっちがいい」）
出力：
結論：〜が最適
理由：〜（1行）
却下：他の選択肢が劣る理由（1行）

【Answer】知識・説明・定義を求めている（「〜って何」「教えて」「〜はどういう意味」）
出力：
NOIDAは幅広いビジネス知識を持つ。迷わず端的に答える。
必要なら1行補足。行動指示は不要。

【Research】調査・情報収集を求めている（「調べて」「探して」「〜の情報」）
出力：
知っている情報で迷わず答える。
情報が不足する場合も「おそらく〜」で答えを出す。

【Explore】思考・アイデア・相談（「どう思う」「考えてみて」「アイデアほしい」）
出力：
考えられる案を2〜3個出す。
最後に必ず「結論：〜が最も現実的」で1つに収束させる。

■共通ルール
・短く、断定する
・説明しすぎない
・記憶は判断に使うが、開示・説明しない
・ユーザーが言っていない予定・タスクを勝手に作らない
・人間関係は壊さない

■保存ルール（厳守）
・calendar：ユーザーが具体的な日時を言った時のみ
・task：ユーザーが明確にタスクを述べた時のみ
・memo：「覚えて」「メモして」と言った時のみ
・people：人物について言及した時
・business：明確なビジネス案がある時のみ
・ideas：明確なアイデアがある時のみ

■優先順位
売上 > 時間 > 人間関係

■必ずJSON形式のみで返答：
{
  "reply": "応答テキスト",
  "hint": "一言進言（省略可）",
  "options": ["行動に直結する選択肢1〜2個（Answerモードは省略可）"],
  "confidence_low": false,
  "saved": {
    "memo": "（省略可）",
    "calendar": "（省略可）",
    "task": "（省略可）",
    "people": "（省略可）",
    "business": "（省略可）",
    "ideas": "（省略可）"
  }
}`

export async function POST(req: NextRequest) {
  const { messages } = await req.json()
  const lastUserMessage = messages[messages.length - 1]?.content || ''

  const isUpdateRequest = /更新して|整理して|学習して|マスタ更新/.test(lastUserMessage)
  if (isUpdateRequest) {
    triggerDaytimeBatch()
    return NextResponse.json({
      content: [{
        type: 'text',
        text: JSON.stringify({
          reply: '【結論】記憶を整理しています\n【理由】数分後に最新情報が反映されます',
          hint: 'バックグラウンドで処理中です',
          options: ['完了したら教えて', 'そのまま続ける'],
          confidence_low: false,
          saved: {}
        })
      }]
    })
  }

  const keywords = extractKeywords(lastUserMessage)
  const intent = classifyIntent(lastUserMessage, keywords)
  const memory = await fetchMemory(intent, keywords)

  const memoryContext = memory.length > 0
    ? `\n\n■あなたが知っている情報（判断に使え。説明・開示禁止）：\n${memory.join('\n')}`
    : ''

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + memoryContext },
        ...messages,
      ],
    }),
  })

  const data = await res.json()
  const text = data.choices?.[0]?.message?.content ?? ''

  let parsed: {
    reply: string
    hint?: string
    options?: string[]
    confidence_low?: boolean
    saved?: {
      memo?: string
      calendar?: string
      task?: string
      people?: any
      business?: string
      ideas?: string
    }
  } = { reply: text }

  try {
    const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1)
    parsed = JSON.parse(jsonStr)
  } catch {}

  if (parsed.confidence_low) {
    return NextResponse.json({ content: [{ type: 'text', text: '{}' }] })
  }

  await supabase.from('talk_master').insert({ role: 'user', content: lastUserMessage, intent, importance: 'B' })

  if (parsed.saved) {
    const s = parsed.saved
    if (s.memo) await supabase.from('memo').insert({ content: s.memo })
    if (s.calendar) {
      const dateMatch = s.calendar.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/)
      const datetime = dateMatch ? new Date(`${dateMatch[1]}T${dateMatch[2]}:00`) : null
      await supabase.from('calendar').insert({ title: s.calendar, datetime })
    }
    if (s.task) {
      const { data: existing } = await supabase.from('task').select('id').eq('content', s.task).single()
      if (!existing) await supabase.from('task').insert({ content: s.task, done: false })
    }
    if (s.people) {
      try {
        const p = typeof s.people === 'object' ? s.people : JSON.parse(s.people)
        if (p.name) {
          const { data: existing } = await supabase.from('people').select('id, note').ilike('name', `%${p.name}%`).single()
          if (existing) {
            const newNote = existing.note ? existing.note + '\n' + (p.note || '') : (p.note || '')
            await supabase.from('people').update({ company: p.company, position: p.position, note: newNote }).eq('id', existing.id)
          } else {
            await supabase.from('people').insert({ name: p.name, company: p.company, position: p.position, note: p.note, importance: 'B' })
          }
        }
      } catch {}
    }
    if (s.business) {
      const { data: existing } = await supabase.from('business_master').select('id, note').ilike('name', `%${s.business.substring(0, 10)}%`).single()
      if (existing) {
        await supabase.from('business_master').update({ note: (existing.note || '') + '\n' + s.business }).eq('id', existing.id)
      } else {
        await supabase.from('business_master').insert({ name: s.business.substring(0, 20), note: s.business })
      }
    }
    if (s.ideas) await supabase.from('ideas').insert({ content: s.ideas })
  }

  await supabase.from('talk_master').insert({ role: 'noida', content: parsed.reply || '', intent, importance: 'B' })

  return NextResponse.json({ content: [{ type: 'text', text }] })
}
