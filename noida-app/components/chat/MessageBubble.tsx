import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { Message } from '../../lib/types'
import OptionList from './OptionList'

interface MessageBubbleProps {
  message: Message
  isOptionDisabled?: boolean
  onOptionSelect?: (text: string) => void
}

export default function MessageBubble({ message, isOptionDisabled, onOptionSelect }: MessageBubbleProps) {
  const isNoida = message.role === 'noida'

  if (!isNoida) {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{message.content}</Text>
          <Text style={styles.timestamp}>{message.timestamp}</Text>
        </View>
      </View>
    )
  }

  return (
    <View style={styles.noidaRow}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>N</Text>
      </View>
      <View style={styles.noidaContent}>
        <View style={styles.noidaBubble}>
          <Text style={styles.noidaText}>{message.content}</Text>
          {message.saved && (
            <View style={styles.savedBadge}>
              <Text style={styles.savedText}>保存済 · {message.saved}</Text>
            </View>
          )}
          {message.hint && (
            <Text style={styles.hint}>{message.hint}</Text>
          )}
          <Text style={styles.timestampNoida}>{message.timestamp}</Text>
        </View>
        {message.options && message.options.length > 0 && (
          <OptionList
            options={message.options}
            disabled={isOptionDisabled}
            onSelect={(text) => onOptionSelect?.(text)}
          />
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  userRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 4,
  },
  userBubble: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 14,
    borderTopRightRadius: 4,
    padding: 10,
    maxWidth: '72%',
  },
  userText: {
    fontSize: 13,
    color: '#0e0e16',
    lineHeight: 20,
  },
  timestamp: {
    fontSize: 10,
    color: 'rgba(0,0,0,0.28)',
    marginTop: 3,
    textAlign: 'right',
  },
  noidaRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginBottom: 4,
  },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.6)',
    fontWeight: '600',
  },
  noidaContent: {
    maxWidth: '82%',
  },
  noidaBubble: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.09)',
    borderRadius: 4,
    borderTopLeftRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 14,
    padding: 11,
  },
  noidaText: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.84)',
    lineHeight: 22,
  },
  savedBadge: {
    marginTop: 8,
    padding: 5,
    backgroundColor: 'rgba(45,138,78,0.12)',
    borderRadius: 6,
  },
  savedText: {
    fontSize: 11,
    color: 'rgba(100,200,130,0.8)',
  },
  hint: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 0.5,
    borderTopColor: 'rgba(255,255,255,0.07)',
    fontSize: 11,
    color: 'rgba(255,255,255,0.32)',
    fontStyle: 'italic',
  },
  timestampNoida: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.2)',
    marginTop: 5,
  },
})