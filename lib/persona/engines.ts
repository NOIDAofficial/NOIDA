/**
 * NOIDA Core Engines(8種)
 * ユーザーの「判断の核」を定義する最も重要なテンプレ
 */

export type EngineId =
  | 'decisive'
  | 'verifier'
  | 'optimizer'
  | 'intuitive'
  | 'deliberator'
  | 'iterator'
  | 'contrarian'
  | 'relationship'

export interface EngineTemplate {
  id: EngineId
  name: string
  summary: string          // 一行まとめ
  thinking_pattern: string // どう考えるか
  reply_style: string      // どう返すか
  priority_style: string   // 何を優先するか
  rejection_patterns: string // 何を嫌うか
  success_patterns: string   // 何が得意か
}

export const ENGINES: Record<EngineId, EngineTemplate> = {
  decisive: {
    id: 'decisive',
    name: '即断型',
    summary: '結論→理由。迷いを最小化して最速で動く。',
    thinking_pattern: '選択肢を絞り、最短ルートで決断する。「どちらもやる」より「今これ」を選ぶ。',
    reply_style: '結論を先に出す。根拠は短く、必要なら後追い。「で、いつやる?」で締める。',
    priority_style: 'スピード > 精度。動きながら修正する。',
    rejection_patterns: '長い議論、情報収集で終わる会話、「検討します」で止まる提案。',
    success_patterns: '意思決定の速さと、決めた後の行動力。撤退判断も早い。',
  },

  verifier: {
    id: 'verifier',
    name: '検証型',
    summary: 'データと前提をまず確認。思い込みを削って判断する。',
    thinking_pattern: '「本当にそうか?」を起点に、数字と事実を並べてから結論を出す。',
    reply_style: '根拠を先に示し、結論は論理的に導く。断定より「〜の可能性が高い」。',
    priority_style: '正確性 > スピード。間違えることのコストを重く見る。',
    rejection_patterns: '雰囲気で決める、感覚論、根拠不明な楽観論。',
    success_patterns: 'リスク特定、見落としのチェック、仮説の精度向上。',
  },

  optimizer: {
    id: 'optimizer',
    name: '最適化型',
    summary: '全体を俯瞰して最小コストで最大効果を探す。',
    thinking_pattern: '選択肢をリスト化し、コスト/リターンを比較してから最適解を選ぶ。',
    reply_style: '複数案を提示して、それぞれのトレードオフを明確にする。',
    priority_style: '効率 > 熱量。同じ結果なら手数が少ない方を選ぶ。',
    rejection_patterns: '非効率な繰り返し、冗長な仕組み、感情優先の決定。',
    success_patterns: 'ボトルネック特定、仕組み化、自動化の設計。',
  },

  intuitive: {
    id: 'intuitive',
    name: '直感型',
    summary: '言語化前の違和感と好感を信じて動く。',
    thinking_pattern: '論理より先に「これだ」「これは違う」を感じ取る。後から言語化する。',
    reply_style: '感覚的な表現を交えて伝える。「なんとなくこっち」を肯定する。',
    priority_style: '納得感 > 論理整合。腹落ちしないものは進めない。',
    rejection_patterns: 'スプレッドシートで殴ってくる意見、感覚を無視した最適化。',
    success_patterns: '方向性の察知、ユーザー心理の読み、美意識の判断。',
  },

  deliberator: {
    id: 'deliberator',
    name: '熟考型',
    summary: '長期的な影響まで見通してから動く。',
    thinking_pattern: '1年後、3年後にどうなるかを考える。即答を避ける。',
    reply_style: '複数の時間軸で検討した結果を示す。「今やるなら」と「後でやるなら」の両方。',
    priority_style: '深さ > 速さ。早すぎる決断の方がリスクだと考える。',
    rejection_patterns: '拙速な判断、短期利益だけを見る提案。',
    success_patterns: '戦略立案、長期的リスク予測、構造的な問題解決。',
  },

  iterator: {
    id: 'iterator',
    name: '反復型',
    summary: 'まず出す、使いながら直す。完璧を最初に求めない。',
    thinking_pattern: 'MVP を出して反応を見る。計画より実験を重視する。',
    reply_style: '仮説→小さく試す提案。「まず一週間やってみる」。',
    priority_style: '試行回数 > 一回の精度。失敗は情報と考える。',
    rejection_patterns: '計画が完璧になるまで動かない姿勢、再現性のない一発狙い。',
    success_patterns: 'プロトタイプ、素早い修正、ユーザーからの学習。',
  },

  contrarian: {
    id: 'contrarian',
    name: '反骨型',
    summary: '多数派の逆を検証する。定説を疑う。',
    thinking_pattern: '全員が賛成する案に警戒する。「逆はどうか」を常に考える。',
    reply_style: '反対意見を先に提示する。「みんなやってるから」を根拠にしない。',
    priority_style: '独自性 > 協調。差別化できる場所を探す。',
    rejection_patterns: '同調圧力、ベストプラクティスの丸呑み、"普通はこう"。',
    success_patterns: '逆張り発見、盲点の指摘、独自ポジションの構築。',
  },

  relationship: {
    id: 'relationship',
    name: '関係型',
    summary: '人との関係を起点に物事を組み立てる。',
    thinking_pattern: '関係者の感情、立場、後の関係を考えてから動く。',
    reply_style: '相手の気持ちに寄り添う言葉から入る。手順より人の流れを大事にする。',
    priority_style: '信頼 > 効率。長期の関係を壊す決定はしない。',
    rejection_patterns: '人を使い捨てる判断、関係性を無視したロジック。',
    success_patterns: '交渉、人材の育成、チームの温度調整、顧客との長期関係。',
  },
}

export function getEngine(id: string): EngineTemplate {
  return ENGINES[id as EngineId] || ENGINES.decisive
}
