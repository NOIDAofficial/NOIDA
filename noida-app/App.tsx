import React, { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { KeyboardAvoidingView, Platform } from 'react-native'
import MessageList from './components/chat/MessageList'
import Composer from './components/chat/Composer'
import { useChat } from './hooks/useChat'
import { useChatStore } from './stores/chatStore'
import { supabase } from './lib/supabase'
import { Message } from './lib/types'

function uid() {
  return Math.random().toString(36).slice(2)
}

function now() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function App() {
  const { messages, loading, sendMessage } = useChat()
  const { addMessage } = useChatStore()
  const [disabledOptionId, setDisabledOptionId] = useState<string | null>(null)
  const [initialLoading, setInitialLoading] = useState(true)

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
          addMessage({
            id: uid(), role: 'noida',
            content: briefing.top_action,
            hint: briefing.summary || undefined,
            options: [
              { num: '01', text: '今日のタスクを確認する' },
              { num: '02', text: '新しい指示を出す' },
              { num: '03', text: '昨日の振り返り' },
            ],
            timestamp: now(),
          })
        } else {
          const { data: tasks } = await supabase
            .from('task').select('*').eq('done', false)
            .order('created_at', { ascending: false }).limit(1)

          const topTask = tasks?.[0]?.content

          addMessage({
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
          })
        }
      } catch {
        addMessage({
          id: uid(), role: 'noida',
          content: 'おはようございます。今日も判断を任せてください。',
          options: [
            { num: '01', text: '今日のタスクを確認する' },
            { num: '02', text: '新しい指示を出す' },
          ],
          timestamp: now(),
        })
      }
      setInitialLoading(false)
    }
    fetchBriefing()
  }, [])

  const handleSend = (text: string) => {
    sendMessage(text)
  }

  const handleOptionSelect = (msgId: string, text: string) => {
    setDisabledOptionId(msgId)
    sendMessage(text)
  }

  return (
    <SafeAreaProvider>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* ヘッダー */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>NOIDA</Text>
          <Text style={styles.headerSub}>時間を、渡す。</Text>
        </View>

        {/* メッセージエリア */}
        <View style={styles.messageArea}>
          {initialLoading ? (
            <View style={styles.loadingContainer}>
              <Text style={styles.loadingText}>...</Text>
            </View>
          ) : (
            <MessageList
              messages={messages}
              loading={loading}
              disabledOptionId={disabledOptionId}
              onOptionSelect={(text) => {
                const lastNoidaMsg = [...messages].reverse().find(m => m.role === 'noida')
                if (lastNoidaMsg) handleOptionSelect(lastNoidaMsg.id, text)
              }}
            />
          )}
        </View>

        {/* Composer */}
        <Composer onSend={handleSend} disabled={loading} />
      </KeyboardAvoidingView>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0e0e16',
  },
  header: {
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(255,255,255,0.07)',
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.88)',
    letterSpacing: 1,
  },
  headerSub: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.25)',
    marginTop: 2,
  },
  messageArea: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 20,
  },
})