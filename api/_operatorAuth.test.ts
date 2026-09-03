import { describe, expect, it } from 'vitest'
import { operatorAuthorized } from './_operatorAuth'

describe('operator authentication', () => {
  it('requires an exact configured bearer secret', () => {
    const env = { CRON_SECRET: 'long-configured-secret' }
    expect(operatorAuthorized({ authorization: 'Bearer long-configured-secret' }, env)).toBe(true)
    expect(operatorAuthorized({ authorization: 'Bearer wrong' }, env)).toBe(false)
    expect(operatorAuthorized({}, env)).toBe(false)
  })

  it('fails closed when the server secret is missing', () => {
    expect(operatorAuthorized({ authorization: 'Bearer attacker' }, {})).toBe(false)
  })
})
