'use client'

import { useState, useEffect } from 'react'
import { MBTI_OPTIONS, MBTIOption } from '@/lib/mbti'

/**
 * NOIDA オンボーディング(Web版・Phase 2-A-1)
 * 
 * 構成:
 *   intro → profile → q1-q10 → q11(MBTI) → analyzing → complete
 * 
 * 演出(簡易・Web版):
 *   - 画面上部に小さな「核」(CSS gradient)
 *   - 質問進捗に応じて光量増加
 *   - Q11 MBTI 選択で核の色が MBTI カラーに変化 + パルス
 *   - Q10 完了後、暗転 → マジックモーメント
 * 
 * アプリ版で本格演出(NOIDAOrb.tsx の WebGL)に置き換え予定
 */

// ============================================
// 質問定義(10問 + Q11)
// ============================================

interface QuestionSelect {
  id: string
  type: 'select'
  label: string
  question: string
  options: { value: string; label: string }[]
}

interface QuestionText {
  id: string
  type: 'text'
  label: string
  question: string
  placeholder: string
  minLength: number
  rows?: number
}

type Question = QuestionSelect | QuestionText

const QUESTIONS: Question[] = [
  {
    id: 'q1_avoid',
    type: 'select',
    label: 'Q1 / 10',
    question: 'あなたが最も避けたいのは?',
    options: [
      { value: 'money_loss',    label: 'お金や機会を失うこと' },
      { value: 'time_waste',    label: '時間を無駄にすること' },
      { value: 'losing',        label: '人に負けること' },
      { value: 'inauthentic',   label: '自分らしくない選択をすること' },
      { value: 'looking_bad',   label: '周囲からダサく見られること' },
    ],
  },
  {
    id: 'q2_judge_angle',
    type: 'select',
    label: 'Q2 / 10',
    question: '新しい案を見た時、最初に気にするのは?',
    options: [
      { value: 'profit',      label: '儲かるか' },
      { value: 'interesting', label: '面白いか' },
      { value: 'sustainable', label: '続くか' },
      { value: 'fast',        label: '速く進められるか' },
      { value: 'advantage',   label: '競争優位があるか' },
    ],
  },
  {
    id: 'q3_info_shortage',
    type: 'select',
    label: 'Q3 / 10',
    question: '情報が足りない時は?',
    options: [
      { value: 'research',  label: '追加で調べる' },
      { value: 'test',      label: '小さく試す' },
      { value: 'intuition', label: '直感で決める' },
      { value: 'ask',       label: '誰かに聞く' },
      { value: 'pause',     label: '一旦止める' },
    ],
  },
  {
    id: 'q4_ideal_advice',
    type: 'select',
    label: 'Q4 / 10',
    question: '理想のアドバイスは?',
    options: [
      { value: 'conclusion',       label: '結論だけ' },
      { value: 'reason',           label: '結論と理由' },
      { value: 'comparison',       label: '選択肢比較' },
      { value: 'harsh',            label: '厳しく本音' },
      { value: 'gentle',           label: '優しく伴走' },
    ],
  },
  {
    id: 'q5_approach',
    type: 'select',
    label: 'Q5 / 10',
    question: 'あなたに近いのは?',
    options: [
      { value: 'act',      label: 'まず動く' },
      { value: 'think',    label: 'まず考える' },
      { value: 'organize', label: 'まず整理する' },
      { value: 'consult',  label: 'まず相談する' },
      { value: 'feel',     label: 'まず熱が乗るか見る' },
    ],
  },
  {
    id: 'q6_resource',
    type: 'select',
    label: 'Q6 / 10',
    question: '今月中に結果が欲しいが、長期で育つ案もある。資金は少ない。どうする?',
    options: [
      { value: 'short_first',  label: '今月の結果を優先、長期案は後回し' },
      { value: 'long_only',    label: '長期案に全振り、短期は諦める' },
      { value: 'balance_82',   label: '8割短期・2割長期で両方動かす' },
      { value: 'hold_all',     label: '資金が足りない時点で両方保留' },
      { value: 'wait_info',    label: 'もう少し情報が揃うまで待つ' },
    ],
  },
  {
    id: 'q7_market_vs_aesthetic',
    type: 'select',
    label: 'Q7 / 10',
    question: '自分は好きだが、市場は微妙そうな企画。どうする?',
    options: [
      { value: 'push',         label: '押す(自分の美意識が最優先)' },
      { value: 'stop',         label: 'やめる(市場が全て)' },
      { value: 'small_test',   label: '条件付きでやる(小さくテスト)' },
      { value: 'ask_trusted',  label: '信頼できる人に意見を聞いてから決める' },
      { value: 'sleep_on_it',  label: '一旦寝かせる' },
    ],
  },
  {
    id: 'q8_recovery',
    type: 'select',
    label: 'Q8 / 10',
    question: '大きなミスをした直後、まず取る行動に一番近いのは?',
    options: [
      { value: 'distance',    label: '一旦距離を置いて頭を冷やす' },
      { value: 'talk',        label: '誰かに話して整理する' },
      { value: 'analyze',     label: 'すぐ原因を分解して次の対策を決める' },
      { value: 'small_win',   label: '別の小さな成功を作って流れを変える' },
      { value: 'next_day',    label: 'その日は深追いせず翌日に持ち越す' },
    ],
  },
  {
    id: 'q9_core_values',
    type: 'text',
    label: 'Q9 / 10',
    question: '今、一番大事にしていることは何ですか?',
    placeholder: '仕事でも人生でも、どちらでも構いません。',
    minLength: 5,
    rows: 3,
  },
  {
    id: 'q10_current_theme',
    type: 'text',
    label: 'Q10 / 10',
    question: '今、あなたが一番頭を使っているテーマは何ですか?',
    placeholder: 'うまくいっていない理由、または迷っている理由もあれば教えてください。',
    minLength: 5,
    rows: 4,
  },
]

