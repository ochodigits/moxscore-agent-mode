import { Link, useNavigate } from 'react-router-dom'
import { MoxLogo } from '../components/Logo'
import { billingUiEnabled } from '../lib/featureFlags'
import { legalReleaseInfo } from '../lib/releaseConfig'
import { accountsUiEnabled } from '../lib/supabaseClient'

export default function PrivacyPage() {
  const navigate = useNavigate()
  const legal = legalReleaseInfo()
  const accountsEnabled = accountsUiEnabled()
  const billingEnabled = billingUiEnabled()

  return (
    <main className="mox-legal">
      <header className="mox-legal-head">
        <MoxLogo size={28} onClick={() => void navigate('/')} />
        <nav>
          <Link to="/">Analyzer</Link>
          <Link to="/terms">Terms</Link>
        </nav>
      </header>

      <article className="mox-legal-doc">
        <p className="t-eyebrow">Privacy Policy</p>
        <h1>Privacy Policy</h1>
        <p>Last updated: August 23, 2026</p>

        {!legal.complete && (
          <div className="mox-legal-alert" role="note">
            <strong>Release information still required</strong>
            <p>The controller/operator name, monitored privacy email, and shared-deck retention period must be confirmed before this policy and the Share feature are released. New share creation remains disabled until then.</p>
          </div>
        )}

        <h2>Who is responsible</h2>
        <p><strong>Controller/operator:</strong> {legal.controllerName ?? 'pending owner confirmation'}.</p>
        <p>
          <strong>Privacy and deletion contact:</strong>{' '}
          {legal.privacyContactEmail ? (
            <a href={`mailto:${legal.privacyContactEmail}`}>{legal.privacyContactEmail}</a>
          ) : (
            'pending owner confirmation; a monitored email address will be published here before release'
          )}.
        </p>

        <h2>Scope and purposes</h2>
        <p>
          Moxscore provides a free, anonymous Commander deck analyzer. It processes a decklist to look up card data, calculate a heuristic score, estimate a Commander bracket, and show suggestions. These operations are necessary to provide the analysis you request.{' '}
          {billingEnabled
            ? 'This Preview environment also lets an optional account start and manage a test-mode Pro subscription. It does not provide public AI features.'
            : 'It does not require an account, collect payment, or provide public AI features.'}
        </p>
        {accountsEnabled && <p>Optional magic-link accounts are enabled in this environment. Signing in is not required for the free analyzer or deterministic tuner; it is used only for the account features described below.</p>}

        <h2>Data processed and legal bases</h2>
        <ul>
          <li><strong>Deck analysis:</strong> card names, quantities, section headings, and any text you include in an uploaded or pasted list are processed because they are necessary to perform the free analysis service you request under the Terms.</li>
          <li><strong>Shared decks:</strong> only when you press Share, Moxscore stores the decklist, deck name, commander, score, format, generated slug, and creation time. This processing is necessary to perform your optional request to create and host a public link under the Terms.</li>
          {accountsEnabled && <li><strong>Optional account:</strong> your email-authentication session, account identifier, saved deck names and versions, and any normalized collection card names and quantities you choose to save are processed to provide those account features. Collection files are parsed in your browser; the original file contents are not saved.</li>}
          {billingEnabled && <li><strong>Pro subscription:</strong> Moxscore stores the account-to-Stripe customer relationship, Stripe subscription identifier, selected plan key, subscription status, paid-period end, cancellation setting, and limited webhook event metadata needed to provide and reconcile Pro access. Payment-card and bank details are collected by Stripe and are not stored by Moxscore.</li>}
          <li><strong>Security and operations:</strong> hosting and API providers may process basic connection data such as IP address, user agent, requested route, timestamps, status codes, and security signals for service delivery, abuse prevention, and legitimate operational interests.</li>
        </ul>

        <h2>Local browser storage</h2>
        <p>Moxscore uses local storage for the Scryfall card cache, Commander Spellbook combo cache, and privacy-notice acknowledgement. Session storage keeps the most recent decklist and Commander format so the results page can survive a refresh. You can clear these values in your browser settings. They are functional storage, not advertising trackers.</p>

        <h2>Recipients and service providers</h2>
        <ul>
          <li><strong>Vercel</strong> hosts the website and server endpoints and may process operational connection data. Moxscore does not enable nonessential product analytics.</li>
          <li><strong>Scryfall</strong> receives card-name lookup requests from the browser so the analyzer can obtain card data and images.</li>
          <li><strong>Commander Spellbook</strong> receives commander and main-deck card names through Moxscore's server endpoint to identify known two-card combos for the beta bracket estimate.</li>
          <li><strong>Supabase</strong> stores shared-deck records only after you press Share{accountsEnabled ? ', and owner-scoped optional-account data when you choose to save it' : ''}. The service role is used only by server endpoints; its key is never sent to the browser.</li>
          {billingEnabled && <li><strong>Stripe</strong> hosts Checkout and the Customer Portal and processes subscription, payment, invoice, tax, fraud-prevention, and related billing data. Stripe's own <a href="https://stripe.com/privacy" target="_blank" rel="noreferrer">Privacy Policy</a> describes its processing.</li>}
          <li><strong>Moxfield or Archidekt</strong> receives the deck identifier when you ask Moxscore to attempt a URL import. Imports rely on third-party endpoints and may fail; paste or upload is the reliable path.</li>
        </ul>
        <p>
          These providers operate internationally and may process data outside your country. Vercel states that it uses appropriate transfer mechanisms, including Standard Contractual Clauses where required, in its{' '}
          <a href="https://vercel.com/legal/privacy-notice" target="_blank" rel="noreferrer">Privacy Notice</a>. Supabase's{' '}
          <a href="https://supabase.com/downloads/docs/Supabase+DPA+260601.pdf" target="_blank" rel="noreferrer">Data Processing Addendum</a>{' '}
          includes the EU Standard Contractual Clauses for covered transfers. Other providers' own notices and terms govern their processing. You may contact the controller for more information about the safeguards applicable to Moxscore.
        </p>

        <h2>Retention and deletion</h2>
        <p>
          Shared decks are public to anyone with the link. Do not include personal information, private notes, or anything you do not want disclosed.{' '}
          {legal.sharedDeckRetentionDays === null
            ? 'The retention period is pending owner confirmation and must be published before release.'
            : `The shared-deck retention rule is ${legal.sharedDeckRetentionDays} days. Expired records are removed by the authenticated daily retention job.`}{' '}
          A shared link can also be deleted with its one-time deletion code. If that code is unavailable, a deletion request will be accepted through the monitored privacy email listed above; include the complete share URL.
        </p>
        <p>When a share is created, Moxscore shows a one-time deletion code. Keep it separately from the public link: it can delete that link, but is never stored in plain text or shown again after you leave the results page.</p>
        {accountsEnabled && <p>Optional-account data is retained while the account exists. You can download the saved account data from the account page. Self-service deletion requires a recently authenticated magic-link session and permanently deletes the Auth user and owner-scoped account data immediately. Anonymous shares are independent records: they are not included in account export or account deletion and require their own deletion code or the 90-day expiry.</p>}
        {billingEnabled && <p>Moxscore retains its limited billing records while needed to operate the test subscription, reconcile provider events, investigate disputes or support cases, and exercise deletion. When you confirm self-service account deletion in this Preview, Moxscore first deletes the linked Stripe test customer and then clears the local billing relationship and account data. Stripe may retain historical test records under its own policy. Retention for live accounting, tax, refund, and dispute records is not finalized; live billing remains closed until the owner decision and public policy match.</p>}

        <h2>Cookies and analytics</h2>
        <p>Moxscore does not set advertising cookies or enable nonessential product analytics. The notice shown in the app records an acknowledgement; it is not presented as consent to nonessential tracking.</p>

        <h2>Your rights and choices</h2>
        <p>You can analyze without sharing, clear browser storage at any time, and use paste or upload instead of a third-party import. Depending on the law that applies to you, you may request access, correction, deletion, restriction, portability, or objection. Where processing depends on a request you made, you can withdraw that request for future processing. You may also complain to your local data-protection authority. The monitored contact above will be the route for these requests.</p>

        <h2>Automated analysis</h2>
        <p>The score, bracket estimate, and suggestions are automated heuristics for entertainment and deck-building guidance. They do not make decisions with legal or similarly significant effects.</p>
      </article>
    </main>
  )
}
