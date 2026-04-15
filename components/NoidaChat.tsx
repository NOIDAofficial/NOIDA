'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Message } from '@/lib/types'
import NoidaIcon from './NoidaIcon'
import { supabase } from '@/lib/supabase'

function now() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function uid() {
  return Math.random().toString(36).slice(2)
}

function todayString() {
  const d = new Date()
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export default function NoidaChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [disabledOptions, setDisabledOptions] = useState<string | null>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: 'end', behavior })
    })
  }, [])

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    const next = Math.min(el.scrollHeight, 100)
    el.style.height = `${next}px`
  }, [])

  useEffect(() => {
    resizeTextarea()
  }, [input, resizeTextarea])

  useEffect(() => {
    const fetchBriefing = async () => {
      try {
        const today = new Date()
        today.setHours(0, 0, 0, 0)

        const { data: briefing } = await supabase
          .from('daily_briefing')
          .select('*')
          .gte('created_at', today.toISOString())
          .order('created_at', { ascending: false })
          .limit(1)
          .single()

        const { data: owner } = await supabase
          .from('owner_master')
          .select('name')
          .limit(1)
          .single()

        const ownerName = owner?.name ? `${owner.name}さん` : 'おはようございます'

        if (briefing?.top_action) {
          setMessages([{
            id: uid(), role: 'noida',
            content: briefing.top_action,
            hint: briefing.summary || undefined,
            options: [
              { num: '01', text: '今日のタスクを確認する' },
              { num: '02', text: '新しい指示を出す' },
              { num: '03', text: '昨日の振り返り' },
            ],
            timestamp: now(),
          }])
        } else {
          const { data: tasks } = await supabase
            .from('task').select('*').eq('done', false)
            .order('created_at', { ascending: false }).limit(1)

          const topTask = tasks?.[0]?.content

          setMessages([{
            id: uid(), role: 'noida',
            content: topTask
              ? `${ownerName}。今日は「${topTask}」が最優先です。`
              : `${ownerName}。今日も判断を任せてください。`,
            hint: '話しかけるだけで動きます。',
            options: [
              { num: '01', text: '今日のタスクを確認する' },
              { num: '02', text: '新しい指示を出す' },
              { num: '03', text: '重要な人を確認する' },
            ],
            timestamp: now(),
          }])
        }
      } catch {
        setMessages([{
          id: uid(), role: 'noida',
          content: 'おはようございます。今日も判断を任せてください。',
          options: [
            { num: '01', text: '今日のタスクを確認する' },
            { num: '02', text: '新しい指示を出す' },
          ],
          timestamp: now(),
        }])
      }
      setInitialLoading(false)
    }
    fetchBriefing()
  }, [])

  useEffect(() => {
    if (messages.length > 0) scrollToBottom()
  }, [messages, scrollToBottom])

  const addMessage = useCallback((msg: Omit<Message, 'id' | 'timestamp'>) => {
    setMessages(prev => [...prev, { ...msg, id: uid(), timestamp: now() }])
  }, [])

  const callNoida = useCallback(async (userMsg: string, history: Message[]) => {
    setLoading(true)

    try {
      const msgs = history
        .filter(m => m.role !== 'noida' || !m.options)
        .slice(-10)
        .map(m => ({ role: m.role === 'noida' ? 'assistant' : 'user', content: m.content }))

      msgs.push({ role: 'user', content: userMsg })

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgs }),
      })

      const data = await res.json()
      const text = data.content?.[0]?.text || ''

      let parsed: { reply: string; hint?: string; options?: string[]; saved?: any } = { reply: text }
      try {
        const match = text.match(/\{[\s\S]*\}/)
        parsed = JSON.parse(match ? match[0] : text)
      } catch {
        parsed = { reply: text, options: ['了解', '続ける', '後で'] }
      }

      setDisabledOptions(null)
      addMessage({
        role: 'noida',
        content: parsed.reply,
        hint: parsed.hint,
        options: parsed.options?.map((o, i) => ({ num: `0${i + 1}`, text: o })),
        saved: parsed.saved
          ? Object.entries(parsed.saved).filter(([, v]) => v).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' / ')
          : undefined,
      })
    } catch {
      addMessage({
        role: 'noida',
        content: 'エラーが発生しました。もう一度お試しください。',
        options: [{ num: '01', text: '再試行' }],
      })
    }

    setLoading(false)
    scrollToBottom('smooth')
  }, [addMessage, scrollToBottom])

  const handleSend = useCallback(async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || loading) return
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setMessages(prev => prev.map(m => ({ ...m, options: undefined })))
    addMessage({ role: 'user', content: msg })
    scrollToBottom()
    await callNoida(msg, messages)
  }, [input, loading, addMessage, callNoida, messages, scrollToBottom])

  const handleOption = useCallback((msgId: string, text: string) => {
    if (disabledOptions === msgId || loading) return
    setDisabledOptions(msgId)
    handleSend(text)
  }, [disabledOptions, loading, handleSend])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault()
      handleSend()
    }
  }

  if (initialLoading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0e0e16', height: '100%',
      }}>
        <div style={{ display: 'flex', gap: 5 }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              width: 5, height: 5, borderRadius: '50%',
              background: 'rgba(255,255,255,0.35)',
              animation: `bounce 0.9s ${i * 0.15}s infinite`,
            }} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateRows: 'minmax(0, 1fr) auto',
      height: '100%',
      overflow: 'hidden',
      background: '#0e0e16',
    }}>
      {/* メッセージエリア */}
      <div
        ref={chatRef}
        style={{
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch' as any,
          padding: '16px 16px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minHeight: 0,
        }}
      >
        <div style={{ textAlign: 'center', fontSize: 10, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.06em' }}>
          今日 · {todayString()}
        </div>

        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.role === 'noida' ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
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
                  <div style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '0.5px solid rgba(255,255,255,0.09)',
                    borderRadius: '4px 14px 14px 14px',
                    padding: '11px 14px',
                  }}>
                    <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.84)', lineHeight: 1.7, margin: 0 }}>
                      {msg.content}
                    </p>
                    {msg.saved && (
                      <div style={{
                        marginTop: 8, padding: '5px 9px',
                        background: 'rgba(45,138,78,0.12)', borderRadius: 6,
                        fontSize: 11, color: 'rgba(100,200,130,0.8)',
                      }}>
                        保存済 · {msg.saved}
                      </div>
                    )}
                    {msg.hint && (
                      <div style={{
                        marginTop: 8, paddingTop: 8,
                        borderTop: '0.5px solid rgba(255,255,255,0.07)',
                        fontSize: 11, color: 'rgba(255,255,255,0.32)', fontStyle: 'italic',
                      }}>
                        {msg.hint}
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', marginTop: 5 }}>
                      {msg.timestamp}
                    </div>
                  </div>

                  {/* ラジオボタン風選択肢 */}
                  {msg.options && msg.options.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                      {msg.options.map((opt) => {
                        const isDisabled = disabledOptions === msg.id || loading
                        return (
                          <button
                            key={opt.num}
                            onClick={() => handleOption(msg.id, opt.text)}
                            disabled={isDisabled}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 12,
                              padding: '10px 14px',
                              border: `0.5px solid ${isDisabled ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.12)'}`,
                              borderRadius: 10,
                              background: isDisabled ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.03)',
                              cursor: isDisabled ? 'default' : 'pointer',
                              textAlign: 'left',
                              width: '100%',
                              transition: 'all 0.15s',
                              opacity: isDisabled ? 0.4 : 1,
                            }}
                          >
                            {/* ラジオサークル */}
                            <div style={{
                              width: 16, height: 16,
                              borderRadius: '50%',
                              border: `1.5px solid ${isDisabled ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.4)'}`,
                              flexShrink: 0,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                              {disabledOptions === msg.id && (
                                <div style={{
                                  width: 8, height: 8,
                                  borderRadius: '50%',
                                  background: 'rgba(255,255,255,0.8)',
                                }} />
                              )}
                            </div>
                            <span style={{
                              fontSize: 13,
                              color: isDisabled ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.8)',
                              flex: 1,
                            }}>
                              {opt.text}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{
                  background: 'rgba(255,255,255,0.9)',
                  borderRadius: '14px 4px 14px 14px',
                  padding: '10px 13px',
                  maxWidth: '72%',
                }}>
                  <p style={{ fontSize: 13, color: '#0e0e16', lineHeight: 1.65, margin: 0 }}>{msg.content}</p>
                  <div style={{ fontSize: 10, color: 'rgba(0,0,0,0.28)', marginTop: 3, textAlign: 'right' }}>
                    {msg.timestamp}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
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
              display: 'flex', gap: 5, alignItems: 'center',
            }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: 'rgba(255,255,255,0.35)',
                  animation: `bounce 0.9s ${i * 0.15}s infinite`,
                }} />
              ))}
            </div>
          </div>
        )}

        <div ref={bottomRef} style={{ height: 1 }} />
      </div>

      {/* composer */}
      <div style={{
        padding: `10px 16px calc(16px + env(safe-area-inset-bottom))`,
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
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { isComposingRef.current = true }}
          onCompositionEnd={() => { isComposingRef.current = false }}
          placeholder="NOIDAに話しかける..."
          rows={1}
          disabled={loading}
          style={{
            flex: 1,
            resize: 'none',
            border: '0.5px solid rgba(255,255,255,0.1)',
            borderRadius: 14,
            padding: '10px 14px',
            fontSize: 16,
            background: 'rgba(255,255,255,0.05)',
            color: 'rgba(255,255,255,0.85)',
            lineHeight: 1.5,
            maxHeight: 100,
            outline: 'none',
            WebkitAppearance: 'none' as any,
          }}
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
            transition: 'all 0.15s',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M7 12V2M7 2L2 7M7 2L12 7" stroke="#0e0e16" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
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
