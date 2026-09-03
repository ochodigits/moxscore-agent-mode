import { accountAccess, accountError } from '../_account.js'
import { publicOrigin, stripeClient } from '../_billing.js'

interface VercelReq {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
}

/**
 * Opens the Stripe Customer Portal for the signed-in user.
 *
 * Cancellation, payment-method updates, and invoice history all live in the
 * portal rather than in Moxscore UI, which keeps card data and dunning flows
 * entirely inside Stripe. The customer id is looked up from the authenticated
 * user; it is never accepted from the request.
 */
export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const access = await accountAccess(req.headers, 'billing')
  if (access.kind !== 'ready') {
    const { status, error } = accountError(access)
    res.status(status).json({ error })
    return
  }

  const stripe = stripeClient()
  const origin = publicOrigin()
  if (stripe === null || origin === null) {
    res.status(503).json({ error: 'Billing is temporarily unavailable.' })
    return
  }

  try {
    const existing = await access.db
      .from('billing_customers')
      .select('provider_customer_id')
      .eq('owner_id', access.user.id)
      .maybeSingle()
    if (existing.error) {
      res.status(503).json({ error: 'Billing is temporarily unavailable.' })
      return
    }

    const customerId = existing.data?.provider_customer_id as string | undefined
    if (!customerId) {
      // Never subscribed: there is no portal to open, and creating a customer
      // here would leave empty records for users who only browsed pricing.
      res.status(404).json({ error: 'No billing account found.' })
      return
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/account`,
    })
    res.status(200).json({ url: session.url })
  } catch {
    res.status(503).json({ error: 'Billing is temporarily unavailable.' })
  }
}
