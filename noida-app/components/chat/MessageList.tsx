import React, { useRef, useCallback } from 'react'
import { FlatList, View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { Message } from '../../lib/types'
import MessageBubble from './MessageBubble'

interface MessageListProps {
  messages: Message[]
  loading?: boolean
  disabledOptionId?: string | null
  onOptionSelect?: (text: string) => void
}

export default function MessageList({ messages, loading, disabledOptionId, onOptionSelect }: MessageListProps) {
  const flatListRef = useRef<FlatList>(null)

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      flatListRef.current?.scrollToEnd({ animated: true })
    })
  }, [])

  return (
    <FlatList
      ref={flatListRef}
      data={messages}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <MessageBubble
          message={item}
          isOptionDisabled={disabledOptionId === item.id}
          onOptionSelect={(text) => {
            onOptionSelect?.(text)
          }}
        />
      )}
      onContentSizeChange={scrollToBottom}
      onLayout={scrollToBottom}
      contentContainerStyle={styles.content}
      ListHeaderComponent={
        <Text style={styles.dateLabel}>今日 · {new Date().getMonth() + 1}月{new Date().getDate()}日</Text>
      }
      ListFooterComponent={
        loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color="rgba(255,255,255,0.4)" size="small" />
          </View>
        ) : null
      }
      showsVerticalScrollIndicator={false}
    />
  )
}

const styles = StyleSheet.create({
  content: {
    padding: 16,
    paddingBottom: 8,
    gap: 12,
  },
  dateLabel: {
    textAlign: 'center',
    fontSize: 10,
    color: 'rgba(255,255,255,0.2)',
    letterSpacing: 1,
    marginBottom: 8,
  },
  loading: {
    paddingVertical: 16,
    alignItems: 'center',
  },
})
