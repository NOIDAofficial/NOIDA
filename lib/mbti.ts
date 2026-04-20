/**
 * NOIDA MBTI 共通定義
 * 
 * 場所: lib/mbti.ts として配置
 * 用途: オンボーディング(Q11)、API 解析、NOIDAOrb の色設定で共通利用
 */

export type MBTICode = 
  | 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP'
  | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ'
  | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP'

export type MBTIGroup = 'analyst' | 'diplomat' | 'sentinel' | 'explorer'

export interface MBTIOption {
  code: MBTICode
  name: string
  group: MBTIGroup
  color: readonly [number, number, number]  // 0-1 の RGB(WebGL シェーダー用)
  hex: string                                // CSS 用(border, glow)
}

export const MBTI_OPTIONS: readonly MBTIOption[] = [
  // Analysts(紫系)— 論理・分析
  { code: 'INTJ', name: '建築家',       group: 'analyst', color: [0.56, 0.32, 0.80], hex: '#8F51CC' },
  { code: 'INTP', name: '論理学者',     group: 'analyst', color: [0.65, 0.45, 0.85], hex: '#A673D9' },
  { code: 'ENTJ', name: '指揮官',       group: 'analyst', color: [0.72, 0.28, 0.75], hex: '#B847BF' },
  { code: 'ENTP', name: '討論者',       group: 'analyst', color: [0.78, 0.38, 0.88], hex: '#C761E0' },
  
  // Diplomats(緑系)— 共感・調和
  { code: 'INFJ', name: '提唱者',       group: 'diplomat', color: [0.18, 0.58, 0.50], hex: '#2E9480' },
  { code: 'INFP', name: '仲介者',       group: 'diplomat', color: [0.32, 0.72, 0.58], hex: '#52B894' },
  { code: 'ENFJ', name: '主人公',       group: 'diplomat', color: [0.15, 0.68, 0.52], hex: '#26AD85' },
  { code: 'ENFP', name: '運動家',       group: 'diplomat', color: [0.42, 0.78, 0.48], hex: '#6BC77A' },
  
  // Sentinels(青系)— 秩序・実務
  { code: 'ISTJ', name: '管理者',       group: 'sentinel', color: [0.20, 0.42, 0.72], hex: '#336BB8' },
  { code: 'ISFJ', name: '擁護者',       group: 'sentinel', color: [0.35, 0.62, 0.85], hex: '#599ED9' },
  { code: 'ESTJ', name: '幹部',         group: 'sentinel', color: [0.22, 0.48, 0.68], hex: '#387AAD' },
  { code: 'ESFJ', name: '領事',         group: 'sentinel', color: [0.42, 0.72, 0.88], hex: '#6BB8E0' },
  
  // Explorers(黄系)— 行動・探索
  { code: 'ISTP', name: '巨匠',         group: 'explorer', color: [0.92, 0.72, 0.22], hex: '#EBB838' },
  { code: 'ISFP', name: '冒険家',       group: 'explorer', color: [0.95, 0.78, 0.35], hex: '#F2C759' },
  { code: 'ESTP', name: '起業家',       group: 'explorer', color: [0.95, 0.65, 0.20], hex: '#F2A633' },
  { code: 'ESFP', name: 'エンターテイナー', group: 'explorer', color: [0.98, 0.82, 0.28], hex: '#FAD147' },
] as const

export const MBTI_UNKNOWN_COLOR: readonly [number, number, number] = [0.9, 0.9, 1.0]
export const MBTI_UNKNOWN_HEX = '#E6E6FF'

export function getMBTIOption(code: string | null | undefined): MBTIOption | null {
  if (!code) return null
  return MBTI_OPTIONS.find(o => o.code === code) ?? null
}

export function getMBTIColor(code: string | null | undefined): readonly [number, number, number] {
  const opt = getMBTIOption(code)
  return opt?.color ?? [0.38, 0.62, 1.0]  // デフォルト NOIDA 青
}

export function getMBTIHex(code: string | null | undefined): string {
  const opt = getMBTIOption(code)
  return opt?.hex ?? '#6EBDFF'  // デフォルト NOIDA 青
}

export function isValidMBTI(code: any): code is MBTICode {
  return typeof code === 'string' && MBTI_OPTIONS.some(o => o.code === code)
}