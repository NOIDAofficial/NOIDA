export type Role = 'noida' | 'user'

export interface Option {
  num: string
  text: string
}

export interface Message {
  id: string
  role: Role
  content: string
  hint?: string
  mode?: string
  options?: Option[]
  timestamp: string
  saved?: string
}
