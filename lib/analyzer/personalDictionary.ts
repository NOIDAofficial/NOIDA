/**
 * NOIDA Personal Dictionary v1.0.1
 * 
 * ユーザー固有の辞書(事業名、人物名など)を Supabase からロードし、
 * analyzeQuery の結果に個人エンティティ情報を付加する。
 * 
 * 設計:
 * - In-memory キャッシュ(TTL 5分)
 * - Serverless 環境対応(コールドスタート時は再ロード)
 * - 軽量クエリ(id, name, 最小フィールドのみ)
 * 
 * v1.0.1: Supabase クエリ結果を明示型付け(TS2339 対応)
 * 
 * 2026-04-20 Day 5 実装
 */

import { createClient } from '@supabase/supabase-js'

// ============================================================
// 型定義
// ============================================================

export type PersonalEntity = {
  id: string
  text: string
  normalized: string
  aliases: string[]
  entity_type: 'business' | 'person'
  
  source_table: 'business_master' | 'people'
  source_id: string
  
  importance?: 'S' | 'A' | 'B' | 'C'
  
  company?: string
  position?: string
  note?: string
}

export type PersonalDictionaryMatch = {
  entity: PersonalEntity
  matched_text: string
  match_type: 'exact' | 'alias' | 'partial'
}

// Supabase row types (明示型付け)
type BusinessRow = {
  id: string
  name: string | null
  note: string | null
}

type PeopleRow = {
  id: string
  name: string | null
  company: string | null
  position: string | null
  importance: string | null
  note: string | null
}

// ============================================================
// キャッシュ管理
// ============================================================

type CacheEntry = {
  entities: PersonalEntity[]
  loadedAt: number
}

const TTL_MS = 5 * 60 * 1000 // 5分
let cache: CacheEntry | null = null

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
// ロード処理
// ============================================================

async function loadFromSupabase(): Promise<PersonalEntity[]> {
  const supabase = getSupabase()
  const entities: PersonalEntity[] = []
  
  // business_master からロード
  try {
    const { data, error } = await supabase
      .from('business_master')
      .select('id, name, note')
      .returns<BusinessRow[]>()
    
    if (error) {
      console.warn('[PersonalDictionary] business_master load failed:', error.message)
    } else if (data) {
      for (const biz of data) {
        const name = biz.name?.trim()
        if (!name || name.length < 2) continue
        
        entities.push({
          id: `biz:${biz.id}`,
          text: name,
          normalized: name.toLowerCase(),
          aliases: extractAliases(name, biz.note),
          entity_type: 'business',
          source_table: 'business_master',
          source_id: biz.id,
          note: biz.note ?? undefined,
        })
      }
    }
  } catch (e) {
    console.warn('[PersonalDictionary] business_master error:', e)
  }
  
  // people からロード
  try {
    const { data, error } = await supabase
      .from('people')
      .select('id, name, company, position, importance, note')
      .returns<PeopleRow[]>()
    
    if (error) {
      console.warn('[PersonalDictionary] people load failed:', error.message)
    } else if (data) {
      for (const p of data) {
        const name = p.name?.trim()
        if (!name || name.length < 1) continue
        
        const importance = (['S', 'A', 'B', 'C'] as const).includes(
          p.importance as 'S' | 'A' | 'B' | 'C'
        )
          ? (p.importance as 'S' | 'A' | 'B' | 'C')
          : 'B'
        
        entities.push({
          id: `person:${p.id}`,
          text: name,
          normalized: name.toLowerCase(),
          aliases: extractAliases(name, p.note),
          entity_type: 'person',
          source_table: 'people',
          source_id: p.id,
          importance,
          company: p.company ?? undefined,
          position: p.position ?? undefined,
          note: p.note ?? undefined,
        })
      }
    }
  } catch (e) {
    console.warn('[PersonalDictionary] people error:', e)
  }
  
  return entities
}

/**
 * 名前から別名を抽出
 */
function extractAliases(name: string, note: string | null | undefined): string[] {
  const aliases = new Set<string>()
  
  // 敬称を除いた形
  const stripped = name.replace(
    /(さん|様|ちゃん|くん|先生|会長|社長|部長|課長|氏|博士|教授)$/,
    ''
  )
  if (stripped && stripped !== name && stripped.length >= 1) {
    aliases.add(stripped.toLowerCase())
  }
  
  // 組織サフィックス除去
  const suffixStripped = name.replace(
    /(庁|省|部|課|店|所|会社|法人|事業所|支社|支店|本部|銀行|病院|Inc|Corp|Ltd|Co)$/,
    ''
  )
  if (suffixStripped && suffixStripped !== name && suffixStripped.length >= 2) {
    aliases.add(suffixStripped.toLowerCase())
  }
  
  // note から別名抽出
  if (note) {
    const match = note.match(/(?:別名|alias|別称|エイリアス)[:::]?\s*([^\n,、]+)/i)
    if (match && match[1]) {
      const aliasStr = match[1].trim()
      for (const a of aliasStr.split(/[,、]/).map(s => s.trim())) {
        if (a && a.length >= 2) aliases.add(a.toLowerCase())
      }
    }
  }
  
  return Array.from(aliases)
}

// ============================================================
// 公開 API
// ============================================================

export async function getPersonalDictionary(): Promise<PersonalEntity[]> {
  const now = Date.now()
  
  if (cache && now - cache.loadedAt < TTL_MS) {
    return cache.entities
  }
  
  const entities = await loadFromSupabase()
  cache = { entities, loadedAt: now }
  return entities
}

export async function matchPersonalEntities(
  text: string
): Promise<PersonalDictionaryMatch[]> {
  const entities = await getPersonalDictionary()
  const lowerText = text.toLowerCase()
  const matches: PersonalDictionaryMatch[] = []
  
  for (const entity of entities) {
    // 完全一致
    if (lowerText.includes(entity.normalized)) {
      matches.push({
        entity,
        matched_text: entity.text,
        match_type: 'exact',
      })
      continue
    }
    
    // alias マッチ
    let matchedAlias: string | null = null
    for (const alias of entity.aliases) {
      if (alias.length >= 2 && lowerText.includes(alias)) {
        matchedAlias = alias
        break
      }
    }
    if (matchedAlias) {
      matches.push({
        entity,
        matched_text: matchedAlias,
        match_type: 'alias',
      })
    }
  }
  
  // 重複除去
  const seen = new Set<string>()
  const unique: PersonalDictionaryMatch[] = []
  for (const m of matches) {
    if (!seen.has(m.entity.id)) {
      seen.add(m.entity.id)
      unique.push(m)
    }
  }
  
  return unique
}

export async function invalidatePersonalDictionaryCache(): Promise<void> {
  cache = null
}

export function getCacheStatus(): { 
  cached: boolean
  ageMs: number
  entryCount: number
} {
  if (!cache) {
    return { cached: false, ageMs: 0, entryCount: 0 }
  }
  return {
    cached: true,
    ageMs: Date.now() - cache.loadedAt,
    entryCount: cache.entities.length,
  }
}