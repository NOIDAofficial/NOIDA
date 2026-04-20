/**
 * NOIDA Input Corrector v1.7.4
 * 
 * 【設計原則: 二層の正しさ(Dual Correctness Principle)】
 *   言葉には 2 つの正しさが同時に存在する:
 *   - Layer A (original): オーナーの生の言葉(意図の層)
 *   - Layer B (corrected): 訂正・補完した言葉(形式の層)
 *   
 *   v1.7.4 の訂正機能は「Layer B を作る」ためだけに存在する。
 *   これは NOIDA が理解するための内部処理であり、
 *   Layer A を書き換える権利を NOIDA は持たない。
 * 
 * 【v1.7.4 の変更点】
 *   1. プロンプト厳格化(誤字・音声認識エラーのみに訂正を限定)
 *   2. validateCorrection 追加(訂正結果の白リスト検証)
 *   3. confidence デフォルト値を 0.5 → 0.3 に下げる
 *   4. mention_count >= 3 で初めて適用開始(1-2回目は保存のみ)
 *   5. 応答文生成の検出・拒否(「了解。」など絶対付け足さない)
 * 
 * 【Takuma の哲学(原則11)】
 *   「NOIDAは誤字修正した正しい文章から何が言いたいのかを
 *   しっかり理解した上で、オーナーの言ってることを
 *   正確に探して処理させないといけない」
 * 
 * 2026-04-20 Day 7 実装(v1.7.4)
 */

import { createClient } from '@supabase/supabase-js'
import { normalizeTypos, COMMON_TYPOS } from './dictionaries'

// ============================================================
// 型定義
// ============================================================

export type CorrectionResult = {
  original: string              // Layer A: オーナーの生の言葉
  corrected: string             // Layer B: 訂正・補完した言葉
  was_corrected: boolean        // 訂正したか
  corrections: Array<{
    from: string
    to: string
    pattern_type: string
    source: 'dictionary' | 'personal' | 'llm_inference'
    confidence: number
  }>
  needs_user_confirmation: boolean
  confirmation_question?: string
  validation_failed?: boolean   // ★v1.7.4: 検証失敗の記録
}

type UserInputPattern = {
  id: string
  original_input: string
  corrected: string
  pattern_type: string
  action_category: string | null
  confidence: number
  mention_count: number
  user_confirmed: boolean
  user_rejected: boolean
}

// ============================================================
// Supabase クライアント
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

// ============================================================
// 個人辞書キャッシュ(TTL 5分)
// ============================================================

let personalPatternsCache: {
  patterns: UserInputPattern[]
  loadedAt: number
} | null = null

const PATTERNS_TTL_MS = 5 * 60 * 1000

async function loadPersonalPatterns(): Promise<UserInputPattern[]> {
  const now = Date.now()
  if (personalPatternsCache && now - personalPatternsCache.loadedAt < PATTERNS_TTL_MS) {
    return personalPatternsCache.patterns
  }
  
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('user_input_patterns')
      .select('id, original_input, corrected, pattern_type, action_category, confidence, mention_count, user_confirmed, user_rejected')
      .eq('user_rejected', false)
      // ★v1.7.4: mention_count >= 3 の成熟したパターンのみ適用
      //   1-2回目の訂正は「観察」のみ、3回目から「適用」
      //   これにより LLM の気まぐれ訂正が個人辞書に固定化されるのを防ぐ
      .gte('mention_count', 3)
      .gte('confidence', 0.5)
      .returns<UserInputPattern[]>()
    
    if (error) {
      console.warn('[InputCorrector v1.7.4] personal patterns load failed:', error.message)
      return []
    }
    
    const patterns = data ?? []
    personalPatternsCache = { patterns, loadedAt: now }
    return patterns
  } catch (e) {
    console.warn('[InputCorrector v1.7.4] personal patterns error:', e)
    return []
  }
}

export function invalidatePersonalPatternsCache(): void {
  personalPatternsCache = null
}

