export type Role = 'noida' | 'user'

/**
 * Option - ボタン選択肢
 * 
 * v1.6: 構造化ペイロード対応
 * - candidate_id: pending_confirmation の候補ID(削除対象などを識別)
 * - undo_token: 実行済み操作の取り消し用トークン
 */
export interface Option {
  num: string
  text: string
  // v1.6: ボタン契約
  candidate_id?: string         // 候補選択ボタン用
  undo_token?: string           // Undo ボタン用
  kind?: 'candidate' | 'undo' | 'plain'  // ボタンの種類(省略時は plain)
}

/**
 * Message - チャットメッセージ
 * 
 * v1.6: mutation サポート
 * - confirmation_id: サーバー側の pending_confirmation.id
 *                    このメッセージのボタンタップ時にこのIDで /api/noida/confirm を呼ぶ
 * - action: 実行するアクション(delete/restore/complete 等)
 */
export interface Message {
  id: string
  role: Role
  content: string
  hint?: string
  mode?: string
  options?: Option[]
  timestamp: string
  saved?: string
  // v1.6: サーバーが作成した pending_confirmation を紐付け
  confirmation_id?: string
  action?: string
}