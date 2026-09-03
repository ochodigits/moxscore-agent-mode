export type AuthenticatedFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface SavedDeck {
  id: string
  name: string
  format: 'commander'
  current_version_id: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface SavedDeckVersion {
  id: string
  version_number: number
  analysis_snapshot: Record<string, unknown>
  analyzer_version: string
  curated_data_version: string
  created_at: string
}

export interface SavedCollection {
  id: string
  source_type: 'manabox-csv' | 'generic-csv' | 'text'
  import_summary: { rows: number; errors: number; cards: number }
  created_at: string
  updated_at: string
}

export interface SavedCollectionCard {
  name: string
  normalized_name: string
  scryfall_oracle_id: string | null
  quantity: number
  unresolved: boolean
}

async function json<T>(request: Promise<Response>): Promise<T> {
  const response = await request
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string }
  if (!response.ok) {
    const detail = body.code ? `${body.error ?? 'Account request failed.'} (${body.code})` : (body.error ?? 'Account request failed.')
    throw new Error(detail)
  }
  return body
}

export async function listSavedDecks(request: AuthenticatedFetch): Promise<SavedDeck[]> {
  const body = await json<{ decks: SavedDeck[] }>(request('/api/decks'))
  return body.decks
}

export async function createSavedDeck(request: AuthenticatedFetch, name: string): Promise<SavedDeck> {
  const body = await json<{ deck: SavedDeck }>(request('/api/decks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, format: 'commander' }),
  }))
  return body.deck
}

export async function updateSavedDeck(
  request: AuthenticatedFetch,
  id: string,
  patch: { name?: string; archived?: boolean },
): Promise<SavedDeck> {
  const body = await json<{ deck: SavedDeck }>(request('/api/deck-item', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...patch }),
  }))
  return body.deck
}

export async function deleteSavedDeck(request: AuthenticatedFetch, id: string): Promise<void> {
  await json(request('/api/deck-item', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  }))
}

export async function saveDeckVersion(
  request: AuthenticatedFetch,
  input: {
    deckId: string
    decklist: string
    analysisSnapshot: Record<string, unknown>
    analyzerVersion: string
    curatedDataVersion: string
  },
): Promise<void> {
  await json(request('/api/deck-version', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }))
}

export async function listDeckVersions(request: AuthenticatedFetch, deckId: string): Promise<SavedDeckVersion[]> {
  const body = await json<{ versions: SavedDeckVersion[] }>(request(`/api/deck-version?deckId=${encodeURIComponent(deckId)}`))
  return body.versions
}

export async function getCollection(request: AuthenticatedFetch): Promise<{ collection: SavedCollection | null; cards: SavedCollectionCard[] }> {
  return json(request('/api/collection'))
}

export async function replaceCollection(
  request: AuthenticatedFetch,
  input: {
    source: 'manabox-csv' | 'generic-csv' | 'text'
    cards: Array<{ name: string; quantity: number; unresolved?: boolean }>
    importSummary: { rows: number; errors: number; cards: number }
  },
): Promise<SavedCollection> {
  const body = await json<{ collection: SavedCollection }>(request('/api/collection', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }))
  return body.collection
}

export async function deleteCollection(request: AuthenticatedFetch): Promise<void> {
  await json(request('/api/collection', { method: 'DELETE' }))
}

export interface AccountDataExport {
  schema_version: 1
  exported_at: string
  profile: { id: string }
  saved_decks: SavedDeck[]
  deck_versions: Array<SavedDeckVersion & { deck_id: string; decklist: string }>
  collection: SavedCollection | null
  collection_cards: SavedCollectionCard[]
}

export async function exportAccountData(request: AuthenticatedFetch): Promise<AccountDataExport> {
  return json<AccountDataExport>(request('/api/account-export'))
}

export async function startAccountDeletion(request: AuthenticatedFetch): Promise<string> {
  const body = await json<{ deletionRequestToken: string }>(request('/api/account-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }),
  }))
  return body.deletionRequestToken
}

export async function confirmAccountDeletion(request: AuthenticatedFetch, deletionRequestToken: string): Promise<void> {
  await json(request('/api/account-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm', confirmation: 'DELETE MY ACCOUNT', deletionRequestToken }),
  }))
}

export type AccountCapability =
  | 'saved_decks'
  | 'deck_versions'
  | 'collection_persistence'
  | 'advanced_tuner'
  | 'ai_explanations'
  | 'advanced_pod'
  | 'discord_pod_check'

export type PriceKey = 'pro_monthly' | 'pro_annual'

export interface AccountMe {
  profile: {
    id: string
    display_name: string | null
    locale: string
    created_at: string
    updated_at: string
    deletion_requested_at: string | null
  }
  plan: 'free' | 'pro'
  capabilities: Record<AccountCapability, boolean>
  limits: {
    savedDecks: number
    versionsPerDeck: number
    collectionCards: number
    aiSessionsPerMonth: number
  }
  period_end: string | null
  cancel_at_period_end: boolean
  quotas: {
    ai_explanations: {
      monthly_limit: number
      monthly_used: number
      monthly_remaining: number
      daily_limit: number
      daily_used: number
      daily_remaining: number
    }
  }
}

/** Server-derived plan and capabilities. Never trust local storage or query params. */
export async function getAccountMe(request: AuthenticatedFetch): Promise<AccountMe> {
  return json<AccountMe>(request('/api/me'))
}

/** Starts Stripe Checkout for an allowlisted price key. Returns the hosted URL. */
export async function startCheckout(request: AuthenticatedFetch, priceKey: PriceKey): Promise<string> {
  const body = await json<{ url: string }>(request('/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priceKey }),
  }))
  if (!body.url) throw new Error('Billing is temporarily unavailable.')
  return body.url
}

/** Opens the Stripe Customer Portal. Returns the hosted URL. */
export async function openBillingPortal(request: AuthenticatedFetch): Promise<string> {
  const body = await json<{ url: string }>(request('/api/portal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }))
  if (!body.url) throw new Error('Billing is temporarily unavailable.')
  return body.url
}