// ============================================================
// ★v1.7.4: 訂正結果のバリデーション(白リスト方式)
// ============================================================
/**
 * 原則11 違反の訂正を検出して reject する
 * - 過剰な長さ変化
 * - 応答文的な接頭辞の付加
 * - 大幅な書き換え
 */
function validateCorrection(
  original: string,
  corrected: string
): { valid: boolean; reason?: string } {
  // 完全一致は訂正なし(valid)
  if (original === corrected) {
    return { valid: true }
  }
  
  // 1. 文字数変化が極端なら reject
  const lenDiff = Math.abs(corrected.length - original.length)
  const maxAllowedDiff = Math.max(3, Math.ceil(original.length * 0.25))
  if (lenDiff > maxAllowedDiff) {
    return {
      valid: false,
      reason: `length_change_too_large (diff=${lenDiff}, max=${maxAllowedDiff})`,
    }
  }
  
  // 2. 応答文的な接頭辞を絶対に許可しない
  //   「了解。」「はい。」「わかりました。」などは NOIDA の応答文であって訂正ではない
  const RESPONSE_PREFIX_PATTERN = 
    /^(了解|はい|承知|わかりました|かしこまりました|OK|ok|Yes|yes)[。\.、,!!??\s]/
  if (RESPONSE_PREFIX_PATTERN.test(corrected) && !RESPONSE_PREFIX_PATTERN.test(original)) {
    return {
      valid: false,
      reason: 'response_prefix_added',
    }
  }
  
  // 3. 語尾の付け足し(文の意味を変える)を検出
  //   「会議」→「会議がある」「会議を追加」などは原則違反
  const SUSPICIOUS_SUFFIX_PATTERN = 
    /(がある|がない|を追加|を削除|を消す|を保存|してください|しました)$/
  const hasSuspiciousSuffixAdded = 
    SUSPICIOUS_SUFFIX_PATTERN.test(corrected) && 
    !SUSPICIOUS_SUFFIX_PATTERN.test(original)
  if (hasSuspiciousSuffixAdded) {
    return {
      valid: false,
      reason: 'suspicious_suffix_added',
    }
  }
  
  // 4. 元テキストが訂正後に実質含まれているか
  //   訂正とは「誤りを直す」ことであって、全く別の文章にすることではない
  const normOriginal = original.replace(/[\s。、,.!?!?]/g, '').toLowerCase()
  const normCorrected = corrected.replace(/[\s。、,.!?!?]/g, '').toLowerCase()
  
  if (normOriginal.length >= 4) {
    // 元テキストの先頭 60% が訂正後に含まれていなければ疑わしい
    const checkLen = Math.floor(normOriginal.length * 0.6)
    const checkPrefix = normOriginal.substring(0, checkLen)
    if (!normCorrected.includes(checkPrefix)) {
      return {
        valid: false,
        reason: 'substantial_rewrite_detected',
      }
    }
  }
  
  return { valid: true }
}

// ============================================================
// Tier 1: 静的辞書訂正(同期、高速)
// ============================================================

function applyDictionaryCorrection(text: string): {
  corrected: string
  corrections: CorrectionResult['corrections']
} {
  const { normalized, corrections: raw } = normalizeTypos(text)
  const corrections: CorrectionResult['corrections'] = raw.map(c => ({
    from: c.from,
    to: c.to,
    pattern_type: c.pattern_type,
    source: 'dictionary' as const,
    confidence: 0.95,
  }))
  return { corrected: normalized, corrections }
}

// ============================================================
// Tier 2: 個人辞書訂正(成熟パターンのみ)
// ============================================================

