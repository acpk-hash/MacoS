export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <defs>
        <linearGradient id="mLogoGrad" x1="0" y1="0" x2="40" y2="40">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="50%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="9" fill="url(#mLogoGrad)" />
      <ellipse cx="20" cy="20" rx="7.4" ry="9.6" stroke="#fff" strokeWidth="3" fill="none" />
      <line x1="20" y1="7" x2="20" y2="33" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
