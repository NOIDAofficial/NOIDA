export type MessageRole = 'user' | 'noida'

export interface Option {
  num: string
  text: string
}

export interface Message {
  id: string
  role: MessageRole
  content: string
  hint?: string
  options?: Option[]
  saved?: string
  timestamp: string
}