async function applyPersonalCorrection(text: string): Promise<{
  corrected: string
  corrections: CorrectionResult['corrections']
}> {
  const patterns = await loadPersonalPatterns()
  let corrected = text
  const corrections: CorrectionResult['corrections'] = []
  
  // confidence 降順で試行
  const sorted = [...patterns].sort((a, b) => b.confidence - a.confidence)
  
  for (const p of sorted) {
    if (corrected.includes(p.original_input)) {
      const candidateText = corrected.split(p.original_input).join(p.corrected)
      
      // ★v1.7.4: 個人辞書の適用にもバリデーションを通す
      //   過去に学習されたパターンでも、今回のコンテキストで問題があれば reject
      const validation = validateCorrection(corrected, candidateText)
      if (!validation.valid) {
        console.warn('[InputCorrector v1.7.4] Personal pattern rejected:', {
          pattern: `${p.original_input} → ${p.corrected}`,
          reason: validation.reason,
        })
        continue
      }
      
      corrected = candidateText
      corrections.push({
        from: p.original_input,
        to: p.corrected,
        pattern_type: p.pattern_type,
        source: 'personal',
        confidence: p.confidence,
      })
    }
  }
  
  return { corrected, corrections }
}

// ============================================================
// Tier 3: LLM 推論(厳格プロンプト + バリデーション)
// ============================================================

/**
 * ★v1.7.4: 厳格化されたプロンプト
 *   Takuma の原則11 に準拠し、以下の訂正のみを許可する:
 *   - 明らかな誤字・タイプミス(変換ミス)
 *   - 音声認識エラー(同音異義)
 *   - 明らかなタイプミスの末尾崩れ
 *   
 *   以下は絶対に訂正しない:
 *   - 助詞の追加・削除
 *   - 敬語化・口語化
 *   - 句読点の追加
 *   - 応答文の生成
 *   - 語尾の付け足し
 */
async function applyLLMInference(
  text: string,
  precedingContext: string | null
): Promise<{
  corrected: string
  corrections: CorrectionResult['corrections']
  needsConfirmation: boolean
  confirmationQuestion?: string
  validationFailed?: boolean
}> {
  // 訂正が必要そうなサインがあるか判定
  const hasYappari = /やっぱり/.test(text)
  const hasUnusualCombination = /[あ-んア-ンー]{3,}.{0,2}[一-龯]/.test(text)
  const isVeryShort = text.trim().length < 4
  
  if (!hasYappari && !hasUnusualCombination && !isVeryShort) {
    return { corrected: text, corrections: [], needsConfirmation: false }
  }
  
  try {
    const contextLine = precedingContext 
      ? `直前のNOIDAの応答: "${precedingContext.substring(0, 200)}"`
      : '直前の文脈なし'
    
    // ★v1.7.4: 厳格化されたプロンプト
    const prompt = `あなたはユーザー入力の「明らかな誤字・タイプミス・音声認識エラー」だけを訂正するシステムです。

${contextLine}
ユーザー入力: "${text}"

★訂正して良いもの(これだけ):
- 変換ミス(例: 「かいぎ」→「会議」)
- 音声認識エラー(同音異義語の誤り)
- タイプミスの末尾崩れ(例: 「田中さm」→「田中さん」)
- 「やっぱり」で動詞が不明瞭な場合の直前操作の補完(文脈から明らか)

★絶対に訂正してはいけないもの:
- 助詞の追加(「○○に」「○○を」「○○が」を勝手に付けない)
- 助詞の削除
- 敬語化(「教えて」→「教えてください」にしない)
- 口語化
- 句読点の追加(「会議」→「会議。」にしない)
- 句読点の削除
- 語尾の付け足し(「会議」→「会議がある」「会議を追加」にしない)
- 応答文の生成(文頭に「了解。」「はい。」「わかりました。」を絶対に付けない)
- 省略された主語の補完
- 文の意味を変える変更

★原則:
- 入力が「不完全でも意味が理解可能」なら訂正しない
- 迷ったら訂正しない(was_corrected: false を返す)
- 訂正は「誤字を直す」ことであって「文を整える」ことではない

JSON形式で返答(他の文字は一切含めない):
{
  "corrected": "訂正後の文章(訂正不要なら原文そのまま)",
  "was_corrected": true/false,
  "pattern_type": "typo" | "voice_recognition" | "yappari_inference" | "none",
  "confidence": 0.0-1.0,
  "needs_confirmation": true/false,
  "confirmation_question": "ユーザー確認が必要ならここに質問文、不要なら空文字"
}`
    
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.0,  // ★v1.7.4: 最も保守的な温度
        max_tokens: 200,
        response_format: { type: 'json_object' },  // ★v1.7.4: JSON強制
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? ''
    const jsonStr = content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1)
    const parsed = JSON.parse(jsonStr)
    
    // 訂正なしパターン
    if (!parsed.was_corrected || parsed.corrected === text || !parsed.corrected) {
      return { corrected: text, corrections: [], needsConfirmation: false }
    }
    
    // ★v1.7.4: バリデーション実行
    const validation = validateCorrection(text, parsed.corrected)
    if (!validation.valid) {
      console.warn('[InputCorrector v1.7.4] LLM correction rejected:', {
        original: text,
        attempted: parsed.corrected,
        reason: validation.reason,
      })
      return { 
        corrected: text, 
        corrections: [], 
        needsConfirmation: false,
        validationFailed: true,
      }
    }
    
    const corrections: CorrectionResult['corrections'] = [{
      from: text,
      to: parsed.corrected,
      pattern_type: parsed.pattern_type || 'other',
      source: 'llm_inference',
      confidence: parsed.confidence || 0.3,  // ★v1.7.4: デフォルト 0.5 → 0.3
    }]
    
    return {
      corrected: parsed.corrected,
      corrections,
      // ★v1.7.4: confidence < 0.7 で必ずユーザー確認(0.7 → 0.8 に引き上げも検討)
      needsConfirmation: parsed.needs_confirmation || parsed.confidence < 0.8,
      confirmationQuestion: parsed.confirmation_question || undefined,
    }
  } catch (e) {
    console.warn('[InputCorrector v1.7.4] LLM inference error:', e)
    return { corrected: text, corrections: [], needsConfirmation: false }
  }
}

