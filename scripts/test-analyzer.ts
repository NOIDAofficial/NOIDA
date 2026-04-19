// .env.local を読み込む(tsx 実行時のみ必要、本番の Next.js では自動ロードされる)
import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

/**
 * analyzeQuery + Personal Dictionary のクイック動作テスト
 * 
 * 実行: npx tsx scripts/test-analyzer.ts
 */

import { analyzeQuery, debugAnalysis } from '../lib/analyzer/analyzeQuery'
import {
  getPersonalDictionary,
  matchPersonalEntities,
  getCacheStatus,
} from '../lib/analyzer/personalDictionary'

// ============================================================
// Part 1: analyzeQuery クイックテスト
// ============================================================

const testCases = [
  '検察庁のタスク消して',
  'パンのタスク消して',
  '池田さんに連絡するタスク、終わった',
  '明日10時の会議キャンセル',
  'あのメモ消して',
  'ガス代払うタスク、完了',
  '5月11日15時の打ち合わせ',
  '検察庁のタスクやっぱり戻して',
  '孫さんに1万円送金',
  'PokeStockの検索バグ修正タスク追加',
  'おはよう',
  'ありがとう',
]

console.log('='.repeat(60))
console.log('NOIDA analyzeQuery クイックテスト')
console.log('='.repeat(60))

for (const text of testCases) {
  const analysis = analyzeQuery(text)
  console.log()
  console.log(debugAnalysis(analysis))
}

console.log()
console.log('='.repeat(60))
console.log('analyzeQuery テスト完了')

// ============================================================
// Part 2: Personal Dictionary テスト
// ============================================================

;(async () => {
  console.log()
  console.log('='.repeat(60))
  console.log('Personal Dictionary テスト')
  console.log('='.repeat(60))
  
  console.log()
  console.log('[1] 辞書ロード(1回目 = Supabaseから取得)')
  const start1 = Date.now()
  const entities = await getPersonalDictionary()
  const elapsed1 = Date.now() - start1
  console.log(`  ロード成功: ${entities.length} エントリ (${elapsed1}ms)`)
  
  // 最初の10件を表示
  const displayLimit = Math.min(10, entities.length)
  for (const e of entities.slice(0, displayLimit)) {
    const aliasStr = e.aliases.length > 0 ? e.aliases.join(', ') : 'なし'
    console.log(`  - [${e.entity_type}] ${e.text} (aliases: ${aliasStr})`)
  }
  if (entities.length > displayLimit) {
    console.log(`  - ... 他 ${entities.length - displayLimit} 件`)
  }
  
  console.log()
  console.log('[2] 辞書ロード(2回目 = キャッシュから)')
  const start2 = Date.now()
  await getPersonalDictionary()
  const elapsed2 = Date.now() - start2
  console.log(`  キャッシュヒット: ${elapsed2}ms (1回目より ${elapsed1 - elapsed2}ms 速い)`)
  
  console.log()
  console.log('[3] matchPersonalEntities テスト')
  const testQueries = [
    'PokeStockの検索バグ修正',
    '池田さんに連絡',
    '検察庁のタスク消して',
    'パンのタスク消して',
    'RINNEの件',
    '三木谷会長との会議',
    '孫さんに連絡',
  ]
  
  for (const q of testQueries) {
    const matches = await matchPersonalEntities(q)
    console.log(`  "${q}"`)
    if (matches.length === 0) {
      console.log(`    → マッチなし`)
    } else {
      for (const m of matches) {
        console.log(
          `    → [${m.entity.entity_type}] "${m.entity.text}" (${m.match_type}) source=${m.entity.source_table}`
        )
      }
    }
  }
  
  console.log()
  console.log('[4] キャッシュ状態')
  const status = getCacheStatus()
  console.log(
    `  cached: ${status.cached}, ageMs: ${status.ageMs}, entries: ${status.entryCount}`
  )
  
  console.log()
  console.log('='.repeat(60))
  console.log('Personal Dictionary テスト完了')
  console.log('='.repeat(60))
})()

// ============================================================
// Part 3: Person Matcher テスト
// ============================================================

import { 
    matchPerson, 
    debugMatchResult,
    getPeopleDictionary,
    invalidatePeopleCache,
  } from '../lib/analyzer/personMatcher'
  
  ;(async () => {
    console.log()
    console.log('='.repeat(60))
    console.log('Person Matcher テスト')
    console.log('='.repeat(60))
    
    // キャッシュ無効化(前のテストで触ったかも)
    invalidatePeopleCache()
    
    console.log()
    console.log('[1] 人物辞書ロード(呼称データ含む)')
    const start = Date.now()
    const people = await getPeopleDictionary()
    const elapsed = Date.now() - start
    console.log(`  ロード成功: ${people.length}人 (${elapsed}ms)`)
    
    for (const p of people) {
      const exprs = p.referring_expressions
        .map(e => `${e.expression}(count=${e.mention_count}, conf=${e.confidence.toFixed(2)})`)
        .join(', ')
      console.log(`  - ${p.name}(${p.company ?? '?'}・${p.position ?? '?'}・${p.importance ?? '-'})`)
      if (exprs) console.log(`    呼称: ${exprs}`)
    }
    
    console.log()
    console.log('[2] 人物マッチテスト(複数シナリオ)')
    
    const testCases: { text: string; context?: any; expect: string }[] = [
      { 
        text: '三木谷会長との会議', 
        expect: 'confident(三木谷浩一・呼称+役職+ビジネス文脈)' 
      },
      { 
        text: '三木谷さんに連絡', 
        expect: '三木谷浩一(姓+ビジネス文脈)' 
      },
      { 
        text: '三木谷に連絡', 
        expect: '三木谷浩一(姓+文脈)' 
      },
      { 
        text: '池田さんのタスク', 
        expect: '池田光陽(姓一致)' 
      },
      { 
        text: '池田光陽に連絡', 
        expect: 'confident(名前完全一致)' 
      },
      { 
        text: '孫さんにアポ', 
        expect: '孫(1文字姓+ビジネス文脈)' 
      },
      { 
        text: '楽天の人と連絡', 
        expect: '三木谷浩一(会社一致)' 
      },
      { 
        text: 'ソフトバンクの社長', 
        expect: '孫(会社+役職)' 
      },
      { 
        text: 'おはよう', 
        expect: 'no_match' 
      },
      { 
        text: '猫かわいい', 
        expect: 'no_match' 
      },
    ]
    
    for (const tc of testCases) {
      const result = await matchPerson(tc.text, tc.context ?? {})
      console.log()
      console.log(`  "${tc.text}"`)
      console.log(`  期待: ${tc.expect}`)
      console.log(`  ${debugMatchResult(result)}`)
    }
    
    console.log()
    console.log('='.repeat(60))
    console.log('Person Matcher テスト完了')
    console.log('='.repeat(60))
  })()
  