import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

type Headers = Record<string, string | string[] | undefined> | undefined

const store = new AsyncLocalStorage<{ requestId: string }>()
const TRUSTED_REQUEST_ID = /^[A-Za-z0-9:_-]{8,128}$/

function header(headers: Headers, name: string): string | undefined {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

/** Accept only a platform-shaped ID; user content never becomes a log key. */
export function requestIdFrom(headers: Headers): string {
  const candidate = header(headers, 'x-vercel-id')?.trim()
  return candidate && TRUSTED_REQUEST_ID.test(candidate) ? candidate : randomUUID()
}

export function withRequestContext<T>(requestId: string, action: () => Promise<T>): Promise<T> {
  return store.run({ requestId }, action)
}

export function currentRequestId(): string | undefined {
  return store.getStore()?.requestId
}
