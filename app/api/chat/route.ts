import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// v1.5: カテゴリ別解析エンジン + 個人辞書 + 人物マッチング
import { analyzeQuery, type QueryAnalysis } from '@/lib/analyzer/analyzeQuery'
import { 
  matchPersonalEntities, 
  type PersonalDictionaryMatch 
} from '@/lib/analyzer/personalDictionary'
import { 
  matchPerson, 
  type PersonMatchResult 
} from '@/lib/analyzer/personMatcher'
import { correctInput } from '@/lib/analyzer/inputCorrector'

/**
 * NOIDA route.ts v1.6 (Phase 1 Day 6 - シリコンバレー3AI合意版)
 *
 * ============================================================
 * v1.6 新機能
 * ============================================================
 * 1. pending_confirmation テーブルに候補保存
 * 2. confirmation_id をフロントエンドに返す
 * 3. 閾値強化(0.3 → 0.5, isStrongMatch ロジック)
 * 4. 詳細ログで真相追跡可能に
 *
 * ============================================================
 * 変更履歴
 * ============================================================
 * v1.5: analyzeQuery + Personal Dictionary + Person Matcher 統合
 * v1.5.1: RLS修正 + 3層入力訂正 + 誤字学習システム
 * v1.6: pending_confirmation + ボタン契約 + 3AI閾値
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

function getSessionDate(): string {
  // JST(UTC+9)の日付を返す。Takumaにとっての「今日」が日本時間基準になる。
  const now = new Date()
  const jstOffsetMs = 9 * 60 * 60 * 1000
  const jstDate = new Date(now.getTime() + jstOffsetMs)
  return jstDate.toISOString().split('T')[0]
}

// ============================================================
// 型定義
// ============================================================

type Intent =
  | 'execute'
  | 'decide'
  | 'answer'
  | 'research'
  | 'explore'
  | 'empathy'
  | 'objection'
  | 'non_intervention'
  | 'modify'
  | 'generic'

type ModifyAction =
  | 'delete'
  | 'complete'
  | 'cancel'
  | 'update'
  | 'restore'
  | 'pause'

type TargetTable = 'memo' | 'task' | 'calendar' | 'ideas'

type MutationPlan = {
  action: ModifyAction
  target_table: TargetTable
  target_id: string | null
  target_title: string | null
  patch: Record<string, unknown>
  confidence: number
  resolver_strategy:
    | 'explicit_ref'
    | 'recency'
    | 'keyword'
    | 'semantic'
    | 'proper_noun'
    | 'user_confirmed'
    | 'ambiguous'
  candidate_rankings: Array<{
    id: string
    title: string
    score: number
    reason: string
  }>
  mutation_mode: 'proposed' | 'confirmed' | 'system_applied'
  requires_confirmation: boolean
  reason_text: string
  idempotency_key: string
}

type ExecutionResult =
  | {
      status: 'executed'
      target_id: string
      target_title: string
      action: ModifyAction
      before_state: string | null
      after_state: string | null
      undo_token: string | null
    }
  | {
      status: 'needs_confirmation'
      confirmation_id: string      // ★v1.6: pending_confirmation.id
      candidates: Array<{ id: string; title: string; score: number }>
      action: ModifyAction
      reason: string
    }
  | {
      status: 'no_target_found'
      action: ModifyAction
      search_text: string
    }
  | {
      status: 'error'
      error: string
      action?: ModifyAction
    }
  | {
      status: 'not_applicable'
    }

// ============================================================
// パターン定義
// ============================================================

const HIGH_RISK_KEYWORDS =
  /(法律|法的|訴訟|契約|税務|確定申告|医療|診断|病気|薬|症状|投資|株|為替|FX|仮想通貨)/

const EMPATHY_KEYWORDS =
  /(疲れた|しんどい|つらい|無理|だるい|眠い|やる気ない|面倒|詰んだ|ミスった|炎上|おはよう|おやすみ|ありがとう|嬉しい|うれしい|悲しい|やばい|最高|最悪)/

const TOPIC_SWITCH = /(話変わるけど|別件|別の話|ところで|そういえば|話変わる)/

const CRISIS_PATTERNS = {
  lethal: /(死にたい|消えたい|終わりにしたい|もう限界|全部捨てる|生きてる意味)/,
  destructive: /(全財産|全部売る|絶縁|廃業|離婚する|辞める|店じまい).*(今日|今すぐ|明日|これから)/,
  illegal: /(脱税|脅迫|暴力|報復|殴る|潰してやる)/,
}

const NON_INTERVENTION_PATTERNS = {
  life: /(結婚しようか|離婚しようか|出産|中絶|養子|別れるべき|復縁)/,
  health: /(手術|抗がん|精神科|薬の量|治療方針|どの病院)/,
  major_finance: /(投資.*\d{7,}|不動産購入|M&A|全資産|借金\d{7,})/,
  legal: /(訴訟|告訴|契約破棄|損害賠償)/,
}

const MODIFY_PATTERNS = {
  restore: /(戻して|復活|やっぱり必要|やり直し|元に戻)/,
  complete: /(終わった|完了|できた|やった|済んだ|終了|済み|終了した)/,
  cancel: /(中止|キャンセル|やめた|中止になった|とりやめ|取りやめ|なくなった)/,
  pause: /(一時停止|止めて|保留|ストップ|後回し)/,
  update: /(変更|修正|訂正|直して|書き換え)/,
  delete: /(消して|削除|消す|捨てて|要らない|いらない|消去)/,
}

const TARGET_TABLE_KEYWORDS = {
  memo: /(メモ|覚え書き|記録|ノート)/,
  task: /(タスク|仕事|作業|やること|TODO|todo)/,
  calendar: /(予定|会議|ミーティング|アポ|約束|スケジュール)/,
  ideas: /(アイデア|企画|構想)/,
}

// ============================================================
// ユーティリティ関数
// ============================================================

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

// ============================================================
// 検知関数
// ============================================================

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

function detectModifyAction(text: string): ModifyAction | null {
  if (MODIFY_PATTERNS.restore.test(text)) return 'restore'
  if (MODIFY_PATTERNS.complete.test(text)) return 'complete'
  if (MODIFY_PATTERNS.cancel.test(text)) return 'cancel'
  if (MODIFY_PATTERNS.pause.test(text)) return 'pause'
  if (MODIFY_PATTERNS.update.test(text)) return 'update'
  if (MODIFY_PATTERNS.delete.test(text)) return 'delete'
  return null
}

function detectTargetTable(
  text: string,
  action: ModifyAction | null
): TargetTable {
  if (TARGET_TABLE_KEYWORDS.calendar.test(text)) return 'calendar'
  if (TARGET_TABLE_KEYWORDS.task.test(text)) return 'task'
  if (TARGET_TABLE_KEYWORDS.memo.test(text)) return 'memo'
  if (TARGET_TABLE_KEYWORDS.ideas.test(text)) return 'ideas'

  if (action === 'complete' || action === 'cancel' || action === 'pause') {
    return 'task'
  }

  return 'task'
}

function classifyIntent(
  text: string,
  keywords: { people: string[]; businesses: string[] }
): Intent {
  if (detectCrisis(text)) return 'objection'
  if (detectNonIntervention(text)) return 'non_intervention'
  if (detectModifyAction(text)) return 'modify'
  if (/(情報|検索|一覧|調べて|探して)/.test(text)) return 'research'
  if (/(どうする|どっち|決めて|どれがいい|どれにする)/.test(text)) return 'decide'
  if (/(どう思う|考えて|アイデア|壁打ち|案|提案)/.test(text)) return 'explore'
  if (/(何|なに|なぜ|意味|とは|教えて|って何|どういう)/.test(text)) return 'answer'
  if (/(して|やって|送って|返して|作って|追加|作成|入れて|登録|保存|記録|メモして)/.test(text)) return 'execute'
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

// ============================================================
// メモリ取得
// ============================================================

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
      .is('deleted_at', null)
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
      .is('deleted_at', null)
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

// ============================================================
// ★ v1.5: Entity Resolution 層
// ============================================================

function scoreCandidate(
  candidate: any,
  text: string,
  table: TargetTable,
  analysis: QueryAnalysis,
  personalMatches: PersonalDictionaryMatch[],
  personMatch: PersonMatchResult
): { score: number; reason: string } {
  let score = 0
  const reasons: string[] = []
  
  const contentField =
    table === 'task' || table === 'memo' || table === 'ideas' ? 'content' : 'title'
  const targetText = String(candidate[contentField] || '').toLowerCase()
  
  if (candidate.created_at) {
    const ageDays =
      (Date.now() - new Date(candidate.created_at).getTime()) / (1000 * 60 * 60 * 24)
    if (ageDays < 1) {
      score += 0.25
      reasons.push('直近')
    } else if (ageDays < 3) {
      score += 0.15
      reasons.push('3日以内')
    } else if (ageDays < 7) {
      score += 0.10
      reasons.push('1週間以内')
    } else if (ageDays < 30) {
      score += 0.05
    }
  }
  
  for (const match of personalMatches) {
    const entityText = match.entity.text.toLowerCase()
    if (targetText.includes(entityText)) {
      score += 0.60
      reasons.push(`個人辞書一致:${match.entity.text}(${match.entity.entity_type})`)
    }
    for (const alias of match.entity.aliases) {
      if (alias.length >= 2 && targetText.includes(alias)) {
        score += 0.45
        reasons.push(`個人辞書エイリアス一致:${alias}`)
        break
      }
    }
  }
  
  if (personMatch.type === 'confident' || personMatch.type === 'likely') {
    const person = personMatch.person
    if (targetText.includes(person.name.toLowerCase())) {
      const weight = personMatch.type === 'confident' ? 0.55 : 0.40
      score += weight
      reasons.push(`人物マッチ:${person.name}(${personMatch.type})`)
    } else {
      const surnameCandidates = [
        person.name.substring(0, 3),
        person.name.substring(0, 2),
        person.name.substring(0, 1),
      ]
      for (const sc of surnameCandidates) {
        if (sc.length >= 2 && targetText.includes(sc.toLowerCase())) {
          const weight = personMatch.type === 'confident' ? 0.45 : 0.30
          score += weight
          reasons.push(`人物姓マッチ:${sc}`)
          break
        }
      }
    }
  }
  
  for (const org of analysis.organizations) {
    if (targetText.includes(org.toLowerCase())) {
      score += 0.40
      reasons.push(`組織一致:${org}`)
    }
  }
  
  const personalEntityTexts = new Set(
    personalMatches.map(m => m.entity.text.toLowerCase())
  )
  for (const pn of analysis.proper_nouns) {
    if (personalEntityTexts.has(pn.toLowerCase())) continue
    if (targetText.includes(pn.toLowerCase())) {
      score += 0.35
      reasons.push(`固有名詞一致:${pn}`)
    }
  }
  
  let keywordMatchCount = 0
  const matchedKeywords: string[] = []
  for (const kw of analysis.keywords) {
    if (kw.length >= 2 && targetText.includes(kw.toLowerCase())) {
      keywordMatchCount++
      matchedKeywords.push(kw)
    }
  }
  if (keywordMatchCount > 0) {
    const kwScore = Math.min(0.50, keywordMatchCount * 0.25)
    score += kwScore
    reasons.push(`キーワード一致:${matchedKeywords.join(',')}`)
  }
  
  if (table === 'calendar' && candidate.datetime) {
    const datetimeStr = String(candidate.datetime)
    for (const dt of analysis.datetime_absolute) {
      if (dt.month !== undefined && dt.day !== undefined) {
        const monthStr = String(dt.month).padStart(2, '0')
        const dayStr = String(dt.day).padStart(2, '0')
        if (datetimeStr.includes(`-${monthStr}-${dayStr}`)) {
          score += 0.50
          reasons.push(`日付一致:${dt.raw}`)
          break
        }
      }
    }
    for (const dt of analysis.datetime_relative) {
      const target = new Date()
      target.setDate(target.getDate() + dt.offset_days)
      const targetIso = target.toISOString().split('T')[0]
      if (datetimeStr.includes(targetIso)) {
        score += 0.50
        reasons.push(`相対日時一致:${dt.raw}`)
        break
      }
    }
  }
  
  if (table === 'task' || table === 'calendar') {
    if (candidate.state === 'completed' || candidate.state === 'cancelled') {
      score *= 0.3
      reasons.push(`状態:${candidate.state}(減点)`)
    }
    if (candidate.deleted_at || candidate.archived_at) {
      score *= 0.1
      reasons.push('削除済み(減点)')
    }
  }
  
  return {
    score: Math.min(1.0, score),
    reason: reasons.join(' / ') || '低スコア',
  }
}

async function resolveReference(
  text: string,
  targetTable: TargetTable,
  includeDeletedAndDone: boolean = false
): Promise<{
  target_id: string | null
  target_title: string | null
  confidence: number
  strategy: MutationPlan['resolver_strategy']
  candidates: Array<{ id: string; title: string; score: number; reason: string }>
  needs_user_confirmation: boolean
}> {
  let candidates: any[] = []

  try {
    if (targetTable === 'task') {
      let query = supabase
        .from('task')
        .select('*')
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(30)
      if (!includeDeletedAndDone) {
        query = query
          .is('deleted_at', null)
          .neq('state', 'completed')
          .neq('state', 'cancelled')
      }
      const { data } = await query
      candidates = data || []
    } else if (targetTable === 'calendar') {
      let query = supabase
        .from('calendar')
        .select('*')
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(30)
      if (!includeDeletedAndDone) {
        query = query.is('deleted_at', null)
      }
      const { data } = await query
      candidates = data || []
    } else if (targetTable === 'memo') {
      const { data } = await supabase
        .from('memo')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30)
      candidates = data || []
    } else if (targetTable === 'ideas') {
      const { data } = await supabase
        .from('ideas')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30)
      candidates = data || []
    }
  } catch (e) {
    console.log('❌ resolveReference エラー:', e)
  }

  if (candidates.length === 0) {
    return {
      target_id: null,
      target_title: null,
      confidence: 0,
      strategy: 'ambiguous',
      candidates: [],
      needs_user_confirmation: true,
    }
  }

  const analysis = analyzeQuery(text)
  const personalMatches = await matchPersonalEntities(text)
  const personMatch = await matchPerson(text)
  
  const scored = candidates.map((c) => {
    const { score, reason } = scoreCandidate(
      c, 
      text, 
      targetTable,
      analysis,
      personalMatches,
      personMatch
    )
    const contentField =
      targetTable === 'task' || targetTable === 'memo' || targetTable === 'ideas'
        ? 'content'
        : 'title'
    return {
      id: c.id,
      title: String(c[contentField] || '').substring(0, 50),
      score,
      reason,
    }
  })

  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]

  let strategy: MutationPlan['resolver_strategy'] = 'recency'
  const hasDate = /(\d{1,2})[月\/](\d{1,2})/.test(text)
  const hasProperNoun = /([一-龯ぁ-んァ-ンA-Za-z]{2,})(さん|会長|社長|庁|省|部|課|店|所|会社)/.test(text)

  if (hasDate) strategy = 'explicit_ref'
  else if (hasProperNoun && top.reason.includes('人物マッチ')) strategy = 'proper_noun'
  else if (/(さっき|今の|直前|ついさっき)/.test(text)) strategy = 'recency'
  else if (top.reason.includes('個人辞書一致')) strategy = 'proper_noun'
  else if (top.score >= 0.5) strategy = 'keyword'
  else if (top.score < 0.3) strategy = 'ambiguous'

  const confidence = top.score
  const scoreGap = scored.length > 1 ? top.score - scored[1].score : 1.0

  // v1.5.2: 閾値強化(シリコンバレー3AI合意)
  const significantCandidates = scored.filter(s => s.score >= 0.5)
  const isOnlyCandidate = significantCandidates.length === 1 && top.score >= 0.5
  const isStrongMatch = top.score >= 0.70 && 
                       (scored.length < 2 || scored[1].score <= 0.35) &&
                       scoreGap >= 0.20
  const canAutoExecute = isOnlyCandidate || isStrongMatch

  const isAmbiguousReference = /(あの|その|この)(メモ|タスク|予定|会議|ミーティング)/.test(text)
  const needsConfirmation =
    !canAutoExecute && (
      confidence < 0.5 ||
      (scored.length > 1 && scored[1].score >= 0.45 && scoreGap < 0.15) ||
      (isAmbiguousReference && scored.length > 1 && scored[1].score > 0.3 && !hasProperNoun)
    )

  console.log('[resolveReference]', {
    text: text.substring(0, 50),
    targetTable,
    top3: scored.slice(0, 3).map(s => ({
      title: s.title?.substring(0, 30),
      score: parseFloat(s.score.toFixed(3)),
      reason: s.reason?.substring(0, 80),
    })),
    confidence: parseFloat(confidence.toFixed(3)),
    scoreGap: parseFloat(scoreGap.toFixed(3)),
    significantCount: significantCandidates.length,
    isOnlyCandidate,
    isStrongMatch,
    canAutoExecute,
    isAmbiguousReference,
    hasProperNoun,
    hasDate,
    needsConfirmation,
    strategy,
  })
  
  return {
    target_id: top.score >= 0.3 ? top.id : null,
    target_title: top.score >= 0.3 ? top.title : null,
    confidence,
    strategy: needsConfirmation && confidence < 0.5 ? 'ambiguous' : strategy,
    candidates: scored.slice(0, 5),
    needs_user_confirmation: needsConfirmation,
  }
}

async function generateMutationPlan(
  text: string,
  action: ModifyAction,
  userMessageId: string
): Promise<MutationPlan | null> {
  const targetTable = detectTargetTable(text, action)
  const includeDeletedAndDone = action === 'restore'
  const resolved = await resolveReference(text, targetTable, includeDeletedAndDone)

  let patch: Record<string, unknown> = {}
  const nowISO = new Date().toISOString()

  if (targetTable === 'task') {
    if (action === 'complete') {
      patch = { state: 'completed', done: true, completed_at: nowISO, updated_at: nowISO }
    } else if (action === 'cancel') {
      patch = { state: 'cancelled', cancelled_at: nowISO, updated_at: nowISO }
    } else if (action === 'pause') {
      patch = { state: 'paused', updated_at: nowISO }
    } else if (action === 'restore') {
      patch = {
        state: 'active',
        done: false,
        completed_at: null,
        cancelled_at: null,
        deleted_at: null,
        updated_at: nowISO,
      }
    } else if (action === 'delete') {
      patch = { deleted_at: nowISO, updated_at: nowISO }
    }
  } else if (targetTable === 'calendar') {
    if (action === 'complete') {
      patch = { state: 'completed', completed_at: nowISO, updated_at: nowISO }
    } else if (action === 'cancel') {
      patch = { state: 'cancelled', cancelled_at: nowISO, updated_at: nowISO }
    } else if (action === 'restore') {
      patch = { state: 'scheduled', cancelled_at: null, deleted_at: null, updated_at: nowISO }
    } else if (action === 'delete') {
      patch = { deleted_at: nowISO, updated_at: nowISO }
    }
  } else if (targetTable === 'memo' || targetTable === 'ideas') {
    if (action === 'delete') {
      patch = { _action: 'delete' }
    }
  }

  const idempotencyKey = `${action}_${targetTable}_${resolved.target_id || 'null'}_${userMessageId}`

  const requiresConfirmation = resolved.needs_user_confirmation || !resolved.target_id
  const mutationMode: MutationPlan['mutation_mode'] = requiresConfirmation
    ? 'proposed'
    : 'confirmed'

  let reasonText = `${action}を実行`
  if (resolved.target_title) reasonText += ` (対象: ${resolved.target_title})`
  reasonText += ` (信頼度: ${(resolved.confidence * 100).toFixed(0)}%)`

  return {
    action,
    target_table: targetTable,
    target_id: resolved.target_id,
    target_title: resolved.target_title,
    patch,
    confidence: resolved.confidence,
    resolver_strategy: resolved.strategy,
    candidate_rankings: resolved.candidates,
    mutation_mode: mutationMode,
    requires_confirmation: requiresConfirmation,
    reason_text: reasonText,
    idempotency_key: idempotencyKey,
  }
}

/**
 * v1.6: MutationPlan を実行(pending_confirmation統合版)
 */