// ============================================
// メインコンポーネント
// ============================================

type Step = 'intro' | 'profile' | 'questions' | 'mbti' | 'analyzing' | 'complete' | 'error'

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>('intro')
  const [profile, setProfile] = useState({ name: '', company: '', position: '' })
  const [currentQ, setCurrentQ] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [mbti, setMbti] = useState<string | 'unknown' | null>(null)
  const [mbtiPulseKey, setMbtiPulseKey] = useState(0)  // パルス発火用
  const [analysisResult, setAnalysisResult] = useState<any>(null)
  const [errorMsg, setErrorMsg] = useState('')
  
  // 現在の核の光量レベル(0.0 〜 1.0)
  const getOrbLevel = (): number => {
    if (step === 'intro' || step === 'profile') return 0.1
    if (step === 'questions') return 0.15 + (currentQ / 10) * 0.65
    if (step === 'mbti') return 0.85
    if (step === 'analyzing') return 1.0
    if (step === 'complete') return 1.0
    return 0.1
  }
  
  // 現在の核の色
  const getOrbColor = (): [number, number, number] => {
    if ((step === 'mbti' || step === 'complete') && mbti && mbti !== 'unknown') {
      const opt = MBTI_OPTIONS.find(o => o.code === mbti)
      if (opt) return opt.color as [number, number, number]
    }
    return [0.38, 0.62, 1.0]  // デフォルト NOIDA 青
  }
  
  const handleSelectAnswer = (questionId: string, value: string) => {
    setAnswers(prev => ({ ...prev, [questionId]: value }))
  }
  
  const handleTextAnswer = (questionId: string, value: string) => {
    setAnswers(prev => ({ ...prev, [questionId]: value }))
  }
  
  const handleNextQuestion = () => {
    if (currentQ < QUESTIONS.length - 1) {
      setCurrentQ(prev => prev + 1)
    } else {
      setStep('mbti')
    }
  }
  
  const handleMBTISelect = (selection: string | 'unknown') => {
    setMbti(selection)
    setMbtiPulseKey(prev => prev + 1)  // パルス再発火
  }
  
  const handleStartAnalysis = async () => {
    setStep('analyzing')
    
    try {
      const payload = {
        name: profile.name,
        company: profile.company || undefined,
        position: profile.position || undefined,
        ...answers,
        mbti: mbti === 'unknown' ? null : mbti,
      }
      
      const res = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      
      const data = await res.json()
      
      if (!data.success) {
        throw new Error(data.message || 'オンボーディング失敗')
      }
      
      setAnalysisResult(data)
      
      // 演出のため 2 秒待つ(マジックモーメント)
      setTimeout(() => {
        setStep('complete')
      }, 2000)
    } catch (e: any) {
      console.error(e)
      setErrorMsg(e.message || 'エラーが発生しました')
      setStep('error')
    }
  }
  
  // ===========================
  // 画面描画
  // ===========================
  
  return (
    <div className="min-h-screen bg-[#0e0e16] text-white relative overflow-hidden">
      {/* 画面上部の「核」(CSS 簡易版) */}
      <NoidaOrb 
        level={getOrbLevel()} 
        color={getOrbColor()} 
        pulseKey={mbtiPulseKey}
      />
      
      {/* コンテンツ */}
      <div className="relative z-10 min-h-screen flex items-center justify-center p-6 pt-40">
        <div className="max-w-md w-full">
          {step === 'intro' && <IntroScreen onNext={() => setStep('profile')} />}
          {step === 'profile' && (
            <ProfileScreen 
              profile={profile} 
              setProfile={setProfile} 
              onNext={() => setStep('questions')} 
            />
          )}
          {step === 'questions' && (
            <QuestionScreen
              question={QUESTIONS[currentQ]}
              answer={answers[QUESTIONS[currentQ].id]}
              onSelectAnswer={v => handleSelectAnswer(QUESTIONS[currentQ].id, v)}
              onTextAnswer={v => handleTextAnswer(QUESTIONS[currentQ].id, v)}
              onNext={handleNextQuestion}
              progress={(currentQ + 1) / QUESTIONS.length}
            />
          )}
          {step === 'mbti' && (
            <MBTIScreen
              selected={mbti}
              onSelect={handleMBTISelect}
              onStart={handleStartAnalysis}
            />
          )}
          {step === 'analyzing' && <AnalyzingScreen name={profile.name} />}
          {step === 'complete' && (
            <CompleteScreen 
              name={profile.name} 
              result={analysisResult}
              mbti={mbti !== 'unknown' ? mbti : null}
            />
          )}
          {step === 'error' && <ErrorScreen message={errorMsg} />}
        </div>
      </div>
    </div>
  )
}

