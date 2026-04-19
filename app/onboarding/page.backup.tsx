'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

const QUESTIONS = {
  decision_style: {
    type: 'decision_style',
    label: '判断スタイル',
    variants: [
      '締切のある売上案件と重要な相談、どちらを先にやる？',
      '今日中に決める案件と信頼関係が重要な相談、どちらを優先する？',
      '短期的に利益が出る仕事と長期的に関係を築く機会、どちらを選ぶ？',
      '緊急の仕事と重要な人からの依頼、どちらを先に処理する？',
      '売上に直結するタスクと関係維持の連絡、どちらを先にやる？',
    ],
    options: [
      { value: 'A', label: '売上・締切優先' },
      { value: 'B', label: '人間関係優先' },
      { value: 'C', label: '整理してから判断' },
    ],
    feedback: {
      A: '売上・スピード優先ですね。NOIDAを即断型に設定します',
      B: '関係重視ですね。NOIDAを人間関係ファーストに設定します',
      C: 'バランス型ですね。NOIDAを整理型に設定します',
    }
  },
  priority_logic: {
    type: 'priority_logic',
    label: '優先順位',
    variants: [
      '複数の案件がある時、何を基準に優先順位を決める？',
      'タスクが溜まった時、どれから手を付ける？',
      '忙しい時、最初に処理するのはどれ？',
      '優先順位を決める時の基準は？',
      '同時に進める仕事が多い時、何で判断する？',
    ],
    options: [
      { value: 'A', label: '締切が近いもの' },
      { value: 'B', label: '金額・インパクトが大きいもの' },
      { value: 'C', label: '重要な人に関係するもの' },
      { value: 'D', label: '直感で決める' },
    ],
    feedback: {
      A: '締切優先ですね。NOIDAは期限管理を強化します',
      B: 'インパクト重視ですね。NOIDAは金額・効果で判断します',
      C: '関係性優先ですね。NOIDAは人物の重要度で判断します',
      D: '直感型ですね。NOIDAは迷わず1つに絞ります',
    }
  },
  writing_style: {
    type: 'writing_style',
    label: '文体・口調',
    variants: [
      '急ぎの返信が必要。あなたが送りそうなメールはどれ？',
      '取引先への返信、どれに近い？',
      'ビジネスメールのスタイルは？',
      '返信する時の口調は？',
      'メッセージのトーンはどれに近い？',
    ],
    options: [
      { value: 'A', label: '「わかった。明日やる」' },
      { value: 'B', label: '「了解です。明日対応します」' },
      { value: 'C', label: '「承知しました。明日対応いたします」' },
    ],
    feedback: {
      A: 'カジュアルな文体ですね。NOIDAも同じ口調で書きます',
      B: '標準的な文体ですね。NOIDAは丁寧すぎず崩しすぎずで書きます',
      C: 'フォーマルな文体ですね。NOIDAも丁寧語で書きます',
    }
  },
  avoid: {
    type: 'avoid',
    label: '避けたいこと',
    variants: [
      'NOIDAに一番減らしてほしいものは？',
      '日常業務で一番ストレスなのは？',
      '時間を奪われていると感じるのは？',
      'なくしたい無駄はどれ？',
      '改善したい業務はどれ？',
    ],
    options: [
      { value: 'A', label: '返信に悩む時間' },
      { value: 'B', label: 'タスクの見落とし' },
      { value: 'C', label: '無駄なやり取り・会議' },
      { value: 'D', label: 'アイデアが埋もれること' },
    ],
    feedback: {
      A: '返信の迷いを消します。NOIDAが下書きを出します',
      B: '見落としゼロを目指します。NOIDAが先読みします',
      C: '無駄を削ります。NOIDAは必要な時だけ現れます',
      D: 'アイデアを逃しません。NOIDAが即記録します',
    }
  },
  reply_depth: {
    type: 'reply_depth',
    label: '情報量の好み',
    variants: [
      'NOIDAの返答はどれがいい？',
      '意思決定時の情報量はどれくらい必要？',
      '判断材料としてどれくらい説明が欲しい？',
      'AIの返答スタイルはどれがいい？',
      '情報量の好みは？',
    ],
    options: [
      { value: 'A', label: '短く結論だけ（1行）' },
      { value: 'B', label: '結論 + 理由（2〜3行）' },
      { value: 'C', label: '詳しく説明してほしい' },
    ],
    feedback: {
      A: '最短モードに設定します。結論だけ出します',
      B: '標準モードに設定します。結論と理由を出します',
      C: '詳細モードに設定します。しっかり説明します',
    }
  },
}

const QUESTION_ORDER = ['decision_style', 'priority_logic', 'writing_style', 'avoid', 'reply_depth']

