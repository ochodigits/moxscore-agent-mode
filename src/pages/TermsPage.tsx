import { Link, useNavigate } from 'react-router-dom'
import { MoxLogo } from '../components/Logo'
import { billingUiEnabled } from '../lib/featureFlags'
import { accountsUiEnabled } from '../lib/supabaseClient'

export default function TermsPage() {
  const navigate = useNavigate()
  const accountsEnabled = accountsUiEnabled()
  const billingEnabled = billingUiEnabled()

  return (
    <main className="mox-legal">
      <header className="mox-legal-head">
        <MoxLogo size={28} onClick={() => void navigate('/')} />
        <nav>
          <Link to="/">Analyzer</Link>
          <Link to="/privacy">Privacy</Link>
        </nav>
      </header>

      <article className="mox-legal-doc">
        <p className="t-eyebrow">Terms</p>
        <h1>Terms of Use</h1>
        <p>Last updated: August 23, 2026</p>

        <h2>Unofficial fan tool</h2>
        <p>Moxscore is an unofficial deck analysis tool. It is not produced by, endorsed by, supported by, or affiliated with Wizards of the Coast, Moxfield, Archidekt, or Scryfall.</p>

        <h2>Free analysis</h2>
        <p>Moxscore is a free, anonymous Commander analyzer. Its score, beta bracket estimate, combo lookup, deterministic tuner, and suggestions are heuristic guidance, not a guarantee of deck performance, rules legality, price, or suitability for a particular table. Review the underlying cards and current Commander rules before changing a deck.</p>

        {accountsEnabled && <>
          <h2>Optional account</h2>
          <p>Optional magic-link accounts can save up to 10 decks in total (including archived decks), up to 20 immutable versions per deck, and one normalized collection. They do not change the free analyzer{billingEnabled ? '; a paid entitlement exists only after the server confirms a qualifying Stripe subscription' : ' or create a paid entitlement'}. See the Privacy Policy for the data involved, export, and immediate self-service deletion.</p>
        </>}

        {billingEnabled && <>
          <h2>Pro test-mode exercise</h2>
          <p>In this Preview environment, Pro is exercised with Stripe test data at the monthly and annual price hypotheses shown on the Pricing page. It is not a live offer or charge. Selecting a test plan opens Stripe Checkout. Test access begins only after Stripe confirms the subscription and Moxscore records the entitlement; a return or success URL does not grant access.</p>
          <p>The test subscription can renew and be managed through the Stripe Customer Portal. The current reversible engineering default keeps period-end access through the recorded paid test period and gives no past-due grace. These are test controls, not final public cancellation, withdrawal, refund, dispute, dunning, tax, or invoicing terms.</p>
          <p>Live billing remains closed until the selling/support identity and consumer, tax, refund/dispute, backup, and incident decisions are approved and reflected in Checkout, Stripe settings, support operations, and public terms. Planned AI, advanced Pod Check, and Discord features are not included until separately enabled and accepted.</p>
        </>}

        <h2>Deck imports</h2>
        <p>Deck-builder URL imports depend on unofficial or third-party endpoints and should be treated as experimental. For reliable analysis, export or copy a decklist from your deck builder, then paste or upload the list.</p>

        <h2>Shared links</h2>
        <p>If you create a shared link, the decklist becomes available to anyone with that URL. Do not include personal information, private notes, or anything you do not want to be visible through the link. Links expire after 90 days and can be deleted with the one-time deletion code shown when the link is created. Shares are independent anonymous records, not account-owned content.</p>

        <h2>Acceptable use</h2>
        <p>Do not abuse imports, overload external services, attempt to bypass rate limits, upload unlawful content, or use shared links to publish harmful material.</p>

        <h2>Service availability</h2>
        <p>Moxscore is provided as-is and as available. Card databases, combo data, deck-builder imports, hosting, and storage are supplied by third parties and may be delayed or unavailable. Paste or upload remains the supported fallback for deck-builder import failures.</p>

        <h2>Intellectual property</h2>
        <p>You retain any rights you have in text you submit. You grant Moxscore the limited permission needed to process a decklist and, only when you press Share, make that decklist available at the generated public link. Third-party names, card data, artwork, and other materials remain the property of their respective owners.</p>

        <h2>Changes and termination</h2>
        <p>Moxscore may change, suspend, or end the free service, remove harmful shared content, or restrict abusive traffic. Material changes to these terms will be reflected by an updated date on this page.</p>
      </article>
    </main>
  )
}
