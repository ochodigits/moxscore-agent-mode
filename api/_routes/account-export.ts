import { accountAccess, accountError } from '../_account.js'
import { serverFeatureEnabled } from '../_featureFlags.js'

interface VercelReq {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

/**
 * Return only the requesting user's product data. This is deliberately a
 * JSON export rather than an admin/database export, so no provider metadata
 * or credentials can become part of the download.
 */
export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const access = await accountAccess(req.headers, 'persistence')
  if (access.kind !== 'ready') {
    const error = accountError(access)
    res.status(error.status).json({ error: error.error })
    return
  }

  const decksResult = await access.db
    .from('saved_decks')
    .select('id, name, format, current_version_id, created_at, updated_at, archived_at')
    .eq('owner_id', access.user.id)
    .order('created_at', { ascending: true })
  if (decksResult.error) {
    res.status(503).json({ error: 'Account export is temporarily unavailable.' })
    return
  }
  const decks = decksResult.data ?? []
  const deckIds = decks.map((deck: { id: string }) => deck.id)

  let versions: unknown[] = []
  if (deckIds.length > 0) {
    const versionsResult = await access.db
      .from('deck_versions')
      .select('id, deck_id, version_number, decklist, analysis_snapshot, analyzer_version, curated_data_version, created_at')
      .in('deck_id', deckIds)
      .order('deck_id', { ascending: true })
      .order('version_number', { ascending: true })
    if (versionsResult.error) {
      res.status(503).json({ error: 'Account export is temporarily unavailable.' })
      return
    }
    versions = versionsResult.data ?? []
  }

  let collection: unknown = null
  let collectionCards: unknown[] = []
  if (serverFeatureEnabled('collections')) {
    const collectionResult = await access.db
      .from('collections')
      .select('id, source_type, import_summary, created_at, updated_at')
      .eq('owner_id', access.user.id)
      .maybeSingle()
    if (collectionResult.error) {
      res.status(503).json({ error: 'Account export is temporarily unavailable.' })
      return
    }
    collection = collectionResult.data
    if (collectionResult.data !== null) {
      const cardsResult = await access.db
        .from('collection_cards')
        .select('name, normalized_name, scryfall_oracle_id, quantity, unresolved')
        .eq('collection_id', collectionResult.data.id)
        .order('normalized_name', { ascending: true })
      if (cardsResult.error) {
        res.status(503).json({ error: 'Account export is temporarily unavailable.' })
        return
      }
      collectionCards = cardsResult.data ?? []
    }
  }

  res.status(200).json({
    schema_version: 1,
    exported_at: new Date().toISOString(),
    profile: { id: access.user.id },
    saved_decks: decks,
    deck_versions: versions,
    collection,
    collection_cards: collectionCards,
  })
}
