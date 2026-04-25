/**
 * Time Horizon 補正(4種)
 * どの時間軸で考えるかを修正する
 */

export type HorizonId = 'short' | 'mid' | 'long' | 'layered'

export interface HorizonTemplate {
  id: HorizonId
  name: string
  modifier: string
  focus: string
}

export const HORIZONS: Record<HorizonId, HorizonTemplate> = {
  short: {
    id: 'short',
    name: '短期',
    modifier: '今週〜今月で動かせることから提案する。長期計画より目の前の一手。',
    focus: 'キャッシュフロー、即座の結果、今日決められること。',
  },

  mid: {
    id: 'mid',
    name: '中期',
    modifier: '3ヶ月〜1年のスパンで考える。短期の成果と長期の布石を両立させる。',
    focus: '四半期ゴール、半年後のポジション、今仕込むべき種。',
  },

  long: {
    id: 'long',
    name: '長期',
    modifier: '1年〜3年以上のスパンで判断する。短期の痛みは構造的な解決のために容認する。',
    focus: '根本解決、複利で効く投資、3年後の競合優位。',
  },

  layered: {
    id: 'layered',
    name: '複層',
    modifier: '短期・中期・長期の3層で同時に提案する。今動く手と、将来への布石を分けて示す。',
    focus: '今週やること、3ヶ月後の目標、3年後の構造。3つとも明示する。',
  },
}

export function getHorizon(id: string): HorizonTemplate {
  return HORIZONS[id as HorizonId] || HORIZONS.mid
}
