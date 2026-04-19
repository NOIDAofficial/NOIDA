/**
 * NOIDA Person Matcher v1.0
 * 
 * 発言から人物を特定するエンジン。
 * Takumaの哲学:
 *   - 全シグナル(姓・役職・会社・文脈・重要度・呼称履歴)を使う
 *   - 3段階判定(confident / likely / needs_confirmation)
 *   - 確信なきときはユーザーに確認(信用を守る)
 *   - 使われた呼称は自動学習
 * 
 * 2026-04-20 Day 5 実装
 */

import { createClient } from '@supabase/supabase-js'

// ============================================================
// 型定義
// ============================================================

export type PersonRecord = {
  id: string
  name: string
  honorific: string | null
  company: string | null
  position: string | null
  importance: 'S' | 'A' | 'B' | 'C' | null
  note: string | null
}

export type ReferringExpression = {
  id: string
  person_id: string
  expression: string
  normalized: string
  mention_count: number
  confidence: number
  expression_type: string | null
  last_used_at: string
}

export type PersonWithExpressions = PersonRecord & {
  referring_expressions: ReferringExpression[]
}

export type MatchSignal = {
  label: string
  weight: number
}

export type PersonScore = {
  person: PersonWithExpressions
  score: number
  signals: MatchSignal[]
}

export type PersonMatchResult =
  | {
      type: 'confident'
      person: PersonWithExpressions
      score: number
      signals: MatchSignal[]
    }
  | {
      type: 'likely'
      person: PersonWithExpressions
      score: number
      signals: MatchSignal[]
      should_confirm: boolean
    }
  | {
      type: 'needs_confirmation'
      candidates: PersonScore[]
      question: string
    }
  | {
      type: 'no_match'
    }

export type MatchContext = {
  recently_mentioned_persons?: string[] // person_id[]
  is_business_context?: boolean
}

// ============================================================
// Supabase キャッシュ
// ============================================================

let supabaseClient: ReturnType<typeof createClient> | null = null
function getSupabase() {
  if (!supabaseClient) {
    supabaseClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  }
  return supabaseClient
}

type PeopleCache = {
  people: PersonWithExpressions[]
  loadedAt: number
}

const PEOPLE_TTL_MS = 5 * 60 * 1000
let peopleCache: PeopleCache | null = null

// ============================================================
// データロード
// ============================================================

type PeopleRow = {
  id: string
  name: string | null
  honorific: string | null
  company: string | null
  position: string | null
  importance: string | null
  note: string | null
}

type RefExprRow = {
  id: string
  person_id: string
  expression: string
  normalized: string
  mention_count: number | null
  confidence: number | null
  expression_type: string | null
  last_used_at: string
}

async function loadPeopleWithExpressions(): Promise<PersonWithExpressions[]> {
  const supabase = getSupabase()
  
  // people 取得
  const { data: peopleData, error: peopleErr } = await supabase
    .from('people')
    .select('id, name, honorific, company, position, importance, note')
    .returns<PeopleRow[]>()
  
  if (peopleErr || !peopleData) {
    console.warn('[PersonMatcher] people load failed:', peopleErr?.message)
    return []
  }
  
  // referring_expressions 取得
  const { data: exprData, error: exprErr } = await supabase
    .from('person_referring_expressions')
    .select('id, person_id, expression, normalized, mention_count, confidence, expression_type, last_used_at')
    .returns<RefExprRow[]>()
  
  if (exprErr) {
    console.warn('[PersonMatcher] referring_expressions load failed:', exprErr.message)
  }
  
  // 人物 id ごとに呼称をまとめる
  const exprsByPerson = new Map<string, ReferringExpression[]>()
  if (exprData) {
    for (const r of exprData) {
      const list = exprsByPerson.get(r.person_id) ?? []
      list.push({
        id: r.id,
        person_id: r.person_id,
        expression: r.expression,
        normalized: r.normalized,
        mention_count: r.mention_count ?? 1,
        confidence: r.confidence ?? 0.5,
        expression_type: r.expression_type,
        last_used_at: r.last_used_at,
      })
      exprsByPerson.set(r.person_id, list)
    }
  }
  
  // PersonWithExpressions 組み立て
  const result: PersonWithExpressions[] = []
  for (const p of peopleData) {
    const name = p.name?.trim()
    if (!name) continue
    
    const importance = (['S', 'A', 'B', 'C'] as const).includes(
      p.importance as 'S' | 'A' | 'B' | 'C'
    )
      ? (p.importance as 'S' | 'A' | 'B' | 'C')
      : null
    
    result.push({
      id: p.id,
      name,
      honorific: p.honorific,
      company: p.company,
      position: p.position,
      importance,
      note: p.note,
      referring_expressions: exprsByPerson.get(p.id) ?? [],
    })
  }
  
  return result
}

