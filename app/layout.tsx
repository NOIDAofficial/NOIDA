import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'NOIDA — 時間を、渡す。',
  description: '社長の脳の外側に置く、もう一人の自分',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  )
}
