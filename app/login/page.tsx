'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!email || !password) return
    setLoading(true)
    setError('')

    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        window.location.href = '/onboarding'
      } else {
        console.log('ログイン試行:', email)
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        console.log('ログイン結果:', data, error)
        if (error) throw error
        console.log('ログイン成功、リダイレクト開始')
        window.location.href = '/'
      }
    } catch (err: any) {
      console.log('エラー:', err)
      setError(err.message || 'エラーが発生しました')
    }

    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-[#0e0e16] flex items-center justify-center p-6">
      <div className="max-w-sm w-full">
        <div className="text-center mb-10">
          <div className="w-16 h-16 rounded-2xl bg-white/10 flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl font-bold text-white">N</span>
          </div>
          <h1 className="text-[24px] font-bold text-white mb-1">NOIDA</h1>
          <p className="text-[13px] text-white/40">時間を、渡す。</p>
        </div>

        <div className="space-y-3 mb-6">
          <div>
            <label className="text-[11px] text-white/40 uppercase tracking-wider mb-1.5 block">メールアドレス</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-white/20 outline-none focus:border-white/30 transition-colors"
            />
          </div>
          <div>
            <label className="text-[11px] text-white/40 uppercase tracking-wider mb-1.5 block">パスワード</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-white/20 outline-none focus:border-white/30 transition-colors"
            />
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
            <p className="text-[12px] text-red-400">{error}</p>
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={loading || !email || !password}
          className="w-full bg-white text-[#0e0e16] rounded-2xl py-4 text-[14px] font-bold hover:bg-white/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed mb-4"
        >
          {loading ? '処理中...' : mode === 'login' ? 'ログイン' : 'アカウントを作成'}
        </button>

        <button
          onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError('') }}
          className="w-full text-[13px] text-white/30 hover:text-white/60 transition-colors"
        >
          {mode === 'login' ? 'アカウントをお持ちでない方はこちら' : 'すでにアカウントをお持ちの方はこちら'}
        </button>
      </div>
    </div>
  )
}
