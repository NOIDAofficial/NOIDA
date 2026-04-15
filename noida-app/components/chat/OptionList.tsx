import React from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { Option } from '../../lib/types'

interface OptionListProps {
  options: Option[]
  disabled?: boolean
  onSelect: (text: string) => void
}

export default function OptionList({ options, disabled, onSelect }: OptionListProps) {
  return (
    <View style={styles.container}>
      {options.map((opt) => (
        <TouchableOpacity
          key={opt.num}
          onPress={() => !disabled && onSelect(opt.text)}
          disabled={disabled}
          style={[styles.option, disabled && styles.disabled]}
          activeOpacity={0.7}
        >
          <View style={[styles.radio, disabled && styles.radioDisabled]}>
            {disabled && <View style={styles.radioDot} />}
          </View>
          <Text style={[styles.text, disabled && styles.textDisabled]}>
            {opt.text}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    marginTop: 8,
    gap: 6,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  disabled: {
    opacity: 0.4,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDisabled: {
    borderColor: 'rgba(255,255,255,0.2)',
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.8)',
  },
  text: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.8)',
    flex: 1,
  },
  textDisabled: {
    color: 'rgba(255,255,255,0.4)',
  },
})
