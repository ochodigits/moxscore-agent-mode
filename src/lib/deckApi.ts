// Client helpers for the import + share serverless functions.

export interface ImportResult {
  decklist: string
  name: string
  commander: string | null
  source: 'moxfield' | 'archidekt'
}

const DECK_URL_RE = /(moxfield\.com\/decks\/|archidekt\.com\/decks\/)/i
const MOXFIELD_ID_RE = /moxfield\.com\/decks\/([A-Za-z0-9_-]+)/
const IMPORT_FALLBACK =
  "We couldn't import that deck right now. Paste the decklist below and Moxscore will still analyze it."
const MOXFIELD_IMPORT_FALLBACK =
  "Moxfield isn't accepting this import. Use Moxfield or any deck builder of your choice to export or copy the decklist, then paste or upload the list here."

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchJsonWithRetry<T>(input: RequestInfo | URL, init: RequestInit, attempts = 2): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(250 * attempt)
    try {
      const res = await fetch(input, init)
      const data = (await res.json().catch(() => ({}))) as T & { error?: string }
      if (!res.ok) throw new Error(data.error ?? IMPORT_FALLBACK)
      return data
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(IMPORT_FALLBACK)
    }
  }

  throw lastError ?? new Error(IMPORT_FALLBACK)
}

/** True when the input is a Moxfield/Archidekt deck link (single URL, not a list). */
export function looksLikeDeckUrl(input: string): boolean {
  const t = input.trim()
  if (t.includes('\n')) return false
  return DECK_URL_RE.test(t)
}

/** Import a decklist from a Moxfield/Archidekt URL. Throws with a user-facing message. */
export async function importDeckFromUrl(url: string): Promise<ImportResult> {
  const trimmed = url.trim()
  const moxId = trimmed.match(MOXFIELD_ID_RE)?.[1]

  try {
    return await fetchJsonWithRetry<ImportResult>('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: trimmed }),
    })
  } catch (err) {
    if (moxId) throw new Error(MOXFIELD_IMPORT_FALLBACK, { cause: err })
    throw err
  }
}

export interface SavePayload {
  decklist: string
  name?: string
  commander?: string | null
  score?: number
  /** Scoring format id (e.g. "commander", "standard") so shares restore it. */
  format?: string
}

export interface ShareReceipt {
  slug: string
  deletionToken: string
  expiresAt: string
}

/** Persist a deck analysis and return its share capability plus deletion code. */
export async function saveDeck(payload: SavePayload): Promise<ShareReceipt> {
  const res = await fetch('/api/deck', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as Partial<ShareReceipt> & { error?: string }
  if (!res.ok || !data.slug || !data.deletionToken || !data.expiresAt) throw new Error(data.error ?? 'Could not save deck.')
  return data as ShareReceipt
}

/** Delete a share using the one-time capability returned when it was created. */
export async function deleteSharedDeck(slug: string, deletionToken: string): Promise<void> {
  const res = await fetch(`/api/deck?slug=${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deletionToken }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? 'Could not delete deck.')
  }
}

export interface LoadedDeck {
  decklist: string
  name: string | null
  commander: string | null
  score: number | null
  format: string | null
}

/** Load a previously shared deck by slug. */
export async function loadDeck(slug: string): Promise<LoadedDeck> {
  const res = await fetch(`/api/deck?slug=${encodeURIComponent(slug)}`)
  const data = (await res.json().catch(() => ({}))) as Partial<LoadedDeck> & { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Deck not found.')
  return data as LoadedDeck
}

/** The human-facing share link for a slug. */
export function shareUrl(slug: string): string {
  return `${window.location.origin}/d/${slug}`
}

// ---------------------------------------------------------------------------
// Pod Check persistence (api/pod.ts, shared_pods table)
// ---------------------------------------------------------------------------

export interface PodDeckPayload {
  decklist: string
  label?: string | null
}

/** Persist a pod (2–4 decks) and return its share id. */
export async function savePod(decks: PodDeckPayload[]): Promise<string> {
  const res = await fetch('/api/pod', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decks }),
  })
  const data = (await res.json().catch(() => ({}))) as { podId?: string; error?: string }
  if (!res.ok || !data.podId) throw new Error(data.error ?? 'Could not save pod.')
  return data.podId
}

/** Load a previously shared pod by id. */
export async function loadPod(podId: string): Promise<PodDeckPayload[]> {
  const res = await fetch(`/api/pod?id=${encodeURIComponent(podId)}`)
  const data = (await res.json().catch(() => ({}))) as { decks?: PodDeckPayload[]; error?: string }
  if (!res.ok || !Array.isArray(data.decks)) throw new Error(data.error ?? 'Pod not found.')
  return data.decks
}

/** The human-facing share link for a pod. */
export function podShareUrl(podId: string): string {
  return `${window.location.origin}/pod/${podId}`
}
