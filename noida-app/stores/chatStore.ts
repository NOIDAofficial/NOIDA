import { create } from 'zustand'
import { Message } from '../lib/types'

interface ChatStore {
  messages: Message[]
  loading: boolean
  addMessage: (msg: Message) => void
  setLoading: (loading: boolean) => void
  clearOptions: () => void
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  loading: false,
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
  setLoading: (loading) => set({ loading }),
  clearOptions: () => set((state) => ({
    messages: state.messages.map(m => ({ ...m, options: undefined }))
  })),
}))