// ============================================
// 核コンポーネント(CSS 簡易版)
// ============================================

function NoidaOrb({ 
  level, 
  color, 
  pulseKey 
}: { 
  level: number
  color: [number, number, number]
  pulseKey: number
}) {
  const [isPulsing, setIsPulsing] = useState(false)
  
  useEffect(() => {
    if (pulseKey > 0) {
      setIsPulsing(true)
      const t = setTimeout(() => setIsPulsing(false), 1200)
      return () => clearTimeout(t)
    }
  }, [pulseKey])
  
  const rgbColor = `rgb(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)})`
  const size = 80 + level * 40
  const glow = 20 + level * 80
  const opacity = 0.3 + level * 0.7
  
  return (
    <div className="absolute top-12 left-1/2 -translate-x-1/2 z-0 pointer-events-none">
      <div
        className={`rounded-full transition-all duration-[1200ms] ease-out ${isPulsing ? 'animate-noida-pulse' : ''}`}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          background: `radial-gradient(circle at 40% 40%, 
            rgba(255, 255, 255, ${opacity * 0.9}) 0%, 
            ${rgbColor} 30%, 
            rgba(0, 0, 20, 0) 70%)`,
          boxShadow: `0 0 ${glow}px ${rgbColor}, 0 0 ${glow * 2}px ${rgbColor}80`,
          opacity: opacity,
        }}
      />
      <style jsx>{`
        @keyframes noida-pulse {
          0%, 100% { transform: scale(1); filter: brightness(1); }
          25%      { transform: scale(1.15); filter: brightness(1.6); }
          50%      { transform: scale(1); filter: brightness(1); }
          75%      { transform: scale(1.15); filter: brightness(1.6); }
        }
        .animate-noida-pulse {
          animation: noida-pulse 1.2s ease-in-out;
        }
      `}</style>
    </div>
  )
}

