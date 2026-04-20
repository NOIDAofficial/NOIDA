/**
 * POST /api/onboarding
 * 
 * 11問のオンボーディング回答を受け取り、
 * GPT-4o で 50軸推定 → 768プリセット → owner_master 生成
 * 
 * 配置先: app/api/onboarding/route.ts
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import { MBTI_OPTIONS, isValidMBTI } from '@/lib/mbti'

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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
})

interface OnboardingAnswers {
  // プロフィール
  name: string
  company?: string
  position?: string
  
  // Q1-Q5 選択式
  q1_avoid: string           // 最も避けたいこと
  q2_judge_angle: string     // 新案で最初に気にすること
  q3_info_shortage: string   // 情報が足りない時
  q4_ideal_advice: string    // 理想のアドバイス
  q5_approach: string        // 自分に近いのは
  
  // Q6-Q8 状況判断
  q6_resource: string        // リソース配分
  q7_market_vs_aesthetic: string  // 市場 vs 美意識
  q8_recovery: string        // ミスからの回復
  
  // Q9-Q10 記述式
  q9_core_values: string     // 一番大事にしていること
  q10_current_theme: string  // 今一番頭を使っているテーマ
  
  // Q11 MBTI(任意)
  mbti: string | null        // 'INTJ' 等 or null
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  
  try {
    const body = await req.json() as OnboardingAnswers
    
    console.log('🌱 [ONBOARDING] 開始:', { name: body.name, mbti: body.mbti })
    
    // 入力検証
    if (!body.name?.trim()) {
      return NextResponse.json({
        success: false,
        message: '名前は必須です',
      }, { status: 400 })
    }
    
    // MBTI 検証(不正な値なら null にする)
    const validMBTI = body.mbti && isValidMBTI(body.mbti) ? body.mbti : null
    
    // ===========================
    // Step 1: GPT-4o で 50軸推定 + プリセット生成
    // ===========================
    
    const mbtiHint = validMBTI 
      ? `\n参考情報: ユーザーの自己申告 MBTI は ${validMBTI} です。これと矛盾しないように推定してください。` 
      : ''
    
    const systemPrompt = `あなたは NOIDA の人格設計エンジンです。
ユーザーの11問のオンボーディング回答から、初期人格プロファイルを生成してください。

# 出力フォーマット(JSON only、前置き禁止)
{
  "thinking_pattern": "判断エンジンの説明(1-2行)",
  "priority_style": "優先順位の付け方(1行)",
  "writing_style": "返答の文体スタイル(1行)",
  "reply_style": "返答の深さ・温度(1行)",
  "avoid_patterns": "避けるパターン(1-2行)",
  "current_focus": "現在のテーマ(Q10を要約、1-2行)",
  "core_values": "大事にしている価値観(Q9を要約、1-2行)",
  "primary_fear": "最も避けたい状況(Q1から推定、1行)",
  "success_patterns": "成功パターン(状況判断Q6-Q8から推定、1-2行)",
  "rejection_patterns": "拒否するパターン(1行)",
  "mood_pattern": "感情傾向(推定、1行)",
  "peer_pressure_resistance": "同調圧力耐性(high/medium/low)",
  "stability": "精神的安定度(stable/learning/volatile)",
  "context_tags": ["タグ1", "タグ2", "タグ3"],
  "preset_id": "判断エンジン8種のうちどれか: decisive/verifier/optimizer/intuitive/deliberator/iterator/contrarian/relationship",
  "risk_stance": "defensive/neutral/aggressive",
  "time_horizon": "short/mid/long/layered",
  "value_driver": "revenue/growth/freedom/aesthetic/stability/advantage/recognition/influence",
  "mbti_estimated": "16タイプのいずれか(MBTI自己申告があればそれ、なければ推定)",
  "confidence": 0.55,
  "summary_for_user": "3行以内でユーザーに見せる短い説明(「〜型で〜を優先する傾向」形式)"
}

# 重要
- JSON のみ出力、前置き・後置き禁止
- confidence は MBTI 自己申告あり=0.65、なし=0.55
- summary_for_user はユーザーの心に響く短い言葉で`

    const userPrompt = `オーナー名: ${body.name}
${body.company ? `会社: ${body.company}\n` : ''}${body.position ? `役職: ${body.position}\n` : ''}

# 選択式(Q1-Q5)
Q1. 最も避けたいこと: ${body.q1_avoid}
Q2. 新案で最初に気にすること: ${body.q2_judge_angle}
Q3. 情報が足りない時: ${body.q3_info_shortage}
Q4. 理想のアドバイス: ${body.q4_ideal_advice}
Q5. 自分に近いのは: ${body.q5_approach}

# 状況判断(Q6-Q8)
Q6. リソース配分(短期 vs 長期): ${body.q6_resource}
Q7. 市場 vs 美意識: ${body.q7_market_vs_aesthetic}
Q8. ミスからの回復: ${body.q8_recovery}

# 記述式(Q9-Q10)
Q9. 今一番大事にしていること:
${body.q9_core_values}

Q10. 今一番頭を使っているテーマ:
${body.q10_current_theme}
${mbtiHint}`
    
    const gptResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1500,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    })
    
    const gptText = gptResponse.choices[0]?.message?.content || ''
    
    let analysis: any = {}
    try {
      const jsonStart = gptText.indexOf('{')
      const jsonEnd = gptText.lastIndexOf('}')
      if (jsonStart < 0 || jsonEnd < 0) throw new Error('No JSON found')
      const jsonStr = gptText.substring(jsonStart, jsonEnd + 1)
      analysis = JSON.parse(jsonStr)
    } catch (e) {
      console.error('❌ [ONBOARDING] JSON 解析失敗:', e, gptText.substring(0, 200))
      // フォールバック:最低限の値で続行
      analysis = {
        thinking_pattern: '解析中',
        priority_style: '解析中',
        writing_style: '標準',
        reply_style: '結論+理由',
        avoid_patterns: '未解析',
        current_focus: body.q10_current_theme,
        core_values: body.q9_core_values,
        primary_fear: body.q1_avoid,
        success_patterns: '未解析',
        rejection_patterns: '未解析',
        mood_pattern: 'neutral',
        peer_pressure_resistance: 'medium',
        stability: 'learning',
        context_tags: [],
        preset_id: 'decisive',
        risk_stance: 'neutral',
        time_horizon: 'mid',
        value_driver: 'growth',
        mbti_estimated: validMBTI || null,
        confidence: 0.3,
        summary_for_user: `${body.name}さんのNOIDAを起動しました`,
      }
    }
    
    // ===========================
    // Step 2: owner_master に INSERT or UPDATE
    // ===========================
    
    const ownerData: Record<string, any> = {
      name: body.name,
      company: body.company || null,
      position: body.position || null,
      
      // 人格情報
      thinking_pattern: analysis.thinking_pattern,
      priority_style: analysis.priority_style,
      writing_style: analysis.writing_style,
      reply_style: analysis.reply_style,
      avoid_patterns: analysis.avoid_patterns,
      current_focus: analysis.current_focus,
      core_values: analysis.core_values,
      primary_fear: analysis.primary_fear,
      success_patterns: analysis.success_patterns,
      rejection_patterns: analysis.rejection_patterns,
      mood_pattern: analysis.mood_pattern,
      peer_pressure_resistance: analysis.peer_pressure_resistance,
      stability: analysis.stability,
      context_tags: analysis.context_tags || [],
      
      // MBTI
      mbti: validMBTI || analysis.mbti_estimated || null,
      mbti_confidence: validMBTI ? 0.65 : (analysis.mbti_estimated ? 0.4 : 0),
      mbti_source: validMBTI ? 'self_reported' : (analysis.mbti_estimated ? 'estimated' : null),
      
      // confidence
      confidence: analysis.confidence || 0.55,
      confidence_by_field: {
        thinking_pattern: 0.6,
        priority_style: 0.6,
        writing_style: 0.6,
        reply_style: 0.6,
        avoid_patterns: 0.55,
        current_focus: 0.9,  // Q10 直接記述なので高い
        core_values: 0.9,    // Q9 直接記述なので高い
        primary_fear: 0.5,
        mbti: validMBTI ? 0.65 : 0.4,
      },
      
      last_updated_by: 'onboarding',
      updated_at: new Date().toISOString(),
    }
    
    // 既存レコードあるか確認
    const { data: existing } = await supabase
      .from('owner_master')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    
    let ownerId: string
    
    if (existing) {
      // UPDATE(既存)
      const { error: updateErr } = await supabase
        .from('owner_master')
        .update(ownerData)
        .eq('id', existing.id)
      
      if (updateErr) throw new Error(`owner_master UPDATE 失敗: ${updateErr.message}`)
      ownerId = existing.id
      console.log('🔄 [ONBOARDING] owner_master 更新:', ownerId)
    } else {
      // INSERT(新規)
      const { data: inserted, error: insertErr } = await supabase
        .from('owner_master')
        .insert(ownerData)
        .select('id')
        .single()
      
      if (insertErr) throw new Error(`owner_master INSERT 失敗: ${insertErr.message}`)
      ownerId = inserted.id
      console.log('✨ [ONBOARDING] owner_master 新規作成:', ownerId)
    }
    
    // ===========================
    // Step 3: milestone_log に誕生日記録
    // ===========================
    
    await supabase.from('milestone_log').insert({
      user_id: ownerId,
      milestone_type: 'birth',
      milestone_name: 'NOIDA誕生日',
      description: `${body.name}さん専用のNOIDAが誕生しました`,
      importance: 'historical',
      milestone_data: {
        answers: {
          q1_avoid: body.q1_avoid,
          q2_judge_angle: body.q2_judge_angle,
          q3_info_shortage: body.q3_info_shortage,
          q4_ideal_advice: body.q4_ideal_advice,
          q5_approach: body.q5_approach,
          q6_resource: body.q6_resource,
          q7_market_vs_aesthetic: body.q7_market_vs_aesthetic,
          q8_recovery: body.q8_recovery,
          q9_core_values: body.q9_core_values,
          q10_current_theme: body.q10_current_theme,
          mbti_self_reported: validMBTI,
        },
        analysis: {
          preset_id: analysis.preset_id,
          risk_stance: analysis.risk_stance,
          time_horizon: analysis.time_horizon,
          value_driver: analysis.value_driver,
          mbti_final: validMBTI || analysis.mbti_estimated,
          confidence: analysis.confidence,
        },
      },
    })
    
    // ===========================
    // Step 4: current_focus を task に初期タスクとして登録
    // ===========================
    
    if (body.q10_current_theme?.trim()) {
      // current_focus の1行目をタスク名として使う
      const firstLine = body.q10_current_theme.split('\n')[0].trim().substring(0, 100)
      if (firstLine.length >= 3) {
        await supabase.from('task').insert({
          content: firstLine,
          done: false,
        })
        console.log('📋 [ONBOARDING] 初期タスク登録:', firstLine)
      }
    }
    
    // ===========================
    // 完了
    // ===========================
    
    const elapsedMs = Date.now() - startedAt
    console.log('🏁 [ONBOARDING] 完了:', { ownerId, elapsedMs })
    
    return NextResponse.json({
      success: true,
      owner_id: ownerId,
      analysis: {
        preset_id: analysis.preset_id,
        risk_stance: analysis.risk_stance,
        value_driver: analysis.value_driver,
        mbti: validMBTI || analysis.mbti_estimated,
        confidence: analysis.confidence,
        summary: analysis.summary_for_user,
      },
      message: `${body.name}さん専用のNOIDAが誕生しました`,
    })
  } catch (e: any) {
    console.error('❌ [ONBOARDING] 例外:', e)
    return NextResponse.json({
      success: false,
      message: `オンボーディング処理でエラー: ${e.message || 'unknown'}`,
    }, { status: 500 })
  }
}