// ============================================================
// 学習:訂正結果を個人辞書に保存
// ============================================================

export async function recordInputPattern(
  original: string,
  corrected: string,
  patternType: string,
  source: 'dictionary' | 'personal' | 'llm_inference' | 'user_confirmed',
  actionCategory: string | null = null,
  precedingContext: string | null = null
): Promise<void> {
  if (original === corrected) return
  if (original.trim().length < 2) return
  
  // ★v1.7.4: 学習前にも最終バリデーション
  const validation = validateCorrection(original, corrected)
  if (!validation.valid) {
    console.warn('[InputCorrector v1.7.4] Learning rejected (validation failed):', {
      original,
      corrected,
      reason: validation.reason,
    })
    return
  }
  
  try {
    const supabase = getSupabase()
    
    const { data: existing } = await supabase
      .from('user_input_patterns')
      .select('id, mention_count, confidence')
      .eq('original_input', original)
      .maybeSingle<{ id: string; mention_count: number; confidence: number }>()
    
    if (existing) {
      const newCount = existing.mention_count + 1
      // ★v1.7.4: confidence boost を小さめに
      const confBoost = source === 'user_confirmed' ? 0.10 : 0.03
      const newConf = Math.min(0.99, existing.confidence + confBoost)
      
      const updatePayload: Record<string, unknown> = {
        mention_count: newCount,
        confidence: newConf,
        last_seen_at: new Date().toISOString(),
      }
      if (source === 'user_confirmed') {
        updatePayload.user_confirmed = true
        updatePayload.correction_source = 'user_confirmed'
      }
      
      await supabase
        .from('user_input_patterns')
        .update(updatePayload as never)
        .eq('id', existing.id)
    } else {
      // ★v1.7.4: 初回登録は confidence 0.3(低く開始)
      const initialConfidence = source === 'user_confirmed' ? 0.85 : 0.3
      
      const insertPayload: Record<string, unknown> = {
        original_input: original,
        corrected,
        pattern_type: patternType,
        action_category: actionCategory,
        preceding_context: precedingContext?.substring(0, 200) ?? null,
        correction_source: source,
        mention_count: 1,
        confidence: initialConfidence,
        user_confirmed: source === 'user_confirmed',
      }
      
      await supabase
        .from('user_input_patterns')
        .insert(insertPayload as never)
    }
    
    invalidatePersonalPatternsCache()
  } catch (e) {
    console.warn('[InputCorrector v1.7.4] recordInputPattern error:', e)
  }
}

