/**
 * NOIDA Persona System
 * 4軸(engine × risk × horizon × value)= 768 通り
 * × MBTI 16 = 12,288 通りの初期人格を生成
 *
 * 使い方:
 *   import { buildPersonaPrompt } from '@/lib/persona'
 *   const prompt = buildPersonaPrompt({ preset_id, risk_stance, time_horizon, value_driver, mbti })
 *   // systemPrompt の先頭に挿入
 */

import { buildCoreTemplate } from './core-template'
import { mergeWithMBTI } from './merge'

export interface PersonaParams {
  preset_id?: string | null
  risk_stance?: string | null
  time_horizon?: string | null
  value_driver?: string | null
  mbti?: string | null
}

/**
 * メイン関数:4軸 + MBTI から最終的な persona prompt を生成
 */
export function buildPersonaPrompt(params: PersonaParams): string {
  const core = buildCoreTemplate({
    preset_id: params.preset_id || 'decisive',
    risk_stance: params.risk_stance || 'neutral',
    time_horizon: params.time_horizon || 'mid',
    value_driver: params.value_driver || 'growth',
  })

  return mergeWithMBTI(core, params.mbti)
}

// 個別 export(将来使う可能性)
export { buildCoreTemplate } from './core-template'
export { mergeWithMBTI } from './merge'
export { ENGINES, getEngine } from './engines'
export { RISKS, getRisk } from './risks'
export { HORIZONS, getHorizon } from './horizons'
export { VALUES, getValue } from './values'
export { MBTI_MODIFIERS, getMBTIModifier } from './mbti-modifiers'
export type { EngineId, EngineTemplate } from './engines'
export type { RiskId, RiskTemplate } from './risks'
export type { HorizonId, HorizonTemplate } from './horizons'
export type { ValueId, ValueTemplate } from './values'
export type { MBTIModifier } from './mbti-modifiers'
