import { useCallback } from 'react'
import { useChatStore } from '../stores/chatStore'
import { Message } from '../lib/types'
import { supabase } from '../lib/supabase'

function uid() {
  return Math.random().toString(36).slice(2)
}

function now() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!

export function useChat() {
  const { messages, loading, addMessage, setLoading, clearOptions } = useChatStore()

  const sendMessage = useCallback(async (userText: string) => {
    if (!userText.trim() || loading) return

    clearOptions()

    const userMsg: Message = {
      id: uid(),
      role: 'user',
      content: userText.trim(),
      timestamp: now(),
    }
    addMessage(userMsg)
    setLoading(true)

    try {
      const msgs = messages
        .slice(-10)
        .map(m => ({ role: m.role === 'noida' ? 'assistant' : 'user', content: m.content }))
      msgs.push({ role: 'user', content: userText.trim() })

      const res = await fetch(`${SUPABASE_URL.replace('.supabase.co', '')}/api/chat`, {
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

      const noidaMsg: Message = {
        id: uid(),
        role: 'noida',
        content: parsed.reply,
        hint: parsed.hint,
        options: parsed.options?.map((o, i) => ({ num: `0${i + 1}`, text: o })),
        saved: parsed.saved
          ? Object.entries(parsed.saved).filter(([, v]) => v).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' / ')
          : undefined,
        timestamp: now(),
      }
      addMessage(noidaMsg)
    } catch {
      addMessage({
        id: uid(),
        role: 'noida',
        content: 'エラーが発生しました。もう一度お試しください。',
        timestamp: now(),
      })
    }

    setLoading(false)
  }, [messages, loading, addMessage, setLoading, clearOptions])

  return { messages, loading, sendMessage }
}