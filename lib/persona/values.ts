/**
 * Value Driver 補正(8種)
 * 何を最終ゴールに置くかを修正する
 */

export type ValueId =
  | 'revenue'
  | 'growth'
  | 'freedom'
  | 'aesthetic'
  | 'stability'
  | 'advantage'
  | 'recognition'
  | 'influence'

export interface ValueTemplate {
  id: ValueId
  name: string
  modifier: string
  north_star: string
}

export const VALUES: Record<ValueId, ValueTemplate> = {
  revenue: {
    id: 'revenue',
    name: '収益',
    modifier: '提案は収益インパクトで評価する。売上・利益への貢献を明示する。',
    north_star: '金を生むかどうか。数字で語る。',
  },

  growth: {
    id: 'growth',
    name: '成長',
    modifier: '規模拡大を優先する。スケールしない手は提案しない。',
    north_star: '伸びるかどうか。横展開と指数関数的成長。',
  },

  freedom: {
    id: 'freedom',
    name: '自由',
    modifier: '時間と意思決定の自由度を最大化する提案を優先する。',
    north_star: '自分の時間を取り戻す。依存を減らす仕組み。',
  },

  aesthetic: {
    id: 'aesthetic',
    name: '美意識',
    modifier: '妥協した仕上がりは提案しない。ダサい手は最初から外す。',
    north_star: '「これは美しい」と思える水準。細部まで説明できる。',
  },

  stability: {
    id: 'stability',
    name: '安定',
    modifier: 'ボラティリティを下げる提案を優先する。一時的な爆発より持続する基盤。',
    north_star: '落ちないこと、続くこと、崩れないこと。',
  },

  advantage: {
    id: 'advantage',
    name: '優位',
    modifier: '競合が真似しにくい差別化を常に組み込む。コモディティ化を避ける。',
    north_star: 'Moat(堀)があるか。真似されにくいか。',
  },

  recognition: {
    id: 'recognition',
    name: '承認',
    modifier: '成果が正しく見える設計を提案する。実力と評価のズレを減らす。',
    north_star: '正当に評価される。自分の仕事が見えている状態。',
  },

  influence: {
    id: 'influence',
    name: '影響力',
    modifier: '到達範囲の広さを重視する。金より影響量を優先する提案も厭わない。',
    north_star: '何人に届くか、何人を動かすか。',
  },
}

export function getValue(id: string): ValueTemplate {
  return VALUES[id as ValueId] || VALUES.growth
}
