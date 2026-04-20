import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * POST /api/noida/undo
 * 
 * 削除されたレコードを復元する。
 * v2.1.x: Service Role Key 対応 + trash_queue 実カラム(deleted_at / restored)対応
 */

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  SUPABASE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
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
    let trashRecord: any = null
    if (source_table && source_id) {
      const { data, error } = await supabase
        .from('trash_queue')
        .select('*')
        .eq('source_table', source_table)
        .eq('source_id', source_id)
        .eq('restored', false)
        .order('deleted_at', { ascending: false })
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
      const { data, error } = await supabase
        .from('trash_queue')
        .select('*')
        .eq('restored', false)
        .order('deleted_at', { ascending: false })
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

    let restoredTitle = ''
    let restoreError: any = null

    if (restoreTable === 'memo' || restoreTable === 'ideas') {
      const { id, created_at, updated_at, ...dataWithoutMeta } = original_data
      const { data: restored, error } = await supabase
        .from(restoreTable)
        .insert({
          ...dataWithoutMeta,
          id: restoreId,
        })
        .select()
        .single()
      if (error) {
        console.error(`❌ [UNDO] ${restoreTable} INSERT エラー:`, error)
        restoreError = error
      } else {
        restoredTitle = restored?.content?.substring(0, 50) || '(復元)'
      }
    } else if (restoreTable === 'task' || restoreTable === 'calendar') {
      const updates: any = {
        deleted_at: null,
        updated_at: new Date().toISOString(),
      }
      if (restoreTable === 'task') {
        updates.state = 'active'
        updates.done = false
        updates.completed_at = null
        updates.cancelled_at = null
      } else {
        updates.state = 'scheduled'
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

    // trash_queue は物理削除じゃなく restored=true で履歴保持
    await supabase
      .from('trash_queue')
      .update({ restored: true, restored_at: new Date().toISOString() })
      .eq('id', trashId)

    await supabase.from('mutation_event_log').insert({
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