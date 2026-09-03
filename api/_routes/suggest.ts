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
 * Model-selected cards are outside the constrained explanation scope. Keep
 * this legacy route unavailable in every environment, regardless of old flags
 * or provider configuration.
 */
export default async function handler(_req: VercelReq, res: VercelRes): Promise<void> {
  res.status(404).json({ error: 'Not available' })
}
