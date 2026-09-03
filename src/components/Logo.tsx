import { Link } from 'react-router-dom'

const GRAD_ID = 'moxGrad'

function MoxMark({ size = 36, glow = true }: { size?: number; glow?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      style={{ display: 'block', filter: glow ? 'drop-shadow(0 4px 14px rgba(131,62,255,0.45))' : 'none' }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={GRAD_ID} x1="4" y1="6" x2="44" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2766FF" />
          <stop offset="0.55" stopColor="#833EFF" />
          <stop offset="1" stopColor="#B929FF" />
        </linearGradient>
      </defs>
      <path
        d="M24 3 L40 12 V36 L24 45 L8 36 V12 Z"
        fill="rgba(131,62,255,0.10)"
        stroke={`url(#${GRAD_ID})`}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path
        d="M8 12 L24 18 L40 12 M24 3 L24 18"
        stroke={`url(#${GRAD_ID})`}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.7}
      />
      <path
        d="M8 36 L24 30 L40 36 M24 45 L24 30"
        stroke={`url(#${GRAD_ID})`}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.7}
      />
      <path
        d="M9 24 H17 L20 18 L24 30 L28 21 L31 24 H39"
        stroke="#fff"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function MoxLogo({
  size = 30,
  color = 'var(--text-primary)',
  glow = true,
  onClick,
}: {
  size?: number
  color?: string
  glow?: boolean
  onClick?: () => void
}) {
  // A real link: keyboard-focusable, announced as a link, middle-clickable.
  // onClick is kept for callers that manage navigation themselves.
  return (
    <Link
      to="/"
      onClick={(e) => {
        if (onClick) {
          e.preventDefault()
          onClick()
        }
      }}
      aria-label="Moxscore home"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        userSelect: 'none',
        textDecoration: 'none',
      }}
    >
      <MoxMark size={size + 6} glow={glow} />
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 800,
          fontSize: size * 0.74,
          letterSpacing: '-0.02em',
          color,
        }}
      >
        mox<span className="t-gradient">score</span>
      </span>
    </Link>
  )
}
