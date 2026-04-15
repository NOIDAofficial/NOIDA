'use client'

import { useEffect } from 'react'
import NoidaChat from '@/components/NoidaChat'
import NoidaHeader from '@/components/NoidaHeader'

export default function Home() {
  useEffect(() => {
    const updateHeight = () => {
      const h = window.visualViewport?.height ?? window.innerHeight
      document.documentElement.style.setProperty('--app-height', `${h}px`)
    }
    updateHeight()
    window.visualViewport?.addEventListener('resize', updateHeight)
    window.addEventListener('resize', updateHeight)
    return () => {
      window.visualViewport?.removeEventListener('resize', updateHeight)
      window.removeEventListener('resize', updateHeight)
    }
  }, [])

  return (
    <main style={{
      display: 'grid',
      gridTemplateRows: 'auto minmax(0, 1fr)',
      height: 'var(--app-height, 100dvh)',
      overflow: 'hidden',
      background: '#0e0e16',
      maxWidth: 480,
      margin: '0 auto',
    }}>
      <NoidaHeader />
      <NoidaChat />
    </main>
  )
}
