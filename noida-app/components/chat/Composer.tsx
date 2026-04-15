import React, { useRef, useState, useCallback } from 'react'
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

interface ComposerProps {
  onSend: (text: string) => void
  disabled?: boolean
}

export default function Composer({ onSend, disabled }: ComposerProps) {
  const [input, setInput] = useState('')
  const [inputHeight, setInputHeight] = useState(40)
  const insets = useSafeAreaInsets()
  const MIN_HEIGHT = 40
  const MAX_HEIGHT = 120

  const handleSend = useCallback(() => {
    const msg = input.trim()
    if (!msg || disabled) return
    onSend(msg)
    setInput('')
    setInputHeight(MIN_HEIGHT)
  }, [input, disabled, onSend])

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + 8 }]}>
      <TextInput
        style={[styles.input, { height: Math.max(MIN_HEIGHT, inputHeight) }]}
        value={input}
        onChangeText={setInput}
        onContentSizeChange={(e) => {
          const h = e.nativeEvent.contentSize.height
          setInputHeight(Math.min(Math.max(h, MIN_HEIGHT), MAX_HEIGHT))
        }}
        placeholder="NOIDAに話しかける..."
        placeholderTextColor="rgba(255,255,255,0.25)"
        multiline
        editable={!disabled}
        returnKeyType="default"
      />
      <TouchableOpacity
        onPress={handleSend}
        disabled={disabled || !input.trim()}
        style={[
          styles.sendButton,
          { backgroundColor: input.trim() ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.2)' }
        ]}
      >
        <View style={styles.arrow} />
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: 0.5,
    borderTopColor: 'rgba(255,255,255,0.07)',
    backgroundColor: '#0e0e16',
  },
  input: {
    flex: 1,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingTop: Platform.OS === 'ios' ? 10 : 8,
    paddingBottom: Platform.OS === 'ios' ? 10 : 8,
    fontSize: 16,
    backgroundColor: 'rgba(255,255,255,0.05)',
    color: 'rgba(255,255,255,0.85)',
    marginRight: 8,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#0e0e16',
  },
})