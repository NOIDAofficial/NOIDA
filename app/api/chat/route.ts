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
  recordReferringExpression,
  type PersonMatchResult 
} from '@/lib/analyzer/personMatcher'
import { correctInput } from '@/lib/analyzer/inputCorrector'

/**
 * NOIDA route.ts v2.0.0 (Phase 1 Day 7 - Conversation FSM)
 *
 * ============================================================
 * v2.0.0 の核心変更
 * ============================================================
 *
 * Bug H 根治:曖昧題目 clarification の文脈継承
 *   v1.9.1 までは clarification 後の短い回答(例:「会議」)で
 *   datetime NULL の calendar INSERT が発生する不具合があった。
 *
 *   → conversation_state テーブルで FSM 化
 *   → 短い回答を前ターンの文脈に merge して再処理
 *   → 曖昧語連鎖(会議→会議)を検出して再 clarification
 *
 * 継承:v1.9.0 Synchronous Truth / v1.9.1 Bug G 根治
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
  return new Date().toISOString().split('T')[0]
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
    | 'aliases_match'
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
      matched_alias?: string
    }
  | {
      status: 'needs_confirmation'
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

type SaveEntityResult = {
  table: string
  attempted: boolean
  success: boolean
  id?: string
  role?: string
  error_code?: string
  error_message?: string
  skipped_reason?: string
}

type EventSignals = {
  has_explicit_person: boolean
  has_explicit_location: boolean
  has_explicit_time: boolean
  has_business_context: boolean
  has_solo_context: boolean
  has_family_context: boolean
  has_appointment_context: boolean
  is_sensitive: boolean
  has_explicit_tentative: boolean
}

type EventCategory = 
  | 'meeting' 
  | 'solo_activity' 
  | 'appointment' 
  | 'deadline' 
  | 'family' 
  | 'sensitive'
  | 'unknown'

type AskingStrategy =
  | 'silent'
  | 'optional_hint'
  | 'clarification'
  | 'disambiguation'

type PreLLMAnalysis = {
  intent_hint: Intent | null
  is_calendar_add: boolean
  extracted_title: string | null
  extracted_datetime: string | null
  conflict_detection: {
    has_conflict: boolean
    existing_events: any[]
    window_description: string
  }
  modify_action: ModifyAction | null
  has_explicit_title: boolean
  has_vague_topic: boolean
  signals: EventSignals
  inferred_category: EventCategory
}

type ReplyType =
  | 'conflict_same'
  | 'conflict_different'
  | 'modify_approve'
  | 'modify_reject'
  | 'candidate_select'
  | 'unrelated'

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
  cancel: /(中止|キャンセル|やめた|中止になった|とりやめ|取りやめ|なくなった|無くなった)/,
  pause: /(一時停止|止めて|保留|ストップ|後回し)/,
  update: /(変更|修正|訂正|直して|書き換え)/,
  delete: /(消して|削除|消す|捨てて|要らない|いらない|消去)/,
}

const ACKNOWLEDGMENT_PATTERNS = {
  gratitude: /^(ありがと(う)?|あざす|サンキュー|thx|thanks)[!!。\.]*$/,
  acknowledgment: /^(了解|おけ|OK|ok|okay|オッケー|おっけー)[!!。\.]*$/,
  nod: /^(うん|はい|yes|ええ)[!!。\.]*$/,
}

function detectAcknowledgment(text: string): 'gratitude' | 'acknowledgment' | 'nod' | null {
  const trimmed = text.trim()
  if (ACKNOWLEDGMENT_PATTERNS.gratitude.test(trimmed)) return 'gratitude'
  if (ACKNOWLEDGMENT_PATTERNS.acknowledgment.test(trimmed)) return 'acknowledgment'
  if (ACKNOWLEDGMENT_PATTERNS.nod.test(trimmed)) return 'nod'
  return null
}

const VAGUE_TOPICS = /^(会議|ミーティング|打ち合わせ|MTG|mtg|アポ|予定|meeting|Meeting|用事|タスク|やること)$/
const VAGUE_TOPICS_CONTAINS = /(会議|ミーティング|打ち合わせ|MTG|mtg|アポ|予定|用事)/

// ============================================================
// ★v2.0.0 NEW: Conversation FSM
// ============================================================

async function fetchActiveConversationState(sessionDate: string): Promise<any | null> {
  try {
    const { data, error } = await supabase
      .from('conversation_state')
      .select('*')
      .eq('status', 'active')
      .eq('session_date', sessionDate)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) console.error('❌ [v2.0] conversation_state 取得エラー:', error)
    return data ?? null
  } catch (e) {
    console.error('❌ [v2.0] fetchActiveConversationState 例外:', e)
    return null
  }
}

async function createClarificationState(
  partialData: any,
  target: 'title' | 'datetime' | 'both' | 'vague_answer_retry',
  userMessageId: string,
  noidaMessageId: string | null = null
): Promise<string | null> {
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('conversation_state')
    .insert({
      session_date: getSessionDate(),
      state: 'awaiting_clarification',
      partial_data: partialData,
      clarification_target: target,
      source_user_message_id: userMessageId,
      source_noida_message_id: noidaMessageId,
      expires_at: expiresAt,
      status: 'active',
    })
    .select('id')
    .single()
  if (error) {
    console.error('❌ [v2.0] conversation_state INSERT エラー:', error)
    return null
  }
  console.log('🆕 [v2.0 FSM] clarification state 作成:', data?.id, 'target:', target)
  return data?.id ?? null
}

async function resolveConversationState(
  id: string,
  newStatus: 'resolved' | 'expired'
): Promise<void> {
  const { error } = await supabase
    .from('conversation_state')
    .update({ status: newStatus })
    .eq('id', id)
  if (error) {
    console.error(`❌ [v2.0] conversation_state UPDATE(${newStatus}) エラー:`, error)
  } else {
    console.log(`✅ [v2.0 FSM] state ${id} → ${newStatus}`)
  }
}

function userTalkIdOrFallback(id: string | null | undefined): string {
  return id || `msg_${Date.now()}`
}

function mergeClarificationContext(
  original: string,
  answer: string,
  target: 'title' | 'datetime' | 'both' | 'vague_answer_retry' | null
): { merged: string; is_vague_answer: boolean } {
  const answerTrimmed = answer.trim()
  const isVagueAnswer = VAGUE_TOPICS.test(answerTrimmed)

  if (target === 'title' || target === 'vague_answer_retry') {
    const replaced = original.replace(VAGUE_TOPICS_CONTAINS, answerTrimmed).trim()
    const merged = replaced !== original ? replaced : `${original} ${answerTrimmed}`.trim()
    return { merged, is_vague_answer: isVagueAnswer }
  }

  if (target === 'datetime') {
    return { 
      merged: `${answerTrimmed} ${original}`.trim(),
      is_vague_answer: isVagueAnswer,
    }
  }

  if (target === 'both') {
    return {
      merged: `${original} ${answerTrimmed}`.trim(),
      is_vague_answer: isVagueAnswer,
    }
  }

  return { merged: `${original} ${answerTrimmed}`.trim(), is_vague_answer: isVagueAnswer }
}

const REPLY_PATTERNS = {
  conflict_same: /^(同じ|それ|同じの|同じだ|同じです|それです|それね|一緒|そう|そうそう|はい同じ|そう同じ)$/,
  conflict_different: /^(違う|別|違います|別件|別のやつ|違うやつ|別物|別だ|違うよ|別件で|別に追加)$/,
  modify_approve: /^(削除する|消す|消して|する|実行|お願い|頼む|進めて|やって|確定|確定する|承認|はい|yes|OK|ok|オッケー|了解|いいよ|どうぞ)$/,
  modify_reject: /^(やめる|やめて|中止|キャンセル|取り消し|いいや|いえ|no|no|ダメ|違う|やらない)$/,
  // ★v2.0.2 Bug J 修正: 候補選択パターン
  candidate_select_number: /^([1-5]|[1-5]番目|[1-5]つ目|[一二三四五]|最初|2つ目|3つ目|さっきの|最後)$/,
  candidate_select_time: /^(今日|明日|明後日|昨日|今週|来週)?\s*(\d{1,2})時(の|のやつ|のほう|の方)?$/,
  candidate_select_ordinal: /^(\d{1,2})時(の|のやつ|のほう|の方|のほうの)/,
}

/**
 * ★v2.0.2: 複数候補から時刻ベースで1つを選ぶ
 * @returns 選択された候補の index(0-based)、該当なしは -1
 */
function matchCandidateByTime(
  userText: string,
  candidates: Array<{ id: string; title: string }>
): number {
  const trimmed = userText.trim()
  
  // ★v2.0.3 優先1: タイトル完全一致(options タップした時)
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].title === trimmed) return i
  }
  
  // ★v2.0.3 優先2: タイトルを含む(「明日14:00の営業会議」のような長い文字列)
  for (let i = 0; i < candidates.length; i++) {
    if (trimmed.includes(candidates[i].title)) return i
  }
  
  // ★v2.0.3 優先3: 時刻抽出(「14時」「15:00」「14時のやつ」等)
  //   - 「XX時」形式
  //   - 「XX:MM」形式
  //   - 「XX」形式(数字のみ)
  const timePatterns = [
    /(\d{1,2})時/,           // 14時
    /(\d{1,2}):\d{2}/,       // 14:00
    /(\d{1,2}):(\d{2})/,     // 14:00 別キャプチャ用
  ]
  let targetHour: string | null = null
  for (const pattern of timePatterns) {
    const m = trimmed.match(pattern)
    if (m) {
      targetHour = m[1]
      break
    }
  }
  if (!targetHour) return -1
  
  // 各候補の title に対応する時刻が含まれるか
  // candidate title 例: "明日14:00の営業会議" or "明日14時の営業会議"
  for (let i = 0; i < candidates.length; i++) {
    const title = candidates[i].title
    // 「14時」「14:00」「14:30」等すべて拾う
    const candidateTime = title.match(/(\d{1,2})(?:時|:\d{2})/)
    if (candidateTime && candidateTime[1] === targetHour) {
      return i
    }
  }
  return -1
}

/**
 * ★v2.0.2: 「1」「2」「最初」などから候補 index を拾う
 */
function matchCandidateByNumber(
  userText: string,
  candidateCount: number
): number {
  const trimmed = userText.trim()
  const numMap: Record<string, number> = {
    '1': 0, '一': 0, '最初': 0,
    '2': 1, '二': 1, '2つ目': 1, '2番目': 1,
    '3': 2, '三': 2, '3つ目': 2, '3番目': 2,
    '4': 3, '四': 3, '4つ目': 3, '4番目': 3,
    '5': 4, '五': 4, '5つ目': 4, '5番目': 4,
  }
  // 単純一致
  if (numMap[trimmed] !== undefined) {
    const idx = numMap[trimmed]
    return idx < candidateCount ? idx : -1
  }
  // 「1番目」「2番目」パターン
  const ordinalMatch = trimmed.match(/^([1-5])(番目|つ目)$/)
  if (ordinalMatch) {
    const idx = parseInt(ordinalMatch[1]) - 1
    return idx < candidateCount ? idx : -1
  }
  return -1
}

const TARGET_TABLE_KEYWORDS = {
  memo: /(メモ|覚え書き|記録|ノート)/,
  task: /(タスク|仕事|作業|やること|TODO|todo)/,
  calendar: /(予定|会議|ミーティング|アポ|約束|スケジュール|散歩|筋トレ|ジム|散髪|美容院|病院)/,
  ideas: /(アイデア|企画|構想)/,
}

const SIGNAL_PATTERNS = {
  explicit_person: /([一-龯ぁ-んァ-ンA-Za-z]{1,12})(さん|様|会長|社長|部長|課長|先生|ちゃん|くん|氏)|友達|友人|家族|妻|夫|子供|息子|娘|両親|父|母|兄|姉|弟|妹|彼女|彼氏/,
  explicit_location: /([一-龯ぁ-んァ-ンA-Za-z]{1,20})(で|にて|@)(?=[\s、。]|$)|美容院|病院|クリニック|ジム|カフェ|レストラン|オフィス|会社|自宅|家|駅|空港/,
  business_context: /(会議|ミーティング|打ち合わせ|商談|MTG|mtg|案件|契約|プレゼン|営業|交渉|面談|面接|取引|決済|承認|提案|確認)/,
  solo_context: /(散歩|筋トレ|ジム通い|読書|掃除|洗濯|料理|昼寝|休憩|1人で|ひとりで|独り|個人作業)/,
  family_context: /(家族|妻|夫|子供|息子|娘|両親|父|母|兄|姉|弟|妹|旅行|帰省)/,
  appointment_context: /(美容院|病院|クリニック|歯医者|車検|点検|診察|検診|予約|アポ)/,
  sensitive: /(診察|診療|治療|カウンセリング|セラピー|精神科|心療|メンタル|プライベート|個人的な相談|秘密|内緒)/,
  explicit_tentative: /(仮で|仮に|一旦|とりあえず|暫定|後で|とりま)/,
}

// ============================================================
// ユーティリティ
// ============================================================

function normalizeName(name: string) {
  return name.replace(/[さん様社長会長部長課長先生]/g, '').trim()
}

