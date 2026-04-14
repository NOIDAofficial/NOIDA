'use client'

import { useState, useRef, useEffect } from 'react'
import NoidaChat from '@/components/NoidaChat'
import NoidaHeader from '@/components/NoidaHeader'

export default function Home() {
  return (
    <main className="flex flex-col h-screen max-w-md mx-auto">
      <NoidaHeader />
      <NoidaChat />
    </main>
  )
}
