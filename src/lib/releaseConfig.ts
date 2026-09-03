interface PublicReleaseEnv {
  VITE_ENABLE_SHARING?: string
  VITE_LEGAL_CONTROLLER_NAME?: string
  VITE_PRIVACY_CONTACT_EMAIL?: string
  VITE_SHARED_DECK_RETENTION_DAYS?: string
}

export interface LegalReleaseInfo {
  controllerName: string | null
  privacyContactEmail: string | null
  sharedDeckRetentionDays: number | null
  complete: boolean
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function trimmed(value: string | undefined): string | null {
  const result = value?.trim() ?? ''
  return result.length > 0 ? result : null
}

function retentionDays(value: string | undefined): number | null {
  if (!value || !/^\d{1,4}$/.test(value)) return null
  const days = Number(value)
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : null
}

/** Public legal values are intentionally shipped in the browser bundle. */
export function legalReleaseInfo(env: PublicReleaseEnv = import.meta.env as PublicReleaseEnv): LegalReleaseInfo {
  const controllerName = trimmed(env.VITE_LEGAL_CONTROLLER_NAME)
  const rawEmail = trimmed(env.VITE_PRIVACY_CONTACT_EMAIL)
  const privacyContactEmail = rawEmail && EMAIL_RE.test(rawEmail) ? rawEmail : null
  const sharedDeckRetentionDays = retentionDays(env.VITE_SHARED_DECK_RETENTION_DAYS)

  return {
    controllerName,
    privacyContactEmail,
    sharedDeckRetentionDays,
    complete: controllerName !== null && privacyContactEmail !== null && sharedDeckRetentionDays !== null,
  }
}

export function sharingUiEnabled(env: PublicReleaseEnv = import.meta.env as PublicReleaseEnv): boolean {
  return env.VITE_ENABLE_SHARING === 'true' && legalReleaseInfo(env).complete
}
