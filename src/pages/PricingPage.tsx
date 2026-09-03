import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MoxLogo } from '../components/Logo'
import { startCheckout, type PriceKey } from '../lib/accountApi'
import { billingUiEnabled } from '../lib/featureFlags'
import { useAuth } from '../lib/useAuth'

const freeFeatures = [
  'Paste or upload exported decklists — no account required',
  'Full 0–100 health score, sub-scores, curve, and card breakdown',
  'Beta Commander bracket estimate with curated-data version shown',
  'Deterministic Bracket Tuner with local swap explanations',
  'Optional magic-link account: up to 10 saved decks, 20 versions each, one collection',
  'Expiring share links with self-service deletion',
]

const previewProFeatures = [
  'Up to 100 saved decks (20 versions each)',
  'The same free analyzer, deterministic tuner, and collection tools',
  'Stripe Customer Portal for test invoices, cancellation, and payment updates',
]

const plannedProFeatures = [
  'Up to 100 saved decks (20 versions each) and the free collection tools',
  'AI explanations for deterministic tuner swaps (monthly quota)',
  'Advanced Pod Check metrics and saved pod snapshots',
  'Discord Pod Check for linked Pro accounts',
  'Stripe Customer Portal for invoices, cancellation, and payment updates',
]

export default function PricingPage() {
  const navigate = useNavigate()
  const { status, authenticatedFetch } = useAuth()
  const billingEnabled = billingUiEnabled()
  const proFeatures = billingEnabled ? previewProFeatures : plannedProFeatures
  const [busyKey, setBusyKey] = useState<PriceKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function subscribe(priceKey: PriceKey) {
    if (!billingEnabled || busyKey) return
    if (status !== 'authenticated') {
      void navigate('/auth?next=/pricing')
      return
    }
    setBusyKey(priceKey)
    setError(null)
    try {
      const url = await startCheckout(authenticatedFetch, priceKey)
      window.location.assign(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Checkout is temporarily unavailable.')
      setBusyKey(null)
    }
  }

  return (
    <main className="mox-pricing">
      <header className="mox-legal-head">
        <MoxLogo size={28} onClick={() => void navigate('/')} />
        <nav>
          <Link to="/">Analyzer</Link>
          <Link to="/auth">Account</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </nav>
      </header>

      <section className="mox-pricing-hero">
        <p className="t-eyebrow">Pricing</p>
        <h1>{billingEnabled ? 'Preview the Pro billing lifecycle in test mode.' : 'Start free. Pro is not for sale yet.'}</h1>
        <p>
          {billingEnabled
            ? 'No real payment is collected in this Preview. Pro raises the saved-deck limit from 10 to 100; AI, advanced Pod Check, and Discord features are not included yet.'
            : 'Moxscore is focused on a reliable free Commander analyzer. Paid checkout stays closed until billing is enabled in this environment.'}
        </p>
      </section>

      <section className="mox-plan-grid" aria-label="Moxscore plans">
        <article className="mox-plan-card">
          <div className="mox-plan-head">
            <div>
              <p className="mox-plan-kicker">Available now</p>
              <h2>Free</h2>
            </div>
            <span className="mox-plan-price">€0</span>
          </div>
          <p className="mox-plan-copy">
            Analyze exported or copied decklists without creating an account. Optional accounts never gate the analyzer.
          </p>
          <ul className="mox-plan-list">
            {freeFeatures.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
          <Link className="mox-primarybtn mox-plan-action" to="/">
            Analyze a deck
          </Link>
        </article>

        <article className={`mox-plan-card${billingEnabled ? '' : ' mox-plan-card-soon'}`}>
          <div className="mox-plan-head">
            <div>
              <p className="mox-plan-kicker">{billingEnabled ? 'Test subscription' : 'Coming soon'}</p>
              <h2>Pro</h2>
            </div>
            {billingEnabled ? (
              <span className="mox-plan-price">
                €4.99<span className="t-eyebrow"> / month</span>
              </span>
            ) : (
              <span className="mox-soon-pill">Not for sale yet</span>
            )}
          </div>
          <p className="mox-plan-copy">
            {billingEnabled
              ? 'Stripe test mode simulates EUR billing; no real charge is made. Annual plan is €39.99 / year. Access unlocks only after Stripe confirms the subscription — the success page does not grant it.'
              : 'Pro will add constrained AI explanations, higher saved-deck limits, advanced Pod Check, and Discord Pod Check after operating readiness is approved.'}
          </p>
          <ul className="mox-plan-list">
            {proFeatures.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
          {billingEnabled ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <button
                className="mox-primarybtn mox-plan-action"
                type="button"
                disabled={busyKey !== null}
                onClick={() => void subscribe('pro_monthly')}
              >
                {busyKey === 'pro_monthly' ? 'Redirecting…' : status === 'authenticated' ? 'Subscribe monthly' : 'Sign in to subscribe'}
              </button>
              <button
                className="mox-ghostbtn mox-plan-action"
                type="button"
                disabled={busyKey !== null}
                onClick={() => void subscribe('pro_annual')}
              >
                {busyKey === 'pro_annual' ? 'Redirecting…' : 'Subscribe annually (€39.99 / year)'}
              </button>
              {error && <p className="mox-share-error" role="alert">{error}</p>}
            </div>
          ) : (
            <button className="mox-ghostbtn mox-plan-action" type="button" disabled>
              Coming soon
            </button>
          )}
        </article>
      </section>

      <section className="mox-pricing-note">
        <h2>{billingEnabled ? 'How Preview billing works' : 'No checkout yet'}</h2>
        <p>
          {billingEnabled
            ? 'Test Checkout and the Customer Portal are hosted by Stripe. Cancel anytime in the portal; access continues through the simulated paid period end. Account deletion cancels immediately. Heuristic scores remain guidance, not rules certification or performance guarantees.'
            : 'The paid tier stays future-facing until server billing flags and operating readiness are approved. For now, paste or upload a decklist and use the free analysis.'}
        </p>
      </section>
    </main>
  )
}
