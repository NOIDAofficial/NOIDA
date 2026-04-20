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
 * NOIDA route.ts v1.8.0 (Phase 1 Day 7 - 原則11/12/13 完全実装)
 *
 * ============================================================
 * v1.8.0 の追加内容(v1.7.4 からの差分)
 * ============================================================
 *
 * 【3つの原則の同時確立】
 * 
 * 原則11: 二層の正しさ(Dual Correctness)— v1.7.4 から継承
 *   Layer A (生) / Layer B (訂正版) の明確な分離
 *   
 * 原則12: 最小干渉(Minimal Intrusion)— NEW
 *   Takuma:「誰とは聞かなくていい」「時間か場所のどっちかは聞いた方がいい」
 *   NOIDA が聞くべきことは機能として必須な情報のみ。
 *   - 「誰と」は絶対に聞かない
 *   - 時間 or 場所のどちらか1つあれば OK
 *   - それ以外は沈黙 or 任意確認
 *   
 * 原則13: 必要知(Necessary Knowledge)— NEW
 *   Takuma:「予定として保存して欲しいだけなのに
 *            深く聞きすぎるとなんか怪しく感じるでしょ」
 *   NOIDA は「もっと知る」を目的にしない。
 *   - センシティブ領域(医療・個人相談)では聞かない
 *   - 「聞きすぎ」は親切ではなく不信の種
 *
 * 【実装機能】
 * 1. Signal-based Event Classification(カテゴリ廃止、シグナル+推論に)
 * 2. Minimal Intrusion(missing_fields の全廃、AskingStrategy 導入)
 * 3. Tentative vs Confirmed の明示判定
 * 4. プライバシーセンシティブ検出
 * 5. 「聞かないで」の学習機構
 * 6. Debouncing(連続変更の応答集約、60秒窓)
 * 7. Dual-Field Architecture(aliases 保存・検索への統合)
 * 8. Model Router(gpt-4o-mini / gpt-4o 使い分け)
 * 9. recordReferringExpression 統合(呼称自動学習)
 * 10. Person Mention Frequency(頻度ベースの曖昧解消)
 * 
 * 【既知バグ修正】
 * Bug 1: 削除後「消してくれた?」→「消してない」矛盾 → resolveReference で deleted_at 考慮
 * Bug 2: 複数予定の一括保存 → save.calendar の配列対応
 * Bug 3: 「了解」オウム返し → 次行動誘導の強化
 * Bug 4: 「なくなった」→ cancel 判定(delete じゃない)
 *
 * ============================================================
 * 既存の設計原則(継承)
 * ============================================================
 * 原則1: DB真実(Database Truth)
 * 原則2: Execute-First Design
 * 原則3: Fail-Safe(安全優先)
 * 原則4: 全シグナル活用
 * 原則5: 誤字許容 × 学習
 * 原則10: シリコンバレー大手クオリティ
 * 原則11: 二層の正しさ(Dual Correctness)
 * 原則12: 最小干渉(Minimal Intrusion)— NEW
 * 原則13: 必要知(Necessary Knowledge)— NEW
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
    | 'aliases_match'  // ★v1.8.0
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
      matched_alias?: string  // ★v1.8.0: どの呼び方でマッチしたか
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

// ★v1.8.0: Event Signals(シグナル集合 - Takuma 指摘で細分化)
type EventSignals = {
  has_explicit_person: boolean      // 「田中さん」「友達」「家族」明示
  has_explicit_location: boolean    // 「美容院で」「渋谷で」明示
  has_explicit_time: boolean        // 時刻明示
  has_business_context: boolean     // 「会議」「商談」「打ち合わせ」
  has_solo_context: boolean         // 「散歩」「筋トレ」「1人で」
  has_family_context: boolean       // 「家族」「妻」「子供」
  has_appointment_context: boolean  // 「病院」「美容院」「車検」
  is_sensitive: boolean             // 「診察」「カウンセリング」「個人的」
  has_explicit_tentative: boolean   // 「仮で」「一旦」「暫定」
}

type EventCategory = 
  | 'meeting' 
  | 'solo_activity' 
  | 'appointment' 
  | 'deadline' 
  | 'family' 
  | 'sensitive'
  | 'unknown'

// ★v1.8.0: Asking Strategy
type AskingStrategy =
  | 'silent'         // 何も聞かない(情報十分 or センシティブ)
  | 'optional_hint'  // 「他にあれば教えてね」程度(スルー可)
  | 'clarification'  // 必須情報の欠落(時間も場所もない)
  | 'disambiguation' // 曖昧解消(同名者複数)

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

