/**
 * NOIDA analyzeQuery v1.0
 * 
 * ユーザーの発言を13カテゴリに分解するエンジン
 * 
 * 使い方:
 *   const analysis = analyzeQuery("検察庁のタスク消して")
 *   // → {
 *   //   organizations: ["検察庁"],
 *   //   target_type: ["task"],
 *   //   actions: [{verb: "delete", raw: "消して"}],
 *   //   ...
 *   // }
 * 
 * 設計原則:
 * - Pure function(副作用なし)
 * - Deterministic(同じ入力なら同じ出力)
 * - No LLM(正規表現 + 辞書のみ)
 * - Fast(< 5ms)
 * 
 * 2026-04-20 Day 5 実装
 */

import {
    PARTICLE_REGEX,
    HONORIFIC_REGEX,
    ORG_SUFFIX_REGEX,
    DATETIME_RELATIVE,
    DATETIME_REL_REGEX,
    DATE_ABSOLUTE_REGEX,
    TIME_REGEX,
    ISO_DATE_REGEX,
    DURATION_REGEX,
    MONEY_REGEX,
    QUANTITY_REGEX,
    LOCATION_REGEX,
    ANAPHORIC_REGEX,
    STOPWORDS,
    VERB_TO_CATEGORY,
    ALL_ACTION_VERBS,
    TARGET_TO_TYPE,
    ALL_TARGET_KEYWORDS,
  } from './dictionaries'
  
  // ============================================================
  // 型定義
  // ============================================================
  
  export type Person = {
    name: string
    honorific: string
    raw: string
  }
  
  export type DatetimeAbsolute = {
    month?: number
    day?: number
    hour?: number
    minute?: number
    iso_date?: string
    raw: string
  }
  
  export type DatetimeRelative = {
    offset_days: number
    raw: string
  }
  
  export type Duration = {
    value: number
    unit: string
    raw: string
  }
  
  export type Money = {
    value: number
    currency: string
    raw: string
  }
  
  export type Quantity = {
    value: number
    unit: string
    raw: string
  }
  
  export type Action = {
    verb: string
    category: string
    raw: string
  }
  
  export type Reference = {
    type: 'anaphoric' | 'explicit' | 'ambiguous'
    word: string
    raw: string
  }
  
  export type QueryAnalysis = {
    // 人・組織
    people: Person[]
    organizations: string[]
    
    // 時間
    datetime_absolute: DatetimeAbsolute[]
    datetime_relative: DatetimeRelative[]
    duration: Duration[]
    
    // 場所
    locations: string[]
    
    // 数量・金額
    money: Money[]
    quantities: Quantity[]
    
    // コンテンツ
    proper_nouns: string[]
    keywords: string[]
    
    // 意図
    actions: Action[]
    target_type: string[]
    reference: Reference[]
    
    // メタ
    confidence: number
    original_text: string
    tokens: string[]
  }
  
  // ============================================================
  // メインエンジン
  // ============================================================
  
  export function analyzeQuery(text: string): QueryAnalysis {
    const original = text
    
    const people = extractPeople(text)
    const organizations = extractOrganizations(text)
    const datetime_absolute = extractDatetimeAbsolute(text)
    const datetime_relative = extractDatetimeRelative(text)
    const duration = extractDuration(text)
    const money = extractMoney(text)
    const quantities = extractQuantities(text)
    const locations = extractLocations(text)
    const actions = extractActions(text)
    const target_type = extractTargetType(text)
    const reference = extractReferences(text)
    
    const consumed = collectConsumedRanges(text, {
      people, organizations, datetime_absolute, datetime_relative,
      duration, money, quantities, locations, actions, target_type, reference
    })
    
    const tokens = tokenizeRemaining(text, consumed)
    
    const proper_nouns = extractProperNouns(tokens)
    const keywords = extractKeywords(tokens, proper_nouns)
    
    const confidence = calculateConfidence({
      people, organizations, datetime_absolute, datetime_relative,
      actions, target_type, keywords, proper_nouns,
      textLength: text.length,
    })
    
    return {
      people,
      organizations,
      datetime_absolute,
      datetime_relative,
      duration,
      locations,
      money,
      quantities,
      proper_nouns,
      keywords,
      actions,
      target_type,
      reference,
      confidence,
      original_text: original,
      tokens,
    }
  }
  
  // ============================================================
  // 個別抽出関数(すべて Array.from で iterator を配列化)
  // ============================================================
  
  function extractPeople(text: string): Person[] {
    const results: Person[] = []
    const matches = Array.from(text.matchAll(HONORIFIC_REGEX))
    
    for (const match of matches) {
      const raw = match[0]
      const name = match[1]
      const honorific = match[2]
      
      if (name && name.length >= 1) {
        results.push({ name, honorific, raw })
      }
    }
    
    return dedupeBy(results, r => r.raw)
  }
  
  function extractOrganizations(text: string): string[] {
    const results: string[] = []
    const matches = Array.from(text.matchAll(ORG_SUFFIX_REGEX))
    
    for (const match of matches) {
      results.push(match[0])
    }
    
    return dedupe(results)
  }
  
  function extractDatetimeAbsolute(text: string): DatetimeAbsolute[] {
    const results: DatetimeAbsolute[] = []
    
    for (const match of Array.from(text.matchAll(DATE_ABSOLUTE_REGEX))) {
      results.push({
        month: parseInt(match[1]),
        day: parseInt(match[2]),
        raw: match[0],
      })
    }
    
    for (const match of Array.from(text.matchAll(ISO_DATE_REGEX))) {
      results.push({
        iso_date: match[0],
        raw: match[0],
      })
    }
    
    for (const match of Array.from(text.matchAll(TIME_REGEX))) {
      results.push({
        hour: parseInt(match[1]),
        minute: match[2] ? parseInt(match[2]) : 0,
        raw: match[0],
      })
    }
    
    return results
  }
  
  function extractDatetimeRelative(text: string): DatetimeRelative[] {
    const results: DatetimeRelative[] = []
    const matches = Array.from(text.matchAll(DATETIME_REL_REGEX))
    
    for (const match of matches) {
      const word = match[0]
      const offset = DATETIME_RELATIVE[word]
      if (offset !== undefined) {
        results.push({ offset_days: offset, raw: word })
      }
    }
    
    return dedupeBy(results, r => r.raw)
  }
  
  function extractDuration(text: string): Duration[] {
    const results: Duration[] = []
    const matches = Array.from(text.matchAll(DURATION_REGEX))
    
    for (const match of matches) {
      results.push({
        value: parseInt(match[1]),
        unit: match[2],
        raw: match[0],
      })
    }
    
    return results
  }
  
  function extractMoney(text: string): Money[] {
    const results: Money[] = []
    const matches = Array.from(text.matchAll(MONEY_REGEX))
    
    for (const match of matches) {
      const valueStr = match[1].replace(/,/g, '')
      const value = /^[0-9]+$/.test(valueStr) 
        ? parseInt(valueStr) 
        : parseKanjiNumber(valueStr)
      
      results.push({
        value,
        currency: match[2],
        raw: match[0],
      })
    }
    
    return results
  }
  
  function extractQuantities(text: string): Quantity[] {
    const results: Quantity[] = []
    const matches = Array.from(text.matchAll(QUANTITY_REGEX))
    
    for (const match of matches) {
      results.push({
        value: parseInt(match[1]),
        unit: match[2],
        raw: match[0],
      })
    }
    
    return results
  }
  
  function extractLocations(text: string): string[] {
    const results: string[] = []
    const matches = Array.from(text.matchAll(LOCATION_REGEX))
    
    for (const match of matches) {
      results.push(match[0])
    }
    
    return dedupe(results)
  }
  
  function extractActions(text: string): Action[] {
    const results: Action[] = []
    const lowerText = text.toLowerCase()
    
    // 動詞辞書から長い順に検索
    const sortedVerbs = [...ALL_ACTION_VERBS].sort((a, b) => b.length - a.length)
    
    for (const verb of sortedVerbs) {
      if (lowerText.includes(verb.toLowerCase())) {
        const category = VERB_TO_CATEGORY[verb] || 'unknown'
        results.push({ verb, category, raw: verb })
        break
      }
    }
    
    return results
  }
  
  function extractTargetType(text: string): string[] {
    const results = new Set<string>()
    const lowerText = text.toLowerCase()
    
    const sortedKeywords = [...ALL_TARGET_KEYWORDS].sort((a, b) => b.length - a.length)
    
    for (const keyword of sortedKeywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        const type = TARGET_TO_TYPE[keyword]
        if (type) results.add(type)
      }
    }
    
    return Array.from(results)
  }
  
  function extractReferences(text: string): Reference[] {
    const results: Reference[] = []
    const matches = Array.from(text.matchAll(ANAPHORIC_REGEX))
    
    for (const match of matches) {
      results.push({
        type: 'anaphoric',
        word: match[0],
        raw: match[0],
      })
    }
    
    return dedupeBy(results, r => r.raw)
  }
  
  // ============================================================
  // トークン分解
  // ============================================================
  
  type ConsumedInput = {
    people: Person[]
    organizations: string[]
    datetime_absolute: DatetimeAbsolute[]
    datetime_relative: DatetimeRelative[]
    duration: Duration[]
    money: Money[]
    quantities: Quantity[]
    locations: string[]
    actions: Action[]
    target_type: string[]
    reference: Reference[]
  }
  
  function collectConsumedRanges(text: string, data: ConsumedInput): Set<string> {
    const consumed = new Set<string>()
    
    for (const p of data.people) consumed.add(p.raw)
    for (const o of data.organizations) consumed.add(o)
    for (const d of data.datetime_absolute) consumed.add(d.raw)
    for (const d of data.datetime_relative) consumed.add(d.raw)
    for (const d of data.duration) consumed.add(d.raw)
    for (const m of data.money) consumed.add(m.raw)
    for (const q of data.quantities) consumed.add(q.raw)
    for (const l of data.locations) consumed.add(l)
    for (const a of data.actions) consumed.add(a.raw)
    for (const r of data.reference) consumed.add(r.raw)
    
    for (const type of data.target_type) {
      for (const [keyword, mappedType] of Object.entries(TARGET_TO_TYPE)) {
        if (mappedType === type && text.includes(keyword)) {
          consumed.add(keyword)
        }
      }
    }
    
    return consumed
  }
  
  function tokenizeRemaining(text: string, consumed: Set<string>): string[] {
    let working = text
    const placeholderList = Array.from(consumed).sort((a, b) => b.length - a.length)
    
    for (const phrase of placeholderList) {
      working = working.split(phrase).join('\u0001')
    }
    
    const tokens = working
      .split(PARTICLE_REGEX)
      .flatMap(s => s.split('\u0001'))
      .map(s => s.trim())
      .filter(s => s.length >= 2)
      .filter(s => !STOPWORDS.has(s))
      .filter(s => !/^[\d\s\u0001]+$/.test(s))
    
    return dedupe(tokens)
  }
  
  // ============================================================
  // Keyword / Proper Noun 抽出
  // ============================================================
  
  function extractProperNouns(tokens: string[]): string[] {
    return tokens.filter(t => 
      /^[ァ-ヶーA-Za-z0-9]{2,}$/.test(t)
    )
  }
  
  function extractKeywords(tokens: string[], properNouns: string[]): string[] {
    const properSet = new Set(properNouns)
    return tokens.filter(t => !properSet.has(t) && t.length >= 2)
  }
  
  // ============================================================
  // Confidence 計算
  // ============================================================
  
  type ConfidenceInput = {
    people: Person[]
    organizations: string[]
    datetime_absolute: DatetimeAbsolute[]
    datetime_relative: DatetimeRelative[]
    actions: Action[]
    target_type: string[]
    keywords: string[]
    proper_nouns: string[]
    textLength: number
  }
  
  function calculateConfidence(input: ConfidenceInput): number {
    let score = 0.3
    
    if (input.people.length > 0) score += 0.20
    if (input.organizations.length > 0) score += 0.20
    if (input.datetime_absolute.length > 0) score += 0.15
    if (input.datetime_relative.length > 0) score += 0.10
    if (input.actions.length > 0) score += 0.15
    if (input.target_type.length > 0) score += 0.10
    
    if (input.proper_nouns.length > 0) score += 0.10
    if (input.keywords.length > 0) score += 0.05
    
    if (input.textLength > 100) score -= 0.1
    
    return Math.min(1.0, Math.max(0.0, score))
  }
  
  // ============================================================
  // ユーティリティ
  // ============================================================
  
  function dedupe<T>(arr: T[]): T[] {
    return Array.from(new Set(arr))
  }
  
  function dedupeBy<T>(arr: T[], keyFn: (item: T) => string): T[] {
    const seen = new Set<string>()
    const result: T[] = []
    for (const item of arr) {
      const key = keyFn(item)
      if (!seen.has(key)) {
        seen.add(key)
        result.push(item)
      }
    }
    return result
  }
  
  function parseKanjiNumber(str: string): number {
    const map: Record<string, number> = {
      '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
      '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
      '百': 100, '千': 1000, '万': 10000, '億': 100000000,
    }
    
    if (str.length === 1) return map[str] ?? 0
    
    let result = 0
    let current = 0
    for (const ch of str) {
      const val = map[ch]
      if (val === undefined) continue
      if (val >= 10) {
        current = (current || 1) * val
        result += current
        current = 0
      } else {
        current = current * 10 + val
      }
    }
    result += current
    return result
  }
  
  // ============================================================
  // デバッグ用
  // ============================================================
  
  export function debugAnalysis(analysis: QueryAnalysis): string {
    const lines: string[] = []
    lines.push(`🔍 "${analysis.original_text}"`)
    lines.push(`  confidence: ${analysis.confidence.toFixed(2)}`)
    
    if (analysis.people.length > 0) {
      lines.push(`  people: ${analysis.people.map(p => p.raw).join(', ')}`)
    }
    if (analysis.organizations.length > 0) {
      lines.push(`  organizations: ${analysis.organizations.join(', ')}`)
    }
    if (analysis.datetime_absolute.length > 0) {
      lines.push(`  datetime_abs: ${analysis.datetime_absolute.map(d => d.raw).join(', ')}`)
    }
    if (analysis.datetime_relative.length > 0) {
      lines.push(`  datetime_rel: ${analysis.datetime_relative.map(d => d.raw).join(', ')}`)
    }
    if (analysis.actions.length > 0) {
      lines.push(`  actions: ${analysis.actions.map(a => `${a.raw}(${a.category})`).join(', ')}`)
    }
    if (analysis.target_type.length > 0) {
      lines.push(`  target_type: ${analysis.target_type.join(', ')}`)
    }
    if (analysis.proper_nouns.length > 0) {
      lines.push(`  proper_nouns: ${analysis.proper_nouns.join(', ')}`)
    }
    if (analysis.keywords.length > 0) {
      lines.push(`  keywords: ${analysis.keywords.join(', ')}`)
    }
    if (analysis.reference.length > 0) {
      lines.push(`  reference: ${analysis.reference.map(r => r.raw).join(', ')}`)
    }
    if (analysis.money.length > 0) {
      lines.push(`  money: ${analysis.money.map(m => m.raw).join(', ')}`)
    }
    if (analysis.locations.length > 0) {
      lines.push(`  locations: ${analysis.locations.join(', ')}`)
    }
    lines.push(`  tokens: [${analysis.tokens.join(', ')}]`)
    
    return lines.join('\n')
  }
  