// ============================================
// イントロ画面
// ============================================

function IntroScreen({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center">
      <h1 className="text-[28px] font-bold text-white mb-3">NOIDAへようこそ</h1>
      <p className="text-[15px] text-white/60 mb-2">時間を、渡す。</p>
      <p className="text-[13px] text-white/40 mb-10 leading-relaxed">
        10の問いに答えるだけで<br />
        あなた専用のNOIDAが誕生します
      </p>
      <button
        onClick={onNext}
        className="w-full bg-white text-[#0e0e16] rounded-2xl py-4 text-[15px] font-bold hover:bg-white/90 transition-colors"
      >
        始める(約3〜5分)
      </button>
    </div>
  )
}

// ============================================
// プロフィール画面
// ============================================

function ProfileScreen({ 
  profile, 
  setProfile, 
  onNext 
}: { 
  profile: { name: string; company: string; position: string }
  setProfile: (p: any) => void
  onNext: () => void
}) {
  return (
    <div>
      <p className="text-[11px] text-white/30 uppercase tracking-widest mb-3">基本情報</p>
      <h2 className="text-[22px] font-bold text-white mb-8">あなたのことを教えてください</h2>
      
      <div className="space-y-4 mb-8">
        <InputField
          label="名前"
          value={profile.name}
          onChange={v => setProfile({ ...profile, name: v })}
          placeholder="山田 太郎"
        />
        <InputField
          label="会社名(任意)"
          value={profile.company}
          onChange={v => setProfile({ ...profile, company: v })}
          placeholder="株式会社〇〇"
        />
        <InputField
          label="役職(任意)"
          value={profile.position}
          onChange={v => setProfile({ ...profile, position: v })}
          placeholder="代表取締役"
        />
      </div>
      
      <button
        onClick={onNext}
        disabled={!profile.name.trim()}
        className="w-full bg-white text-[#0e0e16] rounded-2xl py-4 text-[14px] font-bold hover:bg-white/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        次へ
      </button>
    </div>
  )
}

function InputField({ 
  label, value, onChange, placeholder 
}: { 
  label: string; value: string; onChange: (v: string) => void; placeholder: string 
}) {
  return (
    <div>
      <label className="text-[11px] text-white/40 uppercase tracking-wider mb-2 block">{label}</label>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-white/20 outline-none focus:border-white/30 transition-colors"
      />
    </div>
  )
}

// ============================================
// 質問画面
// ============================================

