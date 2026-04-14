import NoidaIcon from './NoidaIcon'

export default function NoidaHeader() {
  return (
    <header className="flex-shrink-0" style={{
      background: '#0e0e16',
      borderBottom: '0.5px solid rgba(255,255,255,0.07)',
      padding: '18px 20px 14px',
    }}>
      {/* トップ行 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.05)',
            border: '0.5px solid rgba(255,255,255,0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <NoidaIcon size={16} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'rgba(255,255,255,0.88)', letterSpacing: '0.05em' }}>
              NOIDA
            </div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', marginTop: 1, letterSpacing: '0.04em' }}>
              時間を、渡す。
            </div>
          </div>
        </div>

        {/* ステータス */}
        <div className="flex items-center gap-2">
          <div style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#2d8a4e',
            animation: 'pulse 2s infinite',
          }} />
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.04em' }}>
            稼働中
          </span>
        </div>
      </div>

      {/* サマリー */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { n: '3', l: '残りタスク' },
          { n: '12', l: 'メモ' },
          { n: '8', l: '完了' },
        ].map((s) => (
          <div key={s.l} style={{
            background: 'rgba(255,255,255,0.04)',
            border: '0.5px solid rgba(255,255,255,0.07)',
            borderRadius: 10,
            padding: '8px 10px',
          }}>
            <div style={{ fontSize: 20, fontWeight: 500, color: 'rgba(255,255,255,0.82)', lineHeight: 1 }}>{s.n}</div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', marginTop: 2 }}>{s.l}</div>
          </div>
        ))}
      </div>

      <style jsx global>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>
    </header>
  )
}
