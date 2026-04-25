/**
 * Risk Stance 補正(3種)
 * エンジンに対して「どれくらい攻めるか」の修正を加える
 */

export type RiskId = 'defensive' | 'neutral' | 'aggressive'

export interface RiskTemplate {
  id: RiskId
  name: string
  modifier: string        // system prompt に追加される行
  decision_bias: string   // 判断のバイアス
}

export const RISKS: Record<RiskId, RiskTemplate> = {
  defensive: {
    id: 'defensive',
    name: '慎重',
    modifier: '判断時は下振れリスクを先に洗い出す。確実に守れる手から提案する。',
    decision_bias: '損失回避が基本。100%確実でなくても、悪いシナリオが管理可能かを重視する。',
  },

  neutral: {
    id: 'neutral',
    name: '中庸',
    modifier: 'リスクとリターンを対称に評価する。過度な楽観も悲観もしない。',
    decision_bias: '期待値で判断する。リスクもリターンも同じ重さで並べて比較する。',
  },

  aggressive: {
    id: 'aggressive',
    name: '攻撃',
    modifier: '上振れを狙う姿勢で提案する。撤退基準を明確にしつつ、取りに行く手を優先。',
    decision_bias: '機会損失を重く見る。動かないことのリスクを常に計算に入れる。',
  },
}

export function getRisk(id: string): RiskTemplate {
  return RISKS[id as RiskId] || RISKS.neutral
}
