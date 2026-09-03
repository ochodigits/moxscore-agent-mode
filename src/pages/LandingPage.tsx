import { useState, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MoxLogo } from '../components/Logo'
import { ThemeToggle } from '../components/ThemeToggle'
import { useI18n } from '../lib/i18n'
import { DEFAULT_DECKLIST } from '../lib/cardDatabase'
import { looksLikeDeckUrl, importDeckFromUrl } from '../lib/deckApi'
import { billingUiEnabled } from '../lib/featureFlags'
import { useAuth } from '../lib/useAuth'
import { accountsUiEnabled } from '../lib/supabaseClient'

interface LandingPageProps {
  theme: 'dark' | 'light'
  onToggleTheme: () => void
}

export default function LandingPage({ theme, onToggleTheme }: LandingPageProps) {
  const [text, setText] = useState('')
  const [drag, setDrag] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const { t } = useI18n()
  const { status } = useAuth()
  const showAccounts = accountsUiEnabled()
  const signedIn = status === 'authenticated'

  async function importUrl(url: string) {
    const trimmed = url.trim()
    if (!trimmed || !looksLikeDeckUrl(trimmed) || importing) return
    setImportError(null)
    setImporting(true)
    try {
      const result = await importDeckFromUrl(trimmed)
      void navigate('/results', { state: { decklist: result.decklist } })
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "We couldn't import that deck right now. Paste the decklist below and Moxscore will still analyze it.")
    } finally {
      setImporting(false)
    }
  }

  async function handleAnalyze(src?: string) {
    const deck = (src ?? text).trim()
    if (!deck) return

    if (looksLikeDeckUrl(deck)) {
      await importUrl(deck)
      return
    }

    void navigate('/results', { state: { decklist: deck } })
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDrag(false)
    const file = e.dataTransfer.files[0]
    if (file) {
      file.text().then((t) => setText(t))
    } else {
      const dropped = e.dataTransfer.getData('text')
      if (dropped) setText(dropped)
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) file.text().then((t) => setText(t))
  }

  return (
    <div className="mox-landing">
      <div className="mox-glow-violet" />
      <div className="mox-glow-blue" />

      <header className="mox-landing-head">
        <MoxLogo size={28} onClick={() => void navigate('/')} />
        <nav className="mox-landing-nav">
          <Link to="/agent">Agent Mode</Link>
          {showAccounts && (
            <Link to="/auth">{signedIn ? 'Account' : 'Sign in'}</Link>
          )}
          {billingUiEnabled() && <Link to="/pricing">{t('nav.pricing')}</Link>}
          <Link to="/privacy">{t('nav.privacy')}</Link>
          <Link to="/terms">{t('nav.terms')}</Link>
        </nav>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </header>

      <section className="mox-hero">
        <div className="t-eyebrow" style={{ display: 'inline-block' }}>{t('hero.eyebrow')}</div>
        <h1 className="mox-hero-title">
          {t('hero.title1')}<span className="t-gradient">{t('hero.titleAccent')}</span>{t('hero.title2')}
        </h1>
        <p className="mox-hero-sub">
          {t('hero.sub')}
        </p>

        <div className="mox-url-import">
          <div className="mox-url-import-head">
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M16 12l-4-4m0 0l-4 4m4-4v12" />
            </svg>
            <span>{t('import.head')}</span>
          </div>
          <p className="mox-import-note">
            {t('import.note')}
          </p>
          {importError && (
            <div className="mox-url-error">
              <p>{importError}</p>
              {text.trim() && !looksLikeDeckUrl(text.trim()) && (
                <button type="button" className="mox-inlinebtn" onClick={() => void handleAnalyze()}>
                  {t('import.analyzeInstead')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Decklist textarea */}
        <div
          className={`mox-drop${drag ? ' drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          <textarea
            className="mox-decktext"
            placeholder={"1 Sol Ring\n1 Command Tower\n// Commander\n1 The Ur-Dragon\n…"}
            value={text}
            onChange={(e) => { setText(e.target.value); if (importError) setImportError(null) }}
            spellCheck={false}
          />
          <div className="mox-drop-foot">
            <div className="mox-drop-actions">
              <button type="button" className="mox-ghostbtn" onClick={() => fileRef.current?.click()}>
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M16 12l-4-4m0 0l-4 4m4-4v12" />
                </svg>
                {t('import.file')}
              </button>
              <input ref={fileRef} type="file" accept=".txt,.dec,.dek" style={{ display: 'none' }} onChange={onFileChange} />
              <button type="button" className="mox-ghostbtn" onClick={() => { setText(DEFAULT_DECKLIST); void handleAnalyze(DEFAULT_DECKLIST) }}>
                {t('import.sample')}
              </button>
            </div>
            <button
              type="button"
              className="mox-primarybtn"
              onClick={() => void handleAnalyze()}
              disabled={!text.trim() || importing}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              {importing ? t('import.importing') : t('import.analyze')}
            </button>
          </div>
        </div>
      </section>

      <footer className="mox-footer">
        <span>Free, anonymous Commander deck analysis.</span>
        <span>
          <Link to="/privacy">{t('nav.privacy')}</Link>
          <Link to="/terms">{t('nav.terms')}</Link>
        </span>
      </footer>

    </div>
  )
}