async function executeMutationPlan(
  plan: MutationPlan,
  userMessageId: string
): Promise<ExecutionResult> {
  // ★v1.6: 確認要求の場合、pending_confirmation を作成
  if (plan.mutation_mode !== 'confirmed') {
    const sessionDate = getSessionDate()
    const topCandidates = plan.candidate_rankings
      .slice(0, 3)
      .map(c => ({ id: c.id, title: c.title, score: c.score }))
    
    const { data: pending, error: pendingError } = await supabase
      .from('pending_confirmation')
      .insert({
        user_message_id: userMessageId,
        session_date: sessionDate,
        action: plan.action,
        target_table: plan.target_table,
        candidates: topCandidates,
        mutation_plan: plan,
        reason_text: plan.reason_text,
        status: 'pending',
      })
      .select('id')
      .single()
    
    if (pendingError) {
      console.log('❌ pending_confirmation INSERTエラー:', pendingError)
      return {
        status: 'error',
        error: pendingError.message,
        action: plan.action,
      }
    }
    
    const confirmationId = (pending as any)?.id
    console.log('[pending_confirmation 作成]', { confirmationId, candidates: topCandidates.length })
    
    return {
      status: 'needs_confirmation',
      confirmation_id: confirmationId,
      candidates: topCandidates,
      action: plan.action,
      reason: plan.reason_text,
    }
  }

  if (!plan.target_id) {
    return {
      status: 'no_target_found',
      action: plan.action,
      search_text: plan.target_title || '',
    }
  }

  try {
    const { data: before, error: beforeError } = await supabase
      .from(plan.target_table)
      .select('*')
      .eq('id', plan.target_id)
      .single()

    if (beforeError || !before) {
      return {
        status: 'error',
        error: 'target_not_found_at_execution',
        action: plan.action,
      }
    }

    if (plan.action === 'delete') {
      const autoPurgeAt = new Date()
      autoPurgeAt.setDate(autoPurgeAt.getDate() + 30)

      const { error: trashError } = await supabase.from('trash_queue').insert({
        source_table: plan.target_table,
        source_id: plan.target_id,
        original_data: before,
        delete_reason: plan.reason_text,
        delete_trigger: 'user_request',
        deleted_by: 'user',
        auto_purge_at: autoPurgeAt.toISOString(),
      })

      if (trashError) {
        console.log('⚠️ trash_queue INSERTエラー:', trashError)
      }

      if (plan.target_table === 'memo' || plan.target_table === 'ideas') {
        const { error } = await supabase
          .from(plan.target_table)
          .delete()
          .eq('id', plan.target_id)
        if (error) {
          return { status: 'error', error: error.message, action: plan.action }
        }
      } else {
        const { error } = await supabase
          .from(plan.target_table)
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', plan.target_id)
        if (error) {
          return { status: 'error', error: error.message, action: plan.action }
        }
      }
    } else {
      const { error } = await supabase
        .from(plan.target_table)
        .update(plan.patch)
        .eq('id', plan.target_id)
      if (error) {
        return { status: 'error', error: error.message, action: plan.action }
      }
    }

    if (
      (plan.target_table === 'task' || plan.target_table === 'calendar') &&
      plan.patch.state
    ) {
      await supabase.from('living_record_state_transition').insert({
        source_table: plan.target_table,
        source_id: plan.target_id,
        from_state: before.state || 'active',
        to_state: plan.patch.state,
        reason: plan.reason_text,
        source_type: 'user_message',
        source_ref_id: userMessageId,
        actor_type: 'user',
        version: (before.version || 1) + 1,
        effective_from: new Date().toISOString(),
      })
    }

    let after: any = null
    if (plan.action !== 'delete' || (plan.target_table !== 'memo' && plan.target_table !== 'ideas')) {
      const { data } = await supabase
        .from(plan.target_table)
        .select('*')
        .eq('id', plan.target_id)
        .maybeSingle()
      after = data
    }

    const { data: mutationLog } = await supabase
      .from('mutation_event_log')
      .insert({
        user_message_id: userMessageId,
        event_type: plan.action,
        source_table: plan.target_table,
        source_id: plan.target_id,
        before_data: before,
        after_data: after,
        mutation_plan: plan,
        resolver_strategy: plan.resolver_strategy,
        confidence: plan.confidence,
        executed_by: 'noida',
        mutation_mode: plan.mutation_mode,
        idempotency_key: plan.idempotency_key,
      })
      .select('id')
      .single()

    await supabase.from('entity_reference_resolution_log').insert({
      user_message_id: userMessageId,
      reference_text: plan.target_title || '(unknown)',
      target_table: plan.target_table,
      chosen_target_id: plan.target_id,
      candidate_rankings: plan.candidate_rankings,
      resolver_strategy: plan.resolver_strategy,
      confidence: plan.confidence,
      user_confirmed: !plan.requires_confirmation,
    })

    return {
      status: 'executed',
      target_id: plan.target_id,
      target_title: plan.target_title || '(対象)',
      action: plan.action,
      before_state: before.state || null,
      after_state: (plan.patch.state as string) || (plan.action === 'delete' ? 'deleted' : null),
      undo_token: (mutationLog as any)?.id || null,
    }
  } catch (e: any) {
    console.log('❌ executeMutationPlan 例外:', e)
    return {
      status: 'error',
      error: e.message || 'unknown',
      action: plan.action,
    }
  }
}

