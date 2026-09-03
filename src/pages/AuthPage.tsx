import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { MoxLogo } from '../components/Logo'
import { useAuth } from '../lib/useAuth'
import {
  confirmAccountDeletion,
  createSavedDeck,
  deleteCollection,
  deleteSavedDeck,
  exportAccountData,
  getAccountMe,
  getCollection,
  listDeckVersions,
  listSavedDecks,
  openBillingPortal,
  replaceCollection,
  startAccountDeletion,
  startCheckout,
  updateSavedDeck,
  type AccountMe,
  type SavedCollection,
  type SavedCollectionCard,
  type SavedDeck,
} from '../lib/accountApi'
import { parseCollection } from '../lib/collectionParser'
import { billingUiEnabled } from '../lib/featureFlags'
import { collectionsUiEnabled, persistenceUiEnabled } from '../lib/supabaseClient'
import { compareVersions, type VersionComparison } from '../lib/versionComparison'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function AuthPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { status, user, sendMagicLink, signOut, authenticatedFetch } = useAuth()
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [decks, setDecks] = useState<SavedDeck[]>([])
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [newDeckName, setNewDeckName] = useState('')
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [comparison, setComparison] = useState<VersionComparison | null>(null)
  const [collection, setCollection] = useState<SavedCollection | null>(null)
  const [collectionCards, setCollectionCards] = useState<SavedCollectionCard[]>([])
  const [collectionBusy, setCollectionBusy] = useState(false)
  const [collectionError, setCollectionError] = useState<string | null>(null)
  const [collectionMessage, setCollectionMessage] = useState<string | null>(null)
  const [deleteStep, setDeleteStep] = useState<'idle' | 'confirming'>('idle')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletionRequestToken, setDeletionRequestToken] = useState<string | null>(null)
  const [accountMe, setAccountMe] = useState<AccountMe | null>(null)
  const [billingBusy, setBillingBusy] = useState(false)
  const [billingError, setBillingError] = useState<string | null>(null)
  const [billingMessage, setBillingMessage] = useState<string | null>(null)
  const showLibrary = persistenceUiEnabled()
  const showCollections = collectionsUiEnabled()
  const showBilling = billingUiEnabled()
  const checkoutComplete = searchParams.get('checkout') === 'complete'

  useEffect(() => {
    if (status !== 'authenticated' || !showLibrary) return
    void listSavedDecks(authenticatedFetch)
      .then(setDecks)
      .catch((cause) => setLibraryError(cause instanceof Error ? cause.message : 'Could not load saved decks.'))
  }, [authenticatedFetch, showLibrary, status])

  useEffect(() => {
    if (status !== 'authenticated' || !showBilling) return
    let cancelled = false
    let attempts = 0
    let timer: number | undefined

    async function refreshMe(): Promise<boolean> {
      try {
        const me = await getAccountMe(authenticatedFetch)
        if (cancelled) return true
        setAccountMe(me)
        setBillingError(null)
        if (checkoutComplete && me.plan === 'pro') {
          setBillingMessage('Subscription active. Capabilities come from the server entitlement, not from the checkout redirect.')
          setSearchParams({}, { replace: true })
          return true
        }
        if (checkoutComplete && me.plan !== 'pro' && attempts < 8) {
          attempts += 1
          setBillingMessage('Confirming your subscription…')
          return false
        }
        if (checkoutComplete && me.plan !== 'pro') {
          setBillingMessage('Checkout finished. If Pro does not appear shortly, refresh after Stripe sends the webhook.')
          setSearchParams({}, { replace: true })
        }
        return true
      } catch (cause) {
        if (!cancelled) {
          setBillingError(cause instanceof Error ? cause.message : 'Could not load billing status.')
        }
        return true
      }
    }

    void refreshMe().then((done) => {
      if (done || cancelled) return
      timer = window.setInterval(() => {
        void refreshMe().then((finished) => {
          if (finished && timer !== undefined) window.clearInterval(timer)
        })
      }, 1500)
    })

    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [authenticatedFetch, checkoutComplete, setSearchParams, showBilling, status])

  useEffect(() => {
    if (status !== 'authenticated' || !showCollections) return
    void getCollection(authenticatedFetch)
      .then(({ collection: saved, cards }) => {
        setCollection(saved)
        setCollectionCards(cards)
      })
      .catch((cause) => setCollectionError(cause instanceof Error ? cause.message : 'Could not load your collection.'))
  }, [authenticatedFetch, showCollections, status])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!EMAIL_RE.test(email.trim()) || pending) {
      setError('Enter a valid email address.')
      return
    }
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      await sendMagicLink(email)
      setMessage('Check your inbox for a one-time sign-in link.')
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : 'We could not send a sign-in link.'
      setError(
        /failed to fetch/i.test(raw)
          ? 'Could not reach the account service. Check your connection and try again.'
          : raw,
      )
    } finally {
      setPending(false)
    }
  }

  async function createDeck(event: React.FormEvent) {
    event.preventDefault()
    if (!newDeckName.trim() || libraryBusy) return
    setLibraryBusy(true)
    setLibraryError(null)
    try {
      const deck = await createSavedDeck(authenticatedFetch, newDeckName)
      setDecks((current) => [deck, ...current])
      setNewDeckName('')
    } catch (cause) {
      setLibraryError(cause instanceof Error ? cause.message : 'Could not create saved deck.')
    } finally {
      setLibraryBusy(false)
    }
  }

  async function archiveDeck(deck: SavedDeck) {
    setLibraryBusy(true)
    setLibraryError(null)
    try {
      const updated = await updateSavedDeck(authenticatedFetch, deck.id, { archived: !deck.archived_at })
      setDecks((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (cause) {
      setLibraryError(cause instanceof Error ? cause.message : 'Could not update saved deck.')
    } finally {
      setLibraryBusy(false)
    }
  }

  async function renameDeck(deck: SavedDeck) {
    const name = window.prompt('Deck name', deck.name)?.trim()
    if (!name || name === deck.name || libraryBusy) return
    setLibraryBusy(true)
    setLibraryError(null)
    try {
      const updated = await updateSavedDeck(authenticatedFetch, deck.id, { name })
      setDecks((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (cause) {
      setLibraryError(cause instanceof Error ? cause.message : 'Could not rename saved deck.')
    } finally {
      setLibraryBusy(false)
    }
  }

  async function removeDeck(deck: SavedDeck) {
    if (!window.confirm(`Delete “${deck.name}” and all of its saved versions?`)) return
    setLibraryBusy(true)
    setLibraryError(null)
    try {
      await deleteSavedDeck(authenticatedFetch, deck.id)
      setDecks((current) => current.filter((item) => item.id !== deck.id))
    } catch (cause) {
      setLibraryError(cause instanceof Error ? cause.message : 'Could not delete saved deck.')
    } finally {
      setLibraryBusy(false)
    }
  }

  async function compareDeck(deck: SavedDeck) {
    if (libraryBusy) return
    setLibraryBusy(true)
    setLibraryError(null)
    try {
      const versions = await listDeckVersions(authenticatedFetch, deck.id)
      if (versions.length < 2) {
        setComparison(null)
        setLibraryError('Save another analysis before comparing versions.')
        return
      }
      setComparison(compareVersions(versions[1]!, versions[0]!))
    } catch (cause) {
      setLibraryError(cause instanceof Error ? cause.message : 'Could not compare saved versions.')
    } finally {
      setLibraryBusy(false)
    }
  }

  async function downloadAccountData() {
    if (libraryBusy) return
    setLibraryBusy(true)
    setLibraryError(null)
    try {
      const exported = await exportAccountData(authenticatedFetch)
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `moxscore-account-export-${exported.exported_at.slice(0, 10)}.json`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      setLibraryError(null)
    } catch (cause) {
      setLibraryError(cause instanceof Error ? cause.message : 'Could not export your account data.')
    } finally {
      setLibraryBusy(false)
    }
  }

  async function importCollection(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || collectionBusy) return
    setCollectionBusy(true)
    setCollectionError(null)
    setCollectionMessage(null)
    try {
      const parsed = parseCollection(await file.text())
      if (parsed.cards.length === 0) {
        setCollectionError(parsed.errors[0]?.message ?? 'No card rows were found in that file.')
        return
      }
      const saved = await replaceCollection(authenticatedFetch, {
        source: parsed.source,
        cards: parsed.cards,
        importSummary: { rows: parsed.cards.length + parsed.errors.length, errors: parsed.errors.length, cards: parsed.cards.length },
      })
      setCollection(saved)
      setCollectionCards(parsed.cards.map((card) => ({
        name: card.name, normalized_name: card.name.toLocaleLowerCase('en-US'), scryfall_oracle_id: null, quantity: card.quantity, unresolved: true,
      })))
      setCollectionMessage(`Imported ${parsed.cards.length} unique cards${parsed.errors.length ? ` with ${parsed.errors.length} skipped row${parsed.errors.length === 1 ? '' : 's'}` : ''}.`)
    } catch (cause) {
      setCollectionError(cause instanceof Error ? cause.message : 'Could not import that collection.')
    } finally {
      setCollectionBusy(false)
    }
  }

  async function removeCollection() {
    if (!collection || collectionBusy || !window.confirm('Remove your saved collection?')) return
    setCollectionBusy(true)
    setCollectionError(null)
    setCollectionMessage(null)
    try {
      await deleteCollection(authenticatedFetch)
      setCollection(null)
      setCollectionCards([])
      setCollectionMessage('Saved collection removed.')
    } catch (cause) {
      setCollectionError(cause instanceof Error ? cause.message : 'Could not remove your collection.')
    } finally {
      setCollectionBusy(false)
    }
  }

  async function beginAccountDeletion() {
    if (deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      setDeletionRequestToken(await startAccountDeletion(authenticatedFetch))
      setDeleteStep('confirming')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not start account deletion.'
      if (message.includes('Recent sign-in required')) {
        if (user?.email) {
          try {
            await sendMagicLink(user.email)
            setDeleteError('For safety, we sent a fresh sign-in link to your email. Open it, then start deletion again.')
          } catch {
            setDeleteError('For safety, sign in again with a new email link before deleting your account.')
          }
        } else {
          setDeleteError('For safety, sign in again with a new email link before deleting your account.')
        }
      } else {
        setDeleteError(message)
      }
    } finally {
      setDeleteBusy(false)
    }
  }

  async function finishAccountDeletion() {
    if (deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      if (!deletionRequestToken) throw new Error('Deletion confirmation has expired. Start again.')
      await confirmAccountDeletion(authenticatedFetch, deletionRequestToken)
      await signOut().catch(() => undefined)
      void navigate('/', { replace: true })
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : 'Could not delete your account.')
    } finally {
      setDeleteBusy(false)
    }
  }

  async function manageBilling() {
    if (billingBusy) return
    setBillingBusy(true)
    setBillingError(null)
    try {
      const url = await openBillingPortal(authenticatedFetch)
      window.location.assign(url)
    } catch (cause) {
      setBillingError(cause instanceof Error ? cause.message : 'Could not open the billing portal.')
      setBillingBusy(false)
    }
  }

  async function upgradeMonthly() {
    if (billingBusy) return
    setBillingBusy(true)
    setBillingError(null)
    try {
      const url = await startCheckout(authenticatedFetch, 'pro_monthly')
      window.location.assign(url)
    } catch (cause) {
      setBillingError(cause instanceof Error ? cause.message : 'Checkout is temporarily unavailable.')
      setBillingBusy(false)
    }
  }

  const deckLimit = accountMe?.limits.savedDecks ?? 10
  const planLabel = accountMe?.plan === 'pro' ? 'Pro' : 'Free'

  return (
    <main className="mox-state">
      <MoxLogo size={28} onClick={() => void navigate('/')} />
      <div className="mox-state-card">
        <div className="t-eyebrow">Optional account</div>
        {status === 'unavailable' && (
          <>
            <h1>Accounts are not enabled here</h1>
            <p>The free analyzer remains available without an account.</p>
            <Link className="mox-primarybtn" to="/">Analyze a deck</Link>
          </>
        )}
        {status === 'loading' && <><h1>Checking your session</h1><p>One moment…</p></>}
        {status === 'authenticated' && (
          <>
            <h1>You’re signed in</h1>
            <p>{user?.email ?? 'Your optional Moxscore account is active.'}</p>
            <button className="mox-ghostbtn" type="button" onClick={() => void signOut()}>Sign out</button>
            {showBilling && (
              <section style={{ display: 'grid', gap: 10, marginTop: 24 }} aria-label="Subscription">
                <div>
                  <div className="t-eyebrow">Subscription</div>
                  <p>
                    Plan: <strong>{planLabel}</strong>
                    {accountMe?.period_end ? ` · current period ends ${new Date(accountMe.period_end).toLocaleDateString()}` : ''}
                    {accountMe?.cancel_at_period_end ? ' · cancels at period end' : ''}
                  </p>
                  <p>Saved deck limit: {deckLimit}. Capabilities are resolved on the server from subscription state.</p>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {accountMe?.plan === 'pro' ? (
                    <button className="mox-primarybtn" type="button" disabled={billingBusy} onClick={() => void manageBilling()}>
                      {billingBusy ? 'Opening…' : 'Manage billing'}
                    </button>
                  ) : (
                    <>
                      <button className="mox-primarybtn" type="button" disabled={billingBusy} onClick={() => void upgradeMonthly()}>
                        {billingBusy ? 'Redirecting…' : 'Upgrade to Pro'}
                      </button>
                      <Link className="mox-ghostbtn" to="/pricing">Compare plans</Link>
                    </>
                  )}
                </div>
                {billingError && <p className="mox-share-error" role="alert">{billingError}</p>}
                {billingMessage && <p className="mox-bracket-note">{billingMessage}</p>}
              </section>
            )}
            {showLibrary && (
              <section style={{ display: 'grid', gap: 12, marginTop: 24 }} aria-label="Saved decks">
                <div>
                  <div className="t-eyebrow">Saved decks</div>
                  <p>Save deck versions from an analysis, or create an empty deck to organize later. Limit: {decks.length} / {deckLimit}.</p>
                </div>
                <form onSubmit={createDeck} style={{ display: 'flex', gap: 8 }}>
                  <input className="mox-field" value={newDeckName} onChange={(event) => setNewDeckName(event.target.value)} maxLength={200} placeholder="Deck name" />
                  <button className="mox-primarybtn" type="submit" disabled={libraryBusy || !newDeckName.trim()}>Create</button>
                </form>
                <button className="mox-ghostbtn" type="button" disabled={libraryBusy} onClick={() => void downloadAccountData()}>Download account data</button>
                <section style={{ display: 'grid', gap: 8, marginTop: 14 }} aria-label="Delete account">
                  <div>
                    <div className="t-eyebrow">Delete account</div>
                    <p>This immediately and permanently deletes your account, saved decks, versions, and collection. Anonymous share links are independent: delete them with their one-time deletion code or let them expire.</p>
                  </div>
                  {deleteStep === 'idle' ? (
                    <button className="mox-ghostbtn" type="button" disabled={deleteBusy} onClick={() => void beginAccountDeletion()}>
                      {deleteBusy ? 'Checking…' : 'Delete my account'}
                    </button>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="mox-primarybtn" type="button" disabled={deleteBusy} onClick={() => void finishAccountDeletion()}>
                        {deleteBusy ? 'Deleting…' : 'Permanently delete my account'}
                      </button>
                      <button className="mox-ghostbtn" type="button" disabled={deleteBusy} onClick={() => { setDeleteStep('idle'); setDeletionRequestToken(null) }}>Cancel</button>
                    </div>
                  )}
                  {deleteError && <p className="mox-share-error" role="alert">{deleteError}</p>}
                </section>
                {libraryError && <p className="mox-share-error">{libraryError}</p>}
                <ul style={{ display: 'grid', gap: 8, padding: 0, margin: 0, listStyle: 'none' }}>
                  {decks.map((deck) => (
                    <li key={deck.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span>{deck.name}{deck.archived_at ? ' (archived)' : ''}</span>
                      <span style={{ display: 'flex', gap: 8 }}>
                        <button className="mox-ghostbtn" type="button" disabled={libraryBusy} onClick={() => void compareDeck(deck)}>Compare</button>
                        <button className="mox-ghostbtn" type="button" disabled={libraryBusy} onClick={() => void renameDeck(deck)}>Rename</button>
                        <button className="mox-ghostbtn" type="button" disabled={libraryBusy} onClick={() => void archiveDeck(deck)}>{deck.archived_at ? 'Restore' : 'Archive'}</button>
                        <button className="mox-ghostbtn" type="button" disabled={libraryBusy} onClick={() => void removeDeck(deck)}>Delete</button>
                      </span>
                    </li>
                  ))}
                </ul>
                {comparison && (
                  <section style={{ display: 'grid', gap: 10, marginTop: 12 }} aria-label="Version comparison">
                    <div className="t-eyebrow">Version {comparison.older.version_number} → {comparison.newer.version_number}</div>
                    <p>
                      Score: {comparison.scoreDelta === null ? 'unknown' : `${comparison.scoreDelta >= 0 ? '+' : ''}${comparison.scoreDelta}`} ·
                      Bracket: {comparison.bracketDelta === null ? 'unknown' : `${comparison.bracketDelta >= 0 ? '+' : ''}${comparison.bracketDelta}`}
                    </p>
                    <p>Categories: {Object.entries(comparison.subScoreDeltas).filter(([, delta]) => delta !== 0).map(([key, delta]) => `${key} ${delta >= 0 ? '+' : ''}${delta}`).join(' · ') || 'no change'}</p>
                    <p>Curve: {Object.entries(comparison.curveDeltas).filter(([, delta]) => delta !== 0).map(([key, delta]) => `${key} ${delta >= 0 ? '+' : ''}${delta}`).join(' · ') || 'no change'}</p>
                    <p>Added: {comparison.addedCards.map((card) => `${card.quantity} ${card.name}`).join(', ') || 'none'}</p>
                    <p>Removed: {comparison.removedCards.map((card) => `${card.quantity} ${card.name}`).join(', ') || 'none'}</p>
                  </section>
                )}
                {showCollections && (
                  <section style={{ display: 'grid', gap: 10, marginTop: 18 }} aria-label="Collection">
                    <div>
                      <div className="t-eyebrow">Collection · Preview</div>
                      <p>Choose a ManaBox CSV, a name/quantity CSV, or a text list. The file is parsed in this browser; only normalized card rows and import counts are saved.</p>
                    </div>
                    <label className="mox-primarybtn" style={{ width: 'fit-content', cursor: collectionBusy ? 'not-allowed' : 'pointer' }}>
                      {collectionBusy ? 'Importing…' : 'Import collection'}
                      <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => void importCollection(event)} disabled={collectionBusy} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }} />
                    </label>
                    {collectionError && <p className="mox-share-error">{collectionError}</p>}
                    {collectionMessage && <p className="mox-bracket-note">{collectionMessage}</p>}
                    {collection && (
                      <>
                        <p>{collectionCards.length} unique cards · {collectionCards.reduce((total, card) => total + card.quantity, 0)} total copies · imported from {collection.source_type}</p>
                        <p>{collectionCards.slice(0, 12).map((card) => `${card.quantity} ${card.name}`).join(' · ')}{collectionCards.length > 12 ? ' · …' : ''}</p>
                        <button className="mox-ghostbtn" type="button" disabled={collectionBusy} onClick={() => void removeCollection()}>Remove collection</button>
                      </>
                    )}
                  </section>
                )}
              </section>
            )}
          </>
        )}
        {status === 'anonymous' && (
          <>
            <h1>Sign in with email</h1>
            <p>Accounts are optional. Your free analysis remains available without signing in.</p>
            <form className="mox-auth-form" onSubmit={submit}>
              <label className="mox-field-label">
                <span className="t-eyebrow">Email address</span>
                <input
                  className="mox-field"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-invalid={Boolean(error)}
                />
              </label>
              {error && <p className="mox-share-error">{error}</p>}
              {message && <p className="mox-bracket-note">{message}</p>}
              <button className="mox-primarybtn" type="submit" disabled={pending}>
                {pending ? 'Sending link…' : 'Email me a sign-in link'}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  )
}