// ============================================================
// メイン関数:3層統合訂正(二層の正しさ原則に準拠)
// ============================================================
/**
 * 【Takuma の原則11: 二層の正しさ】
 *   - 返り値の original は絶対に変更されない(Layer A の保全)
 *   - 返り値の corrected は NOIDA の内部理解用(Layer B)
 *   - 呼び出し側は Layer A を DB 保存・検索・応答に使い、
 *     Layer B を intent 分類・意図抽出にのみ使うこと
 */
export async function correctInput(
  text: string,
  precedingContext: string | null = null
): Promise<CorrectionResult> {
  const original = text  // ★ Layer A(不可侵)
  let current = text     // Layer B の構築用
  const allCorrections: CorrectionResult['corrections'] = []
  let validationFailed = false
  
  // ------------------------------------------------------------
  // Tier 1: 静的辞書(同期、高速、0コスト)
  // ------------------------------------------------------------
  const tier1 = applyDictionaryCorrection(current)
  // ★v1.7.4: Tier 1 の結果もバリデーション
  const tier1Validation = validateCorrection(current, tier1.corrected)
  if (tier1Validation.valid) {
    current = tier1.corrected
    allCorrections.push(...tier1.corrections)
  } else {
    console.warn('[InputCorrector v1.7.4] Tier 1 rejected:', tier1Validation.reason)
  }
  
  // ------------------------------------------------------------
  // Tier 2: 個人辞書(成熟パターン mention_count >= 3 のみ)
  // ------------------------------------------------------------
  const tier2 = await applyPersonalCorrection(current)
  current = tier2.corrected
  allCorrections.push(...tier2.corrections)
  
  // ------------------------------------------------------------
  // Tier 3: LLM推論(必要時のみ、バリデーション必須)
  // ------------------------------------------------------------
  let needsConfirmation = false
  let confirmationQuestion: string | undefined
  
  if (allCorrections.length === 0) {
    const tier3 = await applyLLMInference(current, precedingContext)
    current = tier3.corrected
    allCorrections.push(...tier3.corrections)
    needsConfirmation = tier3.needsConfirmation
    confirmationQuestion = tier3.confirmationQuestion
    if (tier3.validationFailed) validationFailed = true
  }
  
  // ------------------------------------------------------------
  // 学習: LLM 推論結果を個人辞書に保存
  //   ★v1.7.4: validateCorrection を通ったもののみ学習される
  //             (recordInputPattern 内で再度検証)
  // ------------------------------------------------------------
  for (const c of allCorrections) {
    if (c.source === 'llm_inference') {
      recordInputPattern(
        original,
        current,
        c.pattern_type,
        'llm_inference',
        null,
        precedingContext
      ).catch(() => {})
    }
  }
  
  return {
    original,                                      // Layer A(不可侵)
    corrected: current,                            // Layer B(内部理解用)
    was_corrected: allCorrections.length > 0 && current !== original,
    corrections: allCorrections,
    needs_user_confirmation: needsConfirmation,
    confirmation_question: confirmationQuestion,
    validation_failed: validationFailed,
  }
}

// ============================================================
// デバッグ用
// ============================================================

export function debugCorrection(result: CorrectionResult): string {
  if (!result.was_corrected) {
    return `✓ 訂正不要: "${result.original}"`
  }
  const lines = [
    `📝 訂正: "${result.original}" → "${result.corrected}"`,
  ]
  for (const c of result.corrections) {
    lines.push(`  - [${c.source}] "${c.from}" → "${c.to}" (${c.pattern_type}, conf=${c.confidence.toFixed(2)})`)
  }
  if (result.needs_user_confirmation) {
    lines.push(`  ⚠️ 確認: ${result.confirmation_question}`)
  }
  if (result.validation_failed) {
    lines.push(`  ❌ バリデーション失敗(訂正を却下)`)
  }
  return lines.join('\n')
}