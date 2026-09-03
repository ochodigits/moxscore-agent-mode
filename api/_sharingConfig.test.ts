import { describe, expect, it } from 'vitest'
import { sharingWritesEnabled } from './_sharingConfig'

const completeEnv = {
  MOXSCORE_ENABLE_SHARING: 'true',
  VITE_ENABLE_SHARING: 'true',
  VITE_LEGAL_CONTROLLER_NAME: 'Example Operator',
  VITE_PRIVACY_CONTACT_EMAIL: 'privacy@example.com',
  VITE_SHARED_DECK_RETENTION_DAYS: '180',
}

describe('shared-deck write release configuration', () => {
  it('requires both explicit release flags', () => {
    expect(sharingWritesEnabled(completeEnv)).toBe(true)
    expect(sharingWritesEnabled({ ...completeEnv, MOXSCORE_ENABLE_SHARING: '' })).toBe(false)
    expect(sharingWritesEnabled({ ...completeEnv, VITE_ENABLE_SHARING: 'false' })).toBe(false)
  })

  it('fails closed when a legal value is absent or invalid', () => {
    expect(sharingWritesEnabled({ ...completeEnv, VITE_LEGAL_CONTROLLER_NAME: '' })).toBe(false)
    expect(sharingWritesEnabled({ ...completeEnv, VITE_PRIVACY_CONTACT_EMAIL: 'invalid' })).toBe(false)
    expect(sharingWritesEnabled({ ...completeEnv, VITE_SHARED_DECK_RETENTION_DAYS: '0' })).toBe(false)
  })
})