function extractKeywords(text: string) {
  const people: string[] = []
  const personRegex = /([一-龯ぁ-んァ-ンA-Za-z]{2,12})(さん|会長|社長|部長|課長|先生|様)/g
  let match: RegExpExecArray | null
  while ((match = personRegex.exec(text)) !== null) {
    const name = match[1]
    const cleaned = name
      .replace(/^.*時に/, '')
      .replace(/^.*分に/, '')
      .replace(/^.*から/, '')
      .replace(/^.*まで/, '')
      .replace(/^\d+/, '')
      .trim()
    if (cleaned.length >= 2 && cleaned !== name) {
      people.push(normalizeName(cleaned))
    } else if (name.length >= 2 && !/^(時|分|月|日|年)/.test(name)) {
      people.push(normalizeName(name))
    }
  }
  const businesses =
    text.match(/[A-Z][A-Za-z0-9_-]+|[一-龯]{2,10}(事業|プロジェクト|案件|サービス|アプリ)/g) || []
  return {
    people: Array.from(new Set(people)),
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
    {
      regex: /(月|火|水|木|金|土|日)曜[のは]?\s*(\d{1,2})時/,
      resolver: (m) => {
        const dayMap: Record<string, number> = { 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6, 日: 0 }
        const target = dayMap[m[1]]
        const d = new Date(now)
        const diff = (target - d.getDay() + 7) % 7 || 7
        d.setDate(d.getDate() + diff)
        d.setHours(parseInt(m[2]), 0, 0, 0)
        return d
      },
    },
    {
      regex: /(?<!\d)(\d{1,2})時(\d{1,2})?分?(から|に|〜|~|より)?/,
      resolver: (m) => {
        const hour = parseInt(m[1])
        const minute = m[2] ? parseInt(m[2]) : 0
        const d = new Date(now)
        d.setHours(hour, minute, 0, 0)
        if (d.getTime() <= now.getTime()) {
          d.setDate(d.getDate() + 1)
        }
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
  if (/(どう思う|考えて|アイデア|壁打ち|提案して|(?<![一-龯々])案(?![件内内外])|草案|私案)/.test(text)) return 'explore'
  if (/(何|なに|なぜ|意味|とは|教えて|って何|どういう)/.test(text)) return 'answer'
  if (/(して|やって|送って|返して|作って|追加|入れて|保存|記録)/.test(text)) return 'execute'
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

function detectReplyType(text: string): ReplyType {
  const trimmed = text.trim()
  if (REPLY_PATTERNS.conflict_same.test(trimmed)) return 'conflict_same'
  if (REPLY_PATTERNS.conflict_different.test(trimmed)) return 'conflict_different'
  if (REPLY_PATTERNS.modify_approve.test(trimmed)) return 'modify_approve'
  if (REPLY_PATTERNS.modify_reject.test(trimmed)) return 'modify_reject'
  return 'unrelated'
}

function extractEventSignals(text: string): EventSignals {
  return {
    has_explicit_person: SIGNAL_PATTERNS.explicit_person.test(text),
    has_explicit_location: SIGNAL_PATTERNS.explicit_location.test(text),
    has_explicit_time: false,
    has_business_context: SIGNAL_PATTERNS.business_context.test(text),
    has_solo_context: SIGNAL_PATTERNS.solo_context.test(text),
    has_family_context: SIGNAL_PATTERNS.family_context.test(text),
    has_appointment_context: SIGNAL_PATTERNS.appointment_context.test(text),
    is_sensitive: SIGNAL_PATTERNS.sensitive.test(text),
    has_explicit_tentative: SIGNAL_PATTERNS.explicit_tentative.test(text),
  }
}

function inferEventCategory(signals: EventSignals): EventCategory {
  if (signals.is_sensitive) return 'sensitive'
  if (signals.has_family_context) return 'family'
  if (signals.has_business_context) return 'meeting'
  if (signals.has_appointment_context) return 'appointment'
  if (signals.has_solo_context) return 'solo_activity'
  return 'unknown'
}

function decideAskingStrategy(
  signals: EventSignals,
  hasTime: boolean,
  hasExplicitTitle: boolean,
  hasVagueTopic: boolean
): AskingStrategy {
  if (signals.is_sensitive) return 'silent'
  const hasTimeOrLocation = hasTime || signals.has_explicit_location
  if (!hasTimeOrLocation) {
    return 'clarification'
  }
  if (!hasExplicitTitle && hasVagueTopic) {
    return 'clarification'
  }
  return 'silent'
}

function decideTentative(
  signals: EventSignals,
  hasTime: boolean,
  hasExplicitTitle: boolean
): boolean {
  if (signals.has_explicit_tentative) return true
  if (hasTime && hasExplicitTitle) return false
  return true
}

async function checkConflictingEventsForPreLLM(
  datetime: string | null,
  extractedTitle: string | null,
  windowMinutes: number = 60
): Promise<{
  has_conflict: boolean
  existing_events: any[]
  window_description: string
}> {
  if (datetime) {
    try {
      const target = new Date(datetime)
      const windowStart = new Date(target.getTime() - windowMinutes * 60 * 1000)
      const windowEnd = new Date(target.getTime() + windowMinutes * 60 * 1000)

      const { data, error } = await supabase
        .from('calendar')
        .select('*')
        .is('deleted_at', null)
        .neq('state', 'cancelled')
        .gte('datetime', windowStart.toISOString())
        .lte('datetime', windowEnd.toISOString())
        .order('datetime', { ascending: true })

      if (error) console.error('❌ [preLLM] checkConflict エラー:', error)
      
      const events = data || []
      if (events.length > 0) {
        return {
          has_conflict: true,
          existing_events: events,
          window_description: `${windowMinutes}分以内の同時刻帯`,
        }
      }
    } catch (e) {
      console.error('❌ [preLLM] checkConflict 例外:', e)
    }
  }
  
  if (extractedTitle && extractedTitle.length >= 2) {
    try {
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const nextWeek = new Date(todayStart)
      nextWeek.setDate(nextWeek.getDate() + 7)

      const { data, error } = await supabase
        .from('calendar')
        .select('*')
        .is('deleted_at', null)
        .neq('state', 'cancelled')
        .ilike('title', `%${extractedTitle}%`)
        .gte('datetime', todayStart.toISOString())
        .lte('datetime', nextWeek.toISOString())
        .order('datetime', { ascending: true })
        .limit(3)

      if (error) console.error('❌ [preLLM] title-based checkConflict エラー:', error)

      const events = data || []
      if (events.length > 0) {
        return {
          has_conflict: true,
          existing_events: events,
          window_description: `同じタイトル「${extractedTitle}」の予定`,
        }
      }
    } catch (e) {
      console.error('❌ [preLLM] title-based checkConflict 例外:', e)
    }
  }
  
  return {
    has_conflict: false,
    existing_events: [],
    window_description: '',
  }
}

async function performPreLLMAnalysis(
  text: string,
  intent: Intent
): Promise<PreLLMAnalysis> {
  const signals = extractEventSignals(text)
  const extractedDt = extractDatetime(text)
  signals.has_explicit_time = !!extractedDt?.datetime
  const inferredCategory = inferEventCategory(signals)
  
  const modifyAction = detectModifyAction(text)
  
  const trimmed = text.trim()
  const hasVagueTopic = VAGUE_TOPICS_CONTAINS.test(trimmed)
  
  const isCalendarAdd = 
    (intent === 'execute' || intent === 'generic' || intent === 'decide') &&
    !modifyAction &&
    (signals.has_explicit_time || 
     signals.has_business_context || 
     signals.has_appointment_context ||
     signals.has_solo_context ||
     hasVagueTopic)
  
  let extractedTitle: string | null = null
  if (isCalendarAdd) {
    const cleaned = text
      .replace(/明日|今日|明後日|来週|今週|昨日/g, '')
      .replace(/(月|火|水|木|金|土|日)曜/g, '')
      .replace(/\d{1,2}時(\d{1,2})?分?/g, '')
      .replace(/\d{1,2}月\d{1,2}日/g, '')
      .replace(/仮で|一旦|とりあえず|暫定/g, '')
      .replace(/の予定|予定|入れて|追加して|追加|入れといて|記録して/g, '')
      .replace(/[のはに、。]/g, '')
      .trim()
    extractedTitle = cleaned.length >= 2 ? cleaned : null
  }
  
  const hasExplicitTitle = 
    signals.has_explicit_person ||
    signals.has_explicit_location ||
    signals.has_solo_context ||
    signals.has_family_context ||
    signals.has_appointment_context ||
    (!!extractedTitle && !VAGUE_TOPICS.test(extractedTitle))
  
  const shouldDetectConflict = isCalendarAdd && hasExplicitTitle
  
  const conflictDetection = shouldDetectConflict
    ? await checkConflictingEventsForPreLLM(
        extractedDt?.datetime || null,
        extractedTitle,
        60
      )
    : { has_conflict: false, existing_events: [], window_description: '' }
  
  return {
    intent_hint: intent,
    is_calendar_add: isCalendarAdd,
    extracted_title: extractedTitle,
    extracted_datetime: extractedDt?.datetime || null,
    conflict_detection: conflictDetection,
    modify_action: modifyAction,
    has_explicit_title: hasExplicitTitle,
    has_vague_topic: hasVagueTopic,
    signals,
    inferred_category: inferredCategory,
  }
}

function selectModel(
  intent: Intent,
  crisisType: string | null,
  nonInterventionType: string | null,
  isHighRisk: boolean
): 'gpt-4o-mini' | 'gpt-4o' {
  if (crisisType) return 'gpt-4o'
  if (nonInterventionType) return 'gpt-4o'
  if (isHighRisk) return 'gpt-4o'
  if (intent === 'decide') return 'gpt-4o'
  return 'gpt-4o-mini'
}

type RecentMutation = {
  target_id: string
  target_table: TargetTable
  timestamp: number
}

const RECENT_MUTATIONS: RecentMutation[] = []
const DEBOUNCE_WINDOW_MS = 60 * 1000

function shouldDebounceReport(
  targetId: string,
  targetTable: TargetTable
): boolean {
  const nowMs = Date.now()
  while (RECENT_MUTATIONS.length > 0 && 
         nowMs - RECENT_MUTATIONS[0].timestamp > DEBOUNCE_WINDOW_MS) {
    RECENT_MUTATIONS.shift()
  }
  const recent = RECENT_MUTATIONS.find(m => 
    m.target_id === targetId && m.target_table === targetTable
  )
  RECENT_MUTATIONS.push({ target_id: targetId, target_table: targetTable, timestamp: nowMs })
  return !!recent
}

async function fetchOwnerMaster() {
  const { data, error } = await supabase.from('owner_master').select('*').limit(1).single()
  if (error && error.code !== 'PGRST116') {
    console.error('❌ owner_master 取得エラー:', error)
  }
  return data ?? null
}

async function fetchMemory(
  intent: Intent,
  keywords: { people: string[]; businesses: string[] }
) {
  const memory: string[] = []

  if (keywords.people.length > 0) {
    const name = keywords.people[0]
    const { data, error } = await supabase
      .from('people')
      .select('*')
      .ilike('name', `%${name}%`)
      .is('deleted_at', null)
      .limit(1)
    if (error) console.error('❌ people 検索エラー:', error)
    if (data?.length) {
      const p = data[0]
      memory.push(
        `【人物】${p.name}(${p.company || ''}・${p.position || ''}・重要度${p.importance})${p.note ? '特記:' + p.note : ''}`
      )
    }
  }

  if (keywords.businesses.length > 0 && memory.length < 3) {
    const name = keywords.businesses[0]
    const { data, error } = await supabase
      .from('business_master')
      .select('*')
      .ilike('name', `%${name}%`)
      .limit(1)
    if (error) console.error('❌ business_master 検索エラー:', error)
    if (data?.length) {
      const b = data[0]
      memory.push(`【事業】${b.name}(${b.status || '進行中'})${b.note ? '詳細:' + b.note : ''}`)
    }
  }

  if (memory.length < 3 && (intent === 'decide' || intent === 'generic' || intent === 'execute')) {
    const { data, error } = await supabase
      .from('task')
      .select('*')
      .eq('done', false)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(2)
    if (error) console.error('❌ task 検索エラー:', error)
    if (data?.length) {
      memory.push(`【未完了タスク】${data.map((t: any) => t.content).join(' / ')}`)
    }
  }

  if (memory.length < 3 && (intent === 'decide' || intent === 'generic')) {
    const { data, error } = await supabase
      .from('calendar')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
    if (error) console.error('❌ calendar 検索エラー:', error)
    if (data?.length) {
      memory.push(`【予定】${data[0].title}`)
    }
  }

  return memory.slice(0, 3)
}

async function fetchPendingFeedback() {
  const { data, error } = await supabase
    .from('feedback_queue')
    .select('id, decision_log_id, decision_log:decision_log_id(decision_text)')
    .eq('asked', false)
    .lte('ask_after', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) console.error('❌ feedback_queue 取得エラー:', error)
  return data ?? null
}

async function recordFeedback(queueId: string, decisionLogId: string, done: boolean) {
  const { error: e1 } = await supabase
    .from('decision_log')
    .update({ action_taken: done ? 'done' : 'skipped', updated_at: new Date().toISOString() })
    .eq('id', decisionLogId)
  if (e1) console.error('❌ decision_log 更新エラー:', e1)

  const { error: e2 } = await supabase
    .from('feedback_queue')
    .update({ asked: true, answered: true })
    .eq('id', queueId)
  if (e2) console.error('❌ feedback_queue 更新エラー:', e2)
}

async function appendAlias(
  table: TargetTable,
  recordId: string,
  newAlias: string
): Promise<void> {
  try {
    const { data: current, error: getErr } = await supabase
      .from(table)
      .select('aliases')
      .eq('id', recordId)
      .maybeSingle<{ aliases: string[] | null }>()
    if (getErr) {
      console.error(`❌ ${table} aliases 取得エラー:`, getErr)
      return
    }
    
    const existing: string[] = current?.aliases ?? []
    const trimmed = newAlias.trim()
    if (!trimmed || trimmed.length < 2) return
    
    const garbagePatterns = [
      /消して|削除|キャンセル|取り消し|なくなった|やめ/,
      /^(あの|その|この)/,
      /^[0-9]/,
      /時間|場所|誰と/,
    ]
    if (garbagePatterns.some(p => p.test(trimmed))) {
      console.log(`⚠️ alias 除外(ゴミ): "${trimmed}"`)
      return
    }
    
    if (existing.some(a => a.toLowerCase() === trimmed.toLowerCase())) return
    
    const updated = [...existing, trimmed].slice(-20)
    const { error: upErr } = await supabase
      .from(table)
      .update({ aliases: updated })
      .eq('id', recordId)
    if (upErr) {
      console.error(`❌ ${table} aliases 更新エラー:`, upErr)
    } else {
      console.log(`✅ aliases 追加: ${table}.${recordId} += "${trimmed}"`)
    }
  } catch (e) {
    console.error(`❌ appendAlias 例外:`, e)
  }
}

function scoreCandidate(
  candidate: any,
  text: string,
  table: TargetTable,
  analysis: QueryAnalysis,
  personalMatches: PersonalDictionaryMatch[],
  personMatch: PersonMatchResult
): { score: number; reason: string; matched_alias?: string } {
  let score = 0
  const reasons: string[] = []
  let matched_alias: string | undefined
  
  const contentField =
    table === 'task' || table === 'memo' || table === 'ideas' ? 'content' : 'title'
  const targetText = String(candidate[contentField] || '').toLowerCase()
  const textLower = text.toLowerCase()
  
  const aliases: string[] = candidate.aliases || []
  
  if (targetText && textLower.includes(targetText)) {
    score += 0.60
    reasons.push(`content一致`)
  }
  
  for (const alias of aliases) {
    const aliasLower = alias.toLowerCase()
    if (aliasLower.length >= 2 && textLower.includes(aliasLower)) {
      score += 0.55
      reasons.push(`alias一致:"${alias}"`)
      matched_alias = alias
      break
    }
  }
  
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
      reasons.push(`個人辞書一致:${match.entity.text}`)
    }
    for (const pdAlias of match.entity.aliases) {
      if (pdAlias.length >= 2 && targetText.includes(pdAlias)) {
        score += 0.45
        reasons.push(`個人辞書エイリアス:${pdAlias}`)
        break
      }
    }
  }
  
  if (personMatch.type === 'confident' || personMatch.type === 'likely') {
    const person = personMatch.person
    if (targetText.includes(person.name.toLowerCase())) {
      const weight = personMatch.type === 'confident' ? 0.55 : 0.40
      score += weight
      reasons.push(`人物:${person.name}(${personMatch.type})`)
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
          reasons.push(`人物姓:${sc}`)
          break
        }
      }
    }
  }
  
  for (const org of analysis.organizations) {
    if (targetText.includes(org.toLowerCase())) {
      score += 0.40
      reasons.push(`組織:${org}`)
    }
  }
  
  const personalEntityTexts = new Set(
    personalMatches.map(m => m.entity.text.toLowerCase())
  )
  for (const pn of analysis.proper_nouns) {
    if (personalEntityTexts.has(pn.toLowerCase())) continue
    if (targetText.includes(pn.toLowerCase())) {
      score += 0.35
      reasons.push(`固有名詞:${pn}`)
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
    reasons.push(`キーワード:${matchedKeywords.join(',')}`)
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
        reasons.push(`相対日時:${dt.raw}`)
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
    matched_alias,
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
  matched_alias?: string
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
      const { data, error } = await query
      if (error) console.error('❌ resolveReference/task エラー:', error)
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
      const { data, error } = await query
      if (error) console.error('❌ resolveReference/calendar エラー:', error)
      candidates = data || []
    } else if (targetTable === 'memo') {
      const { data, error } = await supabase
        .from('memo')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30)
      if (error) console.error('❌ resolveReference/memo エラー:', error)
      candidates = data || []
    } else if (targetTable === 'ideas') {
      const { data, error } = await supabase
        .from('ideas')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30)
      if (error) console.error('❌ resolveReference/ideas エラー:', error)
      candidates = data || []
    }
  } catch (e) {
    console.error('❌ resolveReference 例外:', e)
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
  
  let topMatchedAlias: string | undefined
  const scored = candidates.map((c) => {
    const { score, reason, matched_alias } = scoreCandidate(
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
    // ★v2.0.2 Bug J 修正: calendar は title + datetime で候補表示
    let displayTitle = String(c[contentField] || '').substring(0, 50)
    if (targetTable === 'calendar' && c.datetime) {
      try {
        const dt = new Date(c.datetime)
        const today = new Date()
        const isToday = dt.toDateString() === today.toDateString()
        const tomorrow = new Date(today)
        tomorrow.setDate(tomorrow.getDate() + 1)
        const isTomorrow = dt.toDateString() === tomorrow.toDateString()
        const timeStr = dt.toLocaleTimeString('ja-JP', {
          hour: '2-digit', minute: '2-digit', hour12: false,
        })
        const dateLabel = isToday
          ? `今日${timeStr}`
          : isTomorrow
          ? `明日${timeStr}`
          : `${dt.getMonth() + 1}月${dt.getDate()}日${timeStr}`
        displayTitle = `${dateLabel}の${displayTitle}`
      } catch (e) {
        // datetime 不正なら title のみ
      }
    }
    return {
      id: c.id,
      title: displayTitle,
      score,
      reason,
      matched_alias,
    }
  })

  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]
  topMatchedAlias = top?.matched_alias

  let strategy: MutationPlan['resolver_strategy'] = 'recency'
  const hasDate = /(\d{1,2})[月\/](\d{1,2})/.test(text)
  const hasProperNoun = /([一-龯ぁ-んァ-ンA-Za-z]{2,})(さん|会長|社長|庁|省|部|課|店|所|会社)/.test(text)

  if (top?.matched_alias) strategy = 'aliases_match'
  else if (hasDate) strategy = 'explicit_ref'
  else if (hasProperNoun && top?.reason.includes('人物')) strategy = 'proper_noun'
  else if (/(さっき|今の|直前|ついさっき)/.test(text)) strategy = 'recency'
  else if (top?.reason.includes('個人辞書')) strategy = 'proper_noun'
  else if (top && top.score >= 0.5) strategy = 'keyword'
  else if (!top || top.score < 0.3) strategy = 'ambiguous'

  const confidence = top?.score ?? 0
  const scoreGap = scored.length > 1 ? top.score - scored[1].score : 1.0

  const significantCandidates = scored.filter(s => s.score >= 0.3)
  const isOnlyCandidate = significantCandidates.length === 1 && top.score >= 0.3

  const isAmbiguousReference = /(あの|その|この)(メモ|タスク|予定|会議|ミーティング)/.test(text)
  const needsConfirmation =
    !isOnlyCandidate && (
      confidence < 0.5 ||
      (scored.length > 1 && scored[1].score >= 0.45 && scoreGap < 0.15) ||
      (isAmbiguousReference && scored.length > 1 && scored[1].score > 0.3 && !hasProperNoun)
    )

  return {
    target_id: needsConfirmation ? null : (top && top.score >= 0.3 ? top.id : null),
    target_title: top && top.score >= 0.3 ? top.title : null,
    confidence,
    strategy: needsConfirmation && confidence < 0.5 ? 'ambiguous' : strategy,
    candidates: scored.slice(0, 5).map(s => ({ 
      id: s.id, title: s.title, score: s.score, reason: s.reason 
    })),
    needs_user_confirmation: needsConfirmation,
    matched_alias: topMatchedAlias,
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
      patch = { state: 'active', done: false, completed_at: null, cancelled_at: null, updated_at: nowISO }
    } else if (action === 'delete') {
      patch = { deleted_at: nowISO, updated_at: nowISO }
    }
  } else if (targetTable === 'calendar') {
    if (action === 'complete') {
      patch = { state: 'completed', completed_at: nowISO, updated_at: nowISO }
    } else if (action === 'cancel') {
      patch = { state: 'cancelled', cancelled_at: nowISO, updated_at: nowISO }
    } else if (action === 'restore') {
      patch = { state: 'scheduled', cancelled_at: null, updated_at: nowISO }
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
  if (resolved.matched_alias) reasonText += ` [alias一致: "${resolved.matched_alias}"]`
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

async function createModifyPending(
  plan: MutationPlan,
  userMessageId: string,
  userText: string
): Promise<string | null> {
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()

  const actionJpMap: Record<string, string> = {
    delete: '削除', complete: '完了', cancel: 'キャンセル',
    pause: '一時停止', update: '更新', restore: '復元',
  }
  const actionJp = actionJpMap[plan.action] || plan.action

  const subject_snapshot = {
    action: plan.action,
    action_jp: actionJp,
    candidate_ids: plan.candidate_rankings.map(c => c.id),
    rendered_titles: plan.candidate_rankings.slice(0, 5).map(c => c.title),
    user_text: userText,
    target_title: plan.target_title,
  }

  const candidates = {
    candidates: plan.candidate_rankings.slice(0, 5),
    action: plan.action,
  }

  const { data, error } = await supabase
    .from('pending_confirmation')
    .insert({
      user_message_id: userMessageId,
      session_date: getSessionDate(),
      action: 'confirm_modify',
      target_table: plan.target_table,
      candidates,
      mutation_plan: plan as any,
      subject_snapshot,
      expected_reply_type: plan.candidate_rankings.length > 1 
        ? 'candidate_selection' 
        : 'approve_reject',
      reason_text: plan.reason_text,
      status: 'pending',
      expires_at: expiresAt,
    })
    .select('id')
    .single()

  if (error) {
    console.error('❌ modify pending INSERT エラー:', error)
    return null
  }
  console.log('📌 modify pending 作成:', data?.id)
  return data?.id || null
}

async function fetchLatestModifyPending(): Promise<any | null> {
  try {
    const { data, error } = await supabase
      .from('pending_confirmation')
      .select('*')
      .eq('action', 'confirm_modify')
      .eq('status', 'pending')
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) console.error('❌ fetchLatestModifyPending エラー:', error)
    return data ?? null
  } catch (e) {
    console.error('❌ fetchLatestModifyPending 例外:', e)
    return null
  }
}

async function resolvePending(
  pendingId: string,
  newStatus: 'confirmed' | 'cancelled' | 'expired'
): Promise<void> {
  const { error } = await supabase
    .from('pending_confirmation')
    .update({ 
      status: newStatus, 
      confirmed_at: new Date().toISOString() 
    })
    .eq('id', pendingId)
  if (error) {
    console.error(`❌ pending UPDATE(${newStatus}) エラー:`, error)
  } else {
    console.log(`✅ pending ${pendingId} → ${newStatus}`)
  }
}

async function executeMutationPlan(
  plan: MutationPlan,
  userMessageId: string,
  originalSearchText: string
): Promise<ExecutionResult> {
  if (plan.mutation_mode !== 'confirmed') {
    return {
      status: 'needs_confirmation',
      candidates: plan.candidate_rankings.slice(0, 3),
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
      console.error('❌ executeMutationPlan: target取得エラー', beforeError)
      return {
        status: 'error',
        error: 'target_not_found_at_execution',
        action: plan.action,
      }
    }

    const contentField = plan.target_table === 'task' || plan.target_table === 'memo' || plan.target_table === 'ideas'
      ? 'content'
      : 'title'
    const canonicalText = String(before[contentField] || '').toLowerCase()
    const searchLower = originalSearchText.toLowerCase()
    
    if (searchLower && !searchLower.includes(canonicalText) && !canonicalText.includes(searchLower)) {
      const aliasCandidate = originalSearchText.substring(0, 50).trim()
      if (aliasCandidate.length >= 2 && aliasCandidate.length <= 50) {
        await appendAlias(plan.target_table, plan.target_id, aliasCandidate)
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
        console.error('⚠️ trash_queue INSERTエラー:', trashError)
      }

      if (plan.target_table === 'memo' || plan.target_table === 'ideas') {
        const { data: deletedRows, error } = await supabase
          .from(plan.target_table)
          .delete()
          .eq('id', plan.target_id)
          .select('id')
        if (error) {
          console.error('❌ delete エラー:', error)
          return { status: 'error', error: error.message, action: plan.action }
        }
        if (!deletedRows || deletedRows.length !== 1) {
          console.error('❌ delete で予期しない件数:', deletedRows?.length)
          return { status: 'error', error: `unexpected affected rows: ${deletedRows?.length ?? 0}`, action: plan.action }
        }
      } else {
        const { data: updatedRows, error } = await supabase
          .from(plan.target_table)
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', plan.target_id)
          .select('id')
        if (error) {
          console.error('❌ soft-delete エラー:', error)
          return { status: 'error', error: error.message, action: plan.action }
        }
        if (!updatedRows || updatedRows.length !== 1) {
          console.error('❌ soft-delete で予期しない件数:', updatedRows?.length)
          return { status: 'error', error: `unexpected affected rows: ${updatedRows?.length ?? 0}`, action: plan.action }
        }
      }
    } else {
      const { data: updatedRows, error } = await supabase
        .from(plan.target_table)
        .update(plan.patch)
        .eq('id', plan.target_id)
        .select('id')
      if (error) {
        console.error('❌ update エラー:', error)
        return { status: 'error', error: error.message, action: plan.action }
      }
      if (!updatedRows || updatedRows.length !== 1) {
        console.error('❌ update で予期しない件数:', updatedRows?.length)
        return { status: 'error', error: `unexpected affected rows: ${updatedRows?.length ?? 0}`, action: plan.action }
      }
    }

    if (
      (plan.target_table === 'task' || plan.target_table === 'calendar') &&
      plan.patch.state
    ) {
      const { error: stError } = await supabase.from('living_record_state_transition').insert({
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
      if (stError) console.error('⚠️ state_transition INSERT エラー:', stError)
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

    const { error: mutLogError } = await supabase.from('mutation_event_log').insert({
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
    if (mutLogError) {
      console.error('⚠️ mutation_event_log INSERT エラー:', mutLogError)
    }

    const { error: erResErr } = await supabase.from('entity_reference_resolution_log').insert({
      user_message_id: userMessageId,
      reference_text: plan.target_title || '(unknown)',
      target_table: plan.target_table,
      chosen_target_id: plan.target_id,
      candidate_rankings: plan.candidate_rankings,
      resolver_strategy: plan.resolver_strategy,
      confidence: plan.confidence,
      user_confirmed: !plan.requires_confirmation,
    })
    if (erResErr) console.error('⚠️ entity_reference_resolution_log INSERT エラー:', erResErr)

    const resultMatchedAlias = plan.resolver_strategy === 'aliases_match' 
      ? plan.candidate_rankings[0]?.reason.match(/alias一致:"([^"]+)"/)?.[1]
      : undefined

    return {
      status: 'executed',
      target_id: plan.target_id,
      target_title: plan.target_title || '(対象)',
      action: plan.action,
      before_state: before.state || null,
      after_state: (plan.patch.state as string) || (plan.action === 'delete' ? 'deleted' : null),
      matched_alias: resultMatchedAlias,
    }
  } catch (e: any) {
    console.error('❌ executeMutationPlan 例外:', e)
    return {
      status: 'error',
      error: e.message || 'unknown',
      action: plan.action,
    }
  }
}

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
    console.error('❌ decision_log 記録失敗:', error)
    return
  }

  if (intent === 'objection' || intent === 'non_intervention') return

  const askAfter = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const { error: fqError } = await supabase.from('feedback_queue').insert({
    decision_log_id: data.id,
    ask_after: askAfter,
  })
  if (fqError) console.error('❌ feedback_queue INSERT 失敗:', fqError)
}

async function checkConflictingEvents(
  datetime: string,
  windowMinutes: number = 60
): Promise<any[]> {
  try {
    const target = new Date(datetime)
    const windowStart = new Date(target.getTime() - windowMinutes * 60 * 1000)
    const windowEnd = new Date(target.getTime() + windowMinutes * 60 * 1000)

    const { data, error } = await supabase
      .from('calendar')
      .select('*')
      .is('deleted_at', null)
      .neq('state', 'cancelled')
      .gte('datetime', windowStart.toISOString())
      .lte('datetime', windowEnd.toISOString())
      .order('datetime', { ascending: true })

    if (error) console.error('❌ checkConflictingEvents エラー:', error)
    return data || []
  } catch (e) {
    console.error('❌ checkConflictingEvents 例外:', e)
    return []
  }
}

async function fetchLatestCalendarConflict(): Promise<any | null> {
  try {
    const { data, error } = await supabase
      .from('pending_confirmation')
      .select('*')
      .eq('action', 'resolve_calendar_conflict')
      .eq('status', 'pending')
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) console.error('❌ fetchLatestCalendarConflict エラー:', error)
    return data ?? null
  } catch (e) {
    console.error('❌ fetchLatestCalendarConflict 例外:', e)
    return null
  }
}

async function confirmTentativeCalendar(
  existingId: string,
  newTitle: string,
  newPeopleName: string | null | undefined
): Promise<void> {
  try {
    const { data: current, error: getError } = await supabase
      .from('calendar')
      .select('title, is_tentative, person_id')
      .eq('id', existingId)
      .single()

    if (getError) {
      console.error('❌ confirmTentativeCalendar 取得エラー:', getError)
      return
    }
    if (!current) return

    const updates: any = {
      updated_at: new Date().toISOString(),
    }

    if (newTitle && !VAGUE_TOPICS.test(newTitle.trim())) {
      updates.title = newTitle
    }

    updates.is_tentative = false
    updates.missing_fields = null

    if (newPeopleName && !current.person_id) {
      const normalizedName = normalizeName(newPeopleName)
      const { data: people, error: peopleErr } = await supabase
        .from('people')
        .select('id')
        .ilike('name', `%${normalizedName}%`)
        .is('deleted_at', null)
        .limit(1)
      if (peopleErr) {
        console.error('❌ confirm 用 people 検索エラー:', peopleErr)
      } else if (people?.length) {
        updates.person_id = people[0].id
        console.log(`✅ 仮予定に人物紐付け: ${normalizedName} (${people[0].id})`)
      }
    }

    const { error: upError } = await supabase.from('calendar').update(updates).eq('id', existingId)
    if (upError) {
      console.error('❌ confirmTentativeCalendar UPDATE エラー:', upError)
      return
    }
    console.log('✅ 仮予定を確定:', existingId, updates)
  } catch (e) {
    console.error('❌ confirmTentativeCalendar 例外:', e)
  }
}

const INVALID_SAVE_VALUES = new Set([
  'null', 'undefined', 'NULL', 'None', 'none',
  '(省略可)', '省略可', '(省略)', '省略', '(省略可能)', '省略可能',
  'なし', '(なし)', '無し', '(無し)',
  'N/A', 'n/a', 'NA',
  '(ユーザーが言った時のみ)', '(ユーザーが言った時)',
  '(ユーザーが明示的に述べた場合のみ)',
  '(具体的に述べられた場合のみ)',
])

function cleanSaveValue(value: any): any {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return null
  if (INVALID_SAVE_VALUES.has(trimmed)) {
    console.log('⚠️ ゴミ値を検出してスキップ:', trimmed)
    return null
  }
  const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
  if (ISO_DATETIME_PATTERN.test(trimmed)) {
    console.log('⚠️ ISO 8601 形式を検出してスキップ:', trimmed)
    return null
  }
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    console.log('⚠️ 括弧メタ注釈を検出してスキップ:', trimmed)
    return null
  }
  if (trimmed.includes('省略可') || trimmed.includes('省略する')) {
    console.log('⚠️ 省略関連の語を検出してスキップ:', trimmed)
    return null
  }
  return trimmed
}

function normalizePeopleData(saveData: any): { name: string; note?: string; company?: string; position?: string; phone?: string; email?: string; address?: string } | null {
  if (!saveData) return null
  if (typeof saveData === 'object' && saveData.name) {
    return {
      name: saveData.name,
      note: saveData.note,
      company: saveData.company,
      position: saveData.position,
      phone: saveData.phone,
      email: saveData.email,
      address: saveData.address,
    }
  }
  if (typeof saveData === 'string' && saveData.trim().length >= 1) {
    return { name: saveData.trim() }
  }
  return null
}

async function saveStructuredMemory(
  save: any,
  rawText: string,
  userMessageId: string,
  preLLMAnalysis: PreLLMAnalysis | null
): Promise<SaveEntityResult[]> {
  const results: SaveEntityResult[] = []
  if (!save) {
    console.log('📦 [SAVE] save オブジェクトが null/undefined')
    return results
  }

  console.log('📦 [SAVE] 入口の save 内容:', JSON.stringify(save))

  const signals = preLLMAnalysis?.signals || extractEventSignals(rawText)
  const extractedDt = extractDatetime(rawText)
  signals.has_explicit_time = !!extractedDt?.datetime
  const inferredCategory = preLLMAnalysis?.inferred_category || inferEventCategory(signals)

  const extractedEntities: Array<{ table: string; id: string; role: string }> = []

  let resolvedPersonId: string | null = null
  const peopleData = normalizePeopleData(save.people)
  
  if (peopleData?.name) {
    const normalizedName = normalizeName(peopleData.name)
    const { data: candidates, error: searchErr } = await supabase
      .from('people')
      .select('*')
      .ilike('name', `%${normalizedName}%`)
      .is('deleted_at', null)
      .limit(3)
    if (searchErr) console.error('❌ people 検索エラー:', searchErr)

    const existing =
      candidates?.find(
        (c: any) =>
          (peopleData.company && c.company === peopleData.company) ||
          (peopleData.position && c.position === peopleData.position) ||
          c.name === normalizedName
      ) || candidates?.[0]

    if (existing) {
      const nextNote = [existing.note, peopleData.note].filter(Boolean).join('\n')
      const updateData: any = {
        company: peopleData.company || existing.company,
        position: peopleData.position || existing.position,
        note: nextNote,
        last_mentioned_at: new Date().toISOString(),
        mention_count: (existing.mention_count || 0) + 1,
        updated_at: new Date().toISOString(),
      }
      if (peopleData.phone) updateData.phone = peopleData.phone
      if (peopleData.email) updateData.email = peopleData.email
      if (peopleData.address) updateData.address = peopleData.address

      const { error: upErr } = await supabase
        .from('people')
        .update(updateData)
        .eq('id', existing.id)
      if (upErr) {
        console.error('❌ people UPDATE エラー:', upErr)
        results.push({ table: 'people', attempted: true, success: false, error_code: upErr.code, error_message: upErr.message })
      } else {
        console.log('✅ people UPDATE:', existing.id)
        resolvedPersonId = existing.id
        extractedEntities.push({ table: 'people', id: existing.id, role: 'referenced' })
        results.push({ table: 'people', attempted: true, success: true, id: existing.id, role: 'referenced' })
        try {
          await recordReferringExpression(existing.id, normalizedName, 'nickname', null)
        } catch (e) {
          console.warn('⚠️ recordReferringExpression エラー:', e)
        }
      }
    } else {
      const insertData: any = {
        name: normalizedName,
        company: peopleData.company || null,
        position: peopleData.position || null,
        note: peopleData.note || null,
        importance: 'B',
        last_mentioned_at: new Date().toISOString(),
        mention_count: 1,
      }
      if (peopleData.phone) insertData.phone = peopleData.phone
      if (peopleData.email) insertData.email = peopleData.email
      if (peopleData.address) insertData.address = peopleData.address

      const { data: inserted, error: insErr } = await supabase
        .from('people')
        .insert(insertData)
        .select('id')
        .single()
      if (insErr) {
        console.error('❌ people INSERT エラー:', insErr)
        results.push({ table: 'people', attempted: true, success: false, error_code: insErr.code, error_message: insErr.message })
      } else if (inserted) {
        console.log('✅ people INSERT:', inserted.id)
        resolvedPersonId = inserted.id
        extractedEntities.push({ table: 'people', id: inserted.id, role: 'created' })
        results.push({ table: 'people', attempted: true, success: true, id: inserted.id, role: 'created' })
        try {
          await recordReferringExpression(inserted.id, normalizedName, 'nickname', null)
        } catch (e) {
          console.warn('⚠️ recordReferringExpression エラー:', e)
        }
      }
    }
  }

  const cleanTask = cleanSaveValue(save.task)
  if (cleanTask) {
    const { data: existing, error: existErr } = await supabase
      .from('task')
      .select('id')
      .eq('content', cleanTask)
      .is('deleted_at', null)
      .limit(1)
    if (existErr) console.error('❌ task 既存検索エラー:', existErr)

    if (!existing?.length) {
      const { data: inserted, error: insErr } = await supabase
        .from('task')
        .insert({
          content: cleanTask,
          done: false,
          state: 'active',
          is_user_confirmed: true,
          confidence: 0.9,
          aliases: [],
        })
        .select('id')
        .single()

      if (insErr) {
        console.error('❌ task INSERT エラー:', insErr)
        results.push({
          table: 'task', attempted: true, success: false,
          error_code: insErr.code, error_message: insErr.message,
        })
      } else if (inserted) {
        console.log('✅ task INSERT 成功:', inserted.id)
        extractedEntities.push({ table: 'task', id: inserted.id, role: 'created' })
        results.push({ table: 'task', attempted: true, success: true, id: inserted.id, role: 'created' })
      }
    } else {
      results.push({ table: 'task', attempted: true, success: true, skipped_reason: 'already_exists' })
    }
  } else if (save.task !== null && save.task !== undefined) {
    results.push({ table: 'task', attempted: true, success: false, skipped_reason: 'cleaned_to_null', error_message: String(save.task) })
  }

  const cleanMemo = cleanSaveValue(save.memo)
  if (cleanMemo) {
    const { data: inserted, error: insErr } = await supabase
      .from('memo')
      .insert({ content: cleanMemo, aliases: [] })
      .select('id')
      .single()
    if (insErr) {
      console.error('❌ memo INSERT エラー:', insErr)
      results.push({ table: 'memo', attempted: true, success: false, error_code: insErr.code, error_message: insErr.message })
    } else if (inserted) {
      console.log('✅ memo INSERT 成功:', inserted.id)
      extractedEntities.push({ table: 'memo', id: inserted.id, role: 'created' })
      results.push({ table: 'memo', attempted: true, success: true, id: inserted.id, role: 'created' })
    }
  } else if (save.memo !== null && save.memo !== undefined) {
    results.push({ table: 'memo', attempted: true, success: false, skipped_reason: 'cleaned_to_null', error_message: String(save.memo) })
  }

  const calendarItems: any[] = Array.isArray(save.calendar) 
    ? save.calendar 
    : (save.calendar !== null && save.calendar !== undefined ? [save.calendar] : [])
  
  const skipCalendarInsert = preLLMAnalysis?.conflict_detection?.has_conflict && calendarItems.length === 1
  
  if (skipCalendarInsert && preLLMAnalysis?.conflict_detection) {
    console.log('⏸️ Pre-LLM conflict 検出済みのため calendar INSERT をスキップ、pending_confirmation 作成へ')
    
    const conflict = preLLMAnalysis.conflict_detection.existing_events[0]
    const newCalendarTitle = typeof calendarItems[0] === 'string' ? calendarItems[0] : calendarItems[0]?.title
    const cleanTitle = cleanSaveValue(newCalendarTitle) || preLLMAnalysis.extracted_title || '予定'
    const isTentative = decideTentative(signals, signals.has_explicit_time, preLLMAnalysis.has_explicit_title)
    
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    const { error: pcError } = await supabase.from('pending_confirmation').insert({
      user_message_id: userMessageId,
      session_date: getSessionDate(),
      action: 'resolve_calendar_conflict',
      target_table: 'calendar',
      candidates: {
        existing: {
          id: conflict.id,
          title: conflict.title,
          datetime: conflict.datetime,
          is_tentative: conflict.is_tentative || false,
        },
        new_event: {
          title: cleanTitle,
          datetime: preLLMAnalysis.extracted_datetime,
          is_tentative: isTentative,
          signals,
          inferred_category: inferredCategory,
          person_id: resolvedPersonId,
          person_name: peopleData?.name || null,
        },
      },
      subject_snapshot: {
        action: 'resolve_calendar_conflict',
        existing_title: conflict.title,
        new_title: cleanTitle,
        rendered_titles: [conflict.title, cleanTitle],
      },
      expected_reply_type: 'same_or_different',
      mutation_plan: {
        type: 'calendar_conflict',
        existing_id: conflict.id,
        new_event_data: {
          title: cleanTitle,
          datetime: preLLMAnalysis.extracted_datetime,
          is_tentative: isTentative,
          signals,
          inferred_category: inferredCategory,
          person_id: resolvedPersonId,
          person_name: peopleData?.name || null,
        },
      },
      reason_text: `同時間帯に既存予定「${conflict.title}」があるため確認が必要`,
      status: 'pending',
      expires_at: expiresAt,
    })
    
    if (pcError) {
      console.error('❌ pending_confirmation INSERT エラー:', pcError)
      results.push({ table: 'pending_confirmation', attempted: true, success: false, error_code: pcError.code, error_message: pcError.message })
    } else {
      console.log('🔔 Pre-LLM conflict pending 作成完了')
      results.push({ table: 'pending_confirmation', attempted: true, success: true, role: 'calendar_conflict_pending' })
    }
  } else {
    for (let i = 0; i < calendarItems.length; i++) {
      const calendarItem = calendarItems[i]
      const cleanCalendar = cleanSaveValue(
        typeof calendarItem === 'string' ? calendarItem : calendarItem?.title
      )
      if (!cleanCalendar) {
        if (calendarItem !== null && calendarItem !== undefined) {
          results.push({ 
            table: 'calendar', attempted: true, success: false, 
            skipped_reason: 'cleaned_to_null', 
            error_message: String(calendarItem) 
          })
        }
        continue
      }

      let itemDatetime: string | null = null
      if (typeof calendarItem === 'object' && calendarItem?.datetime) {
        itemDatetime = calendarItem.datetime
      } else {
        itemDatetime = extractedDt?.datetime || null
      }

      console.log('📦 [SAVE] calendar 処理:', {
        index: i,
        title: cleanCalendar,
        datetime: itemDatetime,
        signals,
        inferred_category: inferredCategory,
        person_id: resolvedPersonId,
      })

      const hasExplicitTitle = !VAGUE_TOPICS.test(cleanCalendar.trim())
      const hasTime = !!itemDatetime
      const isTentative = decideTentative(signals, hasTime, hasExplicitTitle)

      const insertData: any = {
        title: cleanCalendar,
        datetime: itemDatetime,
        state: 'scheduled',
        is_tentative: isTentative,
        missing_fields: null,
        event_signals: signals,
        inferred_category: inferredCategory,
        aliases: [],
        is_user_confirmed: true,
        confidence: 0.9,
      }
      if (resolvedPersonId) {
        insertData.person_id = resolvedPersonId
      }

      const { data: inserted, error: insErr } = await supabase
        .from('calendar')
        .insert(insertData)
        .select('id')
        .single()

      if (insErr) {
        console.error('❌ calendar INSERT エラー:', {
          code: insErr.code,
          message: insErr.message,
          payload: { title: cleanCalendar, datetime: itemDatetime, is_tentative: isTentative },
        })
        results.push({ table: 'calendar', attempted: true, success: false, error_code: insErr.code, error_message: insErr.message })
      } else if (inserted) {
        console.log('✅ calendar INSERT 成功:', {
          id: inserted.id, title: cleanCalendar, is_tentative: isTentative, 
          category: inferredCategory, person_id: resolvedPersonId,
        })
        extractedEntities.push({ 
          table: 'calendar', 
          id: inserted.id, 
          role: isTentative ? 'tentative_event' : 'event' 
        })
        results.push({ 
          table: 'calendar', attempted: true, success: true, 
          id: inserted.id, 
          role: isTentative ? 'tentative_event' : 'event' 
        })
      }
    }
  }

  if (save.business?.name) {
    const b = save.business
    const { data: existing, error: searchErr } = await supabase
      .from('business_master')
      .select('*')
      .ilike('name', `%${b.name}%`)
      .limit(1)
    if (searchErr) console.error('❌ business 検索エラー:', searchErr)

    if (existing?.length) {
      const { error: upErr } = await supabase
        .from('business_master')
        .update({
          note: [existing[0].note, b.note].filter(Boolean).join('\n'),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing[0].id)
      if (upErr) {
        console.error('❌ business UPDATE エラー:', upErr)
        results.push({ table: 'business_master', attempted: true, success: false, error_code: upErr.code, error_message: upErr.message })
      } else {
        console.log('✅ business UPDATE:', existing[0].id)
        extractedEntities.push({ table: 'business_master', id: existing[0].id, role: 'referenced' })
        results.push({ table: 'business_master', attempted: true, success: true, id: existing[0].id, role: 'referenced' })
      }
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from('business_master')
        .insert({ name: b.name, note: b.note || null })
        .select('id')
        .single()
      if (insErr) {
        console.error('❌ business INSERT エラー:', insErr)
        results.push({ table: 'business_master', attempted: true, success: false, error_code: insErr.code, error_message: insErr.message })
      } else if (inserted) {
        console.log('✅ business INSERT:', inserted.id)
        extractedEntities.push({ table: 'business_master', id: inserted.id, role: 'created' })
        results.push({ table: 'business_master', attempted: true, success: true, id: inserted.id, role: 'created' })
      }
    }
  }

  const cleanIdeas = cleanSaveValue(save.ideas)
  if (cleanIdeas) {
    const { data: inserted, error: insErr } = await supabase
      .from('ideas')
      .insert({ content: cleanIdeas, aliases: [] })
      .select('id')
      .single()
    if (insErr) {
      console.error('❌ ideas INSERT エラー:', insErr)
      results.push({ table: 'ideas', attempted: true, success: false, error_code: insErr.code, error_message: insErr.message })
    } else if (inserted) {
      console.log('✅ ideas INSERT:', inserted.id)
      extractedEntities.push({ table: 'ideas', id: inserted.id, role: 'created' })
      results.push({ table: 'ideas', attempted: true, success: true, id: inserted.id, role: 'created' })
    }
  } else if (save.ideas !== null && save.ideas !== undefined) {
    results.push({ table: 'ideas', attempted: true, success: false, skipped_reason: 'cleaned_to_null', error_message: String(save.ideas) })
  }

  if (extractedEntities.length > 0) {
    const { error: extLogErr } = await supabase.from('entity_extraction_log').insert({
      source_message_id: userMessageId,
      source_text: rawText,
      extracted_entities: extractedEntities,
      extraction_method: 'llm',
      confidence: 0.85,
      is_user_reviewed: false,
    })
    if (extLogErr) console.error('⚠️ entity_extraction_log INSERT エラー:', extLogErr)
  }

  console.log('📦 [SAVE] 完了サマリ:', JSON.stringify(results))
  return results
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
    else console.error('❌ 昼バッチ起動失敗:', response.status)
  } catch (e) {
    console.error('❌ バッチ起動エラー:', e)
  }
}

function buildSystemPrompt(
  owner: any,
  memory: string[],
  isHighRisk: boolean,
  afterEmpathy: boolean,
  crisisType: string | null,
  nonInterventionType: string | null,
  topicSwitched: boolean,
  executionResult: ExecutionResult | null,
  askingStrategy: AskingStrategy,
  isDebouncedUpdate: boolean,
  preLLMAnalysis: PreLLMAnalysis | null,
  modifyPending: any | null
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
■判断に使う情報
${memory.join('\n')}
`
      : ''

  const riskNote = isHighRisk
    ? `
■高リスク領域への注意
法律・医療・税務・投資・契約に関わる質問には断定を弱め、専門家確認を促すこと。
`
    : ''

  const afterEmpathyNote = afterEmpathy
    ? `
■重要: 直前ターンで感情応答をした。今すぐ通常モードに戻ること。
`
    : ''

  const confidenceNote = owner?.confidence < 0.4
    ? `
■学習中モード
断定の前に「まだ学習中ですが、」と短く添えること。
`
    : ''

  const topicSwitchNote = topicSwitched
    ? `
■トピック切替検出
直前の文脈を引きずらず、新しい話題として扱うこと。
`
    : ''

  const objectionNote = crisisType
    ? `
■★Objectionモード(${crisisType})★
共感禁止。肯定禁止。短く止める。mode="objection"。
`
    : ''

  const nonInterventionNote = nonInterventionType
    ? `
■★Non-Interventionモード(${nonInterventionType})★
1つに決めない。客観的事実を3つ提示。mode="non_intervention"。
`
    : ''

  const askingGuidance = (() => {
    switch (askingStrategy) {
      case 'silent':
        return `
■★原則12/13: 最小干渉・必要知★
ユーザーは十分な情報を提供した。追加質問は一切しない。
- 「誰と?」絶対禁止
- 「何の詳細?」禁止
- 応答は短く完結させる
`
      case 'optional_hint':
        return `
■★原則12/13: 軽い確認のみ★
情報はほぼ足りている。任意の追加があれば受け取る形で。
`
      case 'clarification':
        return `
■★必須情報の欠落(clarification)★
以下のどちらか、または両方を1回で聞く(複数往復しない):
- 時間が不明なら → 「何時?」
- タイトルが曖昧(打ち合わせ/会議/予定など単体)なら → 「何の打ち合わせ?」
- 両方足りないなら → 「何時の何の打ち合わせ?」を1回で聞く
- 「誰と?」は絶対に聞かない
- 内容の詳細は聞かない
`
      case 'disambiguation':
        return `
■★曖昧解消(disambiguation)★
同名の対象が複数ある場合のみ、選択肢を提示して聞く。
それ以外の追加質問は禁止。
`
    }
  })()

  const debounceNote = isDebouncedUpdate
    ? `
■★Debouncing: 連続変更★
直近60秒以内に同じ対象を変更した。報告は最小限に:
- 「更新した」とだけ短く
- hints / options は空にする
`
    : ''

  const preLLMConflictNote = preLLMAnalysis?.conflict_detection?.has_conflict
    ? (() => {
        const conflict = preLLMAnalysis.conflict_detection.existing_events[0]
        const existingDt = conflict.datetime ? new Date(conflict.datetime).toLocaleString('ja-JP', {
          month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
        }) : '時刻不明'
        const tentativeMark = conflict.is_tentative ? '【仮】' : ''
        return `
■★★★最重要:原則14 同期真実性(重複検知済み)★★★
Pre-LLM で既存予定との重複を検知した:
- 既存予定: ${tentativeMark}「${conflict.title}」(${existingDt})
- 今回の入力: 「${preLLMAnalysis.extracted_title || '予定'}」(${preLLMAnalysis.extracted_datetime ? new Date(preLLMAnalysis.extracted_datetime).toLocaleString('ja-JP') : '時刻不明'})
- 重複判定基準: ${preLLMAnalysis.conflict_detection.window_description}

【必須の応答ルール】
1. 「入れた」「追加した」「保存した」は絶対禁止。まだ確定してない。
2. reply には「${conflict.title}と同じ?別件?」と聞く
3. options には必ず ["同じ", "別件"] を入れる
4. mode は "execute"
5. save.calendar には予定タイトルを入れる(システムが pending_confirmation 経由で扱う)
6. save.people も該当者あれば入れる(系統的に処理される)

重要: あなたは「確認中」であって「確定」していない。
ユーザーが「同じ」または「別件」と答えて初めて確定する。
正直に「確認が必要」と伝えること。
`
      })()
    : ''

  const modifyPendingNote = modifyPending
    ? (() => {
        const ss = modifyPending.subject_snapshot || {}
        return `
■★Modify確認待機中★
直前に modify 確認を要求した:
- action: ${ss.action || '未定'} (${ss.action_jp || ''})
- 候補: ${(ss.rendered_titles || []).join(' / ')}

ユーザーの今回の入力はこれへの返答の可能性が高い。
ただしシステム側で pre-routing 済みなので、あなたは通常モードで応答してOK。
`
      })()
    : ''

  let executionNote = ''
  if (executionResult) {
    if (executionResult.status === 'executed') {
      const actionJpMap: Record<string, string> = {
        delete: '削除', complete: '完了', cancel: 'キャンセル',
        pause: '一時停止', update: '更新', restore: '復元',
      }
      const actionJp = actionJpMap[executionResult.action] || executionResult.action
      const aliasNote = executionResult.matched_alias 
        ? `\n- (alias一致: "${executionResult.matched_alias}")` 
        : ''
      executionNote = `
■★Modifyモード(成功)★
- アクション: ${executionResult.action} (${actionJp})
- 対象: "${executionResult.target_title}"${aliasNote}

出力方針:
- 「${executionResult.target_title}を${actionJp}した」と短く過去形で
${executionResult.action === 'delete' ? '- 削除なら「30日以内なら戻せる」と一言添える' : ''}
- mode="modify"
- saveは全てnull
`
    } else if (executionResult.status === 'needs_confirmation') {
      const actionJpMap: Record<string, string> = {
        delete: '削除', complete: '完了', cancel: 'キャンセル',
        pause: '一時停止', update: '更新', restore: '復元',
      }
      const actionJp = actionJpMap[executionResult.action] || executionResult.action
      const candidateList = executionResult.candidates
        .map((c, i) => `${i + 1}. ${c.title}`)
        .join(' / ')
      executionNote = `
■★★★Modifyモード(確認要請・原則14)★★★
- アクション希望: ${actionJp}
- 候補: ${candidateList}

【必須の応答ルール】
- 「${actionJp}した」「しました」は絶対禁止(まだ実行してない)
- 「どれを${actionJp}する?」と聞く
- options に候補タイトルを入れる
- または候補が1つなら ${actionJp === '削除' ? '["削除する", "やめる"]' : '["実行", "やめる"]'} を入れる
- mode="modify"
- saveはnull

正直に「まだ実行してない、確認が必要」と伝えること。
`
    } else if (executionResult.status === 'no_target_found') {
      const actionJpMap: Record<string, string> = {
        delete: '削除', complete: '完了', cancel: 'キャンセル',
        pause: '一時停止', update: '更新', restore: '復元',
      }
      const actionJp = actionJpMap[executionResult.action] || executionResult.action
      executionNote = `
■★Modifyモード(対象なし)★
- アクション希望: ${actionJp}
- 検索: ${executionResult.search_text || '(不明)'}

出力方針:
- 「${actionJp}した」は絶対禁止
- 「該当するのが見つからなかった」と正直に
- mode="modify"
- saveはnull
`
    } else if (executionResult.status === 'error') {
      executionNote = `
■★Modifyモード(エラー)★
- エラー: ${executionResult.error}

出力方針:
- 「した」は絶対禁止
- 「うまくいかなかった、もう一度試して」と正直に
- mode="modify"
`
    }
  }

  return `今日の日付は${todayStr}です。

あなたは社長専属の意思決定AI「NOIDA」です。
NOIDAはオーナーの分身として行動します。

${ownerSection}
${memorySection}
${riskNote}
${afterEmpathyNote}
${confidenceNote}
${topicSwitchNote}
${objectionNote}
${nonInterventionNote}
${executionNote}
${preLLMConflictNote}
${modifyPendingNote}
${askingGuidance}
${debounceNote}

■★原則14: 同期真実性(Synchronous Truth)★★★最重要★★★
NOIDA の発話は、その時点の DB 状態と一致していなければならない。
- DB が未更新なら「した」「入れた」「削除した」と過去形で言わない
- 「確認が必要」「どっち?」と正直に言う
- pending_confirmation がある時点では必ず確認モード
- 「後で確定する」は「入れた」ではない

この原則を破ると、ユーザーは NOIDA を信頼できなくなる。

■★原則11: 二層の正しさ(Dual Correctness)★
オーナーの生の言葉を書き換えない。
訂正版はあなたの理解のため、保存・応答はオーナーの言葉のまま。

■★原則12: 最小干渉(Minimal Intrusion)★
- 「誰と」は絶対に聞かない
- 時間か場所、片方あれば追加質問しない
- オーナーが書いてないことは書かなかった理由がある

■★原則13: 必要知(Necessary Knowledge)★
「もっと知る」を目的にしない。
- 予定保存に必要な情報は title + (time or location)
- それ以上は聞かない
- 知りすぎは不信の種

■絶対原則
・原則1つに決める
・短く断定(Non-Intervention時を除く)
・判断をユーザーに返さない(Non-Intervention時を除く)
・過去の失敗を繰り返さない
・記憶はマスタより直近の事実を優先

■モード判定

【Objection】破滅的判断検出時。共感禁止・短く止める。
【Non-Intervention】結婚・離婚・手術等。客観事実3つのみ。
【Modify】削除・完了・キャンセル・復元・更新。executionNoteに従う。
【Empathy】おはよう/ありがとう/疲れた等の感情。1-2文で温かく。
【Execute】行動リクエスト。結論を短く。
【Decide】意思決定。結論 + 理由1行 + 却下1行。
【Answer】知識・説明。端的に。
【Research】調査。知ってる範囲で。
【Explore】思考・アイデア。2-3案を最後1つに収束。

■★保存ルール★

【save.calendar】
- ユーザーが予定を言ったら必ず自然言語 title で埋める
- 複数の予定を同時に言われた場合は配列で返す:
  save.calendar: ["田中さんとの会議", "犬の散歩"]
- 単一なら文字列: save.calendar: "会議"

【save.task】
明確なタスク(やるべきこと)のみ。「〜しないと」「〜やらなきゃ」。

【save.memo】
「覚えて」「メモして」の時のみ。

【save.people】
オーナーが人物名を明示した時のみ保存する:
- 形式A(推奨): {"name": "田中さん", "note": "...", "company": "...", "phone": "090-...", "email": "..."}
- 形式B(単純): "田中さん"(名前のみ)

★重要:電話番号・住所・メールの保存について★
- オーナーが自発的に「田中さんの電話番号を覚えて、090-xxx」と言った時は phone に入れる
- オーナーが「田中さんの住所は〜」と言った時は address に入れる
- オーナーが与えた連絡先は分身AIとして保存すべき
- 原則13 の「聞かない」は NOIDA から聞かないという意味であって、
  与えられた情報の保存を拒否することではない

【save.business】
明確なビジネス案の時のみ。

【save.ideas】
明確なアイデアの時のみ。

■必ずJSON形式のみで返答
{
  "reply": "応答テキスト",
  "reason": "1行理由(省略可)",
  "hint": "一言進言(省略可)",
  "options": ["行動選択肢"],
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
    "decision_text": "結論(1文)",
    "context_summary": "短い要約"
  }
}`
}

// ============================================================
// ★ v2.0.0 POST関数(Conversation FSM 統合)
// ============================================================

export async function POST(req: NextRequest) {
  const requestStartTime = Date.now()
  const { messages } = await req.json()
  const rawUserMessage = messages[messages.length - 1]?.content || ''
  const sessionDate = getSessionDate()

  console.log('📥 [v2.0 REQUEST]', JSON.stringify({
    layerA_raw_message: rawUserMessage,
    raw_length: rawUserMessage.length,
    messages_count: messages.length,
    session_date: sessionDate,
  }))
  
  // 入力訂正(Layer B 生成)
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
      console.log('✏️ [二層の正しさ]', {
        layerA_original: correctionResult.original,
        layerB_corrected: correctionResult.corrected,
        corrections: correctionResult.corrections,
        validation_failed: correctionResult.validation_failed || false,
      })
      lastUserMessage = correctionResult.corrected
    } else {
      console.log('✏️ [二層の正しさ]', {
        layerA_original: rawUserMessage,
        layerB_corrected: '(差分なし)',
      })
    }
  } catch (e) {
    console.error('❌ [INPUT訂正] エラー、訂正せずに処理続行:', e)
  }

  // ============================================================
  // ★v2.0: Conversation FSM — clarification 文脈の復元
  // ============================================================
  let clarificationMergedFrom: string | null = null
  let activeConversationStateId: string | null = null
  const activeState = await fetchActiveConversationState(sessionDate)

  if (activeState && activeState.state === 'awaiting_clarification') {
    const partial = activeState.partial_data || {}
    const partialOriginal = partial.original_text || ''
    const target = activeState.clarification_target as 'title' | 'datetime' | 'both' | 'vague_answer_retry' | null

    const trimmed = lastUserMessage.trim()
    const isShortAnswer = trimmed.length < 15 && !/[。!?]/.test(trimmed)

    if (isShortAnswer && partialOriginal) {
      const { merged, is_vague_answer } = mergeClarificationContext(
        partialOriginal,
        trimmed,
        target
      )

      console.log('🔄 [v2.0 FSM] clarification merge:', {
        state_id: activeState.id,
        original: partialOriginal,
        answer: trimmed,
        target,
        merged,
        is_vague_answer,
      })

      if (is_vague_answer) {
        console.log('⚠️ [v2.0 FSM] 曖昧語回答を検出、再 clarification 発動')
        
        await resolveConversationState(activeState.id, 'resolved')

        const reply = `「${trimmed}」だけだと曖昧だから、もう少し具体的に教えて。(例: ${trimmed === '会議' ? '営業会議 / 定例' : trimmed + 'の内容'})`

        await supabase.from('talk_master').insert({
          role: 'user',
          content: rawUserMessage,
          content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
          intent: 'execute',
          importance: 'B',
          session_date: sessionDate,
        })
        await supabase.from('talk_master').insert({
          role: 'noida',
          content: reply,
          intent: 'execute',
          importance: 'B',
          session_date: sessionDate,
        })

        await createClarificationState(
          {
            original_text: partialOriginal,
            previous_vague_answer: trimmed,
            extracted_datetime: partial.extracted_datetime,
          },
          'vague_answer_retry',
          userTalkIdOrFallback(null),
          null
        )

        return NextResponse.json({
          content: [{
            type: 'text',
            text: JSON.stringify({
              reply,
              options: [],
              mode: 'execute',
              save: {},
              decision_log: {
                should_log: true,
                decision_text: `曖昧回答「${trimmed}」で再 clarification`,
              },
            }),
          }],
        })
      }

      lastUserMessage = merged
      clarificationMergedFrom = partialOriginal
      activeConversationStateId = activeState.id
    }
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

  // ============================================================
  // ★v1.9.0 核心: 承認返答の先行処理(pre-routing)
  // ============================================================
  const replyType = detectReplyType(lastUserMessage)

  const calendarConflict = await fetchLatestCalendarConflict()
  if (calendarConflict && (replyType === 'conflict_same' || replyType === 'conflict_different')) {
    const plan = calendarConflict.mutation_plan as any
    const { existing_id, new_event_data } = plan

    if (replyType === 'conflict_same') {
      await confirmTentativeCalendar(
        existing_id,
        new_event_data.title,
        new_event_data.person_name || null
      )

      await resolvePending(calendarConflict.id, 'confirmed')

      const replyTitle = new_event_data.title || '予定'
      const reply = `${replyTitle}として確定した。`

      await supabase.from('talk_master').insert({
        role: 'user',
        content: rawUserMessage,
        content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
        intent: 'modify',
        importance: 'B',
        session_date: sessionDate,
      })
      await supabase.from('talk_master').insert({
        role: 'noida',
        content: reply,
        intent: 'modify',
        importance: 'B',
        session_date: sessionDate,
      })

      return NextResponse.json({
        content: [{
          type: 'text',
          text: JSON.stringify({
            reply,
            options: [],
            mode: 'modify',
            save: {},
            decision_log: { should_log: true, decision_text: `予定「${replyTitle}」を確定した` },
          }),
        }],
      })
    }

    if (replyType === 'conflict_different') {
      // ★v1.9.0.1 Bug G 止血: 曖昧題目なら INSERT せず clarification に戻す
      const newTitleForCheck = String(new_event_data.title || '').trim()
      if (VAGUE_TOPICS.test(newTitleForCheck)) {
        await resolvePending(calendarConflict.id, 'cancelled')

        const dtHint = new_event_data.datetime
          ? new Date(new_event_data.datetime).toLocaleString('ja-JP', {
              month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })
          : null
        const reply = dtHint
          ? `${dtHint}の何の${newTitleForCheck}?`
          : `何の${newTitleForCheck}?`

        await supabase.from('talk_master').insert({
          role: 'user',
          content: rawUserMessage,
          content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
          intent: 'execute',
          importance: 'B',
          session_date: sessionDate,
        })
        await supabase.from('talk_master').insert({
          role: 'noida',
          content: reply,
          intent: 'execute',
          importance: 'B',
          session_date: sessionDate,
        })

        return NextResponse.json({
          content: [{
            type: 'text',
            text: JSON.stringify({
              reply,
              options: [],
              mode: 'execute',
              save: {},
              decision_log: {
                should_log: true,
                decision_text: `別件選択だが題目「${newTitleForCheck}」が曖昧なため clarification に戻した`,
              },
            }),
          }],
        })
      }

      const insertData: any = {
        title: new_event_data.title,
        datetime: new_event_data.datetime,
        state: 'scheduled',
        is_tentative: new_event_data.is_tentative,
        event_signals: new_event_data.signals || null,
        inferred_category: new_event_data.inferred_category || null,
        aliases: [],
        is_user_confirmed: true,
        confidence: 0.9,
      }
      if (new_event_data.person_id) {
        insertData.person_id = new_event_data.person_id
      }
      
      const { error: insErr } = await supabase
        .from('calendar')
        .insert(insertData)
      if (insErr) console.error('❌ calendar INSERT(別件)エラー:', insErr)

      await resolvePending(calendarConflict.id, 'confirmed')

      const tentativeLabel = new_event_data.is_tentative ? '【仮】' : ''
      const reply = `別件として${tentativeLabel}${new_event_data.title}を追加した。`

      await supabase.from('talk_master').insert({
        role: 'user',
        content: rawUserMessage,
        content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
        intent: 'execute',
        importance: 'B',
        session_date: sessionDate,
      })
      await supabase.from('talk_master').insert({
        role: 'noida',
        content: reply,
        intent: 'execute',
        importance: 'B',
        session_date: sessionDate,
      })

      return NextResponse.json({
        content: [{
          type: 'text',
          text: JSON.stringify({
            reply,
            options: [],
            mode: 'execute',
            save: {},
            decision_log: { should_log: true, decision_text: '別予定として追加した' },
          }),
        }],
      })
    }
  }

  const modifyPending = await fetchLatestModifyPending()
  // ★v2.0.2 Bug J 修正: 候補が複数ある時は候補選択 replyType も処理する
  if (modifyPending) {
    const ss = modifyPending.subject_snapshot || {}
    const candidateCount = ss.candidate_ids?.length || 0
    
    // === 候補選択パターン(複数候補から1つ選ぶ)===
    if (candidateCount >= 2) {
      const candidates = (ss.candidate_ids || []).map((id: string, idx: number) => ({
        id,
        title: ss.rendered_titles?.[idx] || '(タイトル不明)',
      }))
      
      // 時刻ベース選択 or 番号選択
      let selectedIdx = matchCandidateByTime(lastUserMessage, candidates)
      if (selectedIdx === -1) {
        selectedIdx = matchCandidateByNumber(lastUserMessage, candidateCount)
      }
      
      if (selectedIdx >= 0) {
        const plan = modifyPending.mutation_plan as MutationPlan
        const chosenId = candidates[selectedIdx].id
        const chosenTitle = candidates[selectedIdx].title
        
        const executedPlan: MutationPlan = {
          ...plan,
          target_id: chosenId,
          target_title: chosenTitle,
          mutation_mode: 'confirmed',
          requires_confirmation: false,
        }
        const result = await executeMutationPlan(executedPlan, `modify_select_${modifyPending.id}`, ss.user_text || '')
        await resolvePending(modifyPending.id, 'confirmed')
        
        const actionJp = ss.action_jp || plan.action
        let reply: string
        if (result.status === 'executed') {
          reply = `${chosenTitle}を${actionJp}した。`
          if (plan.action === 'delete') reply += '(30日以内なら戻せる)'
        } else {
          reply = `${actionJp}できなかった、もう一度試して。`
        }
        
        await supabase.from('talk_master').insert({
          role: 'user',
          content: rawUserMessage,
          content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
          intent: 'modify',
          importance: 'B',
          session_date: sessionDate,
        })
        await supabase.from('talk_master').insert({
          role: 'noida',
          content: reply,
          intent: 'modify',
          importance: 'B',
          session_date: sessionDate,
        })
        
        console.log('✅ [v2.0.2 CANDIDATE SELECT]', {
          pending_id: modifyPending.id,
          selected_idx: selectedIdx,
          chosen_id: chosenId,
          chosen_title: chosenTitle,
          status: result.status,
        })
        
        return NextResponse.json({
          content: [{
            type: 'text',
            text: JSON.stringify({
              reply,
              options: [],
              mode: 'modify',
              save: {},
              decision_log: { should_log: true, decision_text: reply },
            }),
          }],
        })
      }
      
      // modify_reject は複数候補でも有効
      if (replyType === 'modify_reject') {
        await resolvePending(modifyPending.id, 'cancelled')
        const reply = 'わかった、やめとく。'
        await supabase.from('talk_master').insert({
          role: 'user', content: rawUserMessage,
          content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
          intent: 'modify', importance: 'C', session_date: sessionDate,
        })
        await supabase.from('talk_master').insert({
          role: 'noida', content: reply,
          intent: 'modify', importance: 'C', session_date: sessionDate,
        })
        return NextResponse.json({
          content: [{
            type: 'text',
            text: JSON.stringify({
              reply, options: [], mode: 'modify', save: {},
              decision_log: { should_log: false },
            }),
          }],
        })
      }
      
      // ★v2.0.2 Bug K 修正: 候補選択できない返答は候補の再提示
      //   ここで return しないと通常フローに流れて conflict 誤突入する
      const reply = `${ss.action_jp || '変更'}する予定を選んで:\n${candidates.map((c: any, i: number) => `${i + 1}. ${c.title}`).join('\n')}`
      const optionList = candidates.map((c: any) => c.title)
      
      await supabase.from('talk_master').insert({
        role: 'user', content: rawUserMessage,
        content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
        intent: 'modify', importance: 'B', session_date: sessionDate,
      })
      await supabase.from('talk_master').insert({
        role: 'noida', content: reply,
        intent: 'modify', importance: 'B', session_date: sessionDate,
      })
      
      console.log('🔁 [v2.0.2] 候補選択再プロンプト:', { candidates: candidates.length })
      
      return NextResponse.json({
        content: [{
          type: 'text',
          text: JSON.stringify({
            reply, options: optionList, mode: 'modify', save: {},
            decision_log: { should_log: false },
          }),
        }],
      })
    }
    
    // === 従来の approve/reject(候補1つの時)===
    if (replyType === 'modify_approve') {
      const plan = modifyPending.mutation_plan as MutationPlan
      if (candidateCount === 1) {
        const executedPlan: MutationPlan = {
          ...plan,
          target_id: ss.candidate_ids[0],
          target_title: ss.rendered_titles?.[0] || plan.target_title,
          mutation_mode: 'confirmed',
          requires_confirmation: false,
        }
        const result = await executeMutationPlan(executedPlan, `modify_approve_${modifyPending.id}`, ss.user_text || '')
        await resolvePending(modifyPending.id, 'confirmed')

        const actionJp = ss.action_jp || plan.action
        const targetTitle = ss.rendered_titles?.[0] || plan.target_title || '対象'
        let reply: string
        if (result.status === 'executed') {
          reply = `${targetTitle}を${actionJp}した。`
          if (plan.action === 'delete') reply += '(30日以内なら戻せる)'
        } else {
          reply = `${actionJp}できなかった、もう一度試して。`
        }

        await supabase.from('talk_master').insert({
          role: 'user',
          content: rawUserMessage,
          content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
          intent: 'modify',
          importance: 'B',
          session_date: sessionDate,
        })
        await supabase.from('talk_master').insert({
          role: 'noida',
          content: reply,
          intent: 'modify',
          importance: 'B',
          session_date: sessionDate,
        })

        return NextResponse.json({
          content: [{
            type: 'text',
            text: JSON.stringify({
              reply,
              options: [],
              mode: 'modify',
              save: {},
              decision_log: { should_log: true, decision_text: reply },
            }),
          }],
        })
      }
    }

    if (replyType === 'modify_reject') {
      await resolvePending(modifyPending.id, 'cancelled')
      const reply = 'わかった、やめとく。'

      await supabase.from('talk_master').insert({
        role: 'user',
        content: rawUserMessage,
        content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
        intent: 'modify',
        importance: 'C',
        session_date: sessionDate,
      })
      await supabase.from('talk_master').insert({
        role: 'noida',
        content: reply,
        intent: 'modify',
        importance: 'C',
        session_date: sessionDate,
      })

      return NextResponse.json({
        content: [{
          type: 'text',
          text: JSON.stringify({
            reply,
            options: [],
            mode: 'modify',
            save: {},
            decision_log: { should_log: false },
          }),
        }],
      })
    }
  }

  // ============================================================
  // ★v2.0.4: Undo pre-routing(「戻して」「undo」等の短い発話)
  // ============================================================
  // 短い restore 発話は trash_queue から直近を自動復元
  // 対象特定は /api/noida/undo endpoint に委譲
  const isUndoShortPhrase = /^(戻して|元に戻して|undo|Undo|UNDO|やっぱ戻して|復元|やり直し)[!!。\.]*$/.test(lastUserMessage.trim())
  if (isUndoShortPhrase) {
    console.log('🔄 [v2.0.4] undo 短い発話を検出、直近復元を実行')
    try {
      // 直近の trash_queue レコードを自前で取る(内部関数呼び出し)
      // ★v2.0.5: 実カラム名 deleted_at で並べ、restored=false のみ取得
      const { data: latestTrash, error: trashErr } = await supabase
        .from('trash_queue')
        .select('*')
        .eq('restored', false)
        .order('deleted_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      
      if (trashErr || !latestTrash) {
        const reply = '直近に削除したものがないよ。'
        await supabase.from('talk_master').insert({
          role: 'user', content: rawUserMessage,
          content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
          intent: 'modify', importance: 'C', session_date: sessionDate,
        })
        await supabase.from('talk_master').insert({
          role: 'noida', content: reply,
          intent: 'modify', importance: 'C', session_date: sessionDate,
        })
        return NextResponse.json({
          content: [{
            type: 'text',
            text: JSON.stringify({
              reply, options: [], mode: 'modify', save: {},
              decision_log: { should_log: false },
            }),
          }],
        })
      }
      
      const { source_table, source_id, original_data } = latestTrash
      let restoredTitle = ''
      let restoreOk = false
      
      if (source_table === 'memo' || source_table === 'ideas') {
        const { id, created_at, updated_at, ...rest } = original_data
        const { error } = await supabase
          .from(source_table)
          .insert({ ...rest, id: source_id })
        if (!error) {
          restoredTitle = original_data?.content?.substring(0, 50) || '(復元)'
          restoreOk = true
        } else {
          console.error(`❌ [v2.0.4 UNDO] ${source_table} INSERT エラー:`, error)
        }
      } else if (source_table === 'task' || source_table === 'calendar') {
        const updates: any = {
          deleted_at: null,
          updated_at: new Date().toISOString(),
        }
        if (source_table === 'task') {
          updates.state = 'active'
          updates.done = false
          updates.completed_at = null
          updates.cancelled_at = null
        } else {
          updates.state = 'scheduled'
          updates.cancelled_at = null
        }
        const { error } = await supabase
          .from(source_table)
          .update(updates)
          .eq('id', source_id)
        if (!error) {
          restoredTitle = 
            original_data?.title?.substring(0, 50) ||
            original_data?.content?.substring(0, 50) ||
            '(復元)'
          restoreOk = true
        } else {
          console.error(`❌ [v2.0.4 UNDO] ${source_table} UPDATE エラー:`, error)
        }
      }
      
      if (restoreOk) {
        // ★v2.0.5: trash_queue は物理削除じゃなく restored=true で履歴保持
        await supabase
          .from('trash_queue')
          .update({ restored: true, restored_at: new Date().toISOString() })
          .eq('id', latestTrash.id)
        // mutation_event_log
        await supabase.from('mutation_event_log').insert({
          user_message_id: userTalkIdOrFallback(null),
          event_type: 'restore',
          source_table,
          source_id,
          before_data: null,
          after_data: original_data,
          mutation_plan: { action: 'restore', source: 'chat_undo_pre_routing' },
          resolver_strategy: 'user_confirmed',
          confidence: 1.0,
          executed_by: 'noida',
          mutation_mode: 'confirmed',
          idempotency_key: `undo_${latestTrash.id}_${Date.now()}`,
        })
        
        const reply = `「${restoredTitle}」を戻した。`
        await supabase.from('talk_master').insert({
          role: 'user', content: rawUserMessage,
          content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
          intent: 'modify', importance: 'B', session_date: sessionDate,
        })
        await supabase.from('talk_master').insert({
          role: 'noida', content: reply,
          intent: 'modify', importance: 'B', session_date: sessionDate,
        })
        
        console.log('✅ [v2.0.4 UNDO] 復元成功:', { source_table, source_id, restoredTitle })
        
        return NextResponse.json({
          content: [{
            type: 'text',
            text: JSON.stringify({
              reply, options: [], mode: 'modify', save: {},
              decision_log: { should_log: true, decision_text: reply },
            }),
          }],
        })
      } else {
        const reply = '復元できなかった、もう一度試して。'
        await supabase.from('talk_master').insert({
          role: 'user', content: rawUserMessage,
          content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
          intent: 'modify', importance: 'B', session_date: sessionDate,
        })
        await supabase.from('talk_master').insert({
          role: 'noida', content: reply,
          intent: 'modify', importance: 'B', session_date: sessionDate,
        })
        return NextResponse.json({
          content: [{
            type: 'text',
            text: JSON.stringify({
              reply, options: [], mode: 'modify', save: {},
              decision_log: { should_log: false },
            }),
          }],
        })
      }
    } catch (e: any) {
      console.error('❌ [v2.0.4 UNDO] 例外:', e)
    }
  }

  // ============================================================
  // 通常フロー
  // ============================================================
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

  const ackType = detectAcknowledgment(lastUserMessage)
  if (ackType) {
    console.log('✅ [ACK発火]', ackType)

    const { data: pendingTasks, error: ptErr } = await supabase
      .from('task')
      .select('content')
      .eq('done', false)
      .is('deleted_at', null)
      .neq('state', 'completed')
      .neq('state', 'cancelled')
      .order('created_at', { ascending: true })
      .limit(1)
    if (ptErr) console.error('❌ ACK用task取得エラー:', ptErr)

    const nowISO = new Date().toISOString()
    const { data: upcomingEvents, error: ueErr } = await supabase
      .from('calendar')
      .select('title, datetime, is_tentative')
      .is('deleted_at', null)
      .neq('state', 'cancelled')
      .gte('datetime', nowISO)
      .order('datetime', { ascending: true })
      .limit(1)
    if (ueErr) console.error('❌ ACK用calendar取得エラー:', ueErr)

    const prefixMap: Record<string, string[]> = {
      gratitude: ['どういたしまして。', 'お役に立てて何より。'],
      acknowledgment: [''],
      nod: [''],
    }
    const prefixes = prefixMap[ackType]
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)]

    let coreMsg: string
    if (pendingTasks?.length) {
      coreMsg = `次「${pendingTasks[0].content}」やろう。`
    } else if (upcomingEvents?.length) {
      const ev = upcomingEvents[0]
      const dt = new Date(ev.datetime)
      const today = new Date()
      const isToday = dt.toDateString() === today.toDateString()
      const timeStr = dt.toLocaleTimeString('ja-JP', {
        hour: '2-digit', minute: '2-digit', hour12: false,
      })
      const dateStr = isToday
        ? `今日${timeStr}`
        : `${dt.getMonth() + 1}月${dt.getDate()}日${timeStr}`
      const tentativeLabel = ev.is_tentative ? '【仮】' : ''
      coreMsg = `${dateStr}に${tentativeLabel}「${ev.title}」があるよ。`
    } else {
      coreMsg = '他に何かある?'
    }

    const reply = prefix + coreMsg

    await supabase.from('talk_master').insert({
      role: 'user',
      content: rawUserMessage,
      content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
      intent: 'empathy',
      importance: 'C',
      session_date: sessionDate,
    })
    await supabase.from('talk_master').insert({
      role: 'noida',
      content: reply,
      intent: 'empathy',
      importance: 'C',
      session_date: sessionDate,
    })

    return NextResponse.json({
      content: [{
        type: 'text',
        text: JSON.stringify({
          reply,
          options: [],
          mode: 'empathy',
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

  const preLLMAnalysis = await performPreLLMAnalysis(lastUserMessage, intent)
  
  const askingStrategy = decideAskingStrategy(
    preLLMAnalysis.signals, 
    preLLMAnalysis.signals.has_explicit_time,
    preLLMAnalysis.has_explicit_title,
    preLLMAnalysis.has_vague_topic
  )

  console.log('🎯 [CLASSIFY]', {
    router_intent: intent,
    crisis: crisisType,
    non_intervention: nonInterventionType,
    topic_switched: topicSwitched,
    after_empathy: afterEmpathy,
    signals: preLLMAnalysis.signals,
    inferred_category: preLLMAnalysis.inferred_category,
    asking_strategy: askingStrategy,
    has_explicit_title: preLLMAnalysis.has_explicit_title,
    has_vague_topic: preLLMAnalysis.has_vague_topic,
    is_calendar_add: preLLMAnalysis.is_calendar_add,
    conflict_detected: preLLMAnalysis.conflict_detection.has_conflict,
    keywords,
    clarification_merged_from: clarificationMergedFrom,
  })

  const { data: userTalkRecord, error: utErr } = await supabase
    .from('talk_master')
    .insert({
      role: 'user',
      content: rawUserMessage,
      content_parsed: lastUserMessage !== rawUserMessage ? lastUserMessage : null,
      intent: intent,
      importance: intent === 'objection' ? 'A' : 'B',
      session_date: sessionDate,
    })
    .select('id')
    .single()
  if (utErr) console.error('❌ talk_master(user) INSERT エラー:', utErr)

  const userMessageId = userTalkRecord?.id || `msg_${Date.now()}`

  let executionResult: ExecutionResult = { status: 'not_applicable' }
  let isDebouncedUpdate = false
  const modifyAction = detectModifyAction(lastUserMessage)

  if (intent === 'modify' && modifyAction && !crisisType && !nonInterventionType) {
    const plan = await generateMutationPlan(lastUserMessage, modifyAction, userMessageId)
    if (plan) {
      if (plan.requires_confirmation) {
        await createModifyPending(plan, userMessageId, lastUserMessage)
      }
      executionResult = await executeMutationPlan(plan, userMessageId, lastUserMessage)
      
      if (executionResult.status === 'executed' && executionResult.target_id) {
        isDebouncedUpdate = shouldDebounceReport(
          executionResult.target_id,
          plan.target_table
        )
        if (isDebouncedUpdate) {
          console.log('🔕 [DEBOUNCE] 60秒以内の連続更新、応答を最小化')
        }
      }
    }
  }

  const selectedModel = selectModel(intent, crisisType, nonInterventionType, isHighRisk)
  console.log('🤖 [MODEL]', {
    model: selectedModel,
    intent,
    reason: crisisType || nonInterventionType || (isHighRisk ? 'high_risk' : intent),
  })

  const systemPrompt = buildSystemPrompt(
    owner,
    memory,
    isHighRisk,
    afterEmpathy,
    crisisType,
    nonInterventionType,
    topicSwitched,
    executionResult.status === 'not_applicable' ? null : executionResult,
    askingStrategy,
    isDebouncedUpdate,
    preLLMAnalysis,
    modifyPending
  )

  const cleanMessages = messages
    .map((m: any) => ({
      role: m.role === 'noida' ? 'assistant' : m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }))
    .slice(-10)

  const temperature = selectedModel === 'gpt-4o' ? 0.1 : 0.2
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: selectedModel,
      temperature,
      max_tokens: 1000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: systemPrompt }, ...cleanMessages],
    }),
  })

  const data = await res.json()
  const text = data.choices?.[0]?.message?.content ?? ''

  console.log('🔍 [LLM RAW]', JSON.stringify({
    model: selectedModel,
    text_length: text.length,
    text_preview: text.substring(0, 400),
  }))

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
  } catch (e) {
    console.error('❌ JSON parse失敗(1回目):', { error: String(e), text_preview: text.substring(0, 300) })

    console.log('🔄 JSON リトライ')
    try {
      const retryRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: selectedModel,
          temperature: 0.1,
          max_tokens: 1000,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            ...cleanMessages,
            { role: 'assistant', content: text },
            {
              role: 'user',
              content: '上記をJSON形式(reply/mode/save/decision_log を含む)で再出力してください。JSON以外の文字は不要です。',
            },
          ],
        }),
      })
      const retryData = await retryRes.json()
      const retryText = retryData.choices?.[0]?.message?.content ?? ''

      const retryJsonStr = retryText.substring(retryText.indexOf('{'), retryText.lastIndexOf('}') + 1)
      parsed = JSON.parse(retryJsonStr)
      console.log('✅ リトライ成功')
    } catch (retryErr) {
      console.error('❌ リトライも失敗:', retryErr)
      parsed = {
        reply: text,
        mode: intent,
        save: {},
        options: [],
        decision_log: { should_log: false },
      }
    }
  }

  if (preLLMAnalysis.conflict_detection.has_conflict && (!parsed.options || parsed.options.length === 0)) {
    parsed.options = ['同じ', '別件']
  }

  // ============================================================
  // ★v2.0.1 Bug I 修正: clarification 時のコード側強制ガード
  // ============================================================
  // LLM が clarification 指示を無視して「入れた」と過去形応答 + save 埋めてくる
  // コード側で強制的に save を null 化、reply も書き換えることで原則14 を守る
  const isClarificationMode = 
    askingStrategy === 'clarification' &&
    preLLMAnalysis.is_calendar_add &&
    !preLLMAnalysis.conflict_detection.has_conflict &&
    !clarificationMergedFrom

  if (isClarificationMode) {
    console.log('🛡️ [v2.0.1 GUARD] clarification mode — LLM save を強制 null 化', {
      original_save_calendar: parsed.save?.calendar,
      original_reply: (parsed.reply || '').substring(0, 50),
    })
    // save を全て null に(LLM の INSERT 暴走を止める)
    parsed.save = {
      memo: null,
      calendar: null,
      task: null,
      people: null,
      business: null,
      ideas: null,
    }
    // reply を書き換え(原則14:DB と発話の一致)
    const missingTitle = !preLLMAnalysis.has_explicit_title || preLLMAnalysis.has_vague_topic
    const missingTime = !preLLMAnalysis.signals.has_explicit_time
    if (missingTitle && missingTime) {
      parsed.reply = '何時の何の予定?'
    } else if (missingTitle) {
      // 時刻は分かってる、題目だけ欠けてる
      const dtStr = preLLMAnalysis.extracted_datetime 
        ? new Date(preLLMAnalysis.extracted_datetime).toLocaleString('ja-JP', {
            month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
          })
        : null
      parsed.reply = dtStr ? `${dtStr}の何の予定?` : '何の予定?'
    } else if (missingTime) {
      parsed.reply = '何時?'
    }
    parsed.mode = 'execute'
    parsed.options = []
  }

  // ============================================================
  // ★v2.0.2 Bug L 修正: modify needs_confirmation 時の強制ガード
  // ============================================================
  // resolveReference が複数候補 or 低 confidence で needs_confirmation を返した時、
  // LLM が「削除した」と嘘応答する事故を防ぐ。コード側で強制書き換え。
  if (executionResult.status === 'needs_confirmation') {
    const actionJpMap: Record<string, string> = {
      delete: '削除', complete: '完了', cancel: 'キャンセル',
      pause: '一時停止', update: '更新', restore: '復元',
    }
    const actionJp = actionJpMap[executionResult.action] || executionResult.action
    const candidates = executionResult.candidates
    
    console.log('🛡️ [v2.0.2 GUARD] modify needs_confirmation — LLM 応答を強制書き換え', {
      action: executionResult.action,
      candidate_count: candidates.length,
      original_reply: (parsed.reply || '').substring(0, 50),
    })
    
    if (candidates.length === 0) {
      parsed.reply = `該当が見つからなかった、もう一度内容を教えて。`
      parsed.options = []
    } else if (candidates.length === 1) {
      parsed.reply = `「${candidates[0].title}」を${actionJp}する?`
      parsed.options = [actionJp === '削除' ? '削除する' : '実行', 'やめる']
    } else {
      const listStr = candidates.map((c, i) => `${i + 1}. ${c.title}`).join('\n')
      parsed.reply = `${actionJp}するのはどれ?\n${listStr}`
      parsed.options = candidates.map(c => c.title)
    }
    parsed.save = {
      memo: null, calendar: null, task: null,
      people: null, business: null, ideas: null,
    }
    parsed.mode = 'modify'
  }

  // ★v2.0 FSM: clarification 応答時に conversation_state 作成
  const shouldCreateClarificationState =
    askingStrategy === 'clarification' &&
    preLLMAnalysis.is_calendar_add &&
    !preLLMAnalysis.conflict_detection.has_conflict &&
    !clarificationMergedFrom

  if (shouldCreateClarificationState) {
    const missingFields: string[] = []
    if (!preLLMAnalysis.has_explicit_title || preLLMAnalysis.has_vague_topic) missingFields.push('title')
    if (!preLLMAnalysis.signals.has_explicit_time) missingFields.push('datetime')
    const target: 'title' | 'datetime' | 'both' = 
      missingFields.length === 2 ? 'both' : (missingFields[0] as 'title' | 'datetime')

    await createClarificationState(
      {
        original_text: lastUserMessage,
        extracted_datetime: preLLMAnalysis.extracted_datetime,
        extracted_title: preLLMAnalysis.extracted_title,
        signals: preLLMAnalysis.signals,
        inferred_category: preLLMAnalysis.inferred_category,
      },
      target,
      userMessageId,
      null
    )
  }

  // merge 完了時は元 state を resolve
  if (activeConversationStateId) {
    await resolveConversationState(activeConversationStateId, 'resolved')
  }

  console.log('📦 [PARSED]', JSON.stringify({
    mode: parsed.mode,
    reply_preview: (parsed.reply || '').substring(0, 100),
    save_keys_present: parsed.save ? Object.keys(parsed.save) : [],
    save_calendar: parsed.save?.calendar,
    save_task: parsed.save?.task,
    save_people: parsed.save?.people,
    options: parsed.options,
  }))

  if (owner?.confidence < 0.4 && parsed.reply && !parsed.reply.startsWith('まだ学習中')) {
    parsed.reply = 'まだ学習中ですが、' + parsed.reply
  }

  let finalIntent = (parsed.mode || intent) as Intent
  if (crisisType) finalIntent = 'objection'
  if (nonInterventionType && !crisisType) finalIntent = 'non_intervention'
  if (modifyAction && !crisisType && !nonInterventionType) finalIntent = 'modify'

  let saveResults: SaveEntityResult[] = []
  if (finalIntent !== 'modify') {
    saveResults = await saveStructuredMemory(parsed.save, lastUserMessage, userMessageId, preLLMAnalysis)
  }
  await saveDecision(lastUserMessage, finalIntent, parsed, owner)

  const { error: noTalkErr } = await supabase.from('talk_master').insert({
    role: 'noida',
    content: parsed.reply || '',
    intent: finalIntent,
    importance:
      finalIntent === 'empathy' || finalIntent === 'objection' ? 'A' : 'B',
    session_date: sessionDate,
  })
  if (noTalkErr) console.error('❌ talk_master(noida) INSERT エラー:', noTalkErr)

  const elapsedMs = Date.now() - requestStartTime
  const wasCorrected = lastUserMessage !== rawUserMessage
  console.log('🏁 [v2.0 DONE]', JSON.stringify({
    elapsed_ms: elapsedMs,
    final_intent: finalIntent,
    model_used: selectedModel,
    execution_status: executionResult.status,
    save_results_count: saveResults.length,
    save_successes: saveResults.filter(r => r.success).length,
    save_failures: saveResults.filter(r => !r.success).length,
    layer_a_preserved: true,
    layer_b_used_for_understanding: wasCorrected,
    asking_strategy: askingStrategy,
    debounced: isDebouncedUpdate,
    pre_llm_conflict_detected: preLLMAnalysis.conflict_detection.has_conflict,
    fsm_merged: !!clarificationMergedFrom,
  }))

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
        save_result: saveResults,
        mutation:
          executionResult.status !== 'not_applicable'
            ? {
                status: executionResult.status,
                action: 'action' in executionResult ? executionResult.action : null,
                target_title:
                  executionResult.status === 'executed'
                    ? executionResult.target_title
                    : null,
                matched_alias:
                  executionResult.status === 'executed'
                    ? executionResult.matched_alias
                    : null,
                executed: executionResult.status === 'executed',
              }
            : null,
      }),
    }],
  })
}