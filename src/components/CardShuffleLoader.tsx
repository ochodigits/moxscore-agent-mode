import { useState, useEffect } from 'react'

const MESSAGES = [
  'Fetching cards from Scryfall…',
  'Looking up oracle text…',
  'Checking mana costs…',
  'Running deck analysis…',
]

type CardStyle = {
  '--fan-x': string
  '--fan-y': string
  '--fan-r': string
  animationDelay: string
  zIndex: number
}

const CARDS: CardStyle[] = [
  { '--fan-x': 'calc(-50% - 66px)', '--fan-y': 'calc(-50% + 12px)', '--fan-r': '-28deg', animationDelay: '0ms',     zIndex: 1 },
  { '--fan-x': 'calc(-50% - 33px)', '--fan-y': 'calc(-50% - 3px)',  '--fan-r': '-13deg', animationDelay: '-400ms',  zIndex: 2 },
  { '--fan-x': '-50%',              '--fan-y': 'calc(-50% - 14px)', '--fan-r': '0deg',   animationDelay: '-800ms',  zIndex: 3 },
  { '--fan-x': 'calc(-50% + 33px)', '--fan-y': 'calc(-50% - 3px)',  '--fan-r': '13deg',  animationDelay: '-1200ms', zIndex: 2 },
  { '--fan-x': 'calc(-50% + 66px)', '--fan-y': 'calc(-50% + 12px)', '--fan-r': '28deg',  animationDelay: '-1600ms', zIndex: 1 },
]

export function CardShuffleLoader() {
  const [msgIdx, setMsgIdx] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setMsgIdx((i) => (i + 1) % MESSAGES.length), 1800)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="mox-shuffle-overlay">
      <div className="mox-shuffle-stage">
        {CARDS.map((style, i) => (
          <div
            key={i}
            className="mox-shuffle-card"
            style={style as React.CSSProperties}
          />
        ))}
      </div>
      <p className="mox-shuffle-msg">{MESSAGES[msgIdx]}</p>
    </div>
  )
}
