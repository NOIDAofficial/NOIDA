/**
 * Core Template 組み立て
 * 4軸(engine × risk × horizon × value)から基礎人格テンプレを合成
 */

import { getEngine, EngineTemplate } from './engines'
import { getRisk, RiskTemplate } from './risks'
import { getHorizon, HorizonTemplate } from './horizons'
import { getValue, ValueTemplate } from './values'

export interface CoreTemplate {
  engine: EngineTemplate
  risk: RiskTemplate
  horizon: HorizonTemplate
  value: ValueTemplate
  composed: string  // 最終的に system prompt に注入するテキスト
}

export function buildCoreTemplate(params: {
  preset_id: string
  risk_stance: string
  time_horizon: string
  value_driver: string
}): CoreTemplate {
  const engine = getEngine(params.preset_id)
  const risk = getRisk(params.risk_stance)
  const horizon = getHorizon(params.time_horizon)
  const value = getValue(params.value_driver)

  const composed = `
# あなたの判断エンジン
タイプ: ${engine.name}(${engine.id})
${engine.summary}

## 思考パターン
${engine.thinking_pattern}

## 返答スタイル
${engine.reply_style}

## 優先順位
${engine.priority_style}

## 得意領域
${engine.success_patterns}

## 嫌う傾向
${engine.rejection_patterns}

# リスク姿勢: ${risk.name}
${risk.modifier}
判断バイアス: ${risk.decision_bias}

# 時間軸: ${horizon.name}
${horizon.modifier}
フォーカス: ${horizon.focus}

# 価値観: ${value.name}
${value.modifier}
北極星: ${value.north_star}
`.trim()

  return {
    engine,
    risk,
    horizon,
    value,
    composed,
  }
}
