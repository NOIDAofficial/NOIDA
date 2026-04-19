/**
 * NOIDA Input Corrector v1.0
 * 
 * ユーザー入力の誤字・タイプミス・語順ミスを3層で訂正する。
 * 
 * 3層アーキテクチャ:
 *   Tier 1: 静的辞書(COMMON_TYPOS)  - 既知の誤字、即時訂正
 *   Tier 2: 個人辞書(user_input_patterns) - Takumaのクセ、学習型
 *   Tier 3: LLM推論(gpt-4o-mini) - 未知パターンに対応
 * 
 * Takumaの哲学:
 *   「その人の性質を根本的に理解する」
 *   → 使うほど NOIDA は Takuma を知る
 *   → 学習結果は user_input_patterns に永続化
 * 
 * 2026-04-20 Day 6 実装
 */

import { createClient } from '@supabase/supabase-js'
import { normalizeTypos, COMMON_TYPOS } from './dictionaries'

// ============================================================
// 型定義
// ============================================================

export type CorrectionResult = {
  original: string              // 元の入力
  corrected: string             // 訂正後
  was_corrected: boolean        // 訂正したか
  corrections: Array<{
    from: string
    to: string
    pattern_type: string
    source: 'dictionary' | 'personal' | 'llm_inference'
    confidence: number
  }>
  needs_user_confirmation: boolean  // ユーザー確認が必要か
  confirmation_question?: string    // 確認メッセージ
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
      .gte('confidence', 0.5)
      .returns<UserInputPattern[]>()
    
    if (error) {
      console.warn('[InputCorrector] personal patterns load failed:', error.message)
      return []
    }
    
    const patterns = data ?? []
    personalPatternsCache = { patterns, loadedAt: now }
    return patterns
  } catch (e) {
    console.warn('[InputCorrector] personal patterns error:', e)
    return []
  }
}

