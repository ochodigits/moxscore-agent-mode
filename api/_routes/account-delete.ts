import { accountAccess, accountError } from '../_account.js'
import { hasRecentBearerSession } from '../_auth.js'
import { stripeClient } from '../_billing.js'
import { serverFeatureEnabled } from '../_featureFlags.js'
import { createHash, randomBytes } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const RECEIPT_TTL_MS = 30 * 60 * 1_000
const RECEIPT_RE = /^[a-f0-9]{64}$/i

interface VercelReq {
  method?: string
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

function rowCount(result: { count?: number | null; error: unknown }): number | null {
  return result.error ? null : result.count ?? 0
}

function receiptHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function receiptStore(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim() ?? ''
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
  return url && serviceRoleKey ? createClient(url, serviceRoleKey, { auth: { persistSession: false } }) : null
}

/**
 * Provider cleanup must happen before Auth deletion. Otherwise the Auth
 * cascade removes our customer mapping while Stripe can continue renewing an
 * ownerless subscription. The local projection is cleared only after Stripe
 * confirms that the customer is already deleted or has just been deleted.
 */
async function deleteBillingIdentity(db: SupabaseClient, ownerId: string): Promise<boolean> {
  if (!serverFeatureEnabled('billing')) return true

  const stripe = stripeClient()
  if (stripe === null) return false

  const customer = await db
    .from('billing_customers')
    .select('provider_customer_id')
    .eq('owner_id', ownerId)
    .maybeSingle()
  if (customer.error) return false

  try {
    const customerId = customer.data?.provider_customer_id as string | undefined
    if (customerId) {
      const current = await stripe.customers.retrieve(customerId)
      if (!current.deleted) await stripe.customers.del(customerId)
    }
  } catch {
    return false
  }

  const cleanup = await db.rpc('moxscore_delete_billing_owner', { p_owner_id: ownerId })
  return cleanup.error === null
}

/**
 * A deliberately separate endpoint: clients first make a `start` request to
 * prove that their magic-link session is recent, then explicitly confirm the
 * irreversible deletion. Anonymous shares are intentionally not queried.
 */
export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  let body: { action?: unknown; confirmation?: unknown; deletionRequestToken?: unknown }
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as typeof body)
  } catch {
    res.status(400).json({ error: 'Invalid body' })
    return
  }

  // A completed receipt is a short-lived, one-time capability for retrying a
  // success response after Auth has already invalidated the browser session.
  const retryToken = typeof body?.deletionRequestToken === 'string' ? body.deletionRequestToken : ''
  if (body?.action === 'confirm' && RECEIPT_RE.test(retryToken)) {
    const store = receiptStore()
    if (store) {
      const { data, error } = await store
        .from('account_deletion_receipts')
        .select('completed_at, expires_at')
        .eq('token_hash', receiptHash(retryToken))
        .maybeSingle()
      if (error) {
        res.status(503).json({ error: 'Account deletion is temporarily unavailable.' })
        return
      }
      if (data?.completed_at && new Date(data.expires_at).getTime() > Date.now()) {
        res.status(204).json({})
        return
      }
    }
  }

  const access = await accountAccess(req.headers, 'persistence')
  if (access.kind !== 'ready') {
    const error = accountError(access)
    res.status(error.status).json({ error: error.error })
    return
  }
  if (!hasRecentBearerSession(req.headers)) {
    res.status(401).json({ error: 'Recent sign-in required', code: 'RECENT_AUTH_REQUIRED' })
    return
  }

  if (body?.action === 'start') {
    const token = randomBytes(32).toString('hex')
    const { error } = await access.db.from('account_deletion_receipts').insert({
      token_hash: receiptHash(token),
      user_id: access.user.id,
      expires_at: new Date(Date.now() + RECEIPT_TTL_MS).toISOString(),
    })
    if (error) {
      res.status(503).json({ error: 'Account deletion is temporarily unavailable.' })
      return
    }
    res.status(200).json({ deletionRequestToken: token })
    return
  }
  if (body?.action !== 'confirm' || body.confirmation !== 'DELETE MY ACCOUNT' || !RECEIPT_RE.test(retryToken)) {
    res.status(400).json({ error: 'Explicit deletion confirmation required' })
    return
  }

  const { data: receipt, error: receiptError } = await access.db
    .from('account_deletion_receipts')
    .select('user_id, expires_at, completed_at')
    .eq('token_hash', receiptHash(retryToken))
    .eq('user_id', access.user.id)
    .maybeSingle()
  if (receiptError) {
    res.status(503).json({ error: 'Account deletion is temporarily unavailable.' })
    return
  }
  if (receipt === null || receipt.completed_at || new Date(receipt.expires_at).getTime() <= Date.now()) {
    res.status(400).json({ error: 'Deletion confirmation has expired. Start again.' })
    return
  }

  if (!await deleteBillingIdentity(access.db, access.user.id)) {
    res.status(503).json({ error: 'Account deletion is temporarily unavailable.' })
    return
  }

  // This is a hard delete; soft deletion would not satisfy the v2 Core
  // immediate-erasure contract. The service key remains server-side.
  const { error: deleteError } = await access.db.auth.admin.deleteUser(access.user.id, false)
  if (deleteError) {
    res.status(503).json({ error: 'Account deletion is temporarily unavailable.' })
    return
  }

  const [profiles, decks, collections] = await Promise.all([
    access.db.from('profiles').select('id', { count: 'exact', head: true }).eq('id', access.user.id),
    access.db.from('saved_decks').select('id', { count: 'exact', head: true }).eq('owner_id', access.user.id),
    access.db.from('collections').select('id', { count: 'exact', head: true }).eq('owner_id', access.user.id),
  ])
  const remaining = [rowCount(profiles), rowCount(decks), rowCount(collections)]
  if (remaining.some((count) => count === null || count > 0)) {
    // Do not claim success if a foreign-key cascade did not complete.
    res.status(503).json({ error: 'Account deletion could not be verified.' })
    return
  }
  const { error: completionError } = await access.db
    .from('account_deletion_receipts')
    .update({ completed_at: new Date().toISOString() })
    .eq('token_hash', receiptHash(retryToken))
  if (completionError) {
    res.status(503).json({ error: 'Account deletion could not be verified.' })
    return
  }
  res.status(204).json({})
}
