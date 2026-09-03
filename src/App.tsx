import { useState, useEffect, lazy, Suspense } from 'react'
import { Navigate, Routes, Route } from 'react-router-dom'
import { PrivacyNotice } from './components/CookieConsent'
import { FanContentNotice } from './components/FanContentNotice'
import { CardShuffleLoader } from './components/CardShuffleLoader'
import { I18nProvider } from './lib/i18n'
import { AuthProvider } from './lib/auth'

// Route-level code splitting: each page loads its own chunk instead of one
// eager bundle.
const LandingPage = lazy(() => import('./pages/LandingPage'))
const AgentModePage = lazy(() => import('./pages/AgentModePage'))
const ResultsPage = lazy(() => import('./pages/ResultsPage'))
const PrivacyPage = lazy(() => import('./pages/PrivacyPage'))
const TermsPage = lazy(() => import('./pages/TermsPage'))
const AuthPage = lazy(() => import('./pages/AuthPage'))
const PricingPage = lazy(() => import('./pages/PricingPage'))

type Theme = 'dark' | 'light'

function App() {
  const [theme, setTheme] = useState<Theme>('dark')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  function toggleTheme() {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }

  return (
    <I18nProvider>
      <AuthProvider>
        <Suspense fallback={<CardShuffleLoader />}>
          <Routes>
            <Route path="/" element={<LandingPage theme={theme} onToggleTheme={toggleTheme} />} />
            <Route path="/agent" element={<AgentModePage theme={theme} onToggleTheme={toggleTheme} />} />
            <Route path="/results" element={<ResultsPage theme={theme} onToggleTheme={toggleTheme} />} />
            <Route path="/d/:slug" element={<ResultsPage theme={theme} onToggleTheme={toggleTheme} />} />
            <Route path="/auth" element={<AuthPage />} />
            <Route path="/auth/callback" element={<AuthPage />} />
            <Route path="/account" element={<AuthPage />} />
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        <FanContentNotice />
        <PrivacyNotice />
      </AuthProvider>
    </I18nProvider>
  )
}

export default App
