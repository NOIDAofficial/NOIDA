import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * NOIDA /api/noida/confirm v1.0
 *
 * ============================================================
 * 設計思想(シリコンバレー3AI合意版)
 * ============================================================
 *
 * 【思想1: 構造化ペイロード】
 *   ボタンクリックはテキストじゃない、イベント。
 *   Slack block_actions / LINE postback / Discord custom_id と同じ。
 *
 * 【思想2: LLM を通さない決定論的処理】
 *   確定は自然言語の再解釈を行わない。
 *   confirmation_id + candidate_id で直接実行。
 *   ハルシネーション防止。
 *
 * 【思想3: Idempotency(冪等性)】
 *   連打・再送・ネットワーク再試行で二重実行されない。
 *   status='pending' 以外ならエラー。
 *
 * ============================================================
 * API 契約
 * ============================================================
 *
 * POST /api/noida/confirm
 *
 * Request Body:
 * {
 *   "confirmation_id": "uuid",
 *   "candidate_id": "uuid" | null,  // null なら cancel
 *   "user_action": "confirm" | "cancel"
 * }
 *
 * Response:
 * {
 *   "status": "executed" | "cancelled" | "expired" | "error",
 *   "reply": "ユーザーに見せるメッセージ",
 *   "target_title": "削除したタスクのタイトル",
 *   "action": "delete" | "complete" | ...,
 *   "undo_token": "mutation_event_log の id(取り消し用)",
 *   "undo_available_until": "ISO timestamp"
 * }
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

type ConfirmRequest = {
  confirmation_id: string
  candidate_id: string | null
  user_action: 'confirm' | 'cancel'
}

type MutationPlanSnapshot = {
  action: string
  target_table: string
  candidate_rankings: Array<{
    id: string
    title: string
    score: number
    reason: string
  }>
  reason_text?: string
  idempotency_key?: string
}

type PendingConfirmationRow = {
  id: string
  user_message_id: string | null
  action: string
  target_table: string
  candidates: Array<{ id: string; title: string; score: number }>
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired'
  mutation_plan: MutationPlanSnapshot | null
  reason_text: string | null
  expires_at: string
}

function actionToJp(action: string): string {
  const map: Record<string, string> = {
    delete: '削除',
    complete: '完了',
    cancel: 'キャンセル',
    pause: '一時停止',
    update: '更新',
    restore: '復元',
  }
  return map[action] || action
}

// ============================================================
// メイン処理
// ============================================================

