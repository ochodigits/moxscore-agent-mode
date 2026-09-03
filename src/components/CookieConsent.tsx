import { useState } from 'react'
import { Link } from 'react-router-dom'

const ACKNOWLEDGEMENT_KEY = 'moxscore:privacy-notice-ack'

export function PrivacyNotice() {
  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem(ACKNOWLEDGEMENT_KEY) !== 'acknowledged'
    } catch {
      return true
    }
  })

  function acknowledge() {
    try {
      localStorage.setItem(ACKNOWLEDGEMENT_KEY, 'acknowledged')
    } catch {
      // The notice can still be dismissed for this page view when storage is blocked.
    }
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="mox-consent" role="region" aria-label="Privacy notice">
      <div>
        <strong>Privacy-first free analysis.</strong>
        <span>
          Moxscore uses browser storage to keep card lookups fast and preserve the current analysis. A deck is stored remotely only when you press Share.
        </span>
      </div>
      <div className="mox-consent-actions">
        <Link to="/privacy">Privacy</Link>
        <button type="button" className="mox-primarybtn" onClick={acknowledge}>
          Acknowledge
        </button>
      </div>
    </div>
  )
}