function generateOwnerMaster(profile: { name: string; company: string; position: string }, answers: Record<string, string>) {
  const thinkingMap: Record<string, string> = {
    A: '即断即決・売上優先・スピード重視',
    B: '関係重視・丁寧・慎重型',
    C: 'バランス型・整理してから動く',
  }
  const priorityMap: Record<string, string> = {
    A: '締切・期限優先',
    B: 'インパクト・金額優先',
    C: '人間関係・信頼優先',
    D: '直感型・即断',
  }
  const writingMap: Record<string, string> = {
    A: 'カジュアル・断定的・敬語なし',
    B: '標準・丁寧すぎず崩しすぎず',
    C: 'フォーマル・丁寧語',
  }
  const avoidMap: Record<string, string> = {
    A: '返信に悩む時間を削減',
    B: '見落とし・抜け漏れを防止',
    C: '無駄なやり取りを削減',
    D: 'アイデアの埋もれを防止',
  }
  const replyMap: Record<string, string> = {
    A: '結論のみ',
    B: '結論 + 理由1行',
    C: '結論 + 理由 + 補足',
  }

  return {
    name: profile.name,
    company: profile.company,
    position: profile.position,
    thinking_pattern: thinkingMap[answers.decision_style] || '',
    priority_style: priorityMap[answers.priority_logic] || '',
    writing_style: writingMap[answers.writing_style] || '',
    key_issues: avoidMap[answers.avoid] || '',
    active_tasks: replyMap[answers.reply_depth] || '',
  }
}

function generateSample(answers: Record<string, string>) {
  const samples = {
    A: { reply: '【結論】⚪︎⚪︎さんへの返信を今すぐしてください', reason: '売上直結の案件だから' },
    B: { reply: '【結論】⚪︎⚪︎さんとの関係を優先して返信してください', reason: '重要な人物との信頼維持のため' },
    C: { reply: '【結論】タスクを整理してから⚪︎⚪︎さんに返信してください', reason: '優先順位を確認してから動く方が効率的だから' },
  }
  return samples[answers.decision_style as keyof typeof samples] || samples.A
}