export function invalidatePersonalPatternsCache(): void {
  personalPatternsCache = null
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
// Tier 2: 個人辞書訂正
// ============================================================

async function applyPersonalCorrection(text: string): Promise<{
  corrected: string
  corrections: CorrectionResult['corrections']
}> {
  const patterns = await loadPersonalPatterns()
  let corrected = text
  const corrections: CorrectionResult['corrections'] = []
  
  // confidence 降順で試行(高確信のパターンを優先)
  const sorted = [...patterns].sort((a, b) => b.confidence - a.confidence)
  
  for (const p of sorted) {
    if (corrected.includes(p.original_input)) {
      corrected = corrected.split(p.original_input).join(p.corrected)
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
// Tier 3: LLM 推論(未知パターン用)
// ============================================================

async function applyLLMInference(
  text: string,
  precedingContext: string | null
): Promise<{
  corrected: string
  corrections: CorrectionResult['corrections']
  needsConfirmation: boolean
  confirmationQuestion?: string
}> {
  // 訂正が必要そうなサインがあるか判定
  const hasYappari = /やっぱり/.test(text)
  const hasUnusualCombination = /[あ-んア-ンー]{3,}.{0,2}[一-龯]/.test(text)
  const isVeryShort = text.trim().length < 4
  
  // これらのサインがなければ LLM 呼ばない(コスト節約)
  if (!hasYappari && !hasUnusualCombination && !isVeryShort) {
    return { corrected: text, corrections: [], needsConfirmation: false }
  }
  
  // LLM で推論
  try {
    const contextLine = precedingContext 
      ? `直前のNOIDAの応答: "${precedingContext.substring(0, 200)}"`
      : '直前の文脈なし'
    
    const prompt = `以下のユーザー入力に誤字やタイプミス、語順ミスがあれば訂正せよ。
${contextLine}
ユーザー入力: "${text}"

判定基準:
- 明らかな誤字・タイプミス → 訂正する
- 「やっぱり」が含まれ動詞が不明瞭 → 直前操作の取り消しを推測
- 音声認識エラー(同音異義語)の可能性 → 文脈で判断
- 正常な入力 → そのまま返す

JSON形式で返答(他の文字は一切含めない):
{
  "corrected": "訂正後の文章",
  "was_corrected": true/false,
  "pattern_type": "typo" | "word_order" | "voice_recognition" | "grammatical" | "other",
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
        temperature: 0.1,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? ''
    const jsonStr = content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1)
    const parsed = JSON.parse(jsonStr)
    
    if (!parsed.was_corrected || parsed.corrected === text) {
      return { corrected: text, corrections: [], needsConfirmation: false }
    }
    
    const corrections: CorrectionResult['corrections'] = [{
      from: text,
      to: parsed.corrected,
      pattern_type: parsed.pattern_type || 'other',
      source: 'llm_inference',
      confidence: parsed.confidence || 0.5,
    }]
    
    return {
      corrected: parsed.corrected,
      corrections,
      needsConfirmation: parsed.needs_confirmation || parsed.confidence < 0.7,
      confirmationQuestion: parsed.confirmation_question || undefined,
    }
  } catch (e) {
    console.warn('[InputCorrector] LLM inference error:', e)
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
  
  try {
    const supabase = getSupabase()
    
    // upsert: 既存ならcount++、なければ新規
    const { data: existing } = await supabase
      .from('user_input_patterns')
      .select('id, mention_count, confidence')
      .eq('original_input', original)
      .maybeSingle<{ id: string; mention_count: number; confidence: number }>()
    
    if (existing) {
      const newCount = existing.mention_count + 1
      // user_confirmed 起点なら信頼度up、LLM起点は控えめに上昇
      const confBoost = source === 'user_confirmed' ? 0.10 : 0.05
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
      const insertPayload: Record<string, unknown> = {
        original_input: original,
        corrected,
        pattern_type: patternType,
        action_category: actionCategory,
        preceding_context: precedingContext?.substring(0, 200) ?? null,
        correction_source: source,
        mention_count: 1,
        confidence: source === 'user_confirmed' ? 0.85 : 0.5,
        user_confirmed: source === 'user_confirmed',
      }
      
      await supabase
        .from('user_input_patterns')
        .insert(insertPayload as never)
    }
    
    invalidatePersonalPatternsCache()
  } catch (e) {
    console.warn('[InputCorrector] recordInputPattern error:', e)
  }
}

// ============================================================
// メイン関数:3層統合訂正
// ============================================================

export async function correctInput(
  text: string,
  precedingContext: string | null = null
): Promise<CorrectionResult> {
  const original = text
  let current = text
  const allCorrections: CorrectionResult['corrections'] = []
  
  // ------------------------------------------------------------
  // Tier 1: 静的辞書(同期、高速、0コスト)
  // ------------------------------------------------------------
  const tier1 = applyDictionaryCorrection(current)
  current = tier1.corrected
  allCorrections.push(...tier1.corrections)
  
  // ------------------------------------------------------------
  // Tier 2: 個人辞書(Supabase、5分キャッシュ)
  // ------------------------------------------------------------
  const tier2 = await applyPersonalCorrection(current)
  current = tier2.corrected
  allCorrections.push(...tier2.corrections)
  
  // ------------------------------------------------------------
  // Tier 3: LLM推論(必要時のみ)
  // ------------------------------------------------------------
  let needsConfirmation = false
  let confirmationQuestion: string | undefined
  
  if (allCorrections.length === 0) {
    // Tier 1 も Tier 2 もヒットしなかった場合のみLLM
    const tier3 = await applyLLMInference(current, precedingContext)
    current = tier3.corrected
    allCorrections.push(...tier3.corrections)
    needsConfirmation = tier3.needsConfirmation
    confirmationQuestion = tier3.confirmationQuestion
  }
  
  // ------------------------------------------------------------
  // 学習: LLM 推論結果を個人辞書に保存
  // ------------------------------------------------------------
  for (const c of allCorrections) {
    if (c.source === 'llm_inference') {
      // 非同期で保存(応答をブロックしない)
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
    original,
    corrected: current,
    was_corrected: allCorrections.length > 0 && current !== original,
    corrections: allCorrections,
    needs_user_confirmation: needsConfirmation,
    confirmation_question: confirmationQuestion,
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
  return lines.join('\n')
}