// ============================================================
// ここまで v1.6 核心部分
// ============================================================

async function saveDecision(sourceMessage: string, intent: Intent, parsed: any, owner: any) {
  const LOGGABLE_INTENTS = ['execute', 'decide', 'objection', 'non_intervention', 'modify']
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

async function saveStructuredMemory(save: any, rawText: string, userMessageId: string) {
  if (!save) return

  const extractedEntities: Array<{ table: string; id: string; role: string }> = []

  if (save.task) {
    const { data: existing } = await supabase
      .from('task')
      .select('id')
      .eq('content', save.task)
      .is('deleted_at', null)
      .limit(1)
    if (!existing?.length) {
      const { data: inserted } = await supabase
        .from('task')
        .insert({
          content: save.task,
          done: false,
          state: 'active',
          is_user_confirmed: true,
          confidence: 0.9,
        })
        .select('id')
        .single()
      if (inserted) {
        extractedEntities.push({ table: 'task', id: inserted.id, role: 'created' })
      }
    }
  }

  if (save.memo) {
    const { data: inserted } = await supabase
      .from('memo')
      .insert({ content: save.memo })
      .select('id')
      .single()
    if (inserted) {
      extractedEntities.push({ table: 'memo', id: inserted.id, role: 'created' })
    }
  }

  if (save.calendar) {
    const extracted = extractDatetime(rawText)
    const { data: inserted } = await supabase
      .from('calendar')
      .insert({
        title: save.calendar,
        datetime: extracted?.datetime || null,
        state: 'scheduled',
        is_user_confirmed: true,
        confidence: 0.9,
      })
      .select('id')
      .single()
    if (inserted) {
      extractedEntities.push({ table: 'calendar', id: inserted.id, role: 'event' })
    }
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
        (c: any) =>
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
      extractedEntities.push({ table: 'people', id: existing.id, role: 'referenced' })
    } else {
      const { data: inserted } = await supabase
        .from('people')
        .insert({
          name: normalizedName,
          company: p.company || null,
          position: p.position || null,
          note: p.note || null,
          importance: 'B',
        })
        .select('id')
        .single()
      if (inserted) {
        extractedEntities.push({ table: 'people', id: inserted.id, role: 'created' })
      }
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
      extractedEntities.push({ table: 'business_master', id: existing[0].id, role: 'referenced' })
    } else {
      const { data: inserted } = await supabase
        .from('business_master')
        .insert({ name: b.name, note: b.note || null })
        .select('id')
        .single()
      if (inserted) {
        extractedEntities.push({
          table: 'business_master',
          id: inserted.id,
          role: 'created',
        })
      }
    }
  }

  if (save.ideas) {
    const { data: inserted } = await supabase
      .from('ideas')
      .insert({ content: save.ideas })
      .select('id')
      .single()
    if (inserted) {
      extractedEntities.push({ table: 'ideas', id: inserted.id, role: 'created' })
    }
  }

  if (extractedEntities.length > 0) {
    await supabase.from('entity_extraction_log').insert({
      source_message_id: userMessageId,
      source_text: rawText,
      extracted_entities: extractedEntities,
      extraction_method: 'llm',
      confidence: 0.85,
      is_user_reviewed: false,
    })
  }
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

// ============================================================
// システムプロンプト
// ============================================================

function buildSystemPrompt(
  owner: any,
  memory: string[],
  isHighRisk: boolean,
  afterEmpathy: boolean,
  crisisType: string | null,
  nonInterventionType: string | null,
  topicSwitched: boolean,
  executionResult: ExecutionResult | null
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

  let executionNote = ''
  if (executionResult) {
    if (executionResult.status === 'executed') {
      const actionJpMap: Record<string, string> = {
        delete: '削除',
        complete: '完了',
        cancel: 'キャンセル',
        pause: '一時停止',
        update: '更新',
        restore: '復元',
      }
      const actionJp = actionJpMap[executionResult.action] || executionResult.action
      executionNote = `
■★Modifyモード(DB更新完了)★
実行結果: ✅ 成功
- アクション: ${executionResult.action} (${actionJp})
- 対象: "${executionResult.target_title}"
- 状態変化: ${executionResult.before_state || '(初期)'} → ${executionResult.after_state || '(完了)'}

出力方針(厳守):
- 「${executionResult.target_title}を${actionJp}した」と短く過去形で報告
${executionResult.action === 'delete' ? '- 削除なので「30日以内なら戻せる」と一言添える' : ''}
- mode は "modify" で返す
- ★saveフィールドは全てnullにする(新規保存しない)
- ★絶対に再度タスクを作ろうとしない
`
    } else if (executionResult.status === 'needs_confirmation') {
      const actionJpMap: Record<string, string> = {
        delete: '削除',
        complete: '完了',
        cancel: 'キャンセル',
        pause: '一時停止',
        update: '更新',
        restore: '復元',
      }
      const actionJp = actionJpMap[executionResult.action] || executionResult.action
      const candidateList = executionResult.candidates
        .map((c, i) => `${i + 1}. ${c.title}`)
        .join(' / ')
      executionNote = `
■★Modifyモード(確認要請)★
実行結果: ⚠️ 未実行(対象が曖昧)
- アクション希望: ${actionJp}
- 候補: ${candidateList}
- 理由: ${executionResult.reason}

出力方針(厳守):
- ★絶対に「しました」「完了」と過去形で言わない(まだ実行してない)
- 候補を提示して「どれを${actionJp}する?」と聞く
- options には候補のタイトルをそのまま入れる
- mode は "modify" で返す
- ★saveフィールドは全てnullにする
`
    } else if (executionResult.status === 'no_target_found') {
      const actionJpMap: Record<string, string> = {
        delete: '削除',
        complete: '完了',
        cancel: 'キャンセル',
        pause: '一時停止',
        update: '更新',
        restore: '復元',
      }
      const actionJp = actionJpMap[executionResult.action] || executionResult.action
      executionNote = `
■★Modifyモード(対象見つからず)★
実行結果: ❌ 該当するレコードが見つかりませんでした
- アクション希望: ${actionJp}
- 検索対象: ${executionResult.search_text || '(不明)'}

出力方針(厳守):
- ★絶対に「しました」と言わない
- 「該当するタスク/メモ/予定が見つからなかった」と正直に報告
- 「もう少し詳しく教えて」と聞く
- mode は "modify" で返す
- ★saveフィールドは全てnullにする
`
    } else if (executionResult.status === 'error') {
      executionNote = `
■★Modifyモード(エラー発生)★
実行結果: ❌ エラー
- エラー内容: ${executionResult.error}

出力方針(厳守):
- ★絶対に「しました」と言わない
- 「うまくいかなかった、もう一度試してみて」と正直に報告
- mode は "modify" で返す
`
    }
  }

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
${executionNote}

■★v1.5.1 誤字・タイプミス許容原則★
・ユーザーの入力は既に辞書と個人辞書で訂正済みの場合がある
・それでも文章が不自然なら、以下を推論:
  - 「やっぱり」が含まれ動詞が不明瞭 → 直前操作の取り消し
  - 語順が変な場合 → 本来の語順を推測
  - 同音異義語の可能性(音声認識エラー)を考慮
・確信が低い時は優しく確認: 「"○○" のことですか?」

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

■★v1.4 新ルール: DB真実原則★
・Modify系の報告は、必ずDB更新結果に基づくこと
・executionNote に「executed」と書かれていれば「しました」と言ってよい
・「needs_confirmation」「no_target_found」「error」の場合は絶対に「しました」と言わない
・嘘の成功報告は絶対禁止

■モード判定(内部)

【Objection】★安全弁★(最優先)
破滅的・危険な判断を検出した時のみ発動。
共感禁止、肯定禁止、短く止める。

【Non-Intervention】★権限境界★
結婚・離婚・手術・重要投資など、NOIDAが決めるべきでない領域。
1つに決めず、判断材料を3つ出して退く。

【Modify】★データ変更★
削除/完了/キャンセル/復元/更新のリクエスト。
executionNoteの結果に従って正確に報告する。

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

■保存ルール(Modifyモードでは適用されない)
・calendar: ユーザーが日時・予定を言った時のみ
・task: ユーザーが「タスク追加」「タスクに入れて」「やること」等と言った時
  → save.task には【タスクの内容】だけを入れる
  → 例: 「パンを買うタスク追加」 → save.task: "パンを買う"
  → 悪い例: save.task に「パンを買うタスク追加」や「消して」を入れない
・memo: 「覚えて」「メモして」と言った時のみ
・people: 人物について言及した時
・business: 明確なビジネス案がある時のみ
・ideas: 明確なアイデアがある時のみ

■優先順位
売上 > 時間 > 人間関係

■★decision_log の should_log 判定ルール★
modeが "execute" "decide" "objection" "non_intervention" "modify" のいずれかなら
decision_log.should_log は必ず true。
その他のmodeでは false。
decision_text には「何をすべきか」を動詞で終わる1文で。

■必ずJSON形式のみで返答
{
  "reply": "応答テキスト",
  "reason": "1行理由(省略可)",
  "hint": "一言進言(省略可)",
  "options": ["行動に直結する選択肢1〜2個"],
  "mode": "execute|decide|answer|research|explore|empathy|objection|non_intervention|modify",
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

// ============================================================
// ★ v1.6 POST関数
// ============================================================

export async function POST(req: NextRequest) {
  const { messages } = await req.json()
  const rawUserMessage = messages[messages.length - 1]?.content || ''
  const sessionDate = getSessionDate()
  
  // v1.5.1: 入力訂正(3層:辞書→個人辞書→LLM)
  let lastUserMessage = rawUserMessage
  try {
    const lastNoidaMessage = [...messages]
      .reverse()
      .find((m: any) => m.role === 'noida' || m.role === 'assistant')
    const precedingContext = typeof lastNoidaMessage?.content === 'string'
      ? lastNoidaMessage.content
      : null
    
    const correctionResult = await correctInput(rawUserMessage, precedingContext)
    if (correctionResult.was_corrected) {
      console.log(`[Input訂正] "${correctionResult.original}" → "${correctionResult.corrected}"`)
      for (const c of correctionResult.corrections) {
        console.log(`  - [${c.source}] "${c.from}" → "${c.to}" (${c.pattern_type}, conf=${c.confidence.toFixed(2)})`)
      }
      lastUserMessage = correctionResult.corrected
    }
  } catch (e) {
    console.warn('[Input訂正] エラー、訂正せずに処理続行:', e)
  }

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

  // v1.6.1: 明確な意図がある時は、昨日のフィードバック質問を横取りしない
  const hasExplicitIntent = 
    detectModifyAction(lastUserMessage) !== null ||
    /追加|作成|新規|保存|メモして|覚えて/.test(lastUserMessage) ||
    /タスク|予定|会議|メモ|アイデア|ミーティング|アポ/.test(lastUserMessage)

  if (
    pendingFeedback &&
    lastUserMessage.length < 15 &&
    !HIGH_RISK_KEYWORDS.test(lastUserMessage) &&
    !hasExplicitIntent
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

  const { data: userTalkRecord } = await supabase
    .from('talk_master')
    .insert({
      role: 'user',
      content: lastUserMessage,
      intent: intent,
      importance: intent === 'objection' ? 'A' : 'B',
      session_date: sessionDate,
    })
    .select('id')
    .single()

  const userMessageId = userTalkRecord?.id || `msg_${Date.now()}`

  let executionResult: ExecutionResult = { status: 'not_applicable' }
  const modifyAction = detectModifyAction(lastUserMessage)

  if (intent === 'modify' && modifyAction && !crisisType && !nonInterventionType) {
    const plan = await generateMutationPlan(lastUserMessage, modifyAction, userMessageId)
    if (plan) {
      executionResult = await executeMutationPlan(plan, userMessageId)
    }
  }

  const systemPrompt = buildSystemPrompt(
    owner,
    memory,
    isHighRisk,
    afterEmpathy,
    crisisType,
    nonInterventionType,
    topicSwitched,
    executionResult.status === 'not_applicable' ? null : executionResult
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
  if (modifyAction && !crisisType && !nonInterventionType) finalIntent = 'modify'

  if (finalIntent !== 'modify') {
    await saveStructuredMemory(parsed.save, lastUserMessage, userMessageId)
  }
  await saveDecision(lastUserMessage, finalIntent, parsed, owner)

  await supabase.from('talk_master').insert({
    role: 'noida',
    content: parsed.reply || '',
    intent: finalIntent,
    importance:
      finalIntent === 'empathy' || finalIntent === 'objection' ? 'A' : 'B',
    session_date: sessionDate,
  })

  // ★v1.6: mutation レスポンスに confirmation_id と undo_token を含める
  const mutationResponse: any = 
    executionResult.status === 'not_applicable'
      ? null
      : {
          status: executionResult.status,
          action: 'action' in executionResult ? executionResult.action : null,
          target_title:
            executionResult.status === 'executed'
              ? executionResult.target_title
              : null,
          executed: executionResult.status === 'executed',
          // v1.6: ボタン契約用
          confirmation_id: executionResult.status === 'needs_confirmation'
            ? executionResult.confirmation_id
            : null,
          candidates: executionResult.status === 'needs_confirmation'
            ? executionResult.candidates
            : null,
          // v1.6: Undo用
          undo_token: executionResult.status === 'executed'
            ? executionResult.undo_token
            : null,
        }

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
        mutation: mutationResponse,
      }),
    }],
  })
}