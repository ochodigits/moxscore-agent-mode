import { describe, expect, it } from 'vitest'
import { legalReleaseInfo, sharingUiEnabled } from './releaseConfig'

const completeEnv = {
  VITE_ENABLE_SHARING: 'true',
  VITE_LEGAL_CONTROLLER_NAME: 'Example Operator',
  VITE_PRIVACY_CONTACT_EMAIL: 'privacy@example.com',
  VITE_SHARED_DECK_RETENTION_DAYS: '180',
}

describe('public release configuration', () => {
  it('keeps sharing closed when any legal value is missing', () => {
    expect(sharingUiEnabled({ ...completeEnv, VITE_PRIVACY_CONTACT_EMAIL: '' })).toBe(false)
    expect(sharingUiEnabled({ ...completeEnv, VITE_SHARED_DECK_RETENTION_DAYS: '' })).toBe(false)
  })

  it('rejects invalid contact and retention values', () => {
    expect(legalReleaseInfo({ ...completeEnv, VITE_PRIVACY_CONTACT_EMAIL: 'not-an-email' }).complete).toBe(false)
    expect(legalReleaseInfo({ ...completeEnv, VITE_SHARED_DECK_RETENTION_DAYS: '0' }).complete).toBe(false)
    expect(legalReleaseInfo({ ...completeEnv, VITE_SHARED_DECK_RETENTION_DAYS: '3651' }).complete).toBe(false)
  })

  it('enables the UI only with the explicit flag and all validated legal values', () => {
    expect(sharingUiEnabled(completeEnv)).toBe(true)
    expect(sharingUiEnabled({ ...completeEnv, VITE_ENABLE_SHARING: 'false' })).toBe(false)
    expect(legalReleaseInfo(completeEnv)).toEqual({
      controllerName: 'Example Operator',
      privacyContactEmail: 'privacy@example.com',
      sharedDeckRetentionDays: 180,
      complete: true,
    })
  })
})