export async function getPeopleDictionary(): Promise<PersonWithExpressions[]> {
  const now = Date.now()
  if (peopleCache && now - peopleCache.loadedAt < PEOPLE_TTL_MS) {
    return peopleCache.people
  }
  const people = await loadPeopleWithExpressions()
  peopleCache = { people, loadedAt: now }
  return people
}

export function invalidatePeopleCache(): void {
  peopleCache = null
}

// ============================================================
// 姓の抽出(日本語名の場合)
// ============================================================

/**
 * 日本語名からおおまかに姓を抽出
 * "池田光陽" → "池田"
 * "三木谷浩一" → "三木谷"
 * "孫" → "孫"(そのまま)
 * 
 * 原則: 最初の1〜3文字(漢字・カナの場合)
 */
function extractSurname(name: string): string {
  if (!name) return name
  
  // 英字名の場合はスペース区切りで最初の単語
  if (/^[A-Za-z]/.test(name)) {
    return name.split(/\s+/)[0]
  }
  
  // 漢字姓の目安: 1〜3文字
  // 三木谷=3文字、佐々木=3文字、池田=2文字、孫=1文字
  // → 長い候補を順番に試す(textに含まれるかどうかは呼び出し側で)
  
  // とりあえず 2文字 or 1文字を返す
  // より正確には呼び出し側で複数パターン試す
  if (name.length >= 3) return name.substring(0, 3)
  return name
}

/**
 * 姓の候補を複数返す(長い順)
 * "三木谷浩一" → ["三木谷", "三木", "三"]
 * "池田光陽" → ["池田", "池"]
 */
function extractSurnameCandidates(name: string): string[] {
  if (!name) return []
  
  if (/^[A-Za-z]/.test(name)) {
    return [name.split(/\s+/)[0]]
  }
  
  const candidates: string[] = []
  const maxLen = Math.min(3, name.length)
  for (let len = maxLen; len >= 1; len--) {
    candidates.push(name.substring(0, len))
  }
  return candidates
}

// ============================================================
// スコア計算(Takumaの全シグナル)
// ============================================================

const BUSINESS_CONTEXT_REGEX = 
  /会議|打ち合わせ|打合せ|打ち合せ|商談|連絡|アポ|相談|会食|MTG|mtg|ミーティング|面談|訪問|交渉|契約|案件|取引|決済|承認|提案|確認|問い合わせ/

