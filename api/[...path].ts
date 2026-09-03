import accountExport from './_routes/account-export.js'
import accountDelete from './_routes/account-delete.js'
import checkout from './_routes/checkout.js'
import collection from './_routes/collection.js'
import combos from './_routes/combos.js'
import portal from './_routes/portal.js'
import stripeWebhook from './_routes/stripe-webhook.js'
import reconcileBilling from './_routes/cron/reconcile-billing.js'
import billingOperations from './_routes/ops/billing.js'
import aiOperations from './_routes/ops/ai.js'
import aiFeedback from './_routes/ai-feedback.js'
import purgeExpiredShares from './_routes/cron/purge-expired-shares.js'
import deckItem from './_routes/deck-item.js'
import deckVersion from './_routes/deck-version.js'
import deck from './_routes/deck.js'
import decks from './_routes/decks.js'
import health from './_routes/health.js'
import importDeck from './_routes/import.js'
import me from './_routes/me.js'
import og from './_routes/og.js'
import pod from './_routes/pod.js'
import share from './_routes/share.js'
import suggest from './_routes/suggest.js'
import tune from './_routes/tune.js'
import { requestIdFrom, withRequestContext } from './_requestContext.js'

/**
 * Body parsing is disabled for the whole API surface.
 *
 * Stripe signs the webhook over the exact bytes it sent, so verification needs
 * those bytes untouched — a parse-then-reserialize round trip changes key order
 * and escaping and breaks the signature. This config is per function file, and
 * the entire API is one catch-all function, so raw mode is all-or-nothing.
 *
 * Turning it on is close to free here: every route already accepts a string
 * body (`typeof req.body === 'string' ? JSON.parse(...)`), because the dev
 * server in vite.config.ts has always passed one. Before this change dev and
 * production took different branches of that ternary; now both pass a string.
 */
export const config = { api: { bodyParser: false } }

/** Vercel caps serverless request payloads at 4.5 MB; stay just under it. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

interface VercelReq {
  method?: string
  body?: unknown
  /** Exact request bytes, for signature-verifying routes. */
  rawBody?: string
  url?: string
  query?: Record<string, string | string[] | undefined>
  headers?: Record<string, string | string[] | undefined>
}

interface VercelRes {
  status(code: number): VercelRes
  json(body: unknown): void
  setHeader(key: string, value: string): void
  send(body: string | Buffer): void
}

type Handler = (req: VercelReq, res: VercelRes) => Promise<void>

const handlers: Record<string, Handler> = {
  'account-delete': accountDelete,
  'account-export': accountExport,
  checkout,
  collection,
  combos,
  portal,
  'stripe-webhook': stripeWebhook,
  'reconcile-billing': reconcileBilling,
  'cron/reconcile-billing': reconcileBilling,
  'billing-ops': billingOperations,
  'ops/billing': billingOperations,
  'ai-ops': aiOperations,
  'ops/ai': aiOperations,
  'ai-feedback': aiFeedback,
  'cron/purge-expired-shares': purgeExpiredShares,
  'deck-item': deckItem,
  'deck-version': deckVersion,
  deck,
  decks,
  health,
  import: importDeck,
  me,
  og,
  pod,
  'purge-expired-shares': purgeExpiredShares,
  share,
  suggest,
  tune,
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Buffer> {
  return typeof (value as AsyncIterable<Buffer>)?.[Symbol.asyncIterator] === 'function'
}

/** Thrown past MAX_BODY_BYTES so the router can answer 413 before dispatch. */
class BodyTooLarge extends Error {}

/**
 * Drains the request stream once. The dev server already hands us a string, so
 * that case short-circuits and dev/production stay on identical code paths.
 */
async function readRawBody(req: VercelReq): Promise<string> {
  if (typeof req.body === 'string') return req.body
  if (!isAsyncIterable(req)) return ''

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge()
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function requestedPath(req: VercelReq): string {
  const raw = req.query?.path
  const segments = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('/') : []
  const fromQuery = segments.filter(Boolean).join('/')
  if (fromQuery) return fromQuery
  return (req.url?.split('?')[0] ?? '').replace(/^\/api\/?/, '')
}

/**
 * Vercel Hobby permits twelve serverless functions per deployment. Keeping the
 * public API behind this catch-all preserves every existing endpoint while
 * packaging its handlers as a single function. Endpoint handlers stay separate
 * modules so their request validation and test coverage remain unchanged.
 */
export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  const requestId = requestIdFrom(req.headers)
  res.setHeader('X-Request-ID', requestId)
  const endpoint = requestedPath(req)
  const route = handlers[endpoint]
  if (!route) {
    res.status(404).json({ error: 'Not found', request_id: requestId })
    return
  }

  // Raw mode means the router owns body reading and its size limit. An empty
  // body stays undefined rather than becoming '', so GET routes and their
  // existing 400-on-unparseable-body checks behave exactly as before.
  try {
    const raw = await readRawBody(req)
    if (raw.length > 0) {
      req.rawBody = raw
      req.body = raw
    }
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      res.status(413).json({ error: 'Request body is too large', request_id: requestId })
      return
    }
    res.status(400).json({ error: 'Invalid body', request_id: requestId })
    return
  }
  // Existing endpoint modules intentionally stay simple. At the router
  // boundary, add the correlation id to every error without changing success
  // contracts or letting request content enter logs.
  let statusCode = 200
  const response: VercelRes = {
    status(code) {
      statusCode = code
      res.status(code)
      return response
    },
    json(body) {
      if (statusCode >= 400 && typeof body === 'object' && body !== null && !Array.isArray(body)) {
        res.json({ ...body as Record<string, unknown>, request_id: requestId })
      } else {
        res.json(body)
      }
    },
    setHeader: res.setHeader.bind(res),
    send: res.send.bind(res),
  }
  await withRequestContext(requestId, () => route(req, response))
}
