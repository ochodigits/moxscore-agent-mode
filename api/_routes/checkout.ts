import { accountAccess, accountError } from '../_account.js'
import { ensureCustomer, isPriceKey, priceIdFor, publicOrigin, stripeClient } from '../_billing.js'
import { billingOperationEnabled } from '../_operationalFlags.js'

interface VercelReq {
  method?: string
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

/**
 * Creates a Stripe-hosted Checkout session.
 *
 * The client sends only an allowlisted price key. Amount, currency, and price
 * id are server-resolved, and the success page learns nothing: it polls
 * /api/me, which derives capabilities from projected subscription state.
 */
export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!billingOperationEnabled('checkout')) {
    res.status(404).json({ error: 'Not available' })
    return
  }

  const access = await accountAccess(req.headers, 'billing')
  if (access.kind !== 'ready') {
    const { status, error } = accountError(access)
    res.status(status).json({ error })
    return
  }

  let body: { priceKey?: unknown }
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as typeof body)
  } catch {
    res.status(400).json({ error: 'Invalid body' })
    return
  }

  if (!isPriceKey(body?.priceKey)) {
    res.status(400).json({ error: 'Unknown plan' })
    return
  }

  // A deletion receipt is created before the irreversible confirmation. Block
  // new Checkout sessions during that window so a concurrent flow cannot
  // create a Stripe customer after account deletion has begun.
  const pendingDeletion = await access.db
    .from('account_deletion_receipts')
    .select('token_hash')
    .eq('user_id', access.user.id)
    .is('completed_at', null)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
  if (pendingDeletion.error) {
    res.status(503).json({ error: 'Billing is temporarily unavailable.' })
    return
  }
  if ((pendingDeletion.data?.length ?? 0) > 0) {
    res.status(409).json({ error: 'Finish or restart account deletion before subscribing.' })
    return
  }

  const stripe = stripeClient()
  const priceId = priceIdFor(body.priceKey)
  const origin = publicOrigin()
  if (stripe === null || priceId === null || origin === null) {
    const missing = [
      stripe === null ? 'stripe_secret' : null,
      priceId === null ? `price:${body.priceKey}` : null,
      origin === null ? 'public_origin' : null,
    ].filter(Boolean)
    console.error(JSON.stringify({ scope: 'checkout', reason: 'missing_config', missing }))
    res.status(503).json({ error: 'Billing is temporarily unavailable.', code: 'billing_config' })
    return
  }

  try {
    const customerId = await ensureCustomer(stripe, access.db, access.user.id, access.user.email)
    if (customerId === null) {
      console.error(JSON.stringify({ scope: 'checkout', reason: 'ensure_customer_failed' }))
      res.status(503).json({ error: 'Billing is temporarily unavailable.', code: 'billing_customer' })
      return
    }

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${origin}/account?checkout=complete`,
        cancel_url: `${origin}/pricing`,
        client_reference_id: access.user.id,
        subscription_data: { metadata: { moxscore_user_id: access.user.id } },
        allow_promotion_codes: true,
      },
      // Scoped per user and plan so a double-clicked button reuses the session
      // instead of opening a second one.
      { idempotencyKey: `checkout:${access.user.id}:${body.priceKey}` },
    )

    if (!session.url) {
      console.error(JSON.stringify({ scope: 'checkout', reason: 'session_missing_url' }))
      res.status(503).json({ error: 'Billing is temporarily unavailable.', code: 'billing_provider' })
      return
    }
    res.status(200).json({ url: session.url })
  } catch (cause) {
    // No provider message, price id, or customer id reaches the client.
    const err = cause as { type?: string; code?: string; message?: string } | null
    console.error(JSON.stringify({
      scope: 'checkout',
      reason: 'stripe_error',
      type: err?.type ?? null,
      code: err?.code ?? null,
      // Keep message truncated and free of ids; Stripe messages are usually safe codes.
      message: typeof err?.message === 'string' ? err.message.slice(0, 160) : null,
    }))
    res.status(503).json({ error: 'Billing is temporarily unavailable.', code: 'billing_provider' })
  }
}
