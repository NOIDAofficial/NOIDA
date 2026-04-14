export default function NoidaIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <line x1="3" y1="15" x2="3" y2="5" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round"/>
      <line x1="3" y1="5" x2="12" y2="15" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round"/>
      <line x1="12" y1="10" x2="12" y2="15" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round"/>
      <circle cx="12" cy="6" r="3" fill="rgba(255,255,255,0.85)"/>
    </svg>
  )
}
