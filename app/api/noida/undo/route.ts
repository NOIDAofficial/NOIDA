import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * POST /api/noida/undo
 * 
 * 削除されたレコードを復元する。
 * 
 * リクエスト形式:
 *   { source_table, source_id } - 特定レコードを復元
 *   {}                          - 直近の削除を自動復元
 * 
 * 動作:
 *   1. trash_queue から対象取得
 *   2. 元テーブルに復元(memo/ideas は INSERT、task/calendar は deleted_at=null)
 *   3. trash_queue から削除
 *   4. mutation_event_log に undo エントリ追加
 * 
 * レスポンス:
 *   {
 *     success: boolean,
 *     restored: { table, id, title } | null,
 *     message: string
 *   }
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  let body: any = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const { source_table, source_id } = body

  console.log('🔄 [UNDO] リクエスト:', { source_table, source_id })

  try {
    // Step 1: trash_queue から対象取得
    let trashRecord: any = null
    if (source_table && source_id) {
      // 特定指定モード
      const { data, error } = await supabase
        .from('trash_queue')
        .select('*')
        .eq('source_table', source_table)
        .eq('source_id', source_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) {
        console.error('❌ [UNDO] trash_queue 取得エラー:', error)
        return NextResponse.json({
          success: false,
          restored: null,
          message: `復元対象が見つからなかった: ${error.message}`,
        }, { status: 500 })
      }
      trashRecord = data
    } else {
      // 直近モード
      const { data, error } = await supabase
        .from('trash_queue')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) {
        console.error('❌ [UNDO] 直近 trash 取得エラー:', error)
        return NextResponse.json({
          success: false,
          restored: null,
          message: `直近の削除履歴取得エラー: ${error.message}`,
        }, { status: 500 })
      }
      trashRecord = data
    }

    if (!trashRecord) {
      return NextResponse.json({
        success: false,
        restored: null,
        message: '復元できる削除履歴がない(30日以内の削除なら復元可能)',
      }, { status: 404 })
    }

    const {
      id: trashId,
      source_table: restoreTable,
      source_id: restoreId,
      original_data,
    } = trashRecord

    console.log('🔍 [UNDO] 対象:', { restoreTable, restoreId, trashId })

    // Step 2: 元テーブルに復元
    let restoredTitle = ''
    let restoreError: any = null

    if (restoreTable === 'memo' || restoreTable === 'ideas') {
      // 物理削除だったので INSERT で復活
      const { id, created_at, updated_at, ...dataWithoutMeta } = original_data
      const { data: restored, error } = await supabase
        .from(restoreTable)
        .insert({
          ...dataWithoutMeta,
          id: restoreId, // 元の id を保持
        })
        .select()
        .single()
      if (error) {
        console.error(`❌ [UNDO] ${restoreTable} INSERT エラー:`, error)
        restoreError = error
      } else {
        restoredTitle = restored?.content?.substring(0, 50) || '(復元)'
        console.log(`✅ [UNDO] ${restoreTable} 復活:`, restoreId)
      }
    } else if (restoreTable === 'task' || restoreTable === 'calendar') {
      // 論理削除だったので deleted_at を null に戻す
      const updates: any = {
        deleted_at: null,
        updated_at: new Date().toISOString(),
      }
      // task/calendar が state を持つ場合は元に戻す
      if (original_data.state && original_data.state !== 'cancelled') {
        updates.state = original_data.state
      } else if (original_data.state === 'cancelled') {
        updates.state = 'scheduled' // calendar
      }
      if (restoreTable === 'task') {
        updates.done = original_data.done ?? false
        updates.completed_at = null
        updates.cancelled_at = null
      } else {
        updates.cancelled_at = null
      }

      const { data: restored, error } = await supabase
        .from(restoreTable)
        .update(updates)
        .eq('id', restoreId)
        .select()
        .single()

      if (error) {
        console.error(`❌ [UNDO] ${restoreTable} UPDATE エラー:`, error)
        restoreError = error
      } else {
        restoredTitle = 
          restored?.title?.substring(0, 50) ||
          restored?.content?.substring(0, 50) ||
          '(復元)'
        console.log(`✅ [UNDO] ${restoreTable} 復活:`, restoreId)
      }
    } else {
      return NextResponse.json({
        success: false,
        restored: null,
        message: `復元非対応のテーブル: ${restoreTable}`,
      }, { status: 400 })
    }

    if (restoreError) {
      return NextResponse.json({
        success: false,
        restored: null,
        message: `復元処理でエラー: ${restoreError.message || 'unknown'}`,
      }, { status: 500 })
    }

    // Step 3: trash_queue から削除
    const { error: trashDelErr } = await supabase
      .from('trash_queue')
      .delete()
      .eq('id', trashId)
    if (trashDelErr) {
      console.error('⚠️ [UNDO] trash_queue 削除エラー:', trashDelErr)
      // 復元自体は成功してるので続行
    }

    // Step 4: mutation_event_log に undo エントリ追加
    const { error: logErr } = await supabase.from('mutation_event_log').insert({
      user_message_id: `undo_${Date.now()}`,
      event_type: 'restore',
      source_table: restoreTable,
      source_id: restoreId,
      before_data: null,
      after_data: original_data,
      mutation_plan: {
        action: 'restore',
        target_table: restoreTable,
        target_id: restoreId,
        source: 'undo_endpoint',
      },
      resolver_strategy: 'user_confirmed',
      confidence: 1.0,
      executed_by: 'noida',
      mutation_mode: 'confirmed',
      idempotency_key: `undo_${trashId}_${Date.now()}`,
    })
    if (logErr) {
      console.warn('⚠️ [UNDO] mutation_event_log エラー(無視):', logErr)
    }

    const elapsedMs = Date.now() - startedAt
    console.log('🏁 [UNDO] 完了:', { restoreTable, restoreId, elapsedMs })

    return NextResponse.json({
      success: true,
      restored: {
        table: restoreTable,
        id: restoreId,
        title: restoredTitle,
      },
      message: `「${restoredTitle}」を復元した`,
    })
  } catch (e: any) {
    console.error('❌ [UNDO] 例外:', e)
    return NextResponse.json({
      success: false,
      restored: null,
      message: `予期しないエラー: ${e.message || 'unknown'}`,
    }, { status: 500 })
  }
}