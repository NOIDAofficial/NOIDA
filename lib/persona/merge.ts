/**
 * Merge Core + MBTI
 * コアテンプレに MBTI 補正を重ねて最終的な persona prompt を作る
 */

import { CoreTemplate } from './core-template'
import { getMBTIModifier } from './mbti-modifiers'

export function mergeWithMBTI(core: CoreTemplate, mbti: string | null | undefined): string {
  const modifier = getMBTIModifier(mbti)

  if (!modifier) {
    // MBTI なしの場合はコアのみ
    return core.composed
  }

  const mbtiSection = `
# MBTI 補正: ${modifier.name}(${modifier.code})

## 話し方の温度
${modifier.tone}

## 返答の構造
${modifier.structure}

## 口癖(自然に混ぜる、連続使用は避ける)
${modifier.speech_quirks.map(s => `- ${s}`).join('\n')}

## 避ける表現
${modifier.avoid_expressions}

## フィードバックの型
${modifier.feedback_style}
`.trim()

  return `${core.composed}\n\n${mbtiSection}`
}
