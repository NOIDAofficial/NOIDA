'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Message, Option } from '@/lib/types'
import NoidaIcon from './NoidaIcon'

function now() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function uid() {
  return Math.random().toString(36).slice(2)
}

const INITIAL_MESSAGES: Message[] = [
  {
    id: uid(),
    role: 'noida',
    content: 'おはようございます。今日はAIAIMARTのUI修正が最優先です。先に終わらせると今週リリースに間に合います。',
    hint: '田中商事からメールあり。後で処理します。',
    options: [
      { num: '01', text: 'AIAIMARTから着手する' },
      { num: '02', text: '全タスクを確認する' },
      { num: '03', text: '新しいタスクを追加' },
    ],
    timestamp: now(),
  },
]

export default function NoidaChat() {
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const chatRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  const addMessage = useCallback((msg: Omit<Message, 'id' | 'timestamp'>) => {
    setMessages(prev => [...prev, { ...msg, id: uid(), timestamp: now() }])
  }, [])

  const callClaude = useCallback(async (userMsg: string, history: Message[]) => {
    setLoading(true)

    const systemPrompt = `あなたはNOIDA（ノイダ）。社長専属の意思決定AIです。

役割：ユーザーの代わりに最適な判断を1つだけ提示すること。

絶対ルール：
・必ず1つの結論だけ出す
・短く断定する。長文禁止
・AIっぽい言葉（〜と考えられます、ご確認ください）は禁止
・人間関係は壊さない
・売上と時間を最優先する
・重要な情報はsavedフィールドに記録する
・先読みして能動的に提案する

必ずJSON形式のみで返答：
{
  "reply": "返答文（2〜3文以内）",
  "hint": "進言・一言（省略可）",
  "options": ["選択肢1", "選択肢2", "選択肢3"],
  "saved": "保存した情報（省略可）"
}

optionsは行動に直結するもの2〜3個。
hintは社長への一言進言。省略OK。
savedは今の会話で重要な情報を記録。省略OK。`

    try {
      const msgs = history
        .filter(m => m.role !== 'noida' || !m.options)
        .slice(-10)
        .map(m => ({ role: m.role === 'noida' ? 'assistant' : 'user', content: m.content }))

      msgs.push({ role: 'user', content: userMsg })

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgs, system: systemPrompt }),
      })

      const data = await res.json()
      const text = data.content?.[0]?.text || ''

      let parsed: { reply: string; hint?: string; options?: string[]; saved?: string }
      try {
        const match = text.match(/\{[\s\S]*\}/)
        parsed = JSON.parse(match ? match[0] : text)
      } catch {
        parsed = { reply: text, options: ['了解', '続ける', '後で'] }
      }

      addMessage({
        role: 'noida',
        content: parsed.reply,
        hint: parsed.hint,
        options: parsed.options?.map((o, i) => ({ num: `0${i + 1}`, text: o })),
        saved: parsed.saved ? Object.entries(parsed.saved).filter(([,v]) => v).map(([k,v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' / ') : undefined,
      })
    } catch {
      addMessage({
        role: 'noida',
        content: 'エラーが発生しました。もう一度お試しください。',
        options: [{ num: '01', text: '再試行' }],
      })
    }

    setLoading(false)
  }, [addMessage])

  const handleSend = useCallback(async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || loading) return
    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    // 選択肢を消す
    setMessages(prev => prev.map(m => ({ ...m, options: undefined })))
    addMessage({ role: 'user', content: msg })
    await callClaude(msg, messages)
  }, [input, loading, addMessage, callClaude, messages])

  const handleOption = useCallback((text: string) => {
    handleSend(text)
  }, [handleSend])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px'
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden" style={{ background: '#0e0e16' }}>

      {/* チャットエリア */}
      <div
        ref={chatRef}
        className="flex-1 overflow-y-auto flex flex-col gap-3"
        style={{ padding: '16px' }}
      >
        <div style={{ textAlign: 'center', fontSize: 10, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.06em' }}>
          今日 · 4月14日
        </div>

        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.role === 'noida' ? (
              <div className="flex gap-2 items-end">
                {/* アバター */}
                <div style={{
                  width: 24, height: 24, borderRadius: '50%',
                  background: 'rgba(255,255,255,0.05)',
                  border: '0.5px solid rgba(255,255,255,0.1)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <NoidaIcon size={11} />
                </div>

                <div style={{ maxWidth: '82%' }}>
                  {/* 吹き出し */}
                  <div style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '0.5px solid rgba(255,255,255,0.09)',
                    borderRadius: '4px 14px 14px 14px',
                    padding: '11px 14px',
                  }}>
                    <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.84)', lineHeight: 1.7 }}>
                      {msg.content}
                    </p>

                    {/* 保存通知 */}
                    {msg.saved && (
                      <div style={{
                        marginTop: 8,
                        padding: '5px 9px',
                        background: 'rgba(45,138,78,0.12)',
                        borderRadius: 6,
                        fontSize: 11,
                        color: 'rgba(100,200,130,0.8)',
                      }}>
                        保存済 · {msg.saved}
                      </div>
                    )}

                    {/* ヒント */}
                    {msg.hint && (
                      <div style={{
                        marginTop: 8,
                        paddingTop: 8,
                        borderTop: '0.5px solid rgba(255,255,255,0.07)',
                        fontSize: 11,
                        color: 'rgba(255,255,255,0.32)',
                        fontStyle: 'italic',
                      }}>
                        {msg.hint}
                      </div>
                    )}

                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', marginTop: 5 }}>
                      {msg.timestamp}
                    </div>
                  </div>

                  {/* 選択肢（JARVIS形式） */}
                  {msg.options && msg.options.length > 0 && (
                    <div className="flex flex-col gap-1 mt-2">
                      {msg.options.map((opt) => (
                        <button
                          key={opt.num}
                          onClick={() => handleOption(opt.text)}
                          disabled={loading}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            padding: '9px 13px',
                            border: '0.5px solid rgba(255,255,255,0.1)',
                            borderRadius: 6,
                            background: 'rgba(255,255,255,0.03)',
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'all .18s',
                            width: '100%',
                          }}
                          onMouseEnter={e => {
                            const el = e.currentTarget
                            el.style.background = 'rgba(255,255,255,0.07)'
                            el.style.borderColor = 'rgba(255,255,255,0.2)'
                          }}
                          onMouseLeave={e => {
                            const el = e.currentTarget
                            el.style.background = 'rgba(255,255,255,0.03)'
                            el.style.borderColor = 'rgba(255,255,255,0.1)'
                          }}
                        >
                          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace', width: 18, flexShrink: 0 }}>
                            {opt.num}
                          </span>
                          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', flex: 1, letterSpacing: '0.02em' }}>
                            {opt.text}
                          </span>
                          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>→</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex justify-end">
                <div style={{
                  background: 'rgba(255,255,255,0.9)',
                  borderRadius: '14px 4px 14px 14px',
                  padding: '10px 13px',
                  maxWidth: '72%',
                }}>
                  <p style={{ fontSize: 13, color: '#0e0e16', lineHeight: 1.65 }}>{msg.content}</p>
                  <div style={{ fontSize: 10, color: 'rgba(0,0,0,0.28)', marginTop: 3, textAlign: 'right' }}>
                    {msg.timestamp}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* タイピング */}
        {loading && (
          <div className="flex gap-2 items-end">
            <div style={{
              width: 24, height: 24, borderRadius: '50%',
              background: 'rgba(255,255,255,0.05)',
              border: '0.5px solid rgba(255,255,255,0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              <NoidaIcon size={11} />
            </div>
            <div style={{
              background: 'rgba(255,255,255,0.05)',
              border: '0.5px solid rgba(255,255,255,0.09)',
              borderRadius: '4px 14px 14px 14px',
              padding: '13px 16px',
              display: 'flex',
              gap: 5,
              alignItems: 'center',
            }}>
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  style={{
                    width: 5, height: 5, borderRadius: '50%',
                    background: 'rgba(255,255,255,0.35)',
                    animation: `bounce 0.9s ${i * 0.15}s infinite`,
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 入力エリア */}
      <div style={{
        padding: '10px 16px 16px',
        borderTop: '0.5px solid rgba(255,255,255,0.07)',
        display: 'flex',
        gap: 8,
        alignItems: 'flex-end',
        background: '#0e0e16',
        flexShrink: 0,
      }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="NOIDAに話しかける..."
          rows={1}
          disabled={loading}
          style={{
            flex: 1,
            resize: 'none',
            border: '0.5px solid rgba(255,255,255,0.1)',
            borderRadius: 14,
            padding: '10px 14px',
            fontSize: 13,
            background: 'rgba(255,255,255,0.05)',
            color: 'rgba(255,255,255,0.85)',
            lineHeight: 1.5,
            maxHeight: 100,
            transition: 'border-color .18s',
          }}
          onFocus={e => { e.target.style.borderColor = 'rgba(255,255,255,0.22)' }}
          onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)' }}
        />
        <button
          onClick={() => handleSend()}
          disabled={loading || !input.trim()}
          style={{
            width: 36, height: 36,
            borderRadius: '50%',
            border: 'none',
            background: input.trim() ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.2)',
            cursor: input.trim() ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            transition: 'all .15s',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M7 12V2M7 2L2 7M7 2L12 7" stroke="#0e0e16" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      <style jsx global>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); }
          40% { transform: translateY(-5px); }
        }
      `}</style>
    </div>
  )
}
