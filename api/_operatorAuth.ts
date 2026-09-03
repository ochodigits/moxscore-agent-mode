import { timingSafeEqual } from 'node:crypto'

type Headers = Record<string, string | string[] | undefined> | undefined
type ServerEnv = Record<string, string | undefined>

function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

/** Constant-time bearer comparison for cron and aggregate operator surfaces. */
export function operatorAuthorized(headers: Headers, env: ServerEnv = process.env): boolean {
  const secret = env.CRON_SECRET?.trim() ?? ''
  const supplied = headerValue(headers, 'authorization')?.trim() ?? ''
  if (!secret || !supplied.startsWith('Bearer ')) return false
  const expectedBuffer = Buffer.from(`Bearer ${secret}`)
  const suppliedBuffer = Buffer.from(supplied)
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
}