function calculateScore(
  text: string,
  person: PersonWithExpressions,
  context: MatchContext
): { score: number; signals: MatchSignal[] } {
  const signals: MatchSignal[] = []
  let score = 0
  const lowerText = text.toLowerCase()
  const lowerName = person.name.toLowerCase()
  
  // ------------------------------------------------------------
  // 1. 名前マッチ
  // ------------------------------------------------------------
  
  if (lowerText.includes(lowerName)) {
    score += 0.60
    signals.push({ label: `名前完全一致:${person.name}`, weight: 0.60 })
  } else {
    // 姓マッチ(長い候補から試す)
    const surnameCandidates = extractSurnameCandidates(person.name)
    for (const sc of surnameCandidates) {
      if (sc.length >= 2 && lowerText.includes(sc.toLowerCase())) {
        score += 0.40
        signals.push({ label: `姓一致:${sc}`, weight: 0.40 })
        
        // v1.0.1: 姓の直後に敬称・肩書きがあればブースト
        const suffixRegex = new RegExp(
          `${sc}(さん|様|ちゃん|くん|先生|会長|社長|部長|課長|氏)`,
          'i'
        )
        if (suffixRegex.test(text)) {
          score += 0.15
          signals.push({ label: `敬称付き姓`, weight: 0.15 })
        }
        break
      } else if (sc.length === 1 && lowerText.includes(sc.toLowerCase())) {
        // 1文字姓(孫さん等)は弱めのシグナル
        score += 0.25
        signals.push({ label: `一文字姓一致:${sc}`, weight: 0.25 })
        break
      }
    }
  }
  
  // ------------------------------------------------------------
  // 2. 呼称履歴マッチ(最強シグナルの1つ)
  // ------------------------------------------------------------
  
  for (const expr of person.referring_expressions) {
    if (lowerText.includes(expr.normalized.toLowerCase())) {
      // 基礎点 + confidence による重み
      const baseWeight = 0.25
      const confBoost = expr.confidence * 0.15
      const weight = baseWeight + confBoost
      score += weight
      signals.push({ 
        label: `呼称一致:${expr.expression}(conf=${expr.confidence.toFixed(2)})`, 
        weight 
      })
      
      // 頻出呼称ボーナス
      if (expr.mention_count >= 5) {
        score += 0.05
        signals.push({ label: `頻出呼称`, weight: 0.05 })
      }
      break  // 1つの呼称でOK
    }
  }
  
  // ------------------------------------------------------------
  // 3. 役職マッチ(★Takumaが重視)
  // ------------------------------------------------------------
  
  if (person.position && lowerText.includes(person.position.toLowerCase())) {
    score += 0.35
    signals.push({ label: `役職一致:${person.position}`, weight: 0.35 })
  }
  
  // ------------------------------------------------------------
  // 4. 会社マッチ
  // ------------------------------------------------------------
  
  if (person.company && lowerText.includes(person.company.toLowerCase())) {
    score += 0.20
    signals.push({ label: `会社一致:${person.company}`, weight: 0.20 })
  }
  
  // ------------------------------------------------------------
  // 5. ビジネス文脈
  // ------------------------------------------------------------
  
  if (BUSINESS_CONTEXT_REGEX.test(text)) {
    score += 0.10
    signals.push({ label: 'ビジネス文脈', weight: 0.10 })
  }
  
  // ------------------------------------------------------------
  // 6. 重要度ブースト
  // ------------------------------------------------------------
  
  if (person.importance === 'S') {
    score += 0.10
    signals.push({ label: '最重要人物(S)', weight: 0.10 })
  } else if (person.importance === 'A') {
    score += 0.05
    signals.push({ label: '重要人物(A)', weight: 0.05 })
  }
  
  // ------------------------------------------------------------
  // 7. 直近会話での言及
  // ------------------------------------------------------------
  
  if (context.recently_mentioned_persons?.includes(person.id)) {
    score += 0.15
    signals.push({ label: '直近言及', weight: 0.15 })
  }
  
  return { score: Math.min(1.0, score), signals }
}

// ============================================================
// メインマッチング関数
// ============================================================