function QuestionScreen({
  question,
  answer,
  onSelectAnswer,
  onTextAnswer,
  onNext,
  progress,
}: {
  question: Question
  answer: string | undefined
  onSelectAnswer: (v: string) => void
  onTextAnswer: (v: string) => void
  onNext: () => void
  progress: number
}) {
  const canProceed = question.type === 'select' 
    ? !!answer 
    : !!answer && answer.trim().length >= question.minLength
  
  return (
    <div>
      {/* progress bar */}
      <div className="flex gap-1 mb-8">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className="h-1 flex-1 rounded-full transition-colors"
            style={{ 
              background: i < Math.floor(progress * 10) ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.15)'
            }}
          />
        ))}
      </div>
      
      <p className="text-[11px] text-white/30 uppercase tracking-widest mb-3">
        {question.label}
      </p>
      <h2 className="text-[19px] font-bold text-white mb-8 leading-relaxed">
        {question.question}
      </h2>
      
      {question.type === 'select' ? (
        <div className="space-y-3 mb-6">
          {question.options.map(opt => (
            <button
              key={opt.value}
              onClick={() => onSelectAnswer(opt.value)}
              className={`w-full text-left px-5 py-4 rounded-2xl border transition-all ${
                answer === opt.value
                  ? 'bg-white text-[#0e0e16] border-white'
                  : 'bg-white/5 text-white/80 border-white/10 hover:bg-white/10 hover:border-white/20'
              }`}
            >
              <span className="text-[13px] font-medium">{opt.label}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="mb-6">
          <textarea
            value={answer || ''}
            onChange={e => onTextAnswer(e.target.value)}
            placeholder={question.placeholder}
            rows={question.rows || 3}
            className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-white/20 outline-none focus:border-white/30 transition-colors resize-none"
          />
          {answer && answer.trim().length > 0 && answer.trim().length < question.minLength && (
            <p className="text-[11px] text-white/40 mt-2">
              もう少し詳しく教えてください(あと {question.minLength - answer.trim().length} 文字以上)
            </p>
          )}
        </div>
      )}
      
      {canProceed && (
        <button
          onClick={onNext}
          className="w-full bg-white text-[#0e0e16] rounded-2xl py-4 text-[14px] font-bold hover:bg-white/90 transition-colors"
        >
          次へ
        </button>
      )}
    </div>
  )
}

// ============================================
// MBTI 選択画面(Q11)
// ============================================

function MBTIScreen({
  selected,
  onSelect,
  onStart,
}: {
  selected: string | 'unknown' | null
  onSelect: (s: string | 'unknown') => void
  onStart: () => void
}) {
  return (
    <div>
      <p className="text-[11px] text-white/30 uppercase tracking-widest mb-3">Q11(任意)</p>
      <h2 className="text-[19px] font-bold text-white mb-2 leading-relaxed">
        MBTIを知っていますか?
      </h2>
      <p className="text-[12px] text-white/40 mb-6">
        分析精度が上がります
      </p>
      
      <div className="grid grid-cols-4 gap-2 mb-4">
        {MBTI_OPTIONS.map(opt => (
          <button
            key={opt.code}
            onClick={() => onSelect(opt.code)}
            className={`py-3 px-2 rounded-xl border transition-all ${
              selected === opt.code
                ? 'bg-white/10 border-2'
                : 'bg-white/5 border border-white/10 hover:bg-white/10'
            }`}
            style={{
              borderColor: selected === opt.code ? opt.hex : undefined,
              boxShadow: selected === opt.code ? `0 0 20px ${opt.hex}80` : undefined,
            }}
          >
            <div className="text-[12px] font-bold text-white">{opt.code}</div>
            <div className="text-[10px] text-white/50 mt-0.5">{opt.name}</div>
          </button>
        ))}
      </div>
      
      <div className="border-t border-white/10 my-5" />
      
      <button
        onClick={() => onSelect('unknown')}
        className={`w-full py-3 rounded-xl border transition-all ${
          selected === 'unknown'
            ? 'bg-white/10 border-white/40'
            : 'bg-white/5 border-white/10 hover:bg-white/10'
        }`}
      >
        <span className="text-[13px] text-white/70">知らない / 答えたくない</span>
      </button>
      
      {selected && (
        <button
          onClick={onStart}
          className="w-full bg-white text-[#0e0e16] rounded-2xl py-4 text-[14px] font-bold hover:bg-white/90 transition-colors mt-6"
        >
          分析を開始
        </button>
      )}
    </div>
  )
}

// ============================================
// 解析中画面(マジックモーメント)
// ============================================

function AnalyzingScreen({ name }: { name: string }) {
  return (
    <div className="text-center py-20">
      <p className="text-[15px] text-white/60 mb-3">
        あなただけのNOIDAを組み立てています
      </p>
      <p className="text-[12px] text-white/30">
        少しだけ時間をください
      </p>
    </div>
  )
}

// ============================================
// 完了画面
// ============================================

function CompleteScreen({ 
  name, 
  result,
  mbti,
}: { 
  name: string
  result: any
  mbti: string | null
}) {
  const mbtiOpt = mbti ? MBTI_OPTIONS.find(o => o.code === mbti) : null
  
  return (
    <div className="text-center">
      <p className="text-[13px] text-white/50 mb-3 tracking-widest uppercase">Analysis Complete</p>
      <h2 className="text-[22px] font-bold text-white mb-2">
        {name}さん専用の
      </h2>
      <h2 className="text-[22px] font-bold text-white mb-6">
        NOIDAの核が完成しました
      </h2>
      
      {result?.analysis?.summary && (
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5 mb-6">
          <p className="text-[14px] text-white/90 leading-relaxed">
            {result.analysis.summary}
          </p>
        </div>
      )}
      
      <div className="space-y-2 mb-8 text-left">
        {result?.analysis?.preset_id && (
          <InfoRow label="判断タイプ" value={presetLabel(result.analysis.preset_id)} />
        )}
        {result?.analysis?.risk_stance && (
          <InfoRow label="リスク姿勢" value={riskLabel(result.analysis.risk_stance)} />
        )}
        {result?.analysis?.value_driver && (
          <InfoRow label="駆動価値" value={valueLabel(result.analysis.value_driver)} />
        )}
        {mbtiOpt && (
          <InfoRow label="MBTI" value={`${mbtiOpt.code} ${mbtiOpt.name}`} color={mbtiOpt.hex} />
        )}
        {result?.analysis?.confidence != null && (
          <InfoRow 
            label="マッチング精度" 
            value={`${Math.round(result.analysis.confidence * 100)}%`} 
          />
        )}
      </div>
      
      <a
        href="/"
        className="block w-full bg-white text-[#0e0e16] rounded-2xl py-4 text-[14px] font-bold hover:bg-white/90 transition-colors"
      >
        NOIDAを始める
      </a>
    </div>
  )
}

function InfoRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-white/5">
      <span className="text-[11px] text-white/40 uppercase tracking-wider">{label}</span>
      <span 
        className="text-[13px] font-medium"
        style={{ color: color || 'rgba(255,255,255,0.9)' }}
      >
        {value}
      </span>
    </div>
  )
}

function presetLabel(id: string): string {
  const m: Record<string, string> = {
    decisive: '即断型',
    verifier: '検証型',
    optimizer: '最適化型',
    intuitive: '直感型',
    deliberator: '熟考型',
    iterator: '反復型',
    contrarian: '逆張り型',
    relationship: '関係重視型',
  }
  return m[id] || id
}

function riskLabel(stance: string): string {
  return ({ defensive: '守り', neutral: '中立', aggressive: '攻め' })[stance] || stance
}

function valueLabel(driver: string): string {
  return ({
    revenue: '売上', growth: '成長', freedom: '自由', aesthetic: '美学',
    stability: '安定', advantage: '競争優位', recognition: '承認', influence: '影響力',
  })[driver] || driver
}

// ============================================
// エラー画面
// ============================================

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="text-center py-10">
      <p className="text-[15px] text-white/80 mb-4">うまくいかなかった</p>
      <p className="text-[12px] text-white/40 mb-6">{message}</p>
      <button
        onClick={() => window.location.reload()}
        className="bg-white text-[#0e0e16] rounded-2xl px-8 py-3 text-[13px] font-bold hover:bg-white/90 transition-colors"
      >
        やり直す
      </button>
    </div>
  )
}