export async function POST(req: NextRequest) {
  let body: ConfirmRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ status: 'error', error: 'invalid_body' }, { status: 400 })
  }

  const { confirmation_id, candidate_id, user_action } = body

  // ------------------------------------------------------------
  // 1. バリデーション
  // ------------------------------------------------------------
  if (!confirmation_id || !user_action) {
    return NextResponse.json(
      { status: 'error', error: 'missing_required_fields' },
      { status: 400 }
    )
  }

  // ------------------------------------------------------------
  // 2. pending_confirmation を取得
  // ------------------------------------------------------------
  const { data: pcRaw, error: fetchError } = await supabase
    .from('pending_confirmation')
    .select('*')
    .eq('id', confirmation_id)
    .maybeSingle()

  if (fetchError || !pcRaw) {
    return NextResponse.json(
      {
        status: 'error',
        error: 'confirmation_not_found',
        reply: '確認リクエストが見つかりませんでした。もう一度やり直してください。',
      },
      { status: 404 }
    )
  }

  const pc = pcRaw as unknown as PendingConfirmationRow

  // ------------------------------------------------------------
  // 3. 状態チェック(Idempotency)
  // ------------------------------------------------------------
  if (pc.status !== 'pending') {
    return NextResponse.json({
      status: pc.status,
      reply: `この確認は既に "${pc.status}" 状態です。`,
    })
  }

  // ------------------------------------------------------------
  // 4. 期限チェック
  // ------------------------------------------------------------
  const now = Date.now()
  const expiresAt = new Date(pc.expires_at).getTime()
  if (now > expiresAt) {
    await supabase
      .from('pending_confirmation')
      .update({ status: 'expired' })
      .eq('id', confirmation_id)

    return NextResponse.json({
      status: 'expired',
      reply: '確認の有効期限が切れました。もう一度やり直してください。',
    })
  }

  // ------------------------------------------------------------
  // 5. Cancel 処理
  // ------------------------------------------------------------
  if (user_action === 'cancel') {
    await supabase
      .from('pending_confirmation')
      .update({
        status: 'cancelled',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', confirmation_id)

    return NextResponse.json({
      status: 'cancelled',
      reply: 'キャンセルしました。',
    })
  }

  // ------------------------------------------------------------
  // 6. Confirm 処理
  // ------------------------------------------------------------
  if (!candidate_id) {
    return NextResponse.json(
      {
        status: 'error',
        error: 'missing_candidate_id',
        reply: '候補が選択されていません。',
      },
      { status: 400 }
    )
  }

  // 候補が pending_confirmation 内にあるか検証(改ざん防止)
  const validCandidate = pc.candidates.find((c) => c.id === candidate_id)
  if (!validCandidate) {
    return NextResponse.json(
      {
        status: 'error',
        error: 'invalid_candidate',
        reply: '無効な候補IDです。',
      },
      { status: 400 }
    )
  }

  // ------------------------------------------------------------
  // 7. ターゲットの現在状態を取得(before)
  // ------------------------------------------------------------
  const { data: before, error: beforeError } = await supabase
    .from(pc.target_table)
    .select('*')
    .eq('id', candidate_id)
    .maybeSingle()

  if (beforeError || !before) {
    return NextResponse.json(
      {
        status: 'error',
        error: 'target_not_found',
        reply: '対象が見つかりませんでした。既に削除されている可能性があります。',
      },
      { status: 404 }
    )
  }

  // ------------------------------------------------------------
  // 8. パッチ生成(action に応じて)
  // ------------------------------------------------------------
  const nowISO = new Date().toISOString()
  let patch: Record<string, unknown> = {}

  if (pc.target_table === 'task') {
    if (pc.action === 'delete') {
      patch = { deleted_at: nowISO, updated_at: nowISO }
    } else if (pc.action === 'complete') {
      patch = { state: 'completed', done: true, completed_at: nowISO, updated_at: nowISO }
    } else if (pc.action === 'cancel') {
      patch = { state: 'cancelled', cancelled_at: nowISO, updated_at: nowISO }
    } else if (pc.action === 'pause') {
      patch = { state: 'paused', updated_at: nowISO }
    } else if (pc.action === 'restore') {
      patch = {
        state: 'active',
        done: false,
        deleted_at: null,
        completed_at: null,
        cancelled_at: null,
        updated_at: nowISO,
      }
    }
  } else if (pc.target_table === 'calendar') {
    if (pc.action === 'delete') {
      patch = { deleted_at: nowISO, updated_at: nowISO }
    } else if (pc.action === 'complete') {
      patch = { state: 'completed', completed_at: nowISO, updated_at: nowISO }
    } else if (pc.action === 'cancel') {
      patch = { state: 'cancelled', cancelled_at: nowISO, updated_at: nowISO }
    } else if (pc.action === 'restore') {
      patch = { state: 'scheduled', cancelled_at: null, deleted_at: null, updated_at: nowISO }
    }
  }

  // ------------------------------------------------------------
  // 9. 実行(delete は trash_queue 経由)
  // ------------------------------------------------------------
  if (pc.action === 'delete') {
    // trash_queue へ退避
    const autoPurgeAt = new Date()
    autoPurgeAt.setDate(autoPurgeAt.getDate() + 30)

    const { error: trashError } = await supabase.from('trash_queue').insert({
      source_table: pc.target_table,
      source_id: candidate_id,
      original_data: before,
      delete_reason: pc.reason_text || 'user confirmed',
      delete_trigger: 'user_confirmation',
      deleted_by: 'user',
      auto_purge_at: autoPurgeAt.toISOString(),
    })
    if (trashError) {
      console.log('⚠️ trash_queue INSERTエラー(confirm):', trashError)
    }

    if (pc.target_table === 'memo' || pc.target_table === 'ideas') {
      const { error } = await supabase
        .from(pc.target_table)
        .delete()
        .eq('id', candidate_id)
      if (error) {
        return NextResponse.json(
          { status: 'error', error: error.message, reply: '削除に失敗しました。' },
          { status: 500 }
        )
      }
    } else {
      const { error } = await supabase
        .from(pc.target_table)
        .update({ deleted_at: nowISO })
        .eq('id', candidate_id)
      if (error) {
        return NextResponse.json(
          { status: 'error', error: error.message, reply: '削除に失敗しました。' },
          { status: 500 }
        )
      }
    }
  } else {
    // delete 以外は update
    const { error } = await supabase
      .from(pc.target_table)
      .update(patch)
      .eq('id', candidate_id)
    if (error) {
      return NextResponse.json(
        { status: 'error', error: error.message, reply: `${actionToJp(pc.action)}に失敗しました。` },
        { status: 500 }
      )
    }
  }

  // ------------------------------------------------------------
  // 10. State transition 記録
  // ------------------------------------------------------------
  if (
    (pc.target_table === 'task' || pc.target_table === 'calendar') &&
    (patch.state || pc.action === 'delete')
  ) {
    await supabase.from('living_record_state_transition').insert({
      source_table: pc.target_table,
      source_id: candidate_id,
      from_state: before.state || 'active',
      to_state: pc.action === 'delete' ? 'deleted' : (patch.state as string),
      reason: pc.reason_text || `user confirmed ${pc.action}`,
      source_type: 'user_confirmation',
      source_ref_id: pc.user_message_id,
      actor_type: 'user',
      version: (before.version || 1) + 1,
      effective_from: nowISO,
    })
  }

  // ------------------------------------------------------------
  // 11. mutation_event_log 記録(undo_token 発行)
  // ------------------------------------------------------------
  const idempotencyKey = `confirm:${confirmation_id}:${candidate_id}`

  const { data: afterData } = await supabase
    .from(pc.target_table)
    .select('*')
    .eq('id', candidate_id)
    .maybeSingle()

  const { data: mutationLog } = await supabase
    .from('mutation_event_log')
    .insert({
      user_message_id: pc.user_message_id,
      event_type: pc.action,
      source_table: pc.target_table,
      source_id: candidate_id,
      before_data: before,
      after_data: afterData,
      mutation_plan: pc.mutation_plan,
      resolver_strategy: 'user_confirmed',
      confidence: 1.0,
      executed_by: 'user_confirmation',
      mutation_mode: 'confirmed',
      idempotency_key: idempotencyKey,
    })
    .select('id')
    .single()

  const undoToken = (mutationLog as any)?.id || null
  const undoAvailableUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  // ------------------------------------------------------------
  // 12. entity_reference_resolution_log 記録
  // ------------------------------------------------------------
  await supabase.from('entity_reference_resolution_log').insert({
    user_message_id: pc.user_message_id,
    reference_text: validCandidate.title || '(unknown)',
    target_table: pc.target_table,
    chosen_target_id: candidate_id,
    candidate_rankings: pc.candidates,
    resolver_strategy: 'user_confirmed',
    confidence: 1.0,
    user_confirmed: true,
  })

  // ------------------------------------------------------------
  // 13. pending_confirmation を confirmed に更新
  // ------------------------------------------------------------
  await supabase
    .from('pending_confirmation')
    .update({
      status: 'confirmed',
      selected_candidate_id: candidate_id,
      confirmed_at: nowISO,
    })
    .eq('id', confirmation_id)

  // ------------------------------------------------------------
  // 14. talk_master にも追記(履歴を残す)
  // ------------------------------------------------------------
  const actionJp = actionToJp(pc.action)
  const replyText = pc.action === 'delete'
    ? `「${validCandidate.title}」を${actionJp}した。30日以内なら戻せる。`
    : `「${validCandidate.title}」を${actionJp}した。`

  const sessionDate = new Date().toISOString().split('T')[0]
  await supabase.from('talk_master').insert({
    role: 'noida',
    content: replyText,
    intent: 'modify',
    importance: 'B',
    session_date: sessionDate,
  })

  // ------------------------------------------------------------
  // 15. レスポンス
  // ------------------------------------------------------------
  return NextResponse.json({
    status: 'executed',
    reply: replyText,
    target_title: validCandidate.title,
    action: pc.action,
    undo_token: undoToken,
    undo_available_until: undoAvailableUntil,
    ui: {
      kind: 'inline_actions',
      actions: undoToken
        ? [
            {
              type: 'undo_mutation',
              mutation_id: undoToken,
              label: '取り消す',
            },
          ]
        : [],
    },
  })
}