// ★v1.8.0 Bug 4 修正: 「なくなった」を cancel 側に移動(delete ではない)
const MODIFY_PATTERNS = {
  restore: /(戻して|復活|やっぱり必要|やり直し|元に戻)/,
  complete: /(終わった|完了|できた|やった|済んだ|終了|済み|終了した)/,
  cancel: /(中止|キャンセル|やめた|中止になった|とりやめ|取りやめ|なくなった|無くなった)/,  // ★v1.8.0 Bug 4
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

const VAGUE_TOPICS = /^(会議|ミーティング|打ち合わせ|MTG|mtg|アポ|予定|meeting|Meeting)$/

const CONFLICT_SAME_PATTERNS = /^(同じ|それ|同じの|同じだ|同じです|それです|それね|一緒)/
const CONFLICT_DIFFERENT_PATTERNS = /^(違う|別|違います|別件|別のやつ|違うやつ|別物|違います)/

const TARGET_TABLE_KEYWORDS = {
  memo: /(メモ|覚え書き|記録|ノート)/,
  task: /(タスク|仕事|作業|やること|TODO|todo)/,
  calendar: /(予定|会議|ミーティング|アポ|約束|スケジュール|散歩|筋トレ|ジム|散髪|美容院|病院)/,
  ideas: /(アイデア|企画|構想)/,
}

// ★v1.8.0: シグナル抽出のためのパターン
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
// ★v1.8.0: Event Signals 抽出
// ============================================================

function extractEventSignals(text: string): EventSignals {
  return {
    has_explicit_person: SIGNAL_PATTERNS.explicit_person.test(text),
    has_explicit_location: SIGNAL_PATTERNS.explicit_location.test(text),
    has_explicit_time: false, // 後でdatetime 抽出結果と組み合わせる
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

// ============================================================
// ★v1.8.0: Asking Strategy 決定(原則12/13)
// ============================================================

function decideAskingStrategy(
  signals: EventSignals,
  hasTime: boolean,
  hasTitleOrTopic: boolean
): AskingStrategy {
  // センシティブ → 一切聞かない(原則13)
  if (signals.is_sensitive) return 'silent'
  
  // Takuma ルール: 時間 or 場所のどっちかは必要(ダブルブッキング防止)
  const hasTimeOrLocation = hasTime || signals.has_explicit_location
  
  if (!hasTimeOrLocation) {
    return 'clarification'  // 時間か場所を聞く
  }
  
  // どちらかあれば基本 silent(原則12)
  // 「誰と」は絶対に聞かない
  return 'silent'
}

// ============================================================
// ★v1.8.0: Tentative 判定(明示化)
// ============================================================

function decideTentative(
  signals: EventSignals,
  hasTime: boolean,
  hasTitleOrTopic: boolean
): boolean {
  // 「仮で」明示 → 仮
  if (signals.has_explicit_tentative) return true
  
  // 時間+タイトル両方あり → 本予定
  if (hasTime && hasTitleOrTopic) return false
  
  // それ以外 → 仮
  return true
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
    {
      regex: /(?<!\d)(\d{1,2})時(\d{1,2})?分?(から|に|〜|~|より)/,
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
  if (MODIFY_PATTERNS.cancel.test(text)) return 'cancel'   // ★v1.8.0 Bug 4: 「なくなった」もここへ
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

// ============================================================
// ★v1.8.0: Model Router(gpt-4o-mini / gpt-4o 使い分け)
// ============================================================

function selectModel(
  intent: Intent,
  crisisType: string | null,
  nonInterventionType: string | null,
  isHighRisk: boolean
): 'gpt-4o-mini' | 'gpt-4o' {
  // 安全最優先: Objection / Non-Intervention は 4o(ブレない判断)
  if (crisisType) return 'gpt-4o'
  if (nonInterventionType) return 'gpt-4o'
  
  // 高リスク領域(法律/医療/税務/投資)は 4o
  if (isHighRisk) return 'gpt-4o'
  
  // 重要な意思決定(Decide)は 4o
  if (intent === 'decide') return 'gpt-4o'
  
  // その他は mini(コスト節約)
  return 'gpt-4o-mini'
}

// ============================================================
// ★v1.8.0: Debouncing — 連続操作の集約検出
// ============================================================

type RecentMutation = {
  target_id: string
  target_table: TargetTable
  timestamp: number
}

const RECENT_MUTATIONS: RecentMutation[] = []
const DEBOUNCE_WINDOW_MS = 60 * 1000  // 60秒

function shouldDebounceReport(
  targetId: string,
  targetTable: TargetTable
): boolean {
  const nowMs = Date.now()
  // 期限切れを掃除
  while (RECENT_MUTATIONS.length > 0 && 
         nowMs - RECENT_MUTATIONS[0].timestamp > DEBOUNCE_WINDOW_MS) {
    RECENT_MUTATIONS.shift()
  }
  
  // 同じ対象への60秒以内の操作がある?
  const recent = RECENT_MUTATIONS.find(m => 
    m.target_id === targetId && m.target_table === targetTable
  )
  
  // 記録
  RECENT_MUTATIONS.push({ target_id: targetId, target_table: targetTable, timestamp: nowMs })
  
  return !!recent
}

// ============================================================
// メモリ取得
// ============================================================

async function fetchOwnerMaster() {
  const { data, error } = await supabase.from('owner_master').select('*').limit(1).single()
  if (error && error.code !== 'PGRST116') {
    console.error('❌ [v1.8.0] owner_master 取得エラー:', error)
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
    const { data, error } = await supabase.from('people').select('*').ilike('name', `%${name}%`).limit(1)
    if (error) console.error('❌ [v1.8.0] people 検索エラー:', error)
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
    if (error) console.error('❌ [v1.8.0] business_master 検索エラー:', error)
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
    if (error) console.error('❌ [v1.8.0] task 検索エラー:', error)
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
    if (error) console.error('❌ [v1.8.0] calendar 検索エラー:', error)
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
  if (error) console.error('❌ [v1.8.0] feedback_queue 取得エラー:', error)
  return data ?? null
}

async function recordFeedback(queueId: string, decisionLogId: string, done: boolean) {
  const { error: e1 } = await supabase
    .from('decision_log')
    .update({ action_taken: done ? 'done' : 'skipped', updated_at: new Date().toISOString() })
    .eq('id', decisionLogId)
  if (e1) console.error('❌ [v1.8.0] decision_log 更新エラー:', e1)

  const { error: e2 } = await supabase
    .from('feedback_queue')
    .update({ asked: true, answered: true })
    .eq('id', queueId)
  if (e2) console.error('❌ [v1.8.0] feedback_queue 更新エラー:', e2)
}

// ============================================================
// ★v1.8.0: Dual-Field Architecture - Aliases 更新ヘルパー
// ============================================================

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
      console.error(`❌ [v1.8.0] ${table} aliases 取得エラー:`, getErr)
      return
    }
    
    const existing: string[] = current?.aliases ?? []
    const trimmed = newAlias.trim()
    if (!trimmed || trimmed.length < 2) return
    
    // 重複チェック
    if (existing.some(a => a.toLowerCase() === trimmed.toLowerCase())) return
    
    const updated = [...existing, trimmed].slice(-20)  // 最大20件
    const { error: upErr } = await supabase
      .from(table)
      .update({ aliases: updated })
      .eq('id', recordId)
    if (upErr) {
      console.error(`❌ [v1.8.0] ${table} aliases 更新エラー:`, upErr)
    } else {
      console.log(`✅ [v1.8.0 Dual-Field] aliases 追加: ${table}.${recordId} += "${trimmed}"`)
    }
  } catch (e) {
    console.error(`❌ [v1.8.0] appendAlias 例外:`, e)
  }
}
// ============================================================
// ★v1.8.0: Entity Resolution 層(aliases 対応版)
// ============================================================

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
  
  // ★v1.8.0: Dual-Field Matching(生の言葉 + aliases の両方で検索)
  const aliases: string[] = candidate.aliases || []
  
  // 1. content(canonical)との一致
  if (targetText && textLower.includes(targetText)) {
    score += 0.60
    reasons.push(`content一致`)
  }
  
  // 2. aliases との一致(Takuma 提案の核心)
  for (const alias of aliases) {
    const aliasLower = alias.toLowerCase()
    if (aliasLower.length >= 2 && textLower.includes(aliasLower)) {
      score += 0.55
      reasons.push(`alias一致:"${alias}"`)
      matched_alias = alias
      break
    }
  }
  
  // 3. Recency score
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
  
  // 4. Personal Dictionary マッチ
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
  
  // 5. Person Matcher
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
  
  // 6. Organizations
  for (const org of analysis.organizations) {
    if (targetText.includes(org.toLowerCase())) {
      score += 0.40
      reasons.push(`組織:${org}`)
    }
  }
  
  // 7. Proper Nouns
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
  
  // 8. Keywords
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
  
  // 9. Datetime マッチ
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
  
  // 10. State による減点
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
      // ★v1.8.0 Bug 1 修正: 削除済みも含めて取得し、下流でスコアで減点
      // 「消してくれた?」への回答整合性のため
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
      if (error) console.error('❌ [v1.8.0] resolveReference/task エラー:', error)
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
      if (error) console.error('❌ [v1.8.0] resolveReference/calendar エラー:', error)
      candidates = data || []
    } else if (targetTable === 'memo') {
      const { data, error } = await supabase
        .from('memo')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30)
      if (error) console.error('❌ [v1.8.0] resolveReference/memo エラー:', error)
      candidates = data || []
    } else if (targetTable === 'ideas') {
      const { data, error } = await supabase
        .from('ideas')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30)
      if (error) console.error('❌ [v1.8.0] resolveReference/ideas エラー:', error)
      candidates = data || []
    }
  } catch (e) {
    console.error('❌ [v1.8.0] resolveReference 例外:', e)
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
    return {
      id: c.id,
      title: String(c[contentField] || '').substring(0, 50),
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

  if (top?.matched_alias) strategy = 'aliases_match'  // ★v1.8.0
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
    target_id: top && top.score >= 0.3 ? top.id : null,
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

async function executeMutationPlan(
  plan: MutationPlan,
  userMessageId: string,
  originalSearchText: string  // ★v1.8.0: aliases 蓄積用
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
      console.error('❌ [v1.8.0] executeMutationPlan: target取得エラー', beforeError)
      return {
        status: 'error',
        error: 'target_not_found_at_execution',
        action: plan.action,
      }
    }

    // ★v1.8.0 Dual-Field: 使用された呼び方を aliases に追加
    //   「パンのタスク消して」 → "パンのタスク" が aliases に記録される
    //   これで次回「パンのタスク」と言っても見つけられる
    const contentField = plan.target_table === 'task' || plan.target_table === 'memo' || plan.target_table === 'ideas'
      ? 'content'
      : 'title'
    const canonicalText = String(before[contentField] || '').toLowerCase()
    const searchLower = originalSearchText.toLowerCase()
    
    // 元のテキストが canonical と違う表現なら、aliases に追加候補
    if (searchLower && !searchLower.includes(canonicalText) && !canonicalText.includes(searchLower)) {
      // ただし、あまりに長い文の全部を alias にはしない(意味ある部分だけ)
      //  → 文を短く抽出: 30文字以内
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
        console.error('⚠️ [v1.8.0] trash_queue INSERTエラー:', trashError)
      }

      if (plan.target_table === 'memo' || plan.target_table === 'ideas') {
        const { error } = await supabase
          .from(plan.target_table)
          .delete()
          .eq('id', plan.target_id)
        if (error) {
          console.error('❌ [v1.8.0] delete エラー:', error)
          return { status: 'error', error: error.message, action: plan.action }
        }
      } else {
        const { error } = await supabase
          .from(plan.target_table)
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', plan.target_id)
        if (error) {
          console.error('❌ [v1.8.0] soft-delete エラー:', error)
          return { status: 'error', error: error.message, action: plan.action }
        }
      }
    } else {
      const { error } = await supabase
        .from(plan.target_table)
        .update(plan.patch)
        .eq('id', plan.target_id)
      if (error) {
        console.error('❌ [v1.8.0] update エラー:', error)
        return { status: 'error', error: error.message, action: plan.action }
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
      if (stError) console.error('⚠️ [v1.8.0] state_transition INSERT エラー:', stError)
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
      console.error('⚠️ [v1.8.0] mutation_event_log INSERT エラー:', mutLogError)
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
    if (erResErr) console.error('⚠️ [v1.8.0] entity_reference_resolution_log INSERT エラー:', erResErr)

    // ★v1.8.0: resolver_strategy が aliases_match の場合のログ
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
    console.error('❌ [v1.8.0] executeMutationPlan 例外:', e)
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
    console.error('❌ [v1.8.0] decision_log 記録失敗:', error)
    return
  }

  if (intent === 'objection' || intent === 'non_intervention') return

  const askAfter = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const { error: fqError } = await supabase.from('feedback_queue').insert({
    decision_log_id: data.id,
    ask_after: askAfter,
  })
  if (fqError) console.error('❌ [v1.8.0] feedback_queue INSERT 失敗:', fqError)
}

// ============================================================
// v1.7.0: 重複検出
// ============================================================

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

    if (error) console.error('❌ [v1.8.0] checkConflictingEvents エラー:', error)
    return data || []
  } catch (e) {
    console.error('❌ [v1.8.0] checkConflictingEvents 例外:', e)
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
    if (error) console.error('❌ [v1.8.0] fetchLatestCalendarConflict エラー:', error)
    return data ?? null
  } catch (e) {
    console.error('❌ [v1.8.0] fetchLatestCalendarConflict 例外:', e)
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
      .select('title, is_tentative')
      .eq('id', existingId)
      .single()

    if (getError) {
      console.error('❌ [v1.8.0] confirmTentativeCalendar 取得エラー:', getError)
      return
    }
    if (!current) return

    const updates: any = {
      updated_at: new Date().toISOString(),
    }

    if (newTitle && !VAGUE_TOPICS.test(newTitle.trim())) {
      updates.title = newTitle
    }

    // ★v1.8.0: missing_fields 廃止。単純に is_tentative を false にする
    updates.is_tentative = false
    updates.missing_fields = null

    const { error: upError } = await supabase.from('calendar').update(updates).eq('id', existingId)
    if (upError) {
      console.error('❌ [v1.8.0] confirmTentativeCalendar UPDATE エラー:', upError)
      return
    }
    console.log('✅ [v1.8.0] 仮予定を確定:', existingId, updates)
  } catch (e) {
    console.error('❌ [v1.8.0] confirmTentativeCalendar 例外:', e)
  }
}

// ============================================================
// v1.6.4: ゴミ値排除
// ============================================================
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
    console.log('⚠️ [v1.8.0] ゴミ値を検出してスキップ:', trimmed)
    return null
  }
  const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
  if (ISO_DATETIME_PATTERN.test(trimmed)) {
    console.log('⚠️ [v1.8.0] ISO 8601 形式を検出してスキップ:', trimmed)
    return null
  }
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    console.log('⚠️ [v1.8.0] 括弧メタ注釈を検出してスキップ:', trimmed)
    return null
  }
  if (trimmed.includes('省略可') || trimmed.includes('省略する')) {
    console.log('⚠️ [v1.8.0] 省略関連の語を検出してスキップ:', trimmed)
    return null
  }
  return trimmed
}

/**
 * ★v1.8.0: saveStructuredMemory(配列対応 + event_signals + aliases 保存)
 * 
 * 変更点(v1.7.4 からの差分):
 * - save.calendar が配列でも対応(Bug 2 修正)
 * - calendar INSERT 時に event_signals / inferred_category / aliases 保存
 * - missing_fields 廃止(原則12)
 * - 人物は明示的に save.people があった時のみ保存(原則13)
 */
async function saveStructuredMemory(
  save: any,
  rawText: string,
  userMessageId: string
): Promise<SaveEntityResult[]> {
  const results: SaveEntityResult[] = []
  if (!save) {
    console.log('📦 [v1.8.0 SAVE] save オブジェクトが null/undefined')
    return results
  }

  console.log('📦 [v1.8.0 SAVE] 入口の save 内容:', JSON.stringify(save))

  // ★v1.8.0: 入力からシグナル抽出(calendar 保存前)
  const signals = extractEventSignals(rawText)
  const extractedDt = extractDatetime(rawText)
  signals.has_explicit_time = !!extractedDt?.datetime
  const inferredCategory = inferEventCategory(signals)

  const extractedEntities: Array<{ table: string; id: string; role: string }> = []

  // ---------- task ----------
  const cleanTask = cleanSaveValue(save.task)
  if (cleanTask) {
    const { data: existing, error: existErr } = await supabase
      .from('task')
      .select('id')
      .eq('content', cleanTask)
      .is('deleted_at', null)
      .limit(1)
    if (existErr) console.error('❌ [v1.8.0] task 既存検索エラー:', existErr)

    if (!existing?.length) {
      const { data: inserted, error: insErr } = await supabase
        .from('task')
        .insert({
          content: cleanTask,
          done: false,
          state: 'active',
          is_user_confirmed: true,
          confidence: 0.9,
          aliases: [],  // ★v1.8.0: Dual-Field 初期化
        })
        .select('id')
        .single()

      if (insErr) {
        console.error('❌ [v1.8.0] task INSERT エラー:', insErr)
        results.push({
          table: 'task', attempted: true, success: false,
          error_code: insErr.code, error_message: insErr.message,
        })
      } else if (inserted) {
        console.log('✅ [v1.8.0] task INSERT 成功:', inserted.id)
        extractedEntities.push({ table: 'task', id: inserted.id, role: 'created' })
        results.push({ table: 'task', attempted: true, success: true, id: inserted.id, role: 'created' })
      }
    } else {
      results.push({ table: 'task', attempted: true, success: true, skipped_reason: 'already_exists' })
    }
  } else if (save.task !== null && save.task !== undefined) {
    results.push({ table: 'task', attempted: true, success: false, skipped_reason: 'cleaned_to_null', error_message: String(save.task) })
  }

  // ---------- memo ----------
  const cleanMemo = cleanSaveValue(save.memo)
  if (cleanMemo) {
    const { data: inserted, error: insErr } = await supabase
      .from('memo')
      .insert({ content: cleanMemo, aliases: [] })
      .select('id')
      .single()
    if (insErr) {
      console.error('❌ [v1.8.0] memo INSERT エラー:', insErr)
      results.push({ table: 'memo', attempted: true, success: false, error_code: insErr.code, error_message: insErr.message })
    } else if (inserted) {
      console.log('✅ [v1.8.0] memo INSERT 成功:', inserted.id)
      extractedEntities.push({ table: 'memo', id: inserted.id, role: 'created' })
      results.push({ table: 'memo', attempted: true, success: true, id: inserted.id, role: 'created' })
    }
  } else if (save.memo !== null && save.memo !== undefined) {
    results.push({ table: 'memo', attempted: true, success: false, skipped_reason: 'cleaned_to_null', error_message: String(save.memo) })
  }

  // ---------- calendar(★v1.8.0: 配列対応 + signals + Minimal Intrusion) ----------
  // Bug 2 修正: save.calendar が配列でも対応
  const calendarItems: any[] = Array.isArray(save.calendar) 
    ? save.calendar 
    : (save.calendar !== null && save.calendar !== undefined ? [save.calendar] : [])
  
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

    // 配列の各要素で datetime を抽出(もし要素に datetime あればそれを優先)
    let itemDatetime: string | null = null
    if (typeof calendarItem === 'object' && calendarItem?.datetime) {
      itemDatetime = calendarItem.datetime
    } else {
      itemDatetime = extractedDt?.datetime || null
    }

    console.log('📦 [v1.8.0 SAVE] calendar 処理:', {
      index: i,
      title: cleanCalendar,
      datetime: itemDatetime,
      signals,
      inferred_category: inferredCategory,
    })

    // ★v1.8.0: Tentative 判定(原則12 明示化)
    const hasTitleOrTopic = !VAGUE_TOPICS.test(cleanCalendar.trim())
    const hasTime = !!itemDatetime
    const isTentative = decideTentative(signals, hasTime, hasTitleOrTopic)

    // 重複検出
    let conflictDetected = false
    if (itemDatetime) {
      const conflicts = await checkConflictingEvents(itemDatetime, 60)
      if (conflicts.length > 0 && calendarItems.length === 1) {
        // 単一予定の時のみ重複確認を出す(複数同時保存では出さない)
        const conflict = conflicts[0]
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

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
              title: cleanCalendar,
              datetime: itemDatetime,
              is_tentative: isTentative,
              signals,
              inferred_category: inferredCategory,
            },
          },
          mutation_plan: {
            type: 'calendar_conflict',
            existing_id: conflict.id,
            new_event_data: {
              title: cleanCalendar,
              datetime: itemDatetime,
              is_tentative: isTentative,
              signals,
              inferred_category: inferredCategory,
            },
          },
          reason_text: `同時間帯に既存予定「${conflict.title}」があるため確認が必要`,
          status: 'pending',
          expires_at: expiresAt,
        })

        if (pcError) {
          console.error('❌ [v1.8.0] pending_confirmation INSERT エラー:', pcError)
          results.push({ table: 'pending_confirmation', attempted: true, success: false, error_code: pcError.code, error_message: pcError.message })
        } else {
          console.log('🔔 [v1.8.0] 予定重複検出:', conflict.id)
          conflictDetected = true
          results.push({ table: 'pending_confirmation', attempted: true, success: true, role: 'calendar_conflict_pending' })
        }
      }
    }

    if (!conflictDetected) {
      const { data: inserted, error: insErr } = await supabase
        .from('calendar')
        .insert({
          title: cleanCalendar,
          datetime: itemDatetime,
          state: 'scheduled',
          is_tentative: isTentative,
          missing_fields: null,  // ★v1.8.0: 廃止
          event_signals: signals,  // ★v1.8.0
          inferred_category: inferredCategory,  // ★v1.8.0
          aliases: [],  // ★v1.8.0: Dual-Field 初期化
          is_user_confirmed: true,
          confidence: 0.9,
        })
        .select('id')
        .single()

      if (insErr) {
        console.error('❌ [v1.8.0] calendar INSERT エラー:', {
          code: insErr.code,
          message: insErr.message,
          payload: { title: cleanCalendar, datetime: itemDatetime, is_tentative: isTentative },
        })
        results.push({ table: 'calendar', attempted: true, success: false, error_code: insErr.code, error_message: insErr.message })
      } else if (inserted) {
        console.log('✅ [v1.8.0] calendar INSERT 成功:', {
          id: inserted.id, title: cleanCalendar, is_tentative: isTentative, category: inferredCategory,
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

  // ---------- people(★v1.8.0: 原則13 — ユーザーが明示した時のみ) ----------
  if (save.people?.name) {
    const p = save.people
    const normalizedName = normalizeName(p.name)
    const { data: candidates, error: searchErr } = await supabase
      .from('people')
      .select('*')
      .ilike('name', `%${normalizedName}%`)
      .limit(3)
    if (searchErr) console.error('❌ [v1.8.0] people 検索エラー:', searchErr)

    const existing =
      candidates?.find(
        (c: any) =>
          (p.company && c.company === p.company) ||
          (p.position && c.position === p.position) ||
          c.name === normalizedName
      ) || candidates?.[0]

    if (existing) {
      const nextNote = [existing.note, p.note].filter(Boolean).join('\n')
      const { error: upErr } = await supabase
        .from('people')
        .update({
          company: p.company || existing.company,
          position: p.position || existing.position,
          note: nextNote,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
      if (upErr) {
        console.error('❌ [v1.8.0] people UPDATE エラー:', upErr)
        results.push({ table: 'people', attempted: true, success: false, error_code: upErr.code, error_message: upErr.message })
      } else {
        console.log('✅ [v1.8.0] people UPDATE:', existing.id)
        extractedEntities.push({ table: 'people', id: existing.id, role: 'referenced' })
        results.push({ table: 'people', attempted: true, success: true, id: existing.id, role: 'referenced' })
        
        // ★v1.8.0: 呼称学習
        try {
          await recordReferringExpression(existing.id, normalizedName, 'nickname', null)
        } catch (e) {
          console.warn('⚠️ [v1.8.0] recordReferringExpression エラー:', e)
        }
      }
    } else {
      const { data: inserted, error: insErr } = await supabase
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
      if (insErr) {
        console.error('❌ [v1.8.0] people INSERT エラー:', insErr)
        results.push({ table: 'people', attempted: true, success: false, error_code: insErr.code, error_message: insErr.message })
      } else if (inserted) {
        console.log('✅ [v1.8.0] people INSERT:', inserted.id)
        extractedEntities.push({ table: 'people', id: inserted.id, role: 'created' })
        results.push({ table: 'people', attempted: true, success: true, id: inserted.id, role: 'created' })
        
        // ★v1.8.0: 呼称学習(新規人物)
        try {
          await recordReferringExpression(inserted.id, normalizedName, 'nickname', null)
        } catch (e) {
          console.warn('⚠️ [v1.8.0] recordReferringExpression エラー:', e)
        }
      }
    }
  }

  // ---------- business ----------
  if (save.business?.name) {
    const b = save.business
    const { data: existing, error: searchErr } = await supabase
      .from('business_master')
      .select('*')
      .ilike('name', `%${b.name}%`)
      .limit(1)
    if (searchErr) console.error('❌ [v1.8.0] business 検索エラー:', searchErr)

    if (existing?.length) {
      const { error: upErr } = await supabase
        .from('business_master')
        .update({
          note: [existing[0].note, b.note].filter(Boolean).join('\n'),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing[0].id)
      if (upErr) {
        console.error('❌ [v1.8.0] business UPDATE エラー:', upErr)
        results.push({ table: 'business_master', attempted: true, success: false, error_code: upErr.code, error_message: upErr.message })
      } else {
        console.log('✅ [v1.8.0] business UPDATE:', existing[0].id)
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
        console.error('❌ [v1.8.0] business INSERT エラー:', insErr)
        results.push({ table: 'business_master', attempted: true, success: false, error_code: insErr.code, error_message: insErr.message })
      } else if (inserted) {
        console.log('✅ [v1.8.0] business INSERT:', inserted.id)
        extractedEntities.push({ table: 'business_master', id: inserted.id, role: 'created' })
        results.push({ table: 'business_master', attempted: true, success: true, id: inserted.id, role: 'created' })
      }
    }
  }

  // ---------- ideas ----------
  const cleanIdeas = cleanSaveValue(save.ideas)
  if (cleanIdeas) {
    const { data: inserted, error: insErr } = await supabase
      .from('ideas')
      .insert({ content: cleanIdeas, aliases: [] })
      .select('id')
      .single()
    if (insErr) {
      console.error('❌ [v1.8.0] ideas INSERT エラー:', insErr)
      results.push({ table: 'ideas', attempted: true, success: false, error_code: insErr.code, error_message: insErr.message })
    } else if (inserted) {
      console.log('✅ [v1.8.0] ideas INSERT:', inserted.id)
      extractedEntities.push({ table: 'ideas', id: inserted.id, role: 'created' })
      results.push({ table: 'ideas', attempted: true, success: true, id: inserted.id, role: 'created' })
    }
  } else if (save.ideas !== null && save.ideas !== undefined) {
    results.push({ table: 'ideas', attempted: true, success: false, skipped_reason: 'cleaned_to_null', error_message: String(save.ideas) })
  }

  // ---------- entity_extraction_log ----------
  if (extractedEntities.length > 0) {
    const { error: extLogErr } = await supabase.from('entity_extraction_log').insert({
      source_message_id: userMessageId,
      source_text: rawText,
      extracted_entities: extractedEntities,
      extraction_method: 'llm',
      confidence: 0.85,
      is_user_reviewed: false,
    })
    if (extLogErr) console.error('⚠️ [v1.8.0] entity_extraction_log INSERT エラー:', extLogErr)
  }

  console.log('📦 [v1.8.0 SAVE] 完了サマリ:', JSON.stringify(results))
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
// ============================================================
// ★v1.8.0: システムプロンプト(原則11/12/13 完全反映)
// ============================================================

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
  isDebouncedUpdate: boolean
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

  // ★v1.8.0: AskingStrategy に基づく Minimal Intrusion 指示
  const askingGuidance = (() => {
    switch (askingStrategy) {
      case 'silent':
        return `
■★原則12/13: 最小干渉・必要知★
ユーザーは十分な情報を提供した。追加質問は一切しない。
- 「誰と?」絶対禁止
- 「何の詳細?」禁止
- 「他にある?」程度の軽い確認のみOK(スルー可能な形で)
- 応答は短く完結させる
`
      case 'optional_hint':
        return `
■★原則12/13: 軽い確認のみ★
情報はほぼ足りている。任意の追加があれば受け取る形で。
- 「他にわかってる事あれば教えて」程度OK
- 「〜は?」と個別に聞かない
- 誰とは絶対聞かない
`
      case 'clarification':
        return `
■★必須情報の欠落(clarification)★
時間も場所もわからない予定は、ダブルブッキング防止のため最低限聞く必要あり。
- 「時間か場所、どっちか分かる?」と聞く
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
- 「仮予定として押さえた」「詳細教えて」は繰り返さない
- hints / options は空にする
`
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
■★Modifyモード(確認要請)★
- アクション希望: ${actionJp}
- 候補: ${candidateList}

出力方針:
- 「しました」と絶対言わない
- 「どれを${actionJp}する?」と聞く
- options に候補タイトル
- mode="modify"
- saveはnull
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
- 「しました」と絶対言わない
- 「該当するのが見つからなかった」と正直に
- mode="modify"
- saveはnull
`
    } else if (executionResult.status === 'error') {
      executionNote = `
■★Modifyモード(エラー)★
- エラー: ${executionResult.error}

出力方針:
- 「しました」と言わない
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
${askingGuidance}
${debounceNote}

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
・短く断定
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
- 「日時+予定」なら title のみ入れる("会議"など)。日時は extractDatetime が自動抽出
- 複数の予定を同時に言われた場合は配列で返す:
  save.calendar: ["田中さんとの会議", "犬の散歩"]
- 単一なら文字列で可: save.calendar: "会議"

【save.task】
明確なタスク(やるべきこと)のみ。「〜しないと」「〜やらなきゃ」。

【save.memo】
「覚えて」「メモして」の時のみ。

【save.people】★重要(原則13)★
- オーナーが人物名を明示した時のみ name を埋める
- 「誰と」をあなたから聞いたから答えた、のは NG
- オーナーが自発的に書いた時のみ

【save.business】
明確なビジネス案の時のみ。

【save.ideas】
明確なアイデアの時のみ。

■★仮予定 vs 本予定(原則12 明示化)★
- 「仮で」「一旦」「暫定」→ 仮予定
- 時間 + タイトル両方あり → 本予定
- 片方欠ける → 仮予定
システムが自動判定するが、応答では「押さえた」「入れた」のように中立的に。

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
// ★ v1.8.0 POST関数
// ============================================================

export async function POST(req: NextRequest) {
  // ★原則11: 二層の正しさ
  //   rawUserMessage (Layer A) = オーナーの生の言葉
  //   lastUserMessage (Layer B) = 訂正・補完版(NOIDA の内部理解用)
  const requestStartTime = Date.now()
  const { messages } = await req.json()
  const rawUserMessage = messages[messages.length - 1]?.content || ''
  const sessionDate = getSessionDate()

  console.log('📥 [v1.8.0 REQUEST]', JSON.stringify({
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
      console.log('✏️ [v1.8.0 二層の正しさ]', {
        layerA_original: correctionResult.original,
        layerB_corrected: correctionResult.corrected,
        corrections: correctionResult.corrections,
        validation_failed: correctionResult.validation_failed || false,
      })
      lastUserMessage = correctionResult.corrected
    } else {
      console.log('✏️ [v1.8.0 二層の正しさ]', {
        layerA_original: rawUserMessage,
        layerB_corrected: '(差分なし)',
      })
    }
  } catch (e) {
    console.error('❌ [v1.8.0 INPUT訂正] エラー、訂正せずに処理続行:', e)
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

  // ============================================================
  // v1.7.0: 予定重複の「同じ/違う」選択処理
  // ============================================================
  const calendarConflict = await fetchLatestCalendarConflict()
  if (calendarConflict) {
    const isSame = CONFLICT_SAME_PATTERNS.test(lastUserMessage.trim())
    const isDifferent = CONFLICT_DIFFERENT_PATTERNS.test(lastUserMessage.trim())

    if (isSame || isDifferent) {
      const plan = calendarConflict.mutation_plan as any
      const { existing_id, new_event_data } = plan

      if (isSame) {
        await confirmTentativeCalendar(
          existing_id,
          new_event_data.title,
          null
        )

        const { error: pcUpErr } = await supabase
          .from('pending_confirmation')
          .update({ status: 'resolved', confirmed_at: new Date().toISOString() })
          .eq('id', calendarConflict.id)
        if (pcUpErr) console.error('❌ [v1.8.0] pending_confirmation UPDATE エラー:', pcUpErr)

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

      if (isDifferent) {
        const { data: inserted, error: insErr } = await supabase
          .from('calendar')
          .insert({
            title: new_event_data.title,
            datetime: new_event_data.datetime,
            state: 'scheduled',
            is_tentative: new_event_data.is_tentative,
            event_signals: new_event_data.signals || null,
            inferred_category: new_event_data.inferred_category || null,
            aliases: [],
            is_user_confirmed: true,
            confidence: 0.9,
          })
          .select('id')
          .single()
        if (insErr) console.error('❌ [v1.8.0] calendar INSERT(別件)エラー:', insErr)

        const { error: pcUpErr } = await supabase
          .from('pending_confirmation')
          .update({ status: 'resolved', confirmed_at: new Date().toISOString() })
          .eq('id', calendarConflict.id)
        if (pcUpErr) console.error('❌ [v1.8.0] pending UPDATE(別件)エラー:', pcUpErr)

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
  }

  // ============================================================
  // ★v1.8.0 Bug 3 修正: 受諾ワード → 次行動誘導の強化
  // ============================================================
  const ackType = detectAcknowledgment(lastUserMessage)
  if (ackType) {
    console.log('✅ [v1.8.0 ACK発火]', ackType)

    const { data: pendingTasks, error: ptErr } = await supabase
      .from('task')
      .select('content')
      .eq('done', false)
      .is('deleted_at', null)
      .neq('state', 'completed')
      .neq('state', 'cancelled')
      .order('created_at', { ascending: true })
      .limit(1)
    if (ptErr) console.error('❌ [v1.8.0] ACK用task取得エラー:', ptErr)

    const nowISO = new Date().toISOString()
    const { data: upcomingEvents, error: ueErr } = await supabase
      .from('calendar')
      .select('title, datetime, is_tentative')
      .is('deleted_at', null)
      .neq('state', 'cancelled')
      .gte('datetime', nowISO)
      .order('datetime', { ascending: true })
      .limit(1)
    if (ueErr) console.error('❌ [v1.8.0] ACK用calendar取得エラー:', ueErr)

    const prefixMap: Record<string, string[]> = {
      gratitude: ['どういたしまして。', 'お役に立てて何より。'],
      acknowledgment: [''],
      nod: [''],
    }
    const prefixes = prefixMap[ackType]
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)]

    // ★v1.8.0 Bug 3: オウム返し「了解!」禁止。常に次行動を提示
    let coreMsg: string

    if (pendingTasks?.length) {
      coreMsg = `次「${pendingTasks[0].content}」やろう。`
    } else if (upcomingEvents?.length) {
      const ev = upcomingEvents[0]
      const dt = new Date(ev.datetime)
      const today = new Date()
      const isToday = dt.toDateString() === today.toDateString()
      const timeStr = dt.toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
      const dateStr = isToday
        ? `今日${timeStr}`
        : `${dt.getMonth() + 1}月${dt.getDate()}日${timeStr}`
      const tentativeLabel = ev.is_tentative ? '【仮】' : ''
      // ★v1.8.0 原則12/13: 「誰とか分かったら」は聞かない
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

  // ★v1.8.0: Signal 抽出 & AskingStrategy 決定
  const signals = extractEventSignals(lastUserMessage)
  const extractedDt = extractDatetime(lastUserMessage)
  signals.has_explicit_time = !!extractedDt?.datetime
  const hasTitleOrTopic = !VAGUE_TOPICS.test(lastUserMessage.trim()) && lastUserMessage.trim().length >= 3
  const askingStrategy = decideAskingStrategy(signals, signals.has_explicit_time, hasTitleOrTopic)

  console.log('🎯 [v1.8.0 CLASSIFY]', {
    router_intent: intent,
    crisis: crisisType,
    non_intervention: nonInterventionType,
    topic_switched: topicSwitched,
    after_empathy: afterEmpathy,
    signals,
    inferred_category: inferEventCategory(signals),
    asking_strategy: askingStrategy,
    keywords,
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
  if (utErr) console.error('❌ [v1.8.0] talk_master(user) INSERT エラー:', utErr)

  const userMessageId = userTalkRecord?.id || `msg_${Date.now()}`

  let executionResult: ExecutionResult = { status: 'not_applicable' }
  let isDebouncedUpdate = false
  const modifyAction = detectModifyAction(lastUserMessage)

  if (intent === 'modify' && modifyAction && !crisisType && !nonInterventionType) {
    const plan = await generateMutationPlan(lastUserMessage, modifyAction, userMessageId)
    if (plan) {
      executionResult = await executeMutationPlan(plan, userMessageId, lastUserMessage)
      
      // ★v1.8.0: Debounce 判定
      if (executionResult.status === 'executed' && executionResult.target_id) {
        isDebouncedUpdate = shouldDebounceReport(
          executionResult.target_id,
          plan.target_table
        )
        if (isDebouncedUpdate) {
          console.log('🔕 [v1.8.0 DEBOUNCE] 60秒以内の連続更新、応答を最小化')
        }
      }
    }
  }

  // ★v1.8.0: Model Router
  const selectedModel = selectModel(intent, crisisType, nonInterventionType, isHighRisk)
  console.log('🤖 [v1.8.0 MODEL]', {
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
    isDebouncedUpdate
  )

  const cleanMessages = messages
    .map((m: any) => ({
      role: m.role === 'noida' ? 'assistant' : m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }))
    .slice(-10)

  // ★v1.8.0: Model Router でモデル選択、temperature も調整
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

  console.log('🔍 [v1.8.0 LLM RAW]', JSON.stringify({
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
    console.error('❌ [v1.8.0] JSON parse失敗(1回目):', { error: String(e), text_preview: text.substring(0, 300) })

    // リトライ
    console.log('🔄 [v1.8.0] JSON リトライ')
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
      console.log('✅ [v1.8.0] リトライ成功')
    } catch (retryErr) {
      console.error('❌ [v1.8.0] リトライも失敗:', retryErr)
      parsed = {
        reply: text,
        mode: intent,
        save: {},
        options: [],
        decision_log: { should_log: false },
      }
    }
  }

  console.log('📦 [v1.8.0 PARSED]', JSON.stringify({
    mode: parsed.mode,
    reply_preview: (parsed.reply || '').substring(0, 100),
    save_keys_present: parsed.save ? Object.keys(parsed.save) : [],
    save_calendar: parsed.save?.calendar,
    save_task: parsed.save?.task,
    save_people: parsed.save?.people,
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
    saveResults = await saveStructuredMemory(parsed.save, lastUserMessage, userMessageId)
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
  if (noTalkErr) console.error('❌ [v1.8.0] talk_master(noida) INSERT エラー:', noTalkErr)

  const elapsedMs = Date.now() - requestStartTime
  const wasCorrected = lastUserMessage !== rawUserMessage
  console.log('🏁 [v1.8.0 DONE]', JSON.stringify({
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