export async function matchPerson(
  text: string,
  context: MatchContext = {}
): Promise<PersonMatchResult> {
  const people = await getPeopleDictionary()
  if (people.length === 0) return { type: 'no_match' }
  
  // 全候補スコア算出
  const scored: PersonScore[] = people.map(p => {
    const { score, signals } = calculateScore(text, p, context)
    return { person: p, score, signals }
  })
  
  // スコア > 0 のものだけに絞る
  const significant = scored.filter(s => s.score >= 0.20)
  if (significant.length === 0) return { type: 'no_match' }
  
  // スコア降順ソート
  significant.sort((a, b) => b.score - a.score)
  const top = significant[0]
  const second = significant[1]
  
  // ------------------------------------------------------------
  // Case A: 絶対確信(自動確定)
  // ------------------------------------------------------------
  
  if (top.score >= 0.85) {
    return {
      type: 'confident',
      person: top.person,
      score: top.score,
      signals: top.signals,
    }
  }
  
  // ------------------------------------------------------------
  // Case B: 接戦(確認必要)
  // ------------------------------------------------------------
  
  if (second && top.score >= 0.50 && top.score - second.score < 0.15) {
    return {
      type: 'needs_confirmation',
      candidates: significant.slice(0, 3),
      question: buildConfirmationQuestion(significant.slice(0, 3)),
    }
  }
  
  // ------------------------------------------------------------
  // Case C: 単独候補だがスコア中程度
  // v1.0.1: 閾値を 0.50 → 0.40 に緩和(姓マッチ単体でも likely に上げる)
  // ------------------------------------------------------------
  
  if (top.score >= 0.40) {
    return {
      type: 'likely',
      person: top.person,
      score: top.score,
      signals: top.signals,
      should_confirm: top.score < 0.60,  // < 0.60 なら確認推奨
    }
  }
  
  return { type: 'no_match' }
}

// ============================================================
// 確認メッセージ生成
// ============================================================

function buildConfirmationQuestion(candidates: PersonScore[]): string {
  const list = candidates.map(c => {
    const { person } = c
    const parts = [person.name]
    if (person.company) parts.push(`(${person.company}`)
    if (person.position) parts.push(person.company ? `・${person.position})` : `(${person.position})`)
    else if (person.company) parts[parts.length - 1] += ')'
    return parts.join('')
  })
  return `どちらの方ですか? ${list.join(' / ')}`
}

// ============================================================
// 呼称の自動学習(NEW)
// ============================================================

/**
 * ある人物に対して新しい呼称が使われたら、DB に記録 or 回数を増やす
 */
export async function recordReferringExpression(
  personId: string,
  expression: string,
  expressionType: string = 'other',
  contextTag: string | null = null
): Promise<void> {
  const supabase = getSupabase()
  const normalized = expression.trim().toLowerCase()
  
  if (!normalized || normalized.length < 2) return
  
  try {
    // upsert: あれば count++, なければ新規
    const { data: existing } = await supabase
      .from('person_referring_expressions')
      .select('id, mention_count, confidence')
      .eq('person_id', personId)
      .eq('normalized', normalized)
      .maybeSingle<{ id: string; mention_count: number; confidence: number }>()
    
    if (existing) {
      const newCount = existing.mention_count + 1
      const newConf = Math.min(1.0, existing.confidence + 0.05)
      const updatePayload: Record<string, unknown> = {
        mention_count: newCount,
        confidence: newConf,
        last_used_at: new Date().toISOString(),
      }
      await supabase
        .from('person_referring_expressions')
        .update(updatePayload as never)
        .eq('id', existing.id)
    } else {
      const insertPayload: Record<string, unknown> = {
        person_id: personId,
        expression: expression,
        normalized,
        mention_count: 1,
        confidence: 0.5,
        expression_type: expressionType,
        context_tag: contextTag,
      }
      await supabase
        .from('person_referring_expressions')
        .insert(insertPayload as never)
    }
    
    // キャッシュ無効化
    invalidatePeopleCache()
  } catch (e) {
    console.warn('[PersonMatcher] recordReferringExpression error:', e)
  }
}

// ============================================================
// デバッグ用
// ============================================================

export function debugMatchResult(result: PersonMatchResult): string {
  switch (result.type) {
    case 'confident':
      return `✅ CONFIDENT: ${result.person.name} (score=${result.score.toFixed(2)})\n   signals: ${result.signals.map(s => s.label).join(', ')}`
    case 'likely':
      return `🟡 LIKELY: ${result.person.name} (score=${result.score.toFixed(2)}, confirm=${result.should_confirm})\n   signals: ${result.signals.map(s => s.label).join(', ')}`
    case 'needs_confirmation':
      const list = result.candidates.map(c => 
        `${c.person.name}(score=${c.score.toFixed(2)})`
      ).join(' / ')
      return `❓ NEEDS CONFIRMATION:\n   Q: ${result.question}\n   candidates: ${list}`
    case 'no_match':
      return `❌ NO MATCH`
  }
}