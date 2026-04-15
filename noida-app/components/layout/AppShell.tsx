import React from 'react'
import { View, StyleSheet } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { KeyboardAvoidingView, Platform } from 'react-native'

interface AppShellProps {
  children: React.ReactNode
}

export default function AppShell({ children }: AppShellProps) {
  return (
    <SafeAreaProvider>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <View style={styles.inner}>
          {children}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0e0e16',
  },
  inner: {
    flex: 1,
  },
})