export default function OnboardingPage() {
  const [step, setStep] = useState<'intro' | 'profile' | 'questions' | 'complete'>('intro')
  const [profile, setProfile] = useState({ name: '', company: '', position: '' })
  const [currentQ, setCurrentQ] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null)
  const [showFeedback, setShowFeedback] = useState(false)
  const [saving, setSaving] = useState(false)

  const [variantIndices] = useState(() =>
    QUESTION_ORDER.reduce((acc, key) => {
      const q = QUESTIONS[key as keyof typeof QUESTIONS]
      acc[key] = Math.floor(Math.random() * q.variants.length)
      return acc
    }, {} as Record<string, number>)
  )

  const currentKey = QUESTION_ORDER[currentQ]
  const currentQuestion = QUESTIONS[currentKey as keyof typeof QUESTIONS]
  const currentVariant = currentQuestion.variants[variantIndices[currentKey]]

  const handleSelect = (value: string) => {
    setSelectedAnswer(value)
    setShowFeedback(true)
  }

  const handleNext = async () => {
    if (!selectedAnswer) return
    const newAnswers = { ...answers, [currentKey]: selectedAnswer }
    setAnswers(newAnswers)
    setSelectedAnswer(null)
    setShowFeedback(false)

    if (currentQ < QUESTION_ORDER.length - 1) {
      setCurrentQ(prev => prev + 1)
    } else {
      setSaving(true)
      const ownerData = generateOwnerMaster(profile, newAnswers)
      const { data: existing } = await supabase
        .from('owner_master')
        .select('id')
        .order('created_at', { ascending: true })
        .limit(1)
        .single()
      if (existing) {
        await supabase.from('owner_master').update({ ...ownerData, updated_at: new Date().toISOString() }).eq('id', existing.id)
      } else {
        await supabase.from('owner_master').insert(ownerData)
      }
      setSaving(false)
      setStep('complete')
    }
  }

  const sample = step === 'complete' ? generateSample(answers) : null

  // イントロ画面
  if (step === 'intro') {
    return (
      <div className="min-h-screen bg-[#0e0e16] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-2xl bg-white/10 flex items-center justify-center mx-auto mb-6">
            <span className="text-2xl font-bold text-white">N</span>
          </div>
          <h1 className="text-[28px] font-bold text-white mb-3">NOIDAへようこそ</h1>
          <p className="text-[15px] text-white/60 mb-2">時間を、渡す。</p>
          <p className="text-[13px] text-white/40 mb-10">
            いくつかの質問に答えるだけで<br />あなた専用のNOIDAが起動します
          </p>
          <button onClick={() => setStep('profile')}
            className="w-full bg-white text-[#0e0e16] rounded-2xl py-4 text-[15px] font-bold hover:bg-white/90 transition-colors">
            始める（約2分）
          </button>
        </div>
      </div>
    )
  }

  // プロフィール入力画面
  if (step === 'profile') {
    return (
      <div className="min-h-screen bg-[#0e0e16] flex items-center justify-center p-6">
        <div className="max-w-md w-full">
          <p className="text-[11px] text-white/30 uppercase tracking-widest mb-3">基本情報</p>
          <h2 className="text-[22px] font-bold text-white mb-8">あなたのことを教えてください</h2>

          <div className="space-y-4 mb-8">
            <div>
              <label className="text-[11px] text-white/40 uppercase tracking-wider mb-2 block">名前</label>
              <input
                value={profile.name}
                onChange={e => setProfile(p => ({ ...p, name: e.target.value }))}
                placeholder="山田 太郎"
                className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-white/20 outline-none focus:border-white/30 transition-colors"
              />
            </div>
            <div>
              <label className="text-[11px] text-white/40 uppercase tracking-wider mb-2 block">会社名（任意）</label>
              <input
                value={profile.company}
                onChange={e => setProfile(p => ({ ...p, company: e.target.value }))}
                placeholder="株式会社〇〇"
                className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-white/20 outline-none focus:border-white/30 transition-colors"
              />
            </div>
            <div>
              <label className="text-[11px] text-white/40 uppercase tracking-wider mb-2 block">役職（任意）</label>
              <input
                value={profile.position}
                onChange={e => setProfile(p => ({ ...p, position: e.target.value }))}
                placeholder="代表取締役"
                className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-white/20 outline-none focus:border-white/30 transition-colors"
              />
            </div>
          </div>

          <button
            onClick={() => setStep('questions')}
            disabled={!profile.name.trim()}
            className="w-full bg-white text-[#0e0e16] rounded-2xl py-4 text-[14px] font-bold hover:bg-white/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
            次へ
          </button>
        </div>
      </div>
    )
  }

  // 完了画面
  if (step === 'complete') {
    return (
      <div className="min-h-screen bg-[#0e0e16] flex items-center justify-center p-6">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-[#34c759]/20 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">✓</span>
            </div>
            <h2 className="text-[22px] font-bold text-white mb-2">
              {profile.name}さん専用のNOIDAが起動しました
            </h2>
            <p className="text-[13px] text-white/40">5項目を設定完了</p>
          </div>

          <div className="bg-white/5 border border-white/10 rounded-2xl p-5 mb-6">
            <p className="text-[11px] text-white/30 mb-3 uppercase tracking-widest">あなた専用のNOIDA</p>
            <p className="text-[15px] text-white/90 font-medium mb-2">{sample?.reply}</p>
            <p className="text-[13px] text-white/40 italic">{sample?.reason}</p>
            <div className="mt-4 flex gap-2">
              <button className="flex-1 bg-white text-[#0e0e16] rounded-xl py-2.5 text-[13px] font-bold">送信</button>
              <button className="px-4 text-white/40 text-[12px]">修正</button>
              <button className="px-4 text-white/40 text-[12px]">詳しく</button>
            </div>
          </div>

          <p className="text-[12px] text-white/30 text-center mb-6">
            使うほど精度が上がります。
          </p>

          <div className="flex gap-3">
            <a href="/" className="flex-1 bg-white text-[#0e0e16] rounded-2xl py-4 text-[14px] font-bold text-center hover:bg-white/90 transition-colors">
              NOIDAを始める
            </a>
            <a href="/dashboard" className="px-5 bg-white/10 text-white rounded-2xl py-4 text-[14px] font-medium text-center hover:bg-white/20 transition-colors">
              設定
            </a>
          </div>
        </div>
      </div>
    )
  }

  // 質問画面
  return (
    <div className="min-h-screen bg-[#0e0e16] flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="flex gap-1.5 mb-8">
          {QUESTION_ORDER.map((_, i) => (
            <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= currentQ ? 'bg-white' : 'bg-white/20'}`} />
          ))}
        </div>

        <p className="text-[11px] text-white/30 uppercase tracking-widest mb-3">
          Q{currentQ + 1} / {QUESTION_ORDER.length} · {currentQuestion.label}
        </p>
        <h2 className="text-[20px] font-bold text-white mb-8 leading-snug">
          {currentVariant}
        </h2>

        <div className="space-y-3 mb-6">
          {currentQuestion.options.map(option => (
            <button key={option.value} onClick={() => handleSelect(option.value)}
              className={`w-full text-left px-5 py-4 rounded-2xl border transition-all ${
                selectedAnswer === option.value
                  ? 'bg-white text-[#0e0e16] border-white'
                  : 'bg-white/5 text-white/80 border-white/10 hover:bg-white/10 hover:border-white/20'
              }`}>
              <span className="text-[13px] font-medium">{option.label}</span>
            </button>
          ))}
        </div>

        {showFeedback && selectedAnswer && (
          <div className="bg-[#34c759]/10 border border-[#34c759]/30 rounded-2xl px-5 py-4 mb-6">
            <p className="text-[13px] text-[#34c759]">
              {currentQuestion.feedback[selectedAnswer as keyof typeof currentQuestion.feedback]}
            </p>
          </div>
        )}

        {selectedAnswer && (
          <button onClick={handleNext} disabled={saving}
            className="w-full bg-white text-[#0e0e16] rounded-2xl py-4 text-[14px] font-bold hover:bg-white/90 transition-colors disabled:opacity-50">
            {saving ? '設定中...' : currentQ < QUESTION_ORDER.length - 1 ? '次へ' : 'NOIDAを起動する'}
          </button>
        )}
      </div>
